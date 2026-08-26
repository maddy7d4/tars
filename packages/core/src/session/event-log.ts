import type { AgentEvent, SessionId } from '@tars/shared';
import type { ClockPort } from '../ports/clock-port.js';
import type { FileSystemPort } from '../ports/file-system-port.js';
import type { LoggerPort } from '../ports/logger-port.js';
import type { StoragePort } from '../ports/storage-port.js';

/**
 * Version tag on every record. ADR 0006 records why it is per-record rather than
 * per-file: the log is durable user data and cannot be reformatted in place, so a
 * format change must be readable alongside the old one.
 */
export const SESSION_LOG_RECORD_VERSION = 1 as const;

/** One line of the JSONL log. */
export interface SessionLogRecord {
  readonly v: typeof SESSION_LOG_RECORD_VERSION;
  /**
   * Position in the log, from zero. This is the "session event offset" a
   * checkpoint references (Docs/TARS_SPEC.md §4.3, §6.4), which is what makes
   * restoring workspace state and rewinding the conversation one operation.
   */
  readonly seq: number;
  /** Milliseconds since the Unix epoch, from `ClockPort` so ordering is testable. */
  readonly at: number;
  /** `at` in ISO-8601 UTC. Derived from `at`, so the clock is read exactly once. */
  readonly atIso: string;
  readonly event: AgentEvent;
}

/** What `recover` found and did. */
export interface RecoveryOutcome {
  /** Records kept. Also the next `seq`, since seq is zero-based and contiguous. */
  readonly records: number;
  /** Bytes discarded from the tail. Non-zero means a crash left a partial write. */
  readonly truncatedBytes: number;
}

export interface SessionEventLogDeps {
  /**
   * Where the bytes go. `StoragePort` owns the *location* (§3.2) but exposes no
   * file operations, so the append itself goes through `FileSystemPort` — which is
   * also the port that declares `appendTextFile` as "appends without rewriting the
   * file — the session event log depends on this".
   */
  readonly fileSystem: FileSystemPort;
  readonly storage: StoragePort;
  readonly clock: ClockPort;
  readonly logger: LoggerPort;
}

/** Absolute path of a session's log. One file per session, under global storage. */
export function sessionLogPath(storage: StoragePort, sessionId: SessionId): string {
  return `${storage.globalStoragePath}/sessions/${sessionId}.jsonl`;
}

/**
 * The append-only JSONL session log of ADR 0006 — the single primitive behind
 * conversation history (replay), checkpoint/restore (offset addressing) and crash
 * recovery (truncate at the last complete record).
 *
 * Two properties are load-bearing.
 *
 * **Writes are batched, not per-event.** `append` is synchronous and returns
 * immediately; events accumulate and one write drains the whole buffer on the next
 * microtask. A file operation per `text_delta` would put a round trip on the token
 * streaming path, which §4.3 explicitly rules out. Batching also makes flushing
 * deterministic in tests: `await log.flush()` needs no fake timers.
 *
 * **Reads never throw on a damaged tail.** Append-only writing means the only
 * possible corruption is a partial trailing line, so `replay` stops at the first
 * line that is not a whole, parseable record and `recover` truncates the file
 * there. A caller opening a conversation after a crash gets the conversation, not
 * an exception.
 */
export class SessionEventLog {
  readonly path: string;

  private readonly buffer: string[] = [];
  private seq = 0;
  private flushing: Promise<void> | null = null;
  private directoryReady: Promise<void> | null = null;
  private lastWriteError: Error | null = null;
  private readonly logger: LoggerPort;

  constructor(
    private readonly deps: SessionEventLogDeps,
    readonly sessionId: SessionId,
  ) {
    this.path = sessionLogPath(deps.storage, sessionId);
    this.logger = deps.logger.child('session-log');
  }

  /** The offset the next appended event will occupy. */
  get nextSeq(): number {
    return this.seq;
  }

  /**
   * The most recent write failure, or `null`. Surfaced rather than thrown: losing
   * persistence must not abort a live conversation, but it must not be silent
   * either, so it is logged at error level and readable here.
   */
  get writeError(): Error | null {
    return this.lastWriteError;
  }

  /** Buffers one event. Returns the offset it will occupy once flushed. */
  append(event: AgentEvent): number {
    const at = this.deps.clock.now();
    const record: SessionLogRecord = {
      v: SESSION_LOG_RECORD_VERSION,
      seq: this.seq,
      at,
      atIso: new Date(at).toISOString(),
      event,
    };
    this.seq += 1;
    this.buffer.push(`${JSON.stringify(record)}\n`);
    this.scheduleFlush();
    return record.seq;
  }

  /** Resolves once everything appended so far has been written. Never rejects. */
  flush(): Promise<void> {
    return this.flushing ?? Promise.resolve();
  }

  private scheduleFlush(): void {
    if (this.flushing !== null) {
      return;
    }
    this.flushing = this.drain();
  }

  private async drain(): Promise<void> {
    // Yielding once lets every append made in this tick join the same write, which
    // is the whole point of batching.
    await Promise.resolve();
    while (this.buffer.length > 0) {
      const batch = this.buffer.splice(0, this.buffer.length).join('');
      try {
        await this.ensureDirectory();
        await this.deps.fileSystem.appendTextFile(this.path, batch);
      } catch (error: unknown) {
        this.lastWriteError = asError(error);
        this.logger.log('error', 'could not append to the session log', {
          path: this.path,
          error: this.lastWriteError.message,
        });
      }
    }
    // Cleared here rather than in a `.finally`: a callback would run a microtask
    // later, and an `append` landing in that gap would be buffered with no drain
    // scheduled and no error — the event would simply never reach disk.
    this.flushing = null;
  }

  private ensureDirectory(): Promise<void> {
    this.directoryReady ??= this.deps.fileSystem.createDirectory(
      this.path.slice(0, this.path.lastIndexOf('/')),
    );
    return this.directoryReady;
  }

  /**
   * Replays the log in order, optionally from an offset.
   *
   * `fromSeq` is what makes a checkpoint's stored offset address a specific point
   * in the conversation, so restore and conversation rewind are the same read.
   */
  async *replay(fromSeq = 0): AsyncIterable<SessionLogRecord> {
    for (const record of await this.readCompleteRecords()) {
      if (record.seq >= fromSeq) {
        yield record;
      }
    }
  }

  /**
   * Discards a partial or unparseable tail so the log is well-formed again, and
   * resets the sequence counter so subsequent appends continue contiguously.
   *
   * Rewriting is the only truncation available: `FileSystemPort` exposes append and
   * whole-file write, not `ftruncate`. That is acceptable here because recovery
   * runs once when a session is opened, never on the streaming path.
   */
  async recover(): Promise<RecoveryOutcome> {
    const raw = await this.readRaw();
    if (raw === null) {
      this.seq = 0;
      return { records: 0, truncatedBytes: 0 };
    }

    const { records, keptText } = scanCompleteRecords(raw);
    const truncatedBytes = raw.length - keptText.length;

    if (truncatedBytes > 0) {
      this.logger.log('warn', 'truncating an incomplete session log tail', {
        path: this.path,
        truncatedBytes,
        records: records.length,
      });
      try {
        await this.deps.fileSystem.writeTextFile(this.path, keptText);
      } catch (error: unknown) {
        // The in-memory outcome is still correct and callers can still replay; a
        // failed rewrite only means the damaged tail is discarded again next time.
        this.logger.log('error', 'could not rewrite the truncated session log', {
          path: this.path,
          error: asError(error).message,
        });
      }
    }

    this.seq = records.length;
    return { records: records.length, truncatedBytes };
  }

  private async readCompleteRecords(): Promise<readonly SessionLogRecord[]> {
    const raw = await this.readRaw();
    if (raw === null) {
      return [];
    }
    return scanCompleteRecords(raw).records;
  }

  /** `null` for an absent or unreadable file — both mean "no history to replay". */
  private async readRaw(): Promise<string | null> {
    try {
      const stat = await this.deps.fileSystem.stat(this.path);
      if (stat === null) {
        return null;
      }
      return await this.deps.fileSystem.readTextFile(this.path);
    } catch (error: unknown) {
      this.logger.log('warn', 'could not read the session log', {
        path: this.path,
        error: asError(error).message,
      });
      return null;
    }
  }
}

/**
 * Splits raw log text into the records that are complete and the exact prefix of
 * text they occupy.
 *
 * "Complete" means newline-terminated, valid JSON, and a recognised record
 * version. Scanning stops at the first line that fails any of those, so a
 * mid-file corruption truncates from that point rather than leaving a hole that
 * would make `seq` non-contiguous and every stored checkpoint offset wrong.
 */
function scanCompleteRecords(raw: string): {
  records: readonly SessionLogRecord[];
  keptText: string;
} {
  const records: SessionLogRecord[] = [];
  let kept = 0;
  let cursor = 0;

  while (cursor < raw.length) {
    const newline = raw.indexOf('\n', cursor);
    if (newline === -1) {
      // No terminator: this is the partial write a crash left behind.
      break;
    }
    const line = raw.slice(cursor, newline);
    const record = parseRecord(line);
    if (record === null) {
      break;
    }
    records.push(record);
    cursor = newline + 1;
    kept = cursor;
  }

  return { records, keptText: raw.slice(0, kept) };
}

function parseRecord(line: string): SessionLogRecord | null {
  if (line.length === 0) {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return null;
  }
  if (!isRecordShape(parsed)) {
    return null;
  }
  return parsed;
}

function isRecordShape(value: unknown): value is SessionLogRecord {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const candidate = value as Record<string, unknown>;
  if (candidate['v'] !== SESSION_LOG_RECORD_VERSION) {
    return false;
  }
  if (typeof candidate['seq'] !== 'number' || typeof candidate['at'] !== 'number') {
    return false;
  }
  if (typeof candidate['atIso'] !== 'string') {
    return false;
  }
  const event = candidate['event'];
  return typeof event === 'object' && event !== null && typeof (event as Record<string, unknown>)['type'] === 'string';
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}
