import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import type { AgentEvent, PlanStep, SessionId, ToolCallId, TurnId } from '@tars/shared';

/**
 * Stamping and time for a mapped event. The clock is injected rather than read
 * from `Date.now` so this module stays pure and ordering assertions are exact
 * (Docs/TARS_SPEC.md §3.2).
 */
export interface MapContext {
  readonly sessionId: SessionId;
  readonly turnId: TurnId;
  readonly now: () => number;
}

/** What a streaming content block at a given index turns out to be. */
type BlockKind =
  | { readonly kind: 'text' }
  | { readonly kind: 'thinking' }
  | { readonly kind: 'tool_use'; readonly toolCallId: ToolCallId }
  | { readonly kind: 'ignored' };

/** A tool call observed earlier in the stream, so its result can be correlated. */
interface ToolRecord {
  readonly name: string;
  readonly startedAt: number;
}

/**
 * Correlation state the SDK stream forces on us, threaded explicitly rather than
 * held in a module or a session field.
 *
 * Two facts make it unavoidable. `content_block_stop` carries only an index, so
 * closing a thinking block requires remembering what the block at that index was.
 * And a `tool_result` block carries only `tool_use_id`, so naming the tool and
 * timing the call requires remembering the matching `tool_use`.
 *
 * Explicit state keeps the mapper a pure function of (message, context, state),
 * which is what makes it testable against hand-built fixtures with no session,
 * no process and no clock.
 */
export interface MapperState {
  /** Keyed by streaming content-block index; reset at every `message_start`. */
  readonly blocks: ReadonlyMap<number, BlockKind>;
  /** Keyed by tool-use id; spans the whole turn because results arrive later. */
  readonly tools: ReadonlyMap<ToolCallId, ToolRecord>;
}

/** Events produced by one SDK message, plus the state the next call must receive. */
export interface MapResult {
  readonly events: readonly AgentEvent[];
  readonly state: MapperState;
}

export function initialMapperState(): MapperState {
  return { blocks: new Map(), tools: new Map() };
}

/**
 * Maps one `SDKMessage` to zero or more `AgentEvent`s.
 *
 * This is the file ADR 0004 exists to isolate: the entire repository's knowledge
 * of the Agent SDK's stream shape lives here, so an SDK breaking change is a
 * one-file edit. It performs no I/O and holds no session state.
 *
 * The division of labour between message kinds is deliberate, and it is what
 * keeps events from being emitted twice:
 *
 * - `stream_event` (`SDKPartialAssistantMessage`) is the sole source of
 *   incremental content — `text_delta`, `thinking_*`, `tool_call_start` and
 *   `tool_call_delta`. `ClaudeCodeSession` always passes
 *   `includePartialMessages: true`, so this stream is always present.
 * - `assistant` (`SDKAssistantMessage`) is the sole source of *complete* tool
 *   input, because a partial `input_json_delta` is not parseable JSON. It
 *   therefore yields `plan_update` and `file_edit_proposed`, and it deliberately
 *   does not re-emit the text and tool starts already streamed above.
 * - `user` carries `tool_result` blocks, `result` carries turn accounting.
 *
 * Turn and thinking-pair invariants are **not** enforced here — `TurnGuard` owns
 * them, so this function never emits `turn_start` or `turn_end`.
 */
export function mapSdkMessage(
  message: SDKMessage,
  ctx: MapContext,
  state: MapperState,
): MapResult {
  switch (message.type) {
    case 'stream_event':
      return mapStreamEvent(message.event, ctx, state);
    case 'assistant':
      return mapAssistantMessage(message.message.content, message.error, ctx, state);
    case 'user':
      return mapUserMessage(message.message.content, ctx, state);
    case 'result':
      return mapResultMessage(message, ctx, state);
    case 'system':
      return mapSystemMessage(message, ctx, state);
    default:
      // Status, hook, task, plugin, retry and notification messages carry nothing
      // the normalized union names. ADR 0004 accepts this: a capability the union
      // does not name is invisible until the union is deliberately extended.
      return { events: [], state };
  }
}

type StreamEvent = Extract<SDKMessage, { type: 'stream_event' }>['event'];
type AssistantContent = Extract<SDKMessage, { type: 'assistant' }>['message']['content'];
type UserContent = Extract<SDKMessage, { type: 'user' }>['message']['content'];
type ResultMessage = Extract<SDKMessage, { type: 'result' }>;
type SystemMessage = Extract<SDKMessage, { type: 'system' }>;
type AssistantError = Extract<SDKMessage, { type: 'assistant' }>['error'];

function mapStreamEvent(event: StreamEvent, ctx: MapContext, state: MapperState): MapResult {
  switch (event.type) {
    case 'message_start':
      // Block indices restart with every assistant message, so a stale index map
      // would attribute a delta to the wrong block.
      return { events: [], state: { blocks: new Map(), tools: state.tools } };

    case 'content_block_start':
      return mapContentBlockStart(event.index, event.content_block, ctx, state);

    case 'content_block_delta':
      return mapContentBlockDelta(event.index, event.delta, ctx, state);

    case 'content_block_stop': {
      const block = state.blocks.get(event.index);
      const blocks = new Map(state.blocks);
      blocks.delete(event.index);
      const next: MapperState = { blocks, tools: state.tools };
      if (block?.kind === 'thinking') {
        return { events: [{ type: 'thinking_end', ...stamp(ctx) }], state: next };
      }
      return { events: [], state: next };
    }

    default:
      // `message_delta` and `message_stop` carry stop reasons and delta usage. Turn
      // accounting comes from the `result` message, which is cumulative and
      // authoritative, so mapping them too would double-count.
      return { events: [], state };
  }
}

function mapContentBlockStart(
  index: number,
  block: Extract<StreamEvent, { type: 'content_block_start' }>['content_block'],
  ctx: MapContext,
  state: MapperState,
): MapResult {
  const blocks = new Map(state.blocks);

  switch (block.type) {
    case 'text':
      blocks.set(index, { kind: 'text' });
      return { events: [], state: { blocks, tools: state.tools } };

    // Redacted thinking is a thinking block whose content the API withheld. It
    // still opens and closes a block, so the UI must still open and close a panel.
    case 'thinking':
    case 'redacted_thinking':
      blocks.set(index, { kind: 'thinking' });
      return { events: [{ type: 'thinking_start', ...stamp(ctx) }], state: { blocks, tools: state.tools } };

    case 'tool_use':
    case 'server_tool_use':
    case 'mcp_tool_use': {
      const toolCallId: ToolCallId = block.id;
      blocks.set(index, { kind: 'tool_use', toolCallId });
      const tools = new Map(state.tools);
      tools.set(toolCallId, { name: block.name, startedAt: ctx.now() });
      return {
        events: [{ type: 'tool_call_start', toolCallId, toolName: block.name, ...stamp(ctx) }],
        state: { blocks, tools },
      };
    }

    default:
      blocks.set(index, { kind: 'ignored' });
      return { events: [], state: { blocks, tools: state.tools } };
  }
}

function mapContentBlockDelta(
  index: number,
  delta: Extract<StreamEvent, { type: 'content_block_delta' }>['delta'],
  ctx: MapContext,
  state: MapperState,
): MapResult {
  switch (delta.type) {
    case 'text_delta':
      return { events: [{ type: 'text_delta', text: delta.text, ...stamp(ctx) }], state };

    case 'thinking_delta':
      return { events: [{ type: 'thinking_delta', text: delta.thinking, ...stamp(ctx) }], state };

    case 'input_json_delta': {
      const block = state.blocks.get(index);
      if (block?.kind !== 'tool_use') {
        return { events: [], state };
      }
      return {
        events: [
          {
            type: 'tool_call_delta',
            toolCallId: block.toolCallId,
            inputJsonDelta: delta.partial_json,
            ...stamp(ctx),
          },
        ],
        state,
      };
    }

    default:
      // `signature_delta`, `citations_delta` and compaction deltas have no
      // user-visible counterpart in the union.
      return { events: [], state };
  }
}

function mapAssistantMessage(
  content: AssistantContent,
  error: AssistantError,
  ctx: MapContext,
  state: MapperState,
): MapResult {
  const events: AgentEvent[] = [];
  const tools = new Map(state.tools);

  for (const block of content) {
    if (block.type !== 'tool_use' && block.type !== 'server_tool_use' && block.type !== 'mcp_tool_use') {
      continue;
    }
    // Recorded here as well as from the streaming start, so a `tool_result` can
    // still be named if the partial stream missed the opening block.
    if (!tools.has(block.id)) {
      tools.set(block.id, { name: block.name, startedAt: ctx.now() });
    }
    events.push(...deriveToolIntentEvents(block.name, block.input, ctx));
  }

  if (error !== undefined) {
    events.push({
      type: 'error',
      message: describeAssistantError(error),
      code: error,
      retryable: RETRYABLE_ASSISTANT_ERRORS.has(error),
      ...stamp(ctx),
    });
  }

  return { events, state: { blocks: state.blocks, tools } };
}

function mapUserMessage(content: UserContent, ctx: MapContext, state: MapperState): MapResult {
  if (typeof content === 'string') {
    // The turn's own prompt echoed back. The UI already rendered what the user typed.
    return { events: [], state };
  }

  const events: AgentEvent[] = [];
  const tools = new Map(state.tools);

  for (const block of content) {
    if (block.type !== 'tool_result') {
      continue;
    }
    const record = tools.get(block.tool_use_id);
    if (record === undefined) {
      // An orphaned result: no `tool_call_start` was seen, so there is no timeline
      // entry to attach it to and the tool's name is genuinely unknown. Inventing
      // one would put a fabricated tool in the transcript.
      continue;
    }
    tools.delete(block.tool_use_id);
    events.push({
      type: 'tool_call_result',
      toolCallId: block.tool_use_id,
      toolName: record.name,
      isError: block.is_error === true,
      content: renderToolResultContent(block.content),
      // The SDK's `tool_result` block carries no duration, so it is measured from
      // the observed `tool_use` to the observed result on the injected clock.
      durationMs: Math.max(0, ctx.now() - record.startedAt),
      ...stamp(ctx),
    });
  }

  return { events, state: { blocks: state.blocks, tools } };
}

function mapResultMessage(message: ResultMessage, ctx: MapContext, state: MapperState): MapResult {
  const usage = message.usage;
  const events: AgentEvent[] = [
    {
      type: 'usage',
      inputTokens: usage.input_tokens,
      outputTokens: usage.output_tokens,
      cacheReadTokens: usage.cache_read_input_tokens,
      cacheCreationTokens: usage.cache_creation_input_tokens,
      ...stamp(ctx),
    },
  ];

  if (message.subtype !== 'success') {
    events.push({
      type: 'error',
      message: message.errors.length > 0 ? message.errors.join('\n') : describeResultSubtype(message.subtype),
      code: message.subtype,
      // Re-sending a turn that blew a turn or budget ceiling hits the same ceiling.
      retryable: message.subtype === 'error_during_execution',
      ...stamp(ctx),
    });
  }

  return { events, state };
}

function mapSystemMessage(
  message: SystemMessage,
  ctx: MapContext,
  state: MapperState,
): MapResult {
  switch (message.subtype) {
    case 'permission_denied':
      // The SDK denied a tool itself — a deny rule, `dontAsk` mode or the auto
      // classifier — so `canUseTool` never ran and no `permission_request` was
      // emitted. Without this the user would see only an errored tool result.
      return {
        events: [
          {
            type: 'error',
            message: message.message,
            code: 'permission_denied',
            retryable: false,
            ...stamp(ctx),
          },
        ],
        state,
      };

    case 'mirror_error':
      return {
        events: [
          { type: 'error', message: message.error, code: 'mirror_error', retryable: true, ...stamp(ctx) },
        ],
        state,
      };

    default:
      // `init`, `status`, `compact_boundary` and the task/background subtypes are
      // session telemetry, not turn content.
      return { events: [], state };
  }
}

/**
 * Derives the union members that describe a tool's *intent* from its completed
 * input. Only tools whose intent is fully determined by the input appear here.
 *
 * `Edit` is deliberately absent: `file_edit_proposed.afterContent` is the whole
 * post-edit file, and deriving it from `old_string`/`new_string` requires reading
 * the file from disk. This module is pure, so it cannot. Phase 3 owns the diff
 * engine and resolves `Edit` there against `FileSystemPort`.
 */
function deriveToolIntentEvents(
  toolName: string,
  input: unknown,
  ctx: MapContext,
): readonly AgentEvent[] {
  if (toolName === 'Write') {
    const write = asFileWriteInput(input);
    if (write === null) {
      return [];
    }
    return [
      {
        type: 'file_edit_proposed',
        path: write.filePath,
        // `beforeHash` is omitted rather than guessed: hashing the pre-edit file
        // needs a read, and this function performs no I/O.
        afterContent: write.content,
        ...stamp(ctx),
      },
    ];
  }

  if (toolName === 'TodoWrite') {
    const steps = asPlanSteps(input);
    if (steps === null) {
      return [];
    }
    return [{ type: 'plan_update', steps, ...stamp(ctx) }];
  }

  return [];
}

function asFileWriteInput(input: unknown): { filePath: string; content: string } | null {
  if (!isRecord(input)) {
    return null;
  }
  const filePath = input['file_path'];
  const content = input['content'];
  if (typeof filePath !== 'string' || typeof content !== 'string') {
    return null;
  }
  return { filePath, content };
}

const PLAN_STATUSES: ReadonlySet<string> = new Set(['pending', 'in_progress', 'completed']);

function asPlanSteps(input: unknown): readonly PlanStep[] | null {
  if (!isRecord(input)) {
    return null;
  }
  const todos = input['todos'];
  if (!Array.isArray(todos)) {
    return null;
  }

  const steps: PlanStep[] = [];
  for (const [index, todo] of (todos as readonly unknown[]).entries()) {
    if (!isRecord(todo)) {
      return null;
    }
    const content = todo['content'];
    const status = todo['status'];
    if (typeof content !== 'string' || typeof status !== 'string' || !PLAN_STATUSES.has(status)) {
      return null;
    }
    steps.push({
      // `TodoWriteInput` has no stable per-item id: the tool always sends the whole
      // list, so position is the only identity available. `PlanUpdateEvent` is
      // documented as a full replacement, which makes positional ids sufficient.
      id: `step-${String(index)}`,
      title: content,
      status: status as PlanStep['status'],
    });
  }
  return steps;
}

function renderToolResultContent(
  content: Extract<UserContent[number], { type: 'tool_result' }>['content'],
): string {
  if (content === undefined) {
    return '';
  }
  if (typeof content === 'string') {
    return content;
  }
  return content
    .map((part) => {
      if (part.type === 'text') {
        return part.text;
      }
      // Images, documents and search results have no text form. A typed
      // placeholder keeps the transcript honest about what the tool returned
      // instead of silently dropping the block.
      return `[${part.type}]`;
    })
    .join('');
}

const RETRYABLE_ASSISTANT_ERRORS: ReadonlySet<string> = new Set([
  'rate_limit',
  'overloaded',
  'server_error',
]);

const ASSISTANT_ERROR_TEXT: Readonly<Record<string, string>> = {
  authentication_failed:
    'Authentication failed. The Agent SDK resolves credentials from ANTHROPIC_API_KEY, ANTHROPIC_AUTH_TOKEN, or an existing `claude` login.',
  oauth_org_not_allowed: 'Your organization does not permit this login for API access.',
  billing_error: 'The request was rejected for a billing reason.',
  rate_limit: 'Rate limited. Retrying shortly should succeed.',
  overloaded: 'The model is overloaded. Retrying shortly should succeed.',
  invalid_request: 'The request was rejected as invalid.',
  model_not_found: 'The requested model is not available to this account.',
  server_error: 'The API returned a server error.',
  max_output_tokens: 'The response hit the maximum output-token limit.',
  unknown: 'The assistant message failed for an unspecified reason.',
};

function describeAssistantError(code: string): string {
  return ASSISTANT_ERROR_TEXT[code] ?? `The assistant message failed: ${code}.`;
}

function describeResultSubtype(subtype: string): string {
  switch (subtype) {
    case 'error_max_turns':
      return 'The turn stopped after reaching the configured maximum number of agent turns.';
    case 'error_max_budget_usd':
      return 'The turn stopped after reaching the configured spend limit.';
    case 'error_max_structured_output_retries':
      return 'The turn stopped after too many structured-output retries.';
    default:
      return 'The turn failed during execution.';
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stamp(ctx: MapContext): { sessionId: SessionId; turnId: TurnId; at: number } {
  return { sessionId: ctx.sessionId, turnId: ctx.turnId, at: ctx.now() };
}
