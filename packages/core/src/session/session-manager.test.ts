import type { AgentEvent, ProviderId, SessionId, UserTurn } from '@tars/shared';
import { toProviderId, toSessionId, toTurnId } from '@tars/shared';
import { describe, expect, it } from 'vitest';
import type { AgentProvider, AgentSession, ProviderCapabilities, SessionOptions } from '../provider/types.js';
import { BufferLogger, FakeClock, MemoryFileSystem, MemoryStorage } from '../testing/fakes.js';
import { AsyncQueue } from '../util/async-queue.js';
import { SessionManager } from './session-manager.js';

/**
 * The manager is the *sole* consumer of every provider event stream
 * (Docs/TARS_SPEC.md §4), so the invariants that matter here are the ones a
 * second consumer would break: persisted order must equal observed order, one
 * failing subscriber must not silence the others, and a provider stream that
 * rejects must surface as an `error` event rather than a conversation that
 * simply stops.
 */

const T0 = 1_700_000_000_000;
const PROVIDER = toProviderId('fake-provider');
const TURN = toTurnId('turn-1');

/** Yields to the event loop so the manager's `for await` fan-out loop advances. */
function tick(): Promise<void> {
  return new Promise<void>((resolve) => setImmediate(resolve));
}

function textDelta(sessionId: SessionId, text: string, at: number): AgentEvent {
  return { type: 'text_delta', text, sessionId, turnId: TURN, at };
}

/** A provider session whose event stream the test drives by hand. */
class FakeAgentSession implements AgentSession {
  readonly queue = new AsyncQueue<AgentEvent>();
  sent: UserTurn[] = [];
  interrupts = 0;
  disposals = 0;

  constructor(readonly id: SessionId) {}

  send(turn: UserTurn): void {
    this.sent.push(turn);
  }

  interrupt(): void {
    this.interrupts += 1;
  }

  get events(): AsyncIterable<AgentEvent> {
    return this.queue;
  }

  dispose(): void {
    this.disposals += 1;
    this.queue.close();
  }
}

/** A session whose stream rejects, to exercise the synthesized-error path. */
class FailingAgentSession implements AgentSession {
  disposals = 0;

  constructor(
    readonly id: SessionId,
    private readonly failure: Error,
  ) {}

  send(): void {}
  interrupt(): void {}

  get events(): AsyncIterable<AgentEvent> {
    const failure = this.failure;
    // Not a generator: a generator with no `yield` is a lint error, and the point
    // here is a stream that rejects on first pull rather than one that yields.
    return {
      [Symbol.asyncIterator]: (): AsyncIterator<AgentEvent> => ({
        next: () => Promise.reject(failure),
      }),
    };
  }

  dispose(): void {
    this.disposals += 1;
  }
}

const CAPABILITIES: ProviderCapabilities = {
  streaming: true,
  thinking: true,
  subagents: false,
  mcp: false,
  permissionGating: true,
  sessionResume: true,
};

class FakeProvider implements AgentProvider {
  readonly id: ProviderId = PROVIDER;
  readonly displayName = 'Fake Provider';
  readonly capabilities = CAPABILITIES;
  readonly created: FakeAgentSession[] = [];
  private counter = 0;

  createSession(): Promise<AgentSession> {
    this.counter += 1;
    const session = new FakeAgentSession(toSessionId(`session-${String(this.counter)}`));
    this.created.push(session);
    return Promise.resolve(session);
  }
}

interface Harness {
  readonly manager: SessionManager;
  readonly provider: FakeProvider;
  readonly logger: BufferLogger;
}

function harness(provider: AgentProvider = new FakeProvider()): Harness {
  const logger = new BufferLogger();
  const manager = new SessionManager({
    provider,
    fileSystem: new MemoryFileSystem(),
    storage: new MemoryStorage(),
    clock: new FakeClock(T0),
    logger,
  });
  return { manager, provider: provider as FakeProvider, logger };
}

const OPTIONS: SessionOptions = {
  cwd: '/workspace',
  permissionPolicy: 'ask',
};

describe('SessionManager lifecycle', () => {
  it('exposes the provider id', () => {
    const { manager } = harness();
    expect(manager.providerId).toBe(PROVIDER);
  });

  it('registers a created session and makes it retrievable', async () => {
    const { manager } = harness();
    const session = await manager.create(OPTIONS);

    expect(manager.get(session.id)).toBe(session);
    expect(manager.list()).toEqual([session]);
    expect(session.providerId).toBe(PROVIDER);
  });

  it('returns null for an unknown session id', () => {
    const { manager } = harness();
    expect(manager.get(toSessionId('never-created'))).toBeNull();
  });

  it('gives concurrent sessions distinct ids and tracks them all', async () => {
    const { manager } = harness();
    const a = await manager.create(OPTIONS);
    const b = await manager.create(OPTIONS);

    expect(a.id).not.toBe(b.id);
    expect(manager.list()).toHaveLength(2);
  });

  it('delegates send and interrupt to the provider session', async () => {
    const { manager, provider } = harness();
    const session = await manager.create(OPTIONS);
    const turn: UserTurn = { id: TURN, text: 'hello', context: [] };

    session.send(turn);
    session.interrupt();

    expect(provider.created[0]?.sent).toEqual([turn]);
    expect(provider.created[0]?.interrupts).toBe(1);
  });
});

describe('SessionManager fan-out', () => {
  it('delivers live events to every subscriber', async () => {
    const { manager, provider } = harness();
    const session = await manager.create(OPTIONS);
    const first: AgentEvent[] = [];
    const second: AgentEvent[] = [];
    session.subscribe((event) => first.push(event));
    session.subscribe((event) => second.push(event));

    provider.created[0]?.queue.push(textDelta(session.id, 'a', T0));
    await tick();

    expect(first.map((e) => e.type)).toEqual(['text_delta']);
    expect(second).toEqual(first);
  });

  it('stops delivering after unsubscribe', async () => {
    const { manager, provider } = harness();
    const session = await manager.create(OPTIONS);
    const seen: AgentEvent[] = [];
    const unsubscribe = session.subscribe((event) => seen.push(event));

    provider.created[0]?.queue.push(textDelta(session.id, 'a', T0));
    await tick();
    unsubscribe();
    provider.created[0]?.queue.push(textDelta(session.id, 'b', T0 + 1));
    await tick();

    expect(seen).toHaveLength(1);
  });

  it('persists observed events in the order subscribers saw them', async () => {
    const { manager, provider } = harness();
    const session = await manager.create(OPTIONS);
    const seen: string[] = [];
    session.subscribe((event) => {
      if (event.type === 'text_delta') seen.push(event.text);
    });

    for (const text of ['a', 'b', 'c']) {
      provider.created[0]?.queue.push(textDelta(session.id, text, T0));
    }
    await tick();
    await session.flush();

    const persisted: string[] = [];
    for await (const record of session.replay()) {
      if (record.event.type === 'text_delta') persisted.push(record.event.text);
    }

    expect(seen).toEqual(['a', 'b', 'c']);
    expect(persisted).toEqual(seen);
  });

  it('advances logOffset as events are recorded', async () => {
    const { manager, provider } = harness();
    const session = await manager.create(OPTIONS);
    const before = session.logOffset;

    provider.created[0]?.queue.push(textDelta(session.id, 'a', T0));
    provider.created[0]?.queue.push(textDelta(session.id, 'b', T0));
    await tick();

    expect(session.logOffset).toBe(before + 2);
  });

  it('contains a throwing subscriber so others still receive the event', async () => {
    const { manager, provider, logger } = harness();
    const session = await manager.create(OPTIONS);
    const survivor: AgentEvent[] = [];
    session.subscribe(() => {
      throw new Error('subscriber exploded');
    });
    session.subscribe((event) => survivor.push(event));

    provider.created[0]?.queue.push(textDelta(session.id, 'a', T0));
    provider.created[0]?.queue.push(textDelta(session.id, 'b', T0 + 1));
    await tick();

    expect(survivor).toHaveLength(2);
    expect(logger.records.some((r) => r.message === 'event subscriber threw')).toBe(true);
  });

  it('keeps sessions isolated from one another', async () => {
    const { manager, provider } = harness();
    const a = await manager.create(OPTIONS);
    const b = await manager.create(OPTIONS);
    const seenA: AgentEvent[] = [];
    const seenB: AgentEvent[] = [];
    a.subscribe((event) => seenA.push(event));
    b.subscribe((event) => seenB.push(event));

    provider.created[0]?.queue.push(textDelta(a.id, 'for-a', T0));
    await tick();

    expect(seenA).toHaveLength(1);
    expect(seenB).toHaveLength(0);
  });
});

describe('SessionManager stream failure', () => {
  it('synthesizes an error event when the provider stream rejects', async () => {
    const failing = new FailingAgentSession(toSessionId('session-fail'), new Error('stream died'));
    const provider: AgentProvider = {
      id: PROVIDER,
      displayName: 'Failing Provider',
      capabilities: CAPABILITIES,
      createSession: () => Promise.resolve(failing),
    };
    const logger = new BufferLogger();
    const manager = new SessionManager({
      provider,
      fileSystem: new MemoryFileSystem(),
      storage: new MemoryStorage(),
      clock: new FakeClock(T0),
      logger,
    });

    const session = await manager.create(OPTIONS);
    await tick();
    await session.flush();

    const events: AgentEvent[] = [];
    for await (const record of session.replay()) events.push(record.event);

    const error = events.find((e) => e.type === 'error');
    expect(error).toBeDefined();
    if (error?.type === 'error') {
      expect(error.message).toBe('stream died');
      expect(error.code).toBe('provider_stream_failed');
      expect(error.retryable).toBe(true);
    }
    expect(logger.records.some((r) => r.message === 'provider event stream failed')).toBe(true);
  });
});

describe('SessionManager disposal', () => {
  it('disposes the provider session and deregisters it', async () => {
    const { manager, provider } = harness();
    const session = await manager.create(OPTIONS);

    await session.dispose();

    expect(provider.created[0]?.disposals).toBe(1);
    expect(manager.get(session.id)).toBeNull();
    expect(manager.list()).toHaveLength(0);
  });

  it('is idempotent across repeated and concurrent dispose calls', async () => {
    const { manager, provider } = harness();
    const session = await manager.create(OPTIONS);

    await Promise.all([session.dispose(), session.dispose()]);
    await session.dispose();

    expect(provider.created[0]?.disposals).toBe(1);
  });

  it('leaves other sessions working after one is disposed', async () => {
    const { manager, provider } = harness();
    const a = await manager.create(OPTIONS);
    const b = await manager.create(OPTIONS);
    const seenB: AgentEvent[] = [];
    b.subscribe((event) => seenB.push(event));

    await a.dispose();
    provider.created[1]?.queue.push(textDelta(b.id, 'still alive', T0));
    await tick();

    expect(manager.get(b.id)).toBe(b);
    expect(seenB).toHaveLength(1);
  });

  it('disposeAll empties the registry', async () => {
    const { manager } = harness();
    await manager.create(OPTIONS);
    await manager.create(OPTIONS);

    await manager.disposeAll();

    expect(manager.list()).toHaveLength(0);
  });

  it('disposeAll disposes every session even when one throws', async () => {
    let created = 0;
    const good = new FakeAgentSession(toSessionId('session-good'));
    const provider: AgentProvider = {
      id: PROVIDER,
      displayName: 'Mixed Provider',
      capabilities: CAPABILITIES,
      createSession: () => {
        created += 1;
        if (created === 1) {
          const bad = new FakeAgentSession(toSessionId('session-bad'));
          bad.dispose = (): void => {
            throw new Error('disposal exploded');
          };
          return Promise.resolve(bad);
        }
        return Promise.resolve(good);
      },
    };
    const logger = new BufferLogger();
    const manager = new SessionManager({
      provider,
      fileSystem: new MemoryFileSystem(),
      storage: new MemoryStorage(),
      clock: new FakeClock(T0),
      logger,
    });
    await manager.create(OPTIONS);
    await manager.create(OPTIONS);

    await manager.disposeAll();

    expect(good.disposals).toBe(1);
    expect(manager.list()).toHaveLength(0);
    expect(logger.records.some((r) => r.message === 'session disposal failed')).toBe(true);
  });
});
