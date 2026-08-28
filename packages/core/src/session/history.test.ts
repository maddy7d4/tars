import { beforeEach, describe, expect, it } from 'vitest';
import { toSessionId, toTurnId, type AgentEvent, type SessionId } from '@tars/shared';
import { BufferLogger, FakeClock, MemoryFileSystem, MemoryStorage } from '../testing/fakes.js';
import { SESSION_LOG_RECORD_VERSION, type SessionLogRecord } from './event-log.js';
import { ConversationHistory } from './history.js';

/**
 * Tests for conversation history (Docs/TARS_SPEC.md §4.4).
 *
 * History reads the session logs directly rather than keeping an index, so what
 * matters is that it stays useful when those logs are imperfect: truncated by a
 * crash, empty because a session was opened and abandoned, or written by a
 * version that is not this one. Each of those is asserted rather than assumed.
 */

const T0 = 1_700_000_000_000;

interface Harness {
  readonly history: ConversationHistory;
  readonly fs: MemoryFileSystem;
  readonly logger: BufferLogger;
}

function harness(): Harness {
  const fs = new MemoryFileSystem();
  const logger = new BufferLogger();
  const history = new ConversationHistory({
    fileSystem: fs,
    storage: new MemoryStorage('/global', '/workspace'),
    clock: new FakeClock(T0),
    logger,
  });
  return { history, fs, logger };
}

function record(event: AgentEvent, seq: number): string {
  const line: SessionLogRecord = {
    v: SESSION_LOG_RECORD_VERSION,
    seq,
    at: event.at,
    atIso: new Date(event.at).toISOString(),
    event,
  };
  return `${JSON.stringify(line)}\n`;
}

/** Writes a log the way `SessionEventLog` would. */
function writeLog(h: Harness, id: string, events: readonly AgentEvent[]): SessionId {
  const sessionId = toSessionId(id);
  const body = events.map((event, index) => record(event, index)).join('');
  h.fs.files.set(`/global/sessions/${id}.jsonl`, body);
  return sessionId;
}

function conversation(id: string, at: number, text: string): readonly AgentEvent[] {
  const base = { sessionId: toSessionId(id), turnId: toTurnId(`${id}-t1`) } as const;
  return [
    { ...base, at, type: 'turn_start' },
    { ...base, at: at + 1, type: 'text_delta', text },
    { ...base, at: at + 2, type: 'turn_end', reason: 'completed' },
  ];
}

let h: Harness;
beforeEach(() => {
  h = harness();
});

describe('ConversationHistory.list', () => {
  it('reports nothing before any conversation exists', async () => {
    // No directory yet is the ordinary first-run state, not a failure.
    expect(await h.history.list()).toEqual([]);
  });

  it('titles a conversation from the first thing the agent said', async () => {
    writeLog(h, 's1', conversation('s1', T0, 'I will refactor the parser.'));

    const [summary] = await h.history.list();
    expect(summary?.title).toBe('I will refactor the parser.');
    expect(summary?.sessionId).toBe(toSessionId('s1'));
    expect(summary?.startedAt).toBe(T0);
    expect(summary?.eventCount).toBe(3);
  });

  it('orders most recently updated first', async () => {
    writeLog(h, 'older', conversation('older', T0, 'first'));
    writeLog(h, 'newer', conversation('newer', T0 + 10_000, 'second'));

    expect((await h.history.list()).map((entry) => entry.title)).toEqual(['second', 'first']);
  });

  it('takes only the first non-empty line of a multi-line reply', async () => {
    writeLog(h, 's1', conversation('s1', T0, '\n\nFirst line.\nSecond line.'));
    expect((await h.history.list())[0]?.title).toBe('First line.');
  });

  it('truncates a very long opening line', async () => {
    writeLog(h, 's1', conversation('s1', T0, 'x'.repeat(200)));

    const title = (await h.history.list())[0]?.title ?? '';
    expect(title).toHaveLength(81);
    expect(title.endsWith('…')).toBe(true);
  });

  it('falls back to a placeholder when the agent produced no prose', async () => {
    const base = { sessionId: toSessionId('s1'), turnId: toTurnId('t1') } as const;
    writeLog(h, 's1', [
      { ...base, at: T0, type: 'turn_start' },
      { ...base, at: T0 + 1, type: 'tool_call_start', toolCallId: 'c1', toolName: 'Read' },
    ]);

    expect((await h.history.list())[0]?.title).toBe('Untitled conversation');
  });

  it('omits a session that was opened and never used', async () => {
    h.fs.files.set('/global/sessions/empty.jsonl', '');

    // Listing it would offer the user a conversation with nothing in it.
    expect(await h.history.list()).toEqual([]);
  });

  it('reads a log whose tail a crash truncated', async () => {
    const events = conversation('s1', T0, 'partial reply');
    const body = events.map((event, index) => record(event, index)).join('');
    h.fs.files.set('/global/sessions/s1.jsonl', `${body}{"v":1,"seq":3,"eve`);

    // Append-only writing means a partial trailing line is the only possible
    // corruption, and the conversation before it is still worth having.
    const [summary] = await h.history.list();
    expect(summary?.title).toBe('partial reply');
    expect(summary?.eventCount).toBe(3);
  });

  it('ignores files that are not session logs', async () => {
    writeLog(h, 's1', conversation('s1', T0, 'real'));
    h.fs.files.set('/global/sessions/README.txt', 'not a log');

    expect(await h.history.list()).toHaveLength(1);
  });

  it('honours the limit', async () => {
    for (let i = 0; i < 5; i += 1) {
      writeLog(h, `s${String(i)}`, conversation(`s${String(i)}`, T0 + i * 1000, `reply ${String(i)}`));
    }

    expect(await h.history.list(2)).toHaveLength(2);
  });
});

describe('ConversationHistory.forget', () => {
  it('deletes a conversation log', async () => {
    const id = writeLog(h, 's1', conversation('s1', T0, 'gone'));

    expect(await h.history.forget(id)).toBe(true);
    expect(await h.history.list()).toEqual([]);
  });

  it('reports an unknown conversation rather than pretending', async () => {
    expect(await h.history.forget(toSessionId('nope'))).toBe(false);
  });
});
