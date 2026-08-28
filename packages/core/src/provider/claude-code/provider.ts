import { query } from '@anthropic-ai/claude-agent-sdk';
import type { McpServerConfig, Options } from '@anthropic-ai/claude-agent-sdk';
import type { ProviderId, SessionId } from '@tars/shared';
import { toProviderId, toSessionId } from '@tars/shared';
import { randomUUID } from 'node:crypto';
import type { ClockPort } from '../../ports/clock-port.js';
import type { LoggerPort } from '../../ports/logger-port.js';
import type { SecretsPort } from '../../ports/secrets-port.js';
import type {
  AgentProvider,
  AgentSession,
  McpServerSpec,
  ProviderCapabilities,
  SessionOptions,
} from '../types.js';
import type { QueryFn } from './session.js';
import { ClaudeCodeSession } from './session.js';

export const CLAUDE_CODE_PROVIDER_ID: ProviderId = toProviderId('claude-code');

/**
 * `SecretsPort` key for the optional API-key override of Docs/TARS_SPEC.md §1.3.
 *
 * The override lives in the OS keychain and nowhere else. It is deliberately not a
 * configuration setting: `settings.json` is a file users commit.
 */
export const ANTHROPIC_API_KEY_SECRET_KEY = 'tars.anthropicApiKey';

/**
 * What this provider genuinely supports, each flag verified against the installed
 * SDK's own declarations rather than assumed:
 *
 * - `streaming` — `Options.includePartialMessages` plus the
 *   `SDKPartialAssistantMessage` variant of `SDKMessage`, which carries
 *   `BetaRawMessageStreamEvent` content-block deltas.
 * - `thinking` — `Options.thinking: ThinkingConfig` and the `thinking` /
 *   `redacted_thinking` content blocks with their `thinking_delta` deltas.
 * - `subagents` — `Options.agents: Record<string, AgentDefinition>` and
 *   `Options.forwardSubagentText`, with `subagent_type` on assistant messages.
 * - `mcp` — `Options.mcpServers: Record<string, McpServerConfig>`, plus
 *   `mcp_servers` reported on the `system`/`init` message.
 * - `permissionGating` — `Options.canUseTool: CanUseTool`, whose returned
 *   `PermissionResult` is what §4.2's flow resolves.
 * - `sessionResume` — `Options.resume`, `Options.resumeSessionAt` and
 *   `Options.forkSession`.
 */
export const CLAUDE_CODE_CAPABILITIES: ProviderCapabilities = {
  streaming: true,
  thinking: true,
  subagents: true,
  mcp: true,
  permissionGating: true,
  sessionResume: true,
};

export interface ClaudeCodeProviderDeps {
  readonly clock: ClockPort;
  readonly logger: LoggerPort;
  readonly secrets: SecretsPort;
  /** Overridden in tests to drive a fake SDK stream; defaults to the real `query`. */
  readonly startQuery?: QueryFn;
  /** Overridden in tests for deterministic ids; defaults to `crypto.randomUUID`. */
  readonly newSessionId?: () => SessionId;
  /**
   * The environment the agent subprocess inherits. Injected rather than read from
   * `process.env` inline so a test can assert exactly what reaches the SDK.
   */
  readonly processEnv?: Readonly<Record<string, string | undefined>>;
}

/**
 * The Claude Code provider (ADR 0001).
 *
 * This directory is the only place in the repository permitted to import
 * `@anthropic-ai/claude-agent-sdk`, enforced by the ESLint boundary rule. Because
 * neither the orchestrator nor the renderer has ever seen an SDK type, the blast
 * radius of an SDK breaking change is this directory (ADR 0004).
 *
 * Authentication is deliberately absent from this class beyond one keychain read.
 * The SDK resolves credentials through `ANTHROPIC_API_KEY` →
 * `ANTHROPIC_AUTH_TOKEN` → the on-disk OAuth profile of an existing `claude`
 * login, so users who already use Claude Code get zero-config auth and TARS builds
 * no login flow (Docs/TARS_SPEC.md §1.3).
 */
export class ClaudeCodeProvider implements AgentProvider {
  readonly id = CLAUDE_CODE_PROVIDER_ID;
  readonly displayName = 'Claude Code';
  readonly capabilities = CLAUDE_CODE_CAPABILITIES;

  private readonly startQuery: QueryFn;
  private readonly newSessionId: () => SessionId;
  private readonly processEnv: Readonly<Record<string, string | undefined>>;

  constructor(private readonly deps: ClaudeCodeProviderDeps) {
    this.startQuery = deps.startQuery ?? query;
    this.newSessionId = deps.newSessionId ?? (() => toSessionId(randomUUID()));
    this.processEnv = deps.processEnv ?? process.env;
  }

  async createSession(opts: SessionOptions): Promise<AgentSession> {
    const resumeId = opts.resumeSessionId;
    const sessionId = resumeId ?? this.newSessionId();
    const apiKeyOverride = await this.readApiKeyOverride();

    return new ClaudeCodeSession({
      sessionId,
      clock: this.deps.clock,
      logger: this.deps.logger,
      options: opts,
      baseQueryOptions: this.buildQueryOptions(opts, sessionId, apiKeyOverride),
      startQuery: this.startQuery,
    });
  }

  /**
   * Returns `null` when no override is stored, and also when the keychain read
   * fails. A keychain that is locked or unavailable must degrade to the SDK's own
   * credential chain rather than break the session — the override is an
   * enhancement for teams that inject an explicit key, not the primary path.
   */
  private async readApiKeyOverride(): Promise<string | null> {
    try {
      const stored = await this.deps.secrets.get(ANTHROPIC_API_KEY_SECRET_KEY);
      return stored !== null && stored.length > 0 ? stored : null;
    } catch (error: unknown) {
      this.deps.logger.log('warn', 'could not read the stored API key override', {
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  }

  private buildQueryOptions(
    opts: SessionOptions,
    sessionId: SessionId,
    apiKeyOverride: string | null,
  ): Options {
    const base: Options = { cwd: opts.cwd };

    // `sessionId` and `resume` are mutually exclusive in the SDK unless
    // `forkSession` is set. Pinning our own id on a new session is what makes
    // TARS's `SessionId` and the SDK's session id the same value, so a later
    // `resume` addresses the conversation the SDK actually persisted.
    const identity: Options =
      opts.resumeSessionId !== undefined ? { resume: opts.resumeSessionId } : { sessionId };

    const model: Options = opts.model !== undefined ? { model: opts.model } : {};

    // Appended to the Claude Code preset rather than replacing it: replacing the
    // preset would discard the tool instructions the built-in tools rely on.
    const systemPrompt: Options =
      opts.appendSystemPrompt !== undefined
        ? {
            systemPrompt: {
              type: 'preset',
              preset: 'claude_code',
              append: opts.appendSystemPrompt,
            },
          }
        : {};

    // Mapped from core's own spec rather than passed through, so a user-facing
    // setting is never implicitly bound to an SDK type that can change under it.
    const mcp: Options =
      opts.mcpServers === undefined ? {} : { mcpServers: toSdkMcpServers(opts.mcpServers) };

    // The whole environment is forwarded, not just the key: the subprocess needs
    // PATH and the rest to start at all.
    const env: Options =
      apiKeyOverride !== null
        ? { env: { ...this.processEnv, ANTHROPIC_API_KEY: apiKeyOverride } }
        : {};

    return { ...base, ...identity, ...model, ...systemPrompt, ...mcp, ...env };
  }
}

/**
 * Maps core's MCP spec onto the SDK's.
 *
 * The discriminants differ deliberately: core says `transport`, the SDK says
 * `type`. Keeping them distinct is the point of ADR 0004 — a user-facing setting
 * that spelled the SDK's field names would make an SDK rename a breaking change
 * to everyone's `settings.json`.
 */
function toSdkMcpServers(
  servers: Readonly<Record<string, McpServerSpec>>,
): Record<string, McpServerConfig> {
  const mapped: Record<string, McpServerConfig> = {};
  for (const [name, spec] of Object.entries(servers)) {
    mapped[name] =
      spec.transport === 'stdio'
        ? {
            type: 'stdio',
            command: spec.command,
            ...(spec.args === undefined ? {} : { args: [...spec.args] }),
            ...(spec.env === undefined ? {} : { env: { ...spec.env } }),
          }
        : {
            type: spec.transport,
            url: spec.url,
            ...(spec.headers === undefined ? {} : { headers: { ...spec.headers } }),
          };
  }
  return mapped;
}
