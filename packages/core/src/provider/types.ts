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
  /**
   * Per-tool overrides keyed by tool name, e.g. `{ Bash: 'deny' }`. An entry is the
   * user's direct instruction for that tool and wins over both `permissionPolicy`
   * and the built-in defaults that gate destructive and outward-facing tools
   * (§4.2). Absent means "no overrides".
   */
  readonly toolPolicies?: Readonly<Record<string, PermissionPolicy>>;
  /** Resume an existing conversation; requires `capabilities.sessionResume`. */
  readonly resumeSessionId?: SessionId;
  /** Model identifier, or absent to accept the provider's default. */
  readonly model?: string;
  /** Appended to the provider's own system prompt rather than replacing it. */
  readonly appendSystemPrompt?: string;
  /**
   * MCP servers to make available to the agent.
   *
   * Declared in core's own shape rather than the SDK's, so a user-facing setting
   * is not implicitly bound to a third-party type that can change in a patch
   * release (ADR 0004). The adapter maps it.
   */
  readonly mcpServers?: Readonly<Record<string, McpServerSpec>>;
  /** Resolves a held `permission_request`; absent means every gated tool is denied. */
  readonly onPermissionRequest?: (requestId: string) => Promise<PermissionDecision>;
}

/**
 * An MCP server the agent may use.
 *
 * Every tool a server exposes is gated as a class by the permission broker: MCP
 * servers are third-party code reaching outward, and a user who configures one
 * has said it may run, not that it may run unattended.
 */
export type McpServerSpec = McpStdioServerSpec | McpRemoteServerSpec;

/** A server TARS launches as a subprocess. */
export interface McpStdioServerSpec {
  readonly transport: 'stdio';
  readonly command: string;
  readonly args?: readonly string[];
  readonly env?: Readonly<Record<string, string>>;
}

/** A server reached over the network. */
export interface McpRemoteServerSpec {
  readonly transport: 'http' | 'sse';
  readonly url: string;
  readonly headers?: Readonly<Record<string, string>>;
}

/** A user's answer to a `permission_request`, with a reason the model can read on denial. */
export interface PermissionDecision {
  readonly allow: boolean;
  readonly reason?: string;
  /**
   * Promotes the tool to `always_allow` for the rest of this session, so later
   * invocations of it stop prompting. Ignored unless `allow` is true: a refusal
   * is never durable, because a user who declines once has said nothing about
   * what they would decide next time.
   *
   * The grant dies with the session. Persisting it would let a single click
   * silently widen what the agent may do in every future window, which is a
   * decision that belongs in settings, where it is visible and revocable.
   */
  readonly remember?: boolean;
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
