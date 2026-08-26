import type { CanUseTool, PermissionResult } from '@anthropic-ai/claude-agent-sdk';
import type { PermissionPolicy, PermissionRequestEvent, SessionId, TurnId } from '@tars/shared';
import { toSessionId, toTurnId } from '@tars/shared';
import { describe, expect, it } from 'vitest';
import type { PermissionDecision } from '../types.js';
import type { PermissionRequestPayload } from './permission.js';
import { DEFAULT_ASK_TOOLS, PermissionBroker, resolveToolPolicy } from './permission.js';

/**
 * Tests for the permission gate of Docs/TARS_SPEC.md §4.2.
 *
 * This is the security surface of the product: `canUseTool` is the single point
 * where a destructive tool is either held for the user or handed to the model. A
 * regression that silently resolves `always_allow` for `Bash` is the worst thing
 * this codebase can do, so the default-gating invariant is asserted directly and
 * per tool, not inferred from a happy-path scenario.
 */

/** The SDK's own `canUseTool` options object, so a shape change fails typecheck. */
type CanUseToolOptions = Parameters<CanUseTool>[2];

const ALL_POLICIES: readonly PermissionPolicy[] = ['always_allow', 'ask', 'deny'];

const NO_OVERRIDES: Readonly<Record<string, PermissionPolicy>> = {};

interface OptionOverrides {
  readonly requestId?: string;
  readonly toolUseID?: string;
  readonly signal?: AbortSignal;
  readonly blockedPath?: string;
}

function options(overrides: OptionOverrides = {}): CanUseToolOptions {
  const base = {
    signal: overrides.signal ?? new AbortController().signal,
    toolUseID: overrides.toolUseID ?? 'toolu_1',
    requestId: overrides.requestId ?? 'req_1',
  };
  // Built conditionally rather than with `blockedPath: undefined`, because
  // `exactOptionalPropertyTypes` makes an explicit `undefined` a type error.
  return overrides.blockedPath === undefined ? base : { ...base, blockedPath: overrides.blockedPath };
}

/** A promise whose resolution the test controls, standing in for a user decision. */
class Deferred<T> {
  readonly promise: Promise<T>;
  private resolveFn!: (value: T) => void;
  private rejectFn!: (error: Error) => void;

  constructor() {
    this.promise = new Promise<T>((resolve, reject) => {
      this.resolveFn = resolve;
      this.rejectFn = reject;
    });
  }

  resolve(value: T): void {
    this.resolveFn(value);
  }

  reject(error: Error): void {
    this.rejectFn(error);
  }
}

/**
 * The approval channel `ClaudeCodeSession` supplies, as a test double.
 *
 * Requests are held by id, exactly as the real webview round trip holds them, so
 * "two prompts outstanding at once" and "a decision arrives for an id nobody is
 * waiting on" are both expressible.
 */
class ApprovalChannel {
  private readonly pending = new Map<string, Deferred<PermissionDecision>>();

  readonly resolveDecision = (requestId: string): Promise<PermissionDecision> => {
    const deferred = new Deferred<PermissionDecision>();
    this.pending.set(requestId, deferred);
    return deferred.promise;
  };

  get pendingIds(): readonly string[] {
    return [...this.pending.keys()];
  }

  /** Returns whether a request was actually waiting, so stale ids are observable. */
  settle(requestId: string, decision: PermissionDecision): boolean {
    const deferred = this.pending.get(requestId);
    if (deferred === undefined) {
      return false;
    }
    this.pending.delete(requestId);
    deferred.resolve(decision);
    return true;
  }
}

interface Harness {
  readonly broker: PermissionBroker;
  readonly emitted: PermissionRequestPayload[];
  readonly channel: ApprovalChannel;
}

interface HarnessOptions {
  readonly defaultPolicy?: PermissionPolicy;
  readonly toolPolicies?: Readonly<Record<string, PermissionPolicy>>;
  /** `false` models a session with no approval UI attached. */
  readonly withApprovalChannel?: boolean;
}

function harness(config: HarnessOptions = {}): Harness {
  const emitted: PermissionRequestPayload[] = [];
  const channel = new ApprovalChannel();
  const withChannel = config.withApprovalChannel ?? true;
  const broker = new PermissionBroker({
    emit: (request) => {
      emitted.push(request);
    },
    defaultPolicy: config.defaultPolicy ?? 'ask',
    toolPolicies: config.toolPolicies ?? NO_OVERRIDES,
    ...(withChannel ? { resolveDecision: channel.resolveDecision } : {}),
  });
  return { broker, emitted, channel };
}

/** Lets a pending `canUseTool` reach its first await before the test acts on it. */
async function settleMicrotasks(): Promise<void> {
  for (let i = 0; i < 10; i += 1) {
    await Promise.resolve();
  }
}

function denialMessage(result: PermissionResult): string {
  return result.behavior === 'deny' ? result.message : '';
}

/**
 * The SDK's `CanUseTool` type permits a null return, but the broker must always
 * reach a decision — a null here would mean the gate silently produced no answer,
 * which is exactly the failure these tests exist to catch.
 */
function decided(result: PermissionResult | null): PermissionResult {
  if (result === null) {
    throw new Error('permission broker returned no decision');
  }
  return result;
}

describe('DEFAULT_ASK_TOOLS', () => {
  it('is not empty', () => {
    // An empty list would make every assertion below vacuously true while
    // disabling the gate entirely, so its non-emptiness is asserted on its own.
    expect(DEFAULT_ASK_TOOLS.length).toBeGreaterThan(0);
  });

  it('contains the destructive and outward-facing tools named by the spec', () => {
    // §4.2: "Destructive and outward-facing operations (shell commands, file
    // deletion, network writes) default to `ask`." Shell covers deletion — the SDK
    // has no delete tool, so `rm` arrives as a Bash command.
    expect([...DEFAULT_ASK_TOOLS].sort()).toEqual([
      'Bash',
      'Edit',
      'NotebookEdit',
      'WebFetch',
      'WebSearch',
      'Write',
    ]);
  });

  it('omits read-only tools, which must not train reflexive approval', () => {
    for (const readOnly of ['Read', 'Glob', 'Grep', 'TodoWrite']) {
      expect(DEFAULT_ASK_TOOLS).not.toContain(readOnly);
    }
  });
});

describe('resolveToolPolicy', () => {
  it('returns the session default verbatim for an ungated tool', () => {
    for (const policy of ALL_POLICIES) {
      expect(resolveToolPolicy('Read', policy, NO_OVERRIDES)).toBe(policy);
    }
  });

  it('falls back to the session default for an unknown tool name', () => {
    for (const policy of ALL_POLICIES) {
      expect(resolveToolPolicy('SomeToolNobodyHasHeardOf', policy, NO_OVERRIDES)).toBe(policy);
    }
  });

  it('NEVER resolves a default-gated tool to always_allow', () => {
    // The core safety invariant. Asserted per tool, under every session default and
    // with no overrides in play: if this ever passes as `always_allow`, TARS runs a
    // shell command or a network write without asking anyone.
    for (const toolName of DEFAULT_ASK_TOOLS) {
      for (const sessionDefault of ALL_POLICIES) {
        expect(resolveToolPolicy(toolName, sessionDefault, NO_OVERRIDES)).not.toBe('always_allow');
      }
    }
  });

  it('raises a permissive session default to ask for a gated tool', () => {
    expect(resolveToolPolicy('Bash', 'always_allow', NO_OVERRIDES)).toBe('ask');
    expect(resolveToolPolicy('Write', 'always_allow', NO_OVERRIDES)).toBe('ask');
  });

  it('keeps ask as ask and does not loosen deny for a gated tool', () => {
    expect(resolveToolPolicy('Bash', 'ask', NO_OVERRIDES)).toBe('ask');
    expect(resolveToolPolicy('Bash', 'deny', NO_OVERRIDES)).toBe('deny');
  });

  it('gates every MCP tool as a class', () => {
    expect(resolveToolPolicy('mcp__github__create_issue', 'always_allow', NO_OVERRIDES)).toBe('ask');
    expect(resolveToolPolicy('mcp__github__create_issue', 'deny', NO_OVERRIDES)).toBe('deny');
  });

  it('lets an explicit per-tool entry override the built-in gate', () => {
    // The user's direct instruction wins, including the dangerous direction — that
    // is a deliberate, explicitly configured choice rather than a silent default.
    expect(resolveToolPolicy('Bash', 'ask', { Bash: 'always_allow' })).toBe('always_allow');
    expect(resolveToolPolicy('Bash', 'always_allow', { Bash: 'deny' })).toBe('deny');
    expect(resolveToolPolicy('Bash', 'deny', { Bash: 'ask' })).toBe('ask');
  });

  it('lets an explicit per-tool entry override the session default for an ungated tool', () => {
    expect(resolveToolPolicy('Read', 'always_allow', { Read: 'deny' })).toBe('deny');
    expect(resolveToolPolicy('Read', 'ask', { Read: 'always_allow' })).toBe('always_allow');
  });

  it('applies an override only to the tool it names', () => {
    const overrides: Readonly<Record<string, PermissionPolicy>> = { Read: 'deny' };
    expect(resolveToolPolicy('Grep', 'always_allow', overrides)).toBe('always_allow');
    expect(resolveToolPolicy('Bash', 'always_allow', overrides)).toBe('ask');
  });
});

describe('PermissionBroker.policyFor', () => {
  it('reflects the configured default and overrides', () => {
    const { broker } = harness({ defaultPolicy: 'always_allow', toolPolicies: { Read: 'deny' } });

    expect(broker.policyFor('Grep')).toBe('always_allow');
    expect(broker.policyFor('Read')).toBe('deny');
    expect(broker.policyFor('Bash')).toBe('ask');
  });
});

describe('PermissionBroker.canUseTool', () => {
  it('allows an always_allow tool without prompting', async () => {
    const { broker, emitted } = harness({ defaultPolicy: 'always_allow' });

    const result = decided(await broker.canUseTool('Read', { file_path: '/w/a.ts' }, options()));

    expect(result).toEqual({ behavior: 'allow' });
    expect(emitted).toEqual([]);
  });

  it('denies a deny-policy tool without ever prompting the user', async () => {
    const { broker, emitted } = harness({ toolPolicies: { Bash: 'deny' } });

    const result = decided(await broker.canUseTool('Bash', { command: 'rm -rf /' }, options()));

    expect(result.behavior).toBe('deny');
    expect(denialMessage(result)).toContain('workspace permission policy');
    // A tool the user already forbade must never reach them as a prompt.
    expect(emitted).toEqual([]);
  });

  it('emits a permission request carrying the tool, its input and affected paths', async () => {
    const { broker, emitted, channel } = harness();

    const pending = broker.canUseTool(
      'Write',
      { file_path: '/w/src/app.ts', content: 'export const x = 1;' },
      options({ requestId: 'req_write', toolUseID: 'toolu_write' }),
    );
    await settleMicrotasks();

    expect(emitted).toEqual([
      {
        requestId: 'req_write',
        toolName: 'Write',
        input: { file_path: '/w/src/app.ts', content: 'export const x = 1;' },
        affectedPaths: ['/w/src/app.ts'],
        defaultPolicy: 'ask',
      },
    ]);

    channel.settle('req_write', { allow: true });
    await pending;
  });

  it('produces a payload that composes into a complete PermissionRequestEvent', async () => {
    const { broker, emitted, channel } = harness();
    const sessionId: SessionId = toSessionId('s-1');
    const turnId: TurnId = toTurnId('t-1');

    const pending = broker.canUseTool('Bash', { command: 'ls' }, options({ requestId: 'req_ls' }));
    await settleMicrotasks();

    const [payload] = emitted;
    expect(payload).toBeDefined();
    if (payload === undefined) {
      throw new Error('expected a permission request payload');
    }
    // The session stamps the shared fields; this is the assertion that the payload
    // is exactly the rest of the event, with nothing missing and nothing extra.
    const event: PermissionRequestEvent = {
      type: 'permission_request',
      sessionId,
      turnId,
      at: 1_700_000_000_000,
      ...payload,
    };
    expect(event).toEqual({
      type: 'permission_request',
      sessionId,
      turnId,
      at: 1_700_000_000_000,
      requestId: 'req_ls',
      toolName: 'Bash',
      input: { command: 'ls' },
      affectedPaths: [],
      defaultPolicy: 'ask',
    });

    channel.settle('req_ls', { allow: false });
    await pending;
  });

  it('reports a blocked path alongside the input paths, without duplicates', async () => {
    const { broker, emitted, channel } = harness();

    const pending = broker.canUseTool(
      'Edit',
      { file_path: '/w/a.ts', path: '/w/a.ts', notebook_path: '/w/nb.ipynb' },
      options({ requestId: 'req_edit', blockedPath: '/outside/secret.env' }),
    );
    await settleMicrotasks();

    expect(emitted[0]?.affectedPaths).toEqual(['/w/a.ts', '/w/nb.ipynb', '/outside/secret.env']);

    channel.settle('req_edit', { allow: false });
    await pending;
  });

  it('leaves affected paths empty for a Bash command rather than guessing', async () => {
    const { broker, emitted, channel } = harness();

    const pending = broker.canUseTool(
      'Bash',
      { command: 'rm -rf /w/build' },
      options({ requestId: 'req_bash' }),
    );
    await settleMicrotasks();

    expect(emitted[0]?.affectedPaths).toEqual([]);

    channel.settle('req_bash', { allow: false });
    await pending;
  });

  it('resolves as allowed once the user approves', async () => {
    const { broker, channel } = harness();

    const pending = broker.canUseTool('Bash', { command: 'ls' }, options({ requestId: 'req_a' }));
    await settleMicrotasks();
    expect(channel.pendingIds).toEqual(['req_a']);

    channel.settle('req_a', { allow: true });

    expect(await pending).toEqual({ behavior: 'allow', toolUseID: 'toolu_1' });
  });

  it('carries the denial reason through to the SDK result', async () => {
    const { broker, channel } = harness();

    const pending = broker.canUseTool(
      'Bash',
      { command: 'curl evil.example' },
      options({ requestId: 'req_b', toolUseID: 'toolu_b' }),
    );
    await settleMicrotasks();
    channel.settle('req_b', { allow: false, reason: 'That would exfiltrate the repo.' });

    expect(await pending).toEqual({
      behavior: 'deny',
      message: 'That would exfiltrate the repo.',
      toolUseID: 'toolu_b',
    });
  });

  it('substitutes a readable message when the user gives no reason', async () => {
    const { broker, channel } = harness();

    const pending = broker.canUseTool('Bash', { command: 'ls' }, options({ requestId: 'req_c' }));
    await settleMicrotasks();
    channel.settle('req_c', { allow: false });

    const result = decided(await pending);
    expect(result.behavior).toBe('deny');
    // Empty would leave the model guessing why the tool failed.
    expect(denialMessage(result).length).toBeGreaterThan(0);
    expect(denialMessage(result)).toContain('declined');
  });

  it('denies rather than allows when no approval channel is attached', async () => {
    const { broker, emitted } = harness({ withApprovalChannel: false });

    const result = decided(await broker.canUseTool('Bash', { command: 'ls' }, options()));

    // Fail closed: a headless session, or a webview that never mounted, must not
    // become an implicit "yes".
    expect(result.behavior).toBe('deny');
    expect(denialMessage(result)).toContain('no approval UI');
    expect(emitted).toHaveLength(1);
  });

  it('keeps concurrent requests independent and resolves them out of order', async () => {
    const { broker, emitted, channel } = harness();

    const bash = broker.canUseTool(
      'Bash',
      { command: 'git push' },
      options({ requestId: 'req_bash', toolUseID: 'toolu_bash' }),
    );
    const write = broker.canUseTool(
      'Write',
      { file_path: '/w/b.ts', content: 'b' },
      options({ requestId: 'req_write', toolUseID: 'toolu_write' }),
    );
    await settleMicrotasks();

    expect(emitted.map((request) => request.requestId)).toEqual(['req_bash', 'req_write']);
    expect(channel.pendingIds).toEqual(['req_bash', 'req_write']);

    // Resolved in reverse order, with opposite decisions: cross-wiring would show
    // up as the wrong behavior or the wrong toolUseID on one of them.
    channel.settle('req_write', { allow: true });
    channel.settle('req_bash', { allow: false, reason: 'not now' });

    expect(await write).toEqual({ behavior: 'allow', toolUseID: 'toolu_write' });
    expect(await bash).toEqual({
      behavior: 'deny',
      message: 'not now',
      toolUseID: 'toolu_bash',
    });
  });

  it('ignores a decision for an unknown or stale request id', async () => {
    const { broker, channel } = harness();

    const pending = broker.canUseTool('Bash', { command: 'ls' }, options({ requestId: 'req_live' }));
    await settleMicrotasks();

    expect(channel.settle('req_never_existed', { allow: true })).toBe(false);

    // The live request is untouched by the stale decision and still resolves on its
    // own answer — a stale id must never satisfy a different prompt.
    channel.settle('req_live', { allow: false, reason: 'no' });
    expect(await pending).toEqual({
      behavior: 'deny',
      message: 'no',
      toolUseID: 'toolu_1',
    });

    // A second decision for an id already settled is a no-op, not a crash.
    expect(channel.settle('req_live', { allow: true })).toBe(false);
  });

  it('denies a pending request when the turn is interrupted', async () => {
    const controller = new AbortController();
    const { broker } = harness();

    const pending = broker.canUseTool(
      'Bash',
      { command: 'sleep 100' },
      options({ requestId: 'req_int', toolUseID: 'toolu_int', signal: controller.signal }),
    );
    await settleMicrotasks();

    // Teardown while a prompt is outstanding. Without the abort race this promise
    // would stay pending forever and wedge the session.
    controller.abort();

    expect(await pending).toEqual({
      behavior: 'deny',
      message: 'The turn was interrupted before the user decided.',
      toolUseID: 'toolu_int',
    });
  });

  it('denies immediately when the signal is already aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    const { broker } = harness();

    const result = decided(await broker.canUseTool(
      'Bash',
      { command: 'ls' },
      options({ signal: controller.signal }),
    ));

    expect(result.behavior).toBe('deny');
    expect(denialMessage(result)).toContain('interrupted');
  });

  it('leaves no dangling promise when a decision arrives after an interrupt', async () => {
    const controller = new AbortController();
    const { broker, channel } = harness();

    const pending = broker.canUseTool(
      'Bash',
      { command: 'ls' },
      options({ requestId: 'req_late', signal: controller.signal }),
    );
    await settleMicrotasks();
    controller.abort();
    expect(decided(await pending).behavior).toBe('deny');

    // A late user click on a torn-down prompt must be inert.
    expect(channel.settle('req_late', { allow: true })).toBe(true);
    await settleMicrotasks();
  });

  it('propagates an approval-channel failure instead of hanging', async () => {
    const emitted: PermissionRequestPayload[] = [];
    const broker = new PermissionBroker({
      emit: (request) => {
        emitted.push(request);
      },
      defaultPolicy: 'ask',
      toolPolicies: NO_OVERRIDES,
      resolveDecision: () => Promise.reject(new Error('webview disconnected')),
    });

    await expect(broker.canUseTool('Bash', { command: 'ls' }, options())).rejects.toThrow(
      'webview disconnected',
    );
    expect(emitted).toHaveLength(1);
  });

  it('gates a destructive tool end to end even when the session default is always_allow', async () => {
    // The scenario the whole file exists for: a maximally permissive session still
    // stops at a shell command and waits for a human.
    const { broker, emitted, channel } = harness({ defaultPolicy: 'always_allow' });

    const pending = broker.canUseTool(
      'Bash',
      { command: 'rm -rf node_modules' },
      options({ requestId: 'req_destructive' }),
    );
    await settleMicrotasks();

    expect(emitted).toHaveLength(1);
    expect(emitted[0]?.defaultPolicy).toBe('ask');

    channel.settle('req_destructive', { allow: false, reason: 'ask me first' });
    expect(decided(await pending).behavior).toBe('deny');
  });
});
