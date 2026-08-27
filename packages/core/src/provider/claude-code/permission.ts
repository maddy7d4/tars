import type { CanUseTool, PermissionResult } from '@anthropic-ai/claude-agent-sdk';
import type { PermissionPolicy, PermissionRequestEvent } from '@tars/shared';
import type { PermissionDecision } from '../types.js';
import { toJsonValue } from '../../util/json.js';

/**
 * A `permission_request` minus the fields every event shares. The session stamps
 * `sessionId`, `turnId` and `at` and routes the result through `TurnGuard`, so the
 * broker never has to know which turn is live or read the clock.
 */
export type PermissionRequestPayload = Omit<
  PermissionRequestEvent,
  'type' | 'sessionId' | 'turnId' | 'at'
>;

/**
 * Tools whose default policy is `ask` regardless of the session default, per
 * Docs/TARS_SPEC.md §4.2: "Destructive and outward-facing operations (shell
 * commands, file deletion, network writes) default to `ask`."
 *
 * `Bash` covers shell execution and therefore file deletion — the SDK has no
 * delete tool, so `rm` arrives as a Bash command. `Write`, `Edit` and
 * `NotebookEdit` mutate the user's working tree. `WebFetch` and `WebSearch` leave
 * the machine. Read-only tools (`Read`, `Glob`, `Grep`, `TodoWrite`) are absent
 * deliberately: gating them would train the user to approve reflexively, which
 * costs more safety than it buys.
 */
export const DEFAULT_ASK_TOOLS: readonly string[] = [
  'Bash',
  'Write',
  'Edit',
  'NotebookEdit',
  'WebFetch',
  'WebSearch',
];

const DEFAULT_ASK_TOOL_SET: ReadonlySet<string> = new Set(DEFAULT_ASK_TOOLS);

/** MCP tools are third-party code reaching outward; they are gated as a class. */
const MCP_TOOL_PREFIX = 'mcp__';

const POLICY_STRICTNESS: Readonly<Record<PermissionPolicy, number>> = {
  always_allow: 0,
  ask: 1,
  deny: 2,
};

/**
 * Resolves the effective policy for one tool.
 *
 * An explicit per-tool entry is the user's direct instruction and wins outright.
 * Otherwise a default-gated tool takes the *stricter* of the session default and
 * `ask`. Taking the stricter value rather than literally `ask` matters in both
 * directions: a session set to `always_allow` still stops at a shell command, and
 * a session set to `deny` is not loosened into a prompt by this rule.
 */
export function resolveToolPolicy(
  toolName: string,
  sessionDefault: PermissionPolicy,
  overrides: Readonly<Record<string, PermissionPolicy>>,
): PermissionPolicy {
  const explicit = overrides[toolName];
  if (explicit !== undefined) {
    return explicit;
  }
  if (isGatedByDefault(toolName)) {
    return POLICY_STRICTNESS[sessionDefault] >= POLICY_STRICTNESS.ask ? sessionDefault : 'ask';
  }
  return sessionDefault;
}

function isGatedByDefault(toolName: string): boolean {
  return DEFAULT_ASK_TOOL_SET.has(toolName) || toolName.startsWith(MCP_TOOL_PREFIX);
}

/** Collaborators the broker needs. Supplied by `ClaudeCodeSession`. */
export interface PermissionBrokerDeps {
  readonly emit: (request: PermissionRequestPayload) => void;
  readonly defaultPolicy: PermissionPolicy;
  readonly toolPolicies: Readonly<Record<string, PermissionPolicy>>;
  /**
   * Resolves a held request from a user decision. Absent means TARS has no
   * approval channel — a headless session, or a webview that never mounted — in
   * which case a gated tool must be denied rather than allowed.
   */
  readonly resolveDecision?: (requestId: string) => Promise<PermissionDecision>;
}

const DENIED_BY_POLICY =
  'Denied by the workspace permission policy for this tool. Ask the user to change the policy if this tool is genuinely required.';

const NO_APPROVAL_CHANNEL =
  'This tool requires approval, but no approval UI is attached to the session, so it cannot be granted.';

const INTERRUPTED_BEFORE_DECISION = 'The turn was interrupted before the user decided.';

/**
 * Implements the permission flow of Docs/TARS_SPEC.md §4.2 over the SDK's
 * `canUseTool` hook.
 *
 * The SDK calls `canUseTool` and waits on the returned promise, so holding that
 * promise open *is* the gate — there is no separate blocking mechanism to build.
 * The broker emits `permission_request`, waits for a decision, and resolves the
 * promise into the `PermissionResult` the SDK expects.
 *
 * Two behaviours are load-bearing:
 *
 * - `deny` short-circuits without emitting `permission_request`, so a tool the
 *   user has already forbidden never reaches them as a prompt. The SDK still
 *   receives a reason, which the model can read and route around.
 * - the request races the SDK's own `AbortSignal`. Without that, interrupting a
 *   turn while a prompt is outstanding would leave the promise pending forever
 *   and wedge the session; the SDK documents that permission prompts have no
 *   deadline of their own.
 */
export class PermissionBroker {
  /**
   * Tools the user promoted mid-session by answering a prompt with `remember`.
   *
   * Consulted only on the `ask` path, which is what keeps promotion incapable of
   * loosening anything: `deny` — whether from an explicit override or the session
   * default — short-circuits before a prompt is ever emitted, so a denied tool can
   * never reach the point where a grant would be recorded for it.
   *
   * Held on the broker rather than in `deps.toolPolicies` because the broker's
   * lifetime *is* the session's: closing the session drops the grants with it,
   * which is the boundary `PermissionDecision.remember` documents.
   */
  private readonly sessionGrants = new Set<string>();

  constructor(private readonly deps: PermissionBrokerDeps) {}

  policyFor(toolName: string): PermissionPolicy {
    return resolveToolPolicy(toolName, this.deps.defaultPolicy, this.deps.toolPolicies);
  }

  /** True once the user promoted this tool for the session. Exposed for tests and UI. */
  isGrantedForSession(toolName: string): boolean {
    return this.sessionGrants.has(toolName);
  }

  /** Bound so it can be handed to the SDK's `Options.canUseTool` directly. */
  readonly canUseTool: CanUseTool = async (toolName, input, options) => {
    const policy = this.policyFor(toolName);

    if (policy === 'always_allow') {
      return { behavior: 'allow' };
    }
    if (policy === 'deny') {
      return { behavior: 'deny', message: DENIED_BY_POLICY, toolUseID: options.toolUseID };
    }
    if (this.sessionGrants.has(toolName)) {
      return { behavior: 'allow', toolUseID: options.toolUseID };
    }

    const requestId = options.requestId;
    this.deps.emit({
      requestId,
      toolName,
      input: toJsonValue(input),
      affectedPaths: affectedPathsOf(input, options.blockedPath),
      defaultPolicy: policy,
    });

    const resolveDecision = this.deps.resolveDecision;
    if (resolveDecision === undefined) {
      return { behavior: 'deny', message: NO_APPROVAL_CHANNEL, toolUseID: options.toolUseID };
    }

    const decision = await raceAbort(resolveDecision(requestId), options.signal);
    if (decision === null) {
      return {
        behavior: 'deny',
        message: INTERRUPTED_BEFORE_DECISION,
        toolUseID: options.toolUseID,
      };
    }
    if (decision.allow && decision.remember === true) {
      this.sessionGrants.add(toolName);
    }
    return toPermissionResult(decision, options.toolUseID);
  };
}

function toPermissionResult(decision: PermissionDecision, toolUseID: string): PermissionResult {
  if (decision.allow) {
    return { behavior: 'allow', toolUseID };
  }
  // `PermissionResult` requires a message on denial: it is what the model reads,
  // so an empty one would leave the model guessing why the tool failed.
  return {
    behavior: 'deny',
    message: decision.reason ?? 'The user declined this tool invocation.',
    toolUseID,
  };
}

/** Resolves `null` when the signal fires first. */
function raceAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T | null> {
  if (signal.aborted) {
    return Promise.resolve(null);
  }
  return new Promise<T | null>((resolve, reject) => {
    const onAbort = (): void => {
      resolve(null);
    };
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener('abort', onAbort);
        reject(error instanceof Error ? error : new Error(String(error)));
      },
    );
  });
}

/** Input keys the built-in tools use for the path they act on. */
const PATH_KEYS: readonly string[] = ['file_path', 'notebook_path', 'path'];

/**
 * Best-effort extraction of the paths an invocation would touch, for the approval
 * affordance. Best-effort is honest rather than lax: a Bash command's targets are
 * not statically knowable, so the UI shows the command itself and this list stays
 * empty rather than claiming a scope it cannot prove.
 */
function affectedPathsOf(
  input: Record<string, unknown>,
  blockedPath: string | undefined,
): readonly string[] {
  const paths = new Set<string>();
  for (const key of PATH_KEYS) {
    const value = input[key];
    if (typeof value === 'string' && value.length > 0) {
      paths.add(value);
    }
  }
  if (blockedPath !== undefined && blockedPath.length > 0) {
    paths.add(blockedPath);
  }
  return [...paths];
}
