import { describe, expect, it } from 'vitest';
import { toSessionId, toTurnId, type AgentEvent } from '@tars/shared';
import {
  appendHostError,
  appendUserPrompt,
  applyAgentEvent,
  createTranscript,
  replayTranscript,
  resolvePermission,
  type TranscriptBuffer,
  type TranscriptItem,
} from './transcript.js';

const SESSION = toSessionId('session-1');
const TURN = toTurnId('turn-1');

/**
 * Events carry their own timestamps in production; here `at` is a counter so a
 * fixture is a value, not a snapshot of when the suite happened to run.
 */
function makeEvents(): readonly AgentEvent[] {
  let at = 0;
  const base = (): { sessionId: typeof SESSION; turnId: typeof TURN; at: number } => {
    at += 1;
    return { sessionId: SESSION, turnId: TURN, at };
  };

  return [
    { ...base(), type: 'turn_start' },
    { ...base(), type: 'thinking_start' },
    { ...base(), type: 'thinking_delta', text: 'let me ' },
    { ...base(), type: 'thinking_delta', text: 'check' },
    { ...base(), type: 'text_delta', text: 'Hello ' },
    { ...base(), type: 'text_delta', text: 'there' },
    { ...base(), type: 'tool_call_start', toolCallId: 'c1', toolName: 'Read' },
    { ...base(), type: 'tool_call_delta', toolCallId: 'c1', inputJsonDelta: '{"path":' },
    { ...base(), type: 'tool_call_delta', toolCallId: 'c1', inputJsonDelta: '"src/a.ts"}' },
    {
      ...base(),
      type: 'tool_call_result',
      toolCallId: 'c1',
      toolName: 'Read',
      isError: false,
      content: 'file body',
      durationMs: 12,
    },
    // Thinking resumes after the tool call: the block never received `thinking_end`.
    { ...base(), type: 'thinking_delta', text: ' resumed' },
    { ...base(), type: 'thinking_end' },
    { ...base(), type: 'text_delta', text: 'Done' },
    {
      ...base(),
      type: 'plan_update',
      steps: [{ id: 's1', title: 'Read the file', status: 'completed' }],
    },
    {
      ...base(),
      type: 'plan_update',
      steps: [
        { id: 's1', title: 'Read the file', status: 'completed' },
        { id: 's2', title: 'Edit it', status: 'in_progress' },
      ],
    },
    { ...base(), type: 'file_edit_proposed', path: 'src/a.ts', afterContent: 'one\ntwo\n' },
    {
      ...base(),
      type: 'usage',
      inputTokens: 100,
      outputTokens: 20,
      cacheReadTokens: 5,
      cacheCreationTokens: 1,
    },
    {
      ...base(),
      type: 'permission_request',
      requestId: 'r1',
      toolName: 'Bash',
      input: { command: 'rm -rf build' },
      affectedPaths: ['build'],
      defaultPolicy: 'ask',
    },
    { ...base(), type: 'error', message: 'model overloaded', code: 'overloaded', retryable: true },
    { ...base(), type: 'turn_end', reason: 'error' },
  ];
}

function feed(events: readonly AgentEvent[]): TranscriptBuffer {
  const buffer = createTranscript();
  for (const event of events) {
    applyAgentEvent(buffer, event);
  }
  return buffer;
}

function kinds(items: readonly TranscriptItem[]): readonly string[] {
  return items.map((item) => item.kind);
}

describe('transcript reducer', () => {
  it('folds every AgentEvent variant into an ordered transcript', () => {
    const buffer = feed(makeEvents());

    // Ordering is faithful to arrival: the prose written before the tool call sits
    // above it, the prose written after sits below it, in separate blocks.
    expect(kinds(buffer.items)).toEqual([
      'thinking',
      'assistant',
      'tool_call',
      'assistant',
      'plan',
      'file_edit',
      'error',
    ]);

    expect(buffer.items[0]).toEqual({
      kind: 'thinking',
      id: 'thinking-1',
      // The interleaved tool call did not close the block, so the resumed delta
      // landed back in it rather than opening a second panel.
      text: 'let me check resumed',
      streaming: false,
    });
    expect(buffer.items[1]).toEqual({
      kind: 'assistant',
      id: 'assistant-2',
      text: 'Hello there',
      streaming: false,
    });
    expect(buffer.items[2]).toEqual({
      kind: 'tool_call',
      id: 'tool-3',
      toolCallId: 'c1',
      toolName: 'Read',
      inputJson: '{"path":"src/a.ts"}',
      status: 'ok',
      result: 'file body',
      durationMs: 12,
      affectedPaths: ['src/a.ts'],
    });
    expect(buffer.items[3]).toEqual({
      kind: 'assistant',
      id: 'assistant-4',
      text: 'Done',
      streaming: false,
    });
    expect(buffer.items[5]).toEqual({
      kind: 'file_edit',
      id: 'edit-6',
      path: 'src/a.ts',
      summary: 'created · 3 lines',
      isNewFile: true,
    });
    expect(buffer.items[6]).toEqual({
      kind: 'error',
      id: 'error-7',
      message: 'model overloaded',
      code: 'overloaded',
      retryable: true,
    });

    expect(buffer.usage).toEqual({
      inputTokens: 100,
      outputTokens: 20,
      cacheReadTokens: 5,
      cacheCreationTokens: 1,
    });
    expect(buffer.busy).toBe(false);
    expect(buffer.lastError).toBe('model overloaded');
  });

  it('replaces the plan in place rather than appending a snapshot per update', () => {
    const buffer = feed(makeEvents());
    const plans = buffer.items.filter((item) => item.kind === 'plan');

    expect(plans).toHaveLength(1);
    expect(plans[0]?.steps).toHaveLength(2);
  });

  it('accumulates deltas without rebuilding the transcript array', () => {
    const buffer = createTranscript();
    const array = buffer.items;

    for (const text of ['a', 'b', 'c']) {
      applyAgentEvent(buffer, { sessionId: SESSION, turnId: TURN, at: 1, type: 'text_delta', text });
    }

    expect(buffer.items).toHaveLength(1);
    expect(buffer.items[0]).toMatchObject({ kind: 'assistant', text: 'abc', streaming: true });
    // The array identity is the contract the store's `revision` counter exists for.
    expect(buffer.items).toBe(array);
  });

  it('resolves a tool call by id even when calls overlap', () => {
    const at = 1;
    const buffer = createTranscript();
    const events: readonly AgentEvent[] = [
      { sessionId: SESSION, turnId: TURN, at, type: 'tool_call_start', toolCallId: 'a', toolName: 'Read' },
      { sessionId: SESSION, turnId: TURN, at, type: 'tool_call_start', toolCallId: 'b', toolName: 'Bash' },
      {
        sessionId: SESSION,
        turnId: TURN,
        at,
        type: 'tool_call_result',
        toolCallId: 'a',
        toolName: 'Read',
        isError: false,
        content: 'ok',
        durationMs: 3,
      },
      {
        sessionId: SESSION,
        turnId: TURN,
        at,
        type: 'tool_call_result',
        toolCallId: 'b',
        toolName: 'Bash',
        isError: true,
        content: 'exit 1',
        durationMs: 9,
      },
    ];
    for (const event of events) {
      applyAgentEvent(buffer, event);
    }

    expect(buffer.items.map((item) => (item.kind === 'tool_call' ? item.status : item.kind))).toEqual([
      'ok',
      'error',
    ]);
  });

  it('produces an identical transcript whether events are replayed or delivered live', () => {
    const events = makeEvents();

    expect(replayTranscript(events).items).toEqual(feed(events).items);
  });

  it('adds and retires pending permissions', () => {
    const buffer = createTranscript();
    const request: AgentEvent = {
      sessionId: SESSION,
      turnId: TURN,
      at: 1,
      type: 'permission_request',
      requestId: 'r1',
      toolName: 'Bash',
      input: { command: 'ls' },
      affectedPaths: [],
      defaultPolicy: 'ask',
    };

    applyAgentEvent(buffer, request);
    expect(buffer.pendingPermissions).toHaveLength(1);
    expect(buffer.pendingPermissions[0]?.toolName).toBe('Bash');

    resolvePermission(buffer, 'nope');
    expect(buffer.pendingPermissions).toHaveLength(1);

    resolvePermission(buffer, 'r1');
    expect(buffer.pendingPermissions).toHaveLength(0);
  });

  it('retires permissions at turn_end so a replayed history cannot resurrect them', () => {
    const buffer = replayTranscript(makeEvents());

    expect(buffer.pendingPermissions).toEqual([]);
  });

  it('records local prompts and host failures in transcript order', () => {
    const buffer = createTranscript();

    appendUserPrompt(buffer, '  fix the build  ');
    appendHostError(buffer, 'provider not authenticated');

    expect(buffer.items[0]).toEqual({ kind: 'user', id: 'user-1', text: '  fix the build  ' });
    expect(buffer.items[1]).toMatchObject({ kind: 'error', code: 'host_error' });
    expect(buffer.lastError).toBe('provider not authenticated');
  });

  it('survives a truncated log that lacks a tool_call_start', () => {
    const buffer = createTranscript();

    applyAgentEvent(buffer, {
      sessionId: SESSION,
      turnId: TURN,
      at: 1,
      type: 'tool_call_result',
      toolCallId: 'orphan',
      toolName: 'Grep',
      isError: false,
      content: 'match',
      durationMs: 1,
    });

    expect(buffer.items[0]).toMatchObject({ kind: 'tool_call', toolName: 'Grep', status: 'ok' });
  });
});
