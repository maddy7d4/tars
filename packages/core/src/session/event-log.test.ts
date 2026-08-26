import type { AgentEvent, SessionId, TextDeltaEvent, TurnEndEvent, TurnStartEvent, UsageEvent } from '@tars/shared';
import { toSessionId, toTurnId } from '@tars/shared';
import { describe, expect, it } from 'vitest';
import { BufferLogger, FakeClock, MemoryFileSystem, MemoryStorage } from '../testing/fakes.js';
import type { SessionLogRecord } from './event-log.js';
import { SESSION_LOG_RECORD_VERSION, SessionEventLog, sessionLogPath } from './event-log.js';

/**
 * The append-only JSONL log is the single persistence primitive behind
 * conversation history, checkpoint/restore and crash recovery
 * (Docs/TARS_SPEC.md §4.3, §6.4), so the crash cases below are the point of this
 * file: a log whose tail is a half-written line must still yield the whole
 * conversation.
 */

const SESSION = toSessionId('session-abc');
const TURN = toTurnId('turn-1');

/** Fixed epoch the `FakeClock` starts at, so every timestamp assertion is literal. */
const T0 = 1_700_000_000_000;

/**
 * Counts writes so the batching contract of §4.3 — one file operation per tick,
 * not one per `text_delta` — is asserted rather than assumed.
 */
class CountingFileSystem extends MemoryFileSystem {
  appendCalls = 0;
  writeCalls = 0;

  override appendTextFile(path: string, content: string): Promise<void> {
    this.appendCalls += 1;
    return super.appendTextFile(path, content);
  }

  override writeTextFile(path: string, content: string): Promise<void> {
    this.writeCalls += 1;
    return super.writeTextFile(path, content);
  }
}

interface Harness {
  readonly fs: CountingFileSystem;
  readonly storage: MemoryStorage;
  readonly clock: FakeClock;
  readonly logger: BufferLogger;
  readonly log: SessionEventLog;
  readonly path: string;
}

function harness(sessionId: SessionId = SESSION): Harness {
  const fs = new CountingFileSystem();
  const storage = new MemoryStorage();
  const clock = new FakeClock(T0);
  const logger = new BufferLogger();
  const log = new SessionEventLog({ fileSystem: fs, storage, clock, logger }, sessionId);
  return { fs, storage, clock, logger, log, path: log.path };
}

function turnStart(at: number): TurnStartEvent {
  return { type: 'turn_start', sessionId: SESSION, turnId: TURN, at };
}

function textDelta(text: string, at: number): TextDeltaEvent {
  return { type: 'text_delta', sessionId: SESSION, turnId: TURN, at, text };
}

function usage(at: number): UsageEvent {
  return {
    type: 'usage',
    sessionId: SESSION,
    turnId: TURN,
    at,
    inputTokens: 12,
    outputTokens: 34,
    cacheReadTokens: 0,
    cacheCreationTokens: 5,
  };
}

function turnEnd(at: number): TurnEndEvent {
  return { type: 'turn_end', sessionId: SESSION, turnId: TURN, at, reason: 'completed' };
}

/** Builds one well-formed, newline-terminated line exactly as `append` would. */
function line(seq: number, event: AgentEvent, at: number = T0): string {
  const record: SessionLogRecord = {
    v: SESSION_LOG_RECORD_VERSION,
    seq,
    at,
    atIso: new Date(at).toISOString(),
    event,
  };
  return `${JSON.stringify(record)}\n`;
}

/** Same as `line`, but with an arbitrary `v` — for the future-version case. */
function lineWithVersion(v: number, seq: number, event: AgentEvent, at: number = T0): string {
  return `${JSON.stringify({ v, seq, at, atIso: new Date(at).toISOString(), event })}\n`;
}

function parseLine(text: string): SessionLogRecord {
  return JSON.parse(text) as SessionLogRecord;
}

function nonEmptyLines(raw: string): readonly string[] {
  return raw.split('\n').filter((candidate) => candidate.length > 0);
}

async function collect(log: SessionEventLog, fromSeq?: number): Promise<readonly SessionLogRecord[]> {
  const out: SessionLogRecord[] = [];
  for await (const record of log.replay(fromSeq)) {
    out.push(record);
  }
  return out;
}

describe('sessionLogPath', () => {
  it('composes one file per session under the global storage root', () => {
    const storage = new MemoryStorage('/global');

    expect(sessionLogPath(storage, SESSION)).toBe('/global/sessions/session-abc.jsonl');
  });

  it('follows the storage root rather than hard-coding it', () => {
    const storage = new MemoryStorage('/home/u/.vscode/tars', '/ws');

    expect(sessionLogPath(storage, toSessionId('s2'))).toBe(
      '/home/u/.vscode/tars/sessions/s2.jsonl',
    );
  });

  it('is the path the log instance writes to', () => {
    const { log } = harness();

    expect(log.path).toBe('/global/sessions/session-abc.jsonl');
    expect(log.sessionId).toBe(SESSION);
  });
});

describe('SessionEventLog append', () => {
  it('writes one JSON object per line, newline-terminated', async () => {
    const { fs, log, path } = harness();

    log.append(turnStart(T0));
    log.append(textDelta('hi', T0));
    await log.flush();

    const raw = fs.files.get(path);
    expect(raw).toBeDefined();
    expect(raw?.endsWith('\n')).toBe(true);
    expect(nonEmptyLines(raw ?? '')).toHaveLength(2);
    for (const text of nonEmptyLines(raw ?? '')) {
      expect(text.includes('\n')).toBe(false);
      expect(() => {
        JSON.parse(text);
      }).not.toThrow();
    }
  });

  it('stamps every record with the record version', async () => {
    const { fs, log, path } = harness();

    log.append(turnStart(T0));
    log.append(turnEnd(T0));
    await log.flush();

    const versions = nonEmptyLines(fs.files.get(path) ?? '').map((text) => parseLine(text).v);
    expect(versions).toEqual([SESSION_LOG_RECORD_VERSION, SESSION_LOG_RECORD_VERSION]);
    expect(SESSION_LOG_RECORD_VERSION).toBe(1);
  });

  it('round-trips events back to values equal to the originals', async () => {
    const { fs, log, path } = harness();
    const events: readonly AgentEvent[] = [
      turnStart(T0),
      textDelta('hello "world"\nsecond line', T0),
      usage(T0),
      turnEnd(T0),
    ];

    for (const event of events) {
      log.append(event);
    }
    await log.flush();

    const parsed = nonEmptyLines(fs.files.get(path) ?? '').map((text) => parseLine(text).event);
    expect(parsed).toEqual(events);
  });

  it('takes the timestamp from the clock and derives atIso from it', async () => {
    const { fs, clock, log, path } = harness();

    log.append(turnStart(T0));
    await log.flush();
    clock.advance(2_500);
    log.append(turnEnd(T0));
    await log.flush();

    const records = nonEmptyLines(fs.files.get(path) ?? '').map(parseLine);
    expect(records.map((record) => record.at)).toEqual([T0, T0 + 2_500]);
    expect(records.map((record) => record.atIso)).toEqual([
      new Date(T0).toISOString(),
      new Date(T0 + 2_500).toISOString(),
    ]);
  });

  it('returns the offset the event will occupy and advances nextSeq', () => {
    const { log } = harness();

    expect(log.nextSeq).toBe(0);
    expect(log.append(turnStart(T0))).toBe(0);
    expect(log.nextSeq).toBe(1);
    expect(log.append(textDelta('a', T0))).toBe(1);
    expect(log.append(turnEnd(T0))).toBe(2);
    expect(log.nextSeq).toBe(3);
  });

  it('keeps order and contiguous sequence numbers across many appends', async () => {
    const { fs, log, path } = harness();

    for (let index = 0; index < 50; index += 1) {
      log.append(textDelta(`chunk-${String(index)}`, T0));
    }
    await log.flush();

    const records = nonEmptyLines(fs.files.get(path) ?? '').map(parseLine);
    expect(records).toHaveLength(50);
    expect(records.map((record) => record.seq)).toEqual(
      Array.from({ length: 50 }, (_unused, index) => index),
    );
    expect(records.map((record) => (record.event as TextDeltaEvent).text)).toEqual(
      Array.from({ length: 50 }, (_unused, index) => `chunk-${String(index)}`),
    );
  });

  it('batches every append made in one tick into a single file operation', async () => {
    const { fs, log } = harness();

    log.append(turnStart(T0));
    log.append(textDelta('a', T0));
    log.append(textDelta('b', T0));
    await log.flush();

    // §4.3 rules out a round trip per token: three events, one write.
    expect(fs.appendCalls).toBe(1);
  });

  it('starts a new batch for appends made after a flush', async () => {
    const { fs, log } = harness();

    log.append(turnStart(T0));
    await log.flush();
    log.append(turnEnd(T0));
    await log.flush();

    expect(fs.appendCalls).toBe(2);
  });

  it('creates the sessions directory exactly once', async () => {
    const { fs, log } = harness();

    log.append(turnStart(T0));
    await log.flush();
    log.append(turnEnd(T0));
    await log.flush();

    expect([...fs.directories]).toEqual(['/global/sessions']);
  });

  it('flush() with nothing pending resolves without writing', async () => {
    const { fs, log } = harness();

    await expect(log.flush()).resolves.toBeUndefined();
    expect(fs.appendCalls).toBe(0);
  });

  it('surfaces a write failure instead of throwing, and logs it', async () => {
    const { fs, logger, log } = harness();
    fs.failOn = { operation: 'append', message: 'ENOSPC: disk full' };

    expect(log.writeError).toBeNull();
    log.append(turnStart(T0));
    await expect(log.flush()).resolves.toBeUndefined();

    expect(log.writeError?.message).toBe('ENOSPC: disk full');
    const errors = logger.at('error');
    expect(errors).toHaveLength(1);
    expect(errors[0]?.message).toBe('could not append to the session log');
    expect(errors[0]?.scope).toBe('root.session-log');
  });
});

describe('SessionEventLog replay', () => {
  it('returns nothing for a log file that does not exist yet', async () => {
    const { log } = harness();

    expect(await collect(log)).toEqual([]);
  });

  it('returns the appended events in the original order', async () => {
    const { log } = harness();
    const events: readonly AgentEvent[] = [turnStart(T0), textDelta('one', T0), textDelta('two', T0), turnEnd(T0)];

    for (const event of events) {
      log.append(event);
    }
    await log.flush();

    const records = await collect(log);
    expect(records.map((record) => record.event)).toEqual(events);
    expect(records.map((record) => record.seq)).toEqual([0, 1, 2, 3]);
  });

  it('starts at fromSeq, which is how a checkpoint offset addresses the conversation', async () => {
    const { log } = harness();
    for (const event of [turnStart(T0), textDelta('a', T0), textDelta('b', T0), turnEnd(T0)]) {
      log.append(event);
    }
    await log.flush();

    const records = await collect(log, 2);
    expect(records.map((record) => record.seq)).toEqual([2, 3]);
  });

  it('yields nothing when fromSeq is past the end', async () => {
    const { log } = harness();
    log.append(turnStart(T0));
    await log.flush();

    expect(await collect(log, 99)).toEqual([]);
  });

  it('stops at a damaged tail rather than throwing', async () => {
    const { fs, log, path } = harness();
    fs.files.set(path, line(0, turnStart(T0)) + '{"v":1,"seq":1,"at":170000');

    const records = await collect(log);
    expect(records).toHaveLength(1);
    expect(records[0]?.event).toEqual(turnStart(T0));
  });

  it('returns nothing when the file cannot be read, rather than rejecting', async () => {
    const { fs, logger, log, path } = harness();
    fs.files.set(path, line(0, turnStart(T0)));
    fs.failOn = { operation: 'read', message: 'EACCES' };

    expect(await collect(log)).toEqual([]);
    expect(logger.at('warn').map((record) => record.message)).toContain(
      'could not read the session log',
    );
  });
});

describe('SessionEventLog crash recovery', () => {
  it('reports zero records and zero truncation when the file does not exist', async () => {
    const { fs, log, path } = harness();

    expect(await log.recover()).toEqual({ records: 0, truncatedBytes: 0 });
    expect(log.nextSeq).toBe(0);
    expect(fs.files.has(path)).toBe(false);
    expect(fs.writeCalls).toBe(0);
  });

  it('reports zero records and zero truncation for a completely empty file', async () => {
    const { fs, log, path } = harness();
    fs.files.set(path, '');

    expect(await log.recover()).toEqual({ records: 0, truncatedBytes: 0 });
    expect(log.nextSeq).toBe(0);
    expect(fs.files.get(path)).toBe('');
    expect(fs.writeCalls).toBe(0);
  });

  it('leaves an intact log with a trailing newline untouched', async () => {
    const { fs, log, path } = harness();
    const raw = line(0, turnStart(T0)) + line(1, textDelta('a', T0)) + line(2, turnEnd(T0));
    fs.files.set(path, raw);

    expect(await log.recover()).toEqual({ records: 3, truncatedBytes: 0 });
    expect(fs.files.get(path)).toBe(raw);
    expect(fs.writeCalls).toBe(0);
    expect(log.nextSeq).toBe(3);
  });

  it('keeps complete records and drops a tail truncated mid-object', async () => {
    const { fs, log, path } = harness();
    const kept = line(0, turnStart(T0)) + line(1, textDelta('a', T0));
    // A crash mid-write: the object opened but never closed, and no newline.
    const partial = '{"v":1,"seq":2,"at":1700000000000,"atIso":"2023-11-14T22:13:20.000Z","eve';
    fs.files.set(path, kept + partial);

    const outcome = await log.recover();

    expect(outcome).toEqual({ records: 2, truncatedBytes: partial.length });
    expect(fs.files.get(path)).toBe(kept);
    expect(log.nextSeq).toBe(2);
  });

  it('keeps complete records and drops a tail truncated mid-string', async () => {
    const { fs, log, path } = harness();
    const kept = line(0, turnStart(T0));
    // The write stopped inside a JSON string literal — an unterminated quote.
    const partial = '{"v":1,"seq":1,"at":1700000000000,"atIso":"2023-11-14T22:1';
    fs.files.set(path, kept + partial);

    const outcome = await log.recover();

    expect(outcome).toEqual({ records: 1, truncatedBytes: partial.length });
    expect(fs.files.get(path)).toBe(kept);
    expect(log.nextSeq).toBe(1);
  });

  it('drops a final record that is syntactically whole but has no trailing newline', async () => {
    // Deliberate: without a terminator the writer cannot prove the line is whole
    // (the crash may have landed on a byte boundary that happens to parse), so
    // "complete" means newline-terminated. The record is discarded, not kept.
    const { fs, log, path } = harness();
    const kept = line(0, turnStart(T0));
    const unterminated = line(1, turnEnd(T0)).slice(0, -1);
    fs.files.set(path, kept + unterminated);

    const outcome = await log.recover();

    expect(outcome).toEqual({ records: 1, truncatedBytes: unterminated.length });
    expect(fs.files.get(path)).toBe(kept);
    expect(log.nextSeq).toBe(1);
  });

  it('recovers a log whose only content is a partial line', async () => {
    const { fs, log, path } = harness();
    const partial = '{"v":1,"seq":0';
    fs.files.set(path, partial);

    expect(await log.recover()).toEqual({ records: 0, truncatedBytes: partial.length });
    expect(fs.files.get(path)).toBe('');
    expect(log.nextSeq).toBe(0);
  });

  it('warns when it truncates, naming the byte count and record count', async () => {
    const { fs, logger, log, path } = harness();
    const partial = '{"v":1,"seq":1';
    fs.files.set(path, line(0, turnStart(T0)) + partial);

    await log.recover();

    const warnings = logger.at('warn');
    expect(warnings).toHaveLength(1);
    expect(warnings[0]?.message).toBe('truncating an incomplete session log tail');
    expect(warnings[0]?.scope).toBe('root.session-log');
    expect(warnings[0]?.fields?.['truncatedBytes']).toBe(partial.length);
    expect(warnings[0]?.fields?.['records']).toBe(1);
  });

  it('lets appends continue contiguously after recovery', async () => {
    const { fs, log, path } = harness();
    fs.files.set(path, line(0, turnStart(T0)) + line(1, textDelta('a', T0)) + '{"v":1,"se');

    await log.recover();
    expect(log.append(turnEnd(T0))).toBe(2);
    await log.flush();

    const records = await collect(log);
    expect(records.map((record) => record.seq)).toEqual([0, 1, 2]);
    expect(records[2]?.event).toEqual(turnEnd(T0));
  });

  it('resets the sequence counter when the file turns out to be absent', async () => {
    const { log } = harness();
    log.append(turnStart(T0));
    log.append(turnEnd(T0));
    expect(log.nextSeq).toBe(2);

    // Nothing was ever flushed, so recovery finds no file and rewinds to zero.
    expect(await log.recover()).toEqual({ records: 0, truncatedBytes: 0 });
    expect(log.nextSeq).toBe(0);
  });

  it('keeps the in-memory outcome correct when the truncating rewrite fails', async () => {
    const { fs, logger, log, path } = harness();
    const kept = line(0, turnStart(T0));
    const partial = '{"v":1,"seq":1';
    const raw = kept + partial;
    fs.files.set(path, raw);
    fs.failOn = { operation: 'write', message: 'EROFS: read-only file system' };

    const outcome = await log.recover();

    expect(outcome).toEqual({ records: 1, truncatedBytes: partial.length });
    // The damaged tail is still on disk; it is simply discarded again next time.
    expect(fs.files.get(path)).toBe(raw);
    const errors = logger.at('error');
    expect(errors).toHaveLength(1);
    expect(errors[0]?.message).toBe('could not rewrite the truncated session log');
  });

  it('reports nothing to recover when the file cannot be read at all', async () => {
    const { fs, logger, log, path } = harness();
    fs.files.set(path, line(0, turnStart(T0)));
    fs.failOn = { operation: 'read', message: 'EACCES' };

    expect(await log.recover()).toEqual({ records: 0, truncatedBytes: 0 });
    expect(log.nextSeq).toBe(0);
    expect(logger.at('warn').map((record) => record.message)).toContain(
      'could not read the session log',
    );
  });
});

describe('SessionEventLog corruption that is not at the tail', () => {
  it('truncates from a mid-file corrupt record, discarding the records after it', async () => {
    // Deliberate, and documented on `scanCompleteRecords`: keeping the records
    // after the hole would make `seq` non-contiguous, and every checkpoint offset
    // stored against this log would then address the wrong event. Losing the
    // suffix is the safe failure; renumbering silently is not.
    const { fs, log, path } = harness();
    const first = line(0, turnStart(T0));
    const corrupt = '{"v":1,"seq":1,"at":not-json}\n';
    const third = line(2, turnEnd(T0));
    fs.files.set(path, first + corrupt + third);

    const outcome = await log.recover();

    expect(outcome).toEqual({ records: 1, truncatedBytes: corrupt.length + third.length });
    expect(fs.files.get(path)).toBe(first);
    expect(log.nextSeq).toBe(1);
  });

  it('treats a blank line in the middle as the end of the log', async () => {
    const { fs, log, path } = harness();
    const first = line(0, turnStart(T0));
    const rest = `\n${line(1, turnEnd(T0))}`;
    fs.files.set(path, first + rest);

    expect(await log.recover()).toEqual({ records: 1, truncatedBytes: rest.length });
    expect(fs.files.get(path)).toBe(first);
  });

  it('rejects a record whose shape is wrong even though the JSON parses', async () => {
    const { fs, log, path } = harness();
    const first = line(0, turnStart(T0));
    const shapeless = `${JSON.stringify({ v: SESSION_LOG_RECORD_VERSION, seq: 1, at: T0, atIso: new Date(T0).toISOString(), event: { noTypeField: true } })}\n`;
    fs.files.set(path, first + shapeless);

    expect(await log.recover()).toEqual({ records: 1, truncatedBytes: shapeless.length });
    expect(await collect(log)).toHaveLength(1);
  });
});

describe('SessionEventLog record version handling', () => {
  it('does not mis-parse a record written by a future version', async () => {
    // A future format is refused outright rather than read as if it were v1 —
    // ADR 0006's reason for versioning per record instead of per file.
    const { fs, log, path } = harness();
    const kept = line(0, turnStart(T0));
    const future = lineWithVersion(SESSION_LOG_RECORD_VERSION + 1, 1, turnEnd(T0));
    fs.files.set(path, kept + future);

    const outcome = await log.recover();

    expect(outcome).toEqual({ records: 1, truncatedBytes: future.length });
    expect((await collect(log)).map((record) => record.v)).toEqual([SESSION_LOG_RECORD_VERSION]);
  });

  it('refuses a record with a missing or non-numeric version', async () => {
    const { fs, log, path } = harness();
    const noVersion = `${JSON.stringify({ seq: 0, at: T0, atIso: new Date(T0).toISOString(), event: turnStart(T0) })}\n`;
    fs.files.set(path, noVersion);

    expect(await log.recover()).toEqual({ records: 0, truncatedBytes: noVersion.length });
    expect(await collect(log)).toEqual([]);
  });

  it('replays a whole log written by a fresh instance over the same file', async () => {
    // What "resume a session" actually does: a new instance recovers, then reads.
    const { fs, storage, clock, logger } = harness();
    const first = new SessionEventLog({ fileSystem: fs, storage, clock, logger }, SESSION);
    first.append(turnStart(T0));
    first.append(usage(T0));
    await first.flush();

    const second = new SessionEventLog({ fileSystem: fs, storage, clock, logger }, SESSION);
    expect(await second.recover()).toEqual({ records: 2, truncatedBytes: 0 });
    expect((await collect(second)).map((record) => record.event)).toEqual([
      turnStart(T0),
      usage(T0),
    ]);
    expect(second.nextSeq).toBe(2);
  });
});
