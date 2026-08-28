import { AbortError } from '@anthropic-ai/claude-agent-sdk';
import type { Options, SDKMessage, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import type { AgentEvent, ContextItem, SessionId, TurnId, UserTurn } from '@tars/shared';
import { assertNever, toTurnId } from '@tars/shared';
import type { ClockPort } from '../../ports/clock-port.js';
import type { LoggerPort } from '../../ports/logger-port.js';
import { AsyncQueue } from '../../util/async-queue.js';
import type { TurnEndReason } from '../turn-guard.js';
import { TurnGuard } from '../turn-guard.js';
import type { AgentSession, SessionOptions } from '../types.js';
import { initialMapperState, mapSdkMessage } from './map-message.js';
import type { MapperState } from './map-message.js';
import type { PermissionRequestPayload } from './permission.js';
import { PermissionBroker } from './permission.js';

/**
 * The part of the SDK's `Query` this adapter actually uses.
 *
 * The real `Query` declares roughly twenty-five control methods — MCP management,
 * context accounting, skill reloading, file rewinding. Depending on the whole
 * interface would mean a fake had to implement all of it, and every method added
 * upstream would break this file for no reason. Structural typing lets the adapter
 * name only the three members it drives, and the real `Query` satisfies it.
 */
export interface AgentQuery extends AsyncIterable<SDKMessage> {
  /**
   * Stops the in-flight turn. Resolves once the query has stopped processing; the
   * resolved value is an interrupt receipt on newer CLIs and `undefined` on older
   * ones, and this adapter needs neither.
   */
  interrupt(): Promise<unknown>;

  /** Terminates the subprocess and every pending request. */
  close(): void;
}

/**
 * The SDK's `query` entry point, narrowed to the call this adapter makes.
 *
 * Declared as a type rather than reached for directly so tests can drive a fake
 * stream — the exit criterion "covered by tests against a fake SDK stream"
 * (ROADMAP.md phase 1) is unreachable if the process spawn is hard-wired.
 */
export type QueryFn = (params: {
  prompt: string | AsyncIterable<SDKUserMessage>;
  options?: Options;
}) => AgentQuery;

export interface ClaudeCodeSessionDeps {
  readonly sessionId: SessionId;
  readonly clock: ClockPort;
  readonly logger: LoggerPort;
  readonly options: SessionOptions;
  /** Provider-level SDK options; the session adds the ones only it can supply. */
  readonly baseQueryOptions: Options;
  readonly startQuery: QueryFn;
}

/**
 * One live conversation, adapting the Agent SDK's `query()` stream into
 * `AgentEvent` (Docs/TARS_SPEC.md §4.1).
 *
 * The session is driven in **streaming input mode**: `prompt` is an
 * `AsyncIterable<SDKUserMessage>` fed by `send`, rather than a single string. That
 * choice is forced by the feature set — `Query.interrupt()` and
 * `setPermissionMode()` are documented as "only supported when streaming
 * input/output is used", so a string prompt would make `interrupt()`
 * unimplementable and each turn a fresh subprocess.
 *
 * Turn attribution is positional. The SDK emits exactly one `result` message per
 * turn and processes queued user messages in order, so the head of this session's
 * own turn queue is the turn a message belongs to. Turns are opened one at a time
 * even though input is streamed eagerly, which is what keeps `turn_start` for a
 * queued turn from preceding `turn_end` of the running one.
 */
export class ClaudeCodeSession implements AgentSession {
  readonly id: SessionId;
  readonly events: AsyncIterable<AgentEvent>;

  private readonly outbound = new AsyncQueue<AgentEvent>();
  private readonly inbound = new AsyncQueue<SDKUserMessage>();
  private readonly abortController = new AbortController();
  private readonly clock: ClockPort;
  private readonly logger: LoggerPort;
  private readonly query: AgentQuery;

  private readonly pendingTurns: TurnId[] = [];
  private activeGuard: TurnGuard | null = null;
  private activeTurnId: TurnId | null = null;
  private mapperState: MapperState = initialMapperState();
  private interruptRequested = false;
  private disposed = false;
  private readonly pump: Promise<void>;

  constructor(deps: ClaudeCodeSessionDeps) {
    this.id = deps.sessionId;
    this.clock = deps.clock;
    this.logger = deps.logger.child('claude-code-session');
    this.events = this.outbound;

    const emitPermissionRequest = (request: PermissionRequestPayload): void => {
      this.emitMapped([{ type: 'permission_request', ...request, ...this.stamp() }]);
    };

    const broker = new PermissionBroker({
      emit: emitPermissionRequest,
      defaultPolicy: deps.options.permissionPolicy,
      toolPolicies: deps.options.toolPolicies ?? {},
      ...(deps.options.onPermissionRequest !== undefined
        ? { resolveDecision: deps.options.onPermissionRequest }
        : {}),
    });

    this.query = deps.startQuery({
      prompt: this.inbound,
      options: {
        ...deps.baseQueryOptions,
        abortController: this.abortController,
        canUseTool: broker.canUseTool,
        // Without this the SDK emits only whole assistant messages, and
        // `text_delta` would arrive as one block at turn end — the opposite of the
        // streaming requirement in ROADMAP.md phase 2.
        includePartialMessages: true,
        // `bypassPermissions` would skip `canUseTool` entirely and take TARS's
        // policy out of the loop, so the gate stays on the default path.
        permissionMode: 'default',
      },
    });

    this.pump = this.consume();
  }

  send(input: UserTurn): void {
    if (this.disposed) {
      // Silently dropping would look like a hung turn; an error event is visible.
      this.pushDirect({
        type: 'error',
        message: 'The session has been disposed and cannot accept another turn.',
        code: 'session_disposed',
        retryable: false,
        sessionId: this.id,
        turnId: input.id,
        at: this.clock.now(),
      });
      return;
    }

    this.pendingTurns.push(input.id);
    this.inbound.push({
      type: 'user',
      message: { role: 'user', content: renderUserTurn(input) },
      parent_tool_use_id: null,
    });

    if (this.activeGuard === null) {
      this.openNextTurn();
    }
  }

  interrupt(): void {
    if (this.disposed || this.activeGuard === null) {
      return;
    }
    this.interruptRequested = true;

    // `interrupt()` resolves once the query has stopped processing. Ending the turn
    // on that resolution as well as on the `result` message is what guarantees
    // `turn_end` even if the CLI stops without emitting a result; `TurnGuard.end`
    // is idempotent, so whichever arrives first wins.
    void this.query.interrupt().then(
      () => {
        this.endTurn('interrupted');
      },
      (error: unknown) => {
        this.logger.log('warn', 'interrupt request failed', { error: describeError(error) });
        this.endTurn('interrupted');
      },
    );
  }

  dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;

    // Close the turn before the stream, so a consumer mid-iteration still receives
    // `turn_end` rather than seeing the iterator complete inside an open turn.
    this.endTurn('interrupted');

    this.inbound.close();
    this.abortController.abort();
    try {
      this.query.close();
    } catch (error: unknown) {
      this.logger.log('warn', 'query close failed', { error: describeError(error) });
    }
    this.outbound.close();
  }

  /** Resolves when the SDK stream has been fully drained. Exposed for tests. */
  get drained(): Promise<void> {
    return this.pump;
  }

  private async consume(): Promise<void> {
    try {
      for await (const message of this.query) {
        this.handle(message);
      }
      // The generator completed on its own: the CLI exited. Any turn still open
      // ends here rather than hanging.
      this.endTurn(this.interruptRequested ? 'interrupted' : 'completed');
    } catch (error: unknown) {
      this.handleStreamFailure(error);
    } finally {
      this.inbound.close();
      this.outbound.close();
    }
  }

  private handle(message: SDKMessage): void {
    const result = mapSdkMessage(message, this.mapContext(), this.mapperState);
    this.mapperState = result.state;
    this.emitMapped(result.events);

    if (message.type === 'result') {
      this.endTurn(this.reasonFor(message.subtype));
    }
  }

  private handleStreamFailure(error: unknown): void {
    const aborted = error instanceof AbortError || this.abortController.signal.aborted;
    if (!aborted) {
      this.logger.log('error', 'agent stream failed', { error: describeError(error) });
      this.emitMapped([
        {
          type: 'error',
          message: describeError(error),
          code: 'provider_stream_failed',
          retryable: true,
          ...this.stamp(),
        },
      ]);
    }
    this.endTurn(aborted ? 'interrupted' : 'error');
  }

  private reasonFor(subtype: Extract<SDKMessage, { type: 'result' }>['subtype']): TurnEndReason {
    if (this.interruptRequested) {
      return 'interrupted';
    }
    switch (subtype) {
      case 'success':
        return 'completed';
      case 'error_max_turns':
        return 'max_turns';
      default:
        return 'error';
    }
  }

  private openNextTurn(): void {
    const turnId = this.pendingTurns[0];
    if (turnId === undefined) {
      return;
    }
    this.activeTurnId = turnId;
    this.interruptRequested = false;
    // A new turn starts from a clean mapper state: block indices and outstanding
    // tool correlations belong to the turn that produced them.
    this.mapperState = initialMapperState();
    const guard = new TurnGuard({
      sessionId: this.id,
      turnId,
      now: () => this.clock.now(),
    });
    this.activeGuard = guard;
    this.push(guard.begin());
  }

  private endTurn(reason: TurnEndReason): void {
    const guard = this.activeGuard;
    if (guard === null) {
      return;
    }
    this.push(guard.end(reason));
    this.activeGuard = null;
    this.activeTurnId = null;
    this.pendingTurns.shift();
    if (!this.disposed) {
      this.openNextTurn();
    }
  }

  private emitMapped(events: readonly AgentEvent[]): void {
    const guard = this.activeGuard;
    if (guard === null) {
      // Nothing outside a turn has a turn to belong to. Session-level SDK chatter
      // (init, status) maps to no events at all, so reaching here means the CLI
      // produced turn content after the turn closed.
      this.logger.log('debug', 'dropped events emitted outside a turn', {
        count: events.length,
      });
      return;
    }
    for (const event of events) {
      this.push(guard.pass(event));
    }
  }

  private push(events: readonly AgentEvent[]): void {
    for (const event of events) {
      this.outbound.push(event);
    }
  }

  private pushDirect(event: AgentEvent): void {
    this.outbound.push(event);
  }

  private mapContext(): { sessionId: SessionId; turnId: TurnId; now: () => number } {
    return {
      sessionId: this.id,
      turnId: this.requireTurnId(),
      now: () => this.clock.now(),
    };
  }

  private stamp(): { sessionId: SessionId; turnId: TurnId; at: number } {
    return { sessionId: this.id, turnId: this.requireTurnId(), at: this.clock.now() };
  }

  /**
   * The turn a mapped event belongs to. Falls back to the queue head when no turn
   * is open, which happens only for stream content arriving after `turn_end` —
   * `emitMapped` discards those, so the value is never observed.
   */
  private requireTurnId(): TurnId {
    return this.activeTurnId ?? this.pendingTurns[0] ?? UNATTRIBUTED_TURN;
  }
}

/**
 * Stands in for the turn of an event that arrived with no turn open. Such events
 * are dropped rather than emitted, so this value never reaches a consumer; it
 * exists so the type system does not need a nullable `turnId` on every event.
 */
const UNATTRIBUTED_TURN = toTurnId('unattributed');

/**
 * Renders a `UserTurn` into the prompt text the SDK receives.
 *
 * Context items are appended as an explicit, labelled block rather than silently
 * inlined: `shared` keeps them typed so the host can re-resolve paths and the UI
 * can render chips (see `ContextItem`), and the model reads paths it can then
 * open with its own `Read` tool instead of receiving file bodies TARS chose for it
 * — which is the "curate, do not replace" principle of Docs/TARS_SPEC.md §7.1.
 */
export function renderUserTurn(turn: UserTurn): string {
  if (turn.context.length === 0) {
    return turn.text;
  }
  const lines = turn.context.map(renderContextItem);
  return `${turn.text}\n\n<attached-context>\n${lines.join('\n')}\n</attached-context>`;
}

function renderContextItem(item: ContextItem): string {
  switch (item.kind) {
    case 'file':
      return `- file: ${item.path}`;
    case 'selection':
      return `- selection: ${item.path}:${String(item.startLine)}-${String(item.endLine)}`;
    case 'symbol':
      return `- symbol: ${item.name} (${item.path}:${String(item.line)})`;
    case 'diagnostic':
      return `- diagnostic [${item.severity}]: ${item.path}:${String(item.line)} ${item.message}`;
    case 'terminal':
      return `- terminal output:\n\`\`\`\n${item.text}\n\`\`\``;
    case 'git':
      return `- git ${item.label}:\n\`\`\`\n${item.text}\n\`\`\``;
    default:
      return assertNever(item);
  }
}

function describeError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}
