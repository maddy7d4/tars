import { randomUUID } from 'node:crypto';
import type {
  ConversationSummary,
  HostPorts,
  LoggerPort,
  ManagedSession,
  PermissionDecision,
  Unsubscribe,
} from '@tars/core';
import { ClaudeCodeProvider, ConversationHistory, MemoryStore, SessionManager } from '@tars/core';
import type {
  AgentEvent,
  ContextItem,
  HostToWebview,
  PermissionPolicy,
  PermissionRequestEvent,
  SessionId,
} from '@tars/shared';
import { toTurnId } from '@tars/shared';
import { readMcpServers, readPermissionPolicy, readToolPolicies } from './config.js';

/** Collaborators the controller needs. Supplied by `ChatViewProvider`. */
export interface SessionControllerDeps {
  readonly ports: HostPorts;
  /** Delivers one host→webview message. A no-op when no view is attached. */
  readonly post: (message: HostToWebview) => void;
  /** Called only on a transition, so the status bar is not rewritten per token. */
  readonly onBusyChanged: (busy: boolean) => void;
  /**
   * Observes every event before it reaches the webview.
   *
   * The review controller has to snapshot a file *before* the agent's tool
   * writes it, and `file_edit_proposed` is announced before the tool runs. Any
   * separately-ordered notification would race that window.
   */
  readonly onEvent?: (event: AgentEvent) => Promise<void>;
}

const NO_WORKSPACE =
  'TARS needs an open folder: agent tools run in the workspace directory (constraint C3). Open a folder and try again.';

const DECLINED_BY_USER = 'The user declined this tool invocation.';

const TORN_DOWN_BEFORE_DECISION =
  'The session was closed before the user decided, so the tool was not run.';

/**
 * Owns the agent session behind the chat view: one `SessionManager` over one
 * `ClaudeCodeProvider`, plus the permission round-trip the webview drives.
 *
 * Split out of `ChatViewProvider` because the two have different lifetimes. The
 * webview comes and goes — hidden, reloaded, re-resolved — while the session and
 * its subprocess must survive all of that; folding them together is how a reload
 * ends up orphaning a `claude` process or wiping the transcript.
 *
 * The controller never imports the Agent SDK and never touches `vscode`: it speaks
 * `HostPorts` and `AgentEvent` only, so everything below it stays the seam ADR 0004
 * describes.
 */
export class SessionController {
  private readonly manager: SessionManager;
  private readonly log: LoggerPort;
  /**
   * What TARS has learned about this workspace, carried into every new session.
   *
   * Read at session open rather than per turn: the SDK's system prompt is fixed
   * for the life of a session, so a memory recorded mid-conversation reaches the
   * model on the next one. That is the honest bound, and pretending otherwise
   * would mean re-opening the subprocess on every `remember`.
   */
  private readonly memory: MemoryStore;
  private readonly history: ConversationHistory;
  /** Set only for the next `openSession`, so resuming is a one-shot instruction. */
  private resumeId: SessionId | null = null;

  /** Resolvers for `canUseTool` promises the SDK is currently holding open. */
  private readonly pendingDecisions = new Map<string, (decision: PermissionDecision) => void>();
  /**
   * The request events behind those promises, kept so a webview that reloaded
   * mid-approval can be shown the prompts it is still blocking on. Replayed
   * history alone cannot supply this — the log records that a request happened,
   * not that it is still outstanding.
   */
  private readonly pendingRequests = new Map<string, PermissionRequestEvent>();

  private session: ManagedSession | null = null;
  private opening: Promise<ManagedSession> | null = null;
  private unsubscribe: Unsubscribe | null = null;
  private busy = false;
  private disposing: Promise<void> | null = null;

  constructor(private readonly deps: SessionControllerDeps) {
    const { ports } = deps;
    this.log = ports.logger.child('session-controller');
    this.manager = new SessionManager({
      provider: new ClaudeCodeProvider({
        clock: ports.clock,
        logger: ports.logger,
        secrets: ports.secrets,
      }),
      fileSystem: ports.fileSystem,
      storage: ports.storage,
      clock: ports.clock,
      logger: ports.logger,
    });
    this.memory = new MemoryStore({
      fileSystem: ports.fileSystem,
      storage: ports.storage,
      clock: ports.clock,
      logger: ports.logger,
    });
    this.history = new ConversationHistory({
      fileSystem: ports.fileSystem,
      storage: ports.storage,
      clock: ports.clock,
      logger: ports.logger,
    });
  }

  /** Past conversations, for the resume picker. */
  listConversations(): Promise<readonly ConversationSummary[]> {
    return this.history.list();
  }

  /**
   * Closes the current session and reopens the named one.
   *
   * The id is stashed rather than passed down, because opening is latched behind
   * `ensureSession` and threading a parameter through it would let a concurrent
   * prompt open the wrong conversation.
   */
  async resume(sessionId: SessionId): Promise<void> {
    try {
      await this.closeSession();
      this.resumeId = sessionId;
      await this.ensureSession();
      await this.restore();
    } catch (error: unknown) {
      this.fail('could not resume the conversation', error);
    }
  }

  /** The workspace memory, for the commands that inspect and edit it. */
  get workspaceMemory(): MemoryStore {
    return this.memory;
  }

  /**
   * Queues a turn, creating the session on the first prompt.
   *
   * Lazy creation is deliberate: opening a session spawns the agent subprocess and
   * reads the keychain, and doing that at activation would charge every window that
   * merely has the extension installed.
   */
  async sendPrompt(text: string, context: readonly ContextItem[]): Promise<void> {
    try {
      const session = await this.ensureSession();
      // Marked busy here rather than on `turn_start`: the round trip through the
      // subprocess is visible to a human, and a Stop button that only appears once
      // the model answers is a Stop button that arrives too late.
      this.setBusy(true);
      session.send({ id: toTurnId(randomUUID()), text, context });
    } catch (error: unknown) {
      this.fail('could not start the turn', error);
    }
  }

  /** Stops the in-flight turn. Harmless when nothing is running. */
  interrupt(): void {
    this.session?.interrupt();
  }

  /**
   * Settles the `canUseTool` promise the provider is holding for `requestId`.
   *
   * This is the second half of Docs/TARS_SPEC.md §4.2 step 4: the provider emitted
   * `permission_request` and parked, the webview rendered it, and this call is the
   * user's answer flowing back down the same seam.
   */
  decide(requestId: string, decision: PermissionPolicy): void {
    const resolve = this.pendingDecisions.get(requestId);
    this.pendingDecisions.delete(requestId);
    this.pendingRequests.delete(requestId);

    // Echoed even for an unknown id so a stale prompt in the UI still retires;
    // otherwise an approval outlived by its turn would sit there forever.
    this.deps.post({ type: 'permission_resolved', requestId, decision });

    if (resolve === undefined) {
      this.log.log('warn', 'decision for an unknown permission request', { requestId });
      return;
    }
    // The three decisions the prompt offers, mapped onto the broker's vocabulary:
    // `deny` refuses this invocation, `ask` allows exactly this one without
    // promoting the tool, and `always_allow` allows it and promotes the tool for
    // the remainder of this session (never beyond it — see `PermissionDecision`).
    if (decision === 'deny') {
      resolve({ allow: false, reason: DECLINED_BY_USER });
      return;
    }
    resolve(decision === 'always_allow' ? { allow: true, remember: true } : { allow: true });
  }

  /** Discards the current session and opens a fresh one, transcript included. */
  async newSession(): Promise<void> {
    try {
      await this.closeSession();
      await this.ensureSession();
    } catch (error: unknown) {
      this.fail('could not start a new session', error);
    }
  }

  /**
   * Re-seeds a webview that just (re)mounted from the durable log, so a reload —
   * or a view VS Code disposed while hidden — does not read as a lost conversation.
   */
  async restore(): Promise<void> {
    const session = this.session;
    if (session === null) {
      return;
    }
    try {
      // Appends are batched; without the flush the tail of the transcript would be
      // in memory and absent from the replay we are about to read.
      await session.flush();
      const history: AgentEvent[] = [];
      for await (const record of session.replay()) {
        history.push(record.event);
      }
      this.deps.post({
        type: 'session_state',
        sessionId: session.id,
        busy: this.busy,
        history,
      });
      for (const request of this.pendingRequests.values()) {
        this.deps.post({ type: 'agent_event', event: request });
      }
    } catch (error: unknown) {
      this.fail('could not restore the conversation', error);
    }
  }

  /**
   * Idempotent. Releases every session, and therefore every SDK subprocess — a
   * leaked one outlives the window it was spawned for.
   */
  dispose(): Promise<void> {
    this.disposing ??= this.performDispose();
    return this.disposing;
  }

  private async performDispose(): Promise<void> {
    // `closeSession` first, because it awaits an open still in flight. A session
    // that finishes creating *after* `disposeAll` has swept the map would never be
    // reached again, and its subprocess would outlive the window.
    await this.closeSession();
    await this.manager.disposeAll();
  }

  private ensureSession(): Promise<ManagedSession> {
    this.opening ??= this.openSession();
    return this.opening.catch((error: unknown) => {
      // A failed open must not poison every later prompt: clearing the latch lets
      // the next attempt retry rather than re-await a rejected promise forever.
      this.opening = null;
      throw error instanceof Error ? error : new Error(String(error));
    });
  }

  private async openSession(): Promise<ManagedSession> {
    // Appended rather than replacing the provider's own prompt: TARS adds what it
    // knows about this workspace, and overriding would discard everything Claude
    // Code's harness already establishes about how to use its tools.
    const memory = await this.memory.toPromptSection();
    // Read at open, like the memory above: MCP servers are launched with the
    // session, so a setting changed mid-conversation applies to the next one.
    const configured = readMcpServers(this.deps.ports);
    const mcpServers = Object.keys(configured).length === 0 ? null : configured;

    // Consumed here so a later `newSession` opens a fresh conversation rather
    // than silently resuming the same one again.
    const resumeSessionId = this.resumeId;
    this.resumeId = null;

    const session = await this.manager.create({
      cwd: this.requireWorkspacePath(),
      ...(resumeSessionId === null ? {} : { resumeSessionId }),
      permissionPolicy: readPermissionPolicy(this.deps.ports),
      toolPolicies: readToolPolicies(this.deps.ports),
      onPermissionRequest: (requestId) => this.awaitDecision(requestId),
      ...(memory === '' ? {} : { appendSystemPrompt: memory }),
      ...(mcpServers === null ? {} : { mcpServers }),
    });

    this.session = session;
    // One subscription per session, taken before anything is sent: the manager is
    // the single consumer of the provider stream and this is the fan-out the UI
    // sees, so a turn queued before subscribing would stream into nothing.
    this.unsubscribe = session.subscribe((event) => {
      this.handleEvent(event);
    });
    this.deps.post({ type: 'session_state', sessionId: session.id, busy: false, history: [] });
    this.log.log('info', 'chat session ready', { sessionId: session.id });
    return session;
  }

  private handleEvent(event: AgentEvent): void {
    if (event.type === 'turn_start') {
      this.setBusy(true);
    } else if (event.type === 'turn_end') {
      this.setBusy(false);
    } else if (event.type === 'permission_request') {
      this.pendingRequests.set(event.requestId, event);
    }
    // Forwarded before the observer settles: the transcript must not stall behind
    // a filesystem read, and the observer reports its own failures.
    this.deps.post({ type: 'agent_event', event });
    void this.deps.onEvent?.(event).catch((error: unknown) => {
      this.log.log('error', 'event observer failed', {
        type: event.type,
        error: error instanceof Error ? error.message : String(error),
      });
    });
  }

  private awaitDecision(requestId: string): Promise<PermissionDecision> {
    return new Promise<PermissionDecision>((resolve) => {
      this.pendingDecisions.set(requestId, resolve);
    });
  }

  private async closeSession(): Promise<void> {
    const opening = this.opening;
    if (opening !== null) {
      // Awaiting an open already in flight is what stops a session created a
      // moment after teardown from becoming an orphan nothing holds a handle to.
      await opening.catch(() => null);
    }
    const session = this.session;
    this.detach();
    if (session !== null) {
      await session.dispose();
    }
  }

  /** Drops every reference to the current session and settles what it was holding. */
  private detach(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.session = null;
    this.opening = null;
    this.setBusy(false);
    // Every held `canUseTool` promise is settled rather than abandoned: an
    // unsettled one keeps the SDK's tool call pending inside a session we are
    // tearing down, and denial is the only safe answer nobody is left to give.
    for (const resolve of this.pendingDecisions.values()) {
      resolve({ allow: false, reason: TORN_DOWN_BEFORE_DECISION });
    }
    this.pendingDecisions.clear();
    this.pendingRequests.clear();
  }

  private requireWorkspacePath(): string {
    const [folder] = this.deps.ports.workspace.folders;
    if (folder === undefined) {
      throw new Error(NO_WORKSPACE);
    }
    // Multi-root picks the first folder: the SDK takes one cwd, and the first root
    // is the one VS Code itself treats as primary.
    return folder.path;
  }

  private setBusy(busy: boolean): void {
    if (this.busy === busy) {
      return;
    }
    this.busy = busy;
    this.deps.onBusyChanged(busy);
  }

  /**
   * Every failure path ends here: the user sees it in the panel *and* it lands in
   * the output channel. A host error that only reaches the log looks to the user
   * like a prompt that vanished.
   */
  private fail(what: string, error: unknown): void {
    const detail = error instanceof Error ? error.message : String(error);
    this.log.log('error', what, { error: detail });
    this.deps.post({ type: 'host_error', message: `${what}: ${detail}` });
    this.setBusy(false);
  }
}
