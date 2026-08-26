import type { AgentEvent, ProviderId, SessionId, UserTurn } from '@tars/shared';
import { toTurnId } from '@tars/shared';
import type { ClockPort } from '../ports/clock-port.js';
import type { FileSystemPort } from '../ports/file-system-port.js';
import type { LoggerPort } from '../ports/logger-port.js';
import type { StoragePort } from '../ports/storage-port.js';
import type { Unsubscribe } from '../ports/workspace-port.js';
import type { AgentProvider, AgentSession, SessionOptions } from '../provider/types.js';
import type { RecoveryOutcome, SessionLogRecord } from './event-log.js';
import { SessionEventLog } from './event-log.js';

/**
 * A session as the rest of `core` and the host see it: the provider session plus
 * its durable log plus multi-subscriber fan-out.
 *
 * `AgentSession.events` is single-consumer by contract (Docs/TARS_SPEC.md §4) —
 * two `for await` loops over one stream would each get half the deltas. The
 * manager is that single consumer, and `subscribe` is how everything else watches.
 */
export interface ManagedSession {
  readonly id: SessionId;
  readonly providerId: ProviderId;

  send(turn: UserTurn): void;
  interrupt(): void;

  /** Live events from the moment of subscription. Past events come from `replay`. */
  subscribe(listener: (event: AgentEvent) => void): Unsubscribe;

  /** Persisted events, optionally from a checkpoint offset (§4.3, §6.4). */
  replay(fromSeq?: number): AsyncIterable<SessionLogRecord>;

  /** Offset the next event will occupy — the value a checkpoint stores. */
  readonly logOffset: number;

  /** Resolves once every observed event has reached disk. */
  flush(): Promise<void>;

  /** Idempotent. Stops the provider session and flushes the log. */
  dispose(): Promise<void>;
}

export interface SessionManagerDeps {
  readonly provider: AgentProvider;
  readonly fileSystem: FileSystemPort;
  readonly storage: StoragePort;
  readonly clock: ClockPort;
  readonly logger: LoggerPort;
}

/**
 * Owns session lifecycle and is the sole consumer of every provider event stream.
 *
 * Each session's events are fanned out to subscribers and appended to its
 * append-only log in the same pass, so the persisted order and the order the UI
 * observes cannot diverge (ADR 0006).
 *
 * Isolation is deliberate throughout: a provider that throws mid-stream, or a
 * subscriber that throws while handling an event, must not take down the manager
 * or the other sessions. Both failures are contained, logged, and — for a stream
 * failure — surfaced as an `error` event so the user sees something rather than a
 * conversation that silently stops.
 */
export class SessionManager {
  private readonly sessions = new Map<SessionId, ManagedSessionImpl>();
  private readonly logger: LoggerPort;

  constructor(private readonly deps: SessionManagerDeps) {
    this.logger = deps.logger.child('session-manager');
  }

  get providerId(): ProviderId {
    return this.deps.provider.id;
  }

  /**
   * Opens a session. When resuming, the log is recovered first: a log with a
   * partial trailing record from a crash is truncated to its last complete record
   * before anything appends to it, so `seq` stays contiguous and previously stored
   * checkpoint offsets remain valid.
   */
  async create(opts: SessionOptions): Promise<ManagedSession> {
    const session = await this.deps.provider.createSession(opts);
    const log = new SessionEventLog(
      {
        fileSystem: this.deps.fileSystem,
        storage: this.deps.storage,
        clock: this.deps.clock,
        logger: this.deps.logger,
      },
      session.id,
    );

    let recovery: RecoveryOutcome | null = null;
    if (opts.resumeSessionId !== undefined) {
      recovery = await log.recover();
    }

    const managed = new ManagedSessionImpl(
      session,
      this.deps.provider.id,
      log,
      this.deps.clock,
      this.logger,
      () => {
        this.sessions.delete(session.id);
      },
    );
    this.sessions.set(session.id, managed);

    this.logger.log('info', 'session opened', {
      sessionId: session.id,
      resumed: opts.resumeSessionId !== undefined,
      recoveredRecords: recovery?.records ?? 0,
      truncatedBytes: recovery?.truncatedBytes ?? 0,
    });

    managed.start();
    return managed;
  }

  get(id: SessionId): ManagedSession | null {
    return this.sessions.get(id) ?? null;
  }

  list(): readonly ManagedSession[] {
    return [...this.sessions.values()];
  }

  /** Disposes every session, and every one of them even if some throw. */
  async disposeAll(): Promise<void> {
    const results = await Promise.allSettled(
      [...this.sessions.values()].map((session) => session.dispose()),
    );
    for (const result of results) {
      if (result.status === 'rejected') {
        this.logger.log('error', 'session disposal failed', {
          error: describeError(result.reason),
        });
      }
    }
    this.sessions.clear();
  }
}

class ManagedSessionImpl implements ManagedSession {
  readonly id: SessionId;
  private readonly listeners = new Set<(event: AgentEvent) => void>();
  private consuming: Promise<void> | null = null;
  private disposing: Promise<void> | null = null;
  private lastTurnId = toTurnId('unattributed');

  constructor(
    private readonly session: AgentSession,
    readonly providerId: ProviderId,
    private readonly log: SessionEventLog,
    private readonly clock: ClockPort,
    private readonly logger: LoggerPort,
    private readonly onDisposed: () => void,
  ) {
    this.id = session.id;
  }

  start(): void {
    this.consuming ??= this.consume();
  }

  send(turn: UserTurn): void {
    this.session.send(turn);
  }

  interrupt(): void {
    this.session.interrupt();
  }

  subscribe(listener: (event: AgentEvent) => void): Unsubscribe {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  replay(fromSeq = 0): AsyncIterable<SessionLogRecord> {
    return this.log.replay(fromSeq);
  }

  get logOffset(): number {
    return this.log.nextSeq;
  }

  flush(): Promise<void> {
    return this.log.flush();
  }

  dispose(): Promise<void> {
    this.disposing ??= this.performDispose();
    return this.disposing;
  }

  private async performDispose(): Promise<void> {
    // Disposing the provider session completes `events`, which lets the fan-out
    // loop finish rather than being abandoned mid-iteration.
    this.session.dispose();
    await this.consuming;
    await this.log.flush();
    this.listeners.clear();
    this.onDisposed();
  }

  private async consume(): Promise<void> {
    try {
      for await (const event of this.session.events) {
        this.record(event);
      }
    } catch (error: unknown) {
      this.logger.log('error', 'provider event stream failed', {
        sessionId: this.id,
        error: describeError(error),
      });
      // A provider whose stream rejects leaves the conversation looking frozen.
      // Synthesizing the failure keeps it visible in both the UI and the log.
      this.record({
        type: 'error',
        message: describeError(error),
        code: 'provider_stream_failed',
        retryable: true,
        sessionId: this.id,
        turnId: this.lastTurnId,
        at: this.clock.now(),
      });
    }
  }

  private record(event: AgentEvent): void {
    this.lastTurnId = event.turnId;
    this.log.append(event);
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch (error: unknown) {
        // One bad subscriber must not stop the others or end the fan-out loop.
        this.logger.log('error', 'event subscriber threw', {
          sessionId: this.id,
          error: describeError(error),
        });
      }
    }
  }
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
