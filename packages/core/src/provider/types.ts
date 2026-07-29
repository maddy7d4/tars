import type { AgentEvent, PermissionPolicy, ProviderId, SessionId, UserTurn } from '@tars/shared';

/**
 * What a provider can actually do. The UI feature-detects against this rather than
 * branching on `id`, so adding a provider does not require touching the renderer
 * (Docs/TARS_SPEC.md §4).
 */
export interface ProviderCapabilities {
  readonly streaming: boolean;
  readonly thinking: boolean;
  readonly subagents: boolean;
  readonly mcp: boolean;
  readonly permissionGating: boolean;
  readonly sessionResume: boolean;
}

/** Everything a provider needs to open a session. */
export interface SessionOptions {
  /** Working directory for tool execution. Tools run locally (constraint C3). */
  readonly cwd: string;
  /** Default decision for gated tools; per-tool overrides refine it (§4.2). */
  readonly permissionPolicy: PermissionPolicy;
  /** Resume an existing conversation; requires `capabilities.sessionResume`. */
  readonly resumeSessionId?: SessionId;
  /** Model identifier, or absent to accept the provider's default. */
  readonly model?: string;
  /** Appended to the provider's own system prompt rather than replacing it. */
  readonly appendSystemPrompt?: string;
  /** Resolves a held `permission_request`; absent means every gated tool is denied. */
  readonly onPermissionRequest?: (requestId: string) => Promise<PermissionDecision>;
}

/** A user's answer to a `permission_request`, with a reason the model can read on denial. */
export interface PermissionDecision {
  readonly allow: boolean;
  readonly reason?: string;
}

/**
 * One live conversation. `events` is a single-consumer async iterable: the
 * orchestrator owns iteration and fans out, because two independent consumers of
 * one stream would each see half the deltas.
 */
export interface AgentSession {
  readonly id: SessionId;

  /** Queues a turn. Fire-and-forget by design — progress arrives on `events`. */
  send(input: UserTurn): void;

  /** Stops the in-flight turn; `events` then yields `turn_end` with `'interrupted'`. */
  interrupt(): void;

  readonly events: AsyncIterable<AgentEvent>;

  /** Terminates the underlying process and completes `events`. Idempotent. */
  dispose(): void;
}

/**
 * An agent backend. The load-bearing seam of the system: because the orchestrator
 * and the renderer only ever see `AgentEvent`, a breaking change in the pre-1.0
 * Agent SDK is contained to one adapter (Docs/TARS_SPEC.md §4.1).
 */
export interface AgentProvider {
  readonly id: ProviderId;
  readonly displayName: string;
  readonly capabilities: ProviderCapabilities;
  createSession(opts: SessionOptions): Promise<AgentSession>;
}
