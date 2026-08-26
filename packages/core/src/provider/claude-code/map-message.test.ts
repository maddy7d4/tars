import type { SDKMessage, SDKToolProgressMessage } from '@anthropic-ai/claude-agent-sdk';
import type { AgentEvent } from '@tars/shared';
import { toSessionId, toTurnId } from '@tars/shared';
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { FakeClock } from '../../testing/fakes.js';
import type { MapContext, MapperState } from './map-message.js';
import { initialMapperState, mapSdkMessage } from './map-message.js';
import {
  assistantMessage,
  blockStop,
  errorResult,
  initMessage,
  inputJsonDelta,
  messageStart,
  messageStop,
  permissionDeniedMessage,
  signatureDelta,
  successResult,
  textBlockStart,
  textDelta,
  thinkingBlockStart,
  thinkingDelta,
  toolResultMessage,
  toolUseBlockStart,
} from './sdk-fixtures.js';

/**
 * Adapter tests for the one module allowed to know SDK types (Docs/TARS_SPEC.md
 * §4.1). Every SDK message here comes from `sdk-fixtures.ts`, whose builders are
 * typed as the SDK's own declared types: an SDK reshape breaks `pnpm typecheck`
 * on the fixture rather than silently passing these assertions.
 */

const SESSION_ID = toSessionId('sess-1');
const TURN_ID = toTurnId('turn-1');

/** Milliseconds the clock advances before each mapped message. */
const STEP_MS = 10;

interface Harness {
  readonly ctx: MapContext;
  readonly clock: FakeClock;
}

function harness(): Harness {
  const clock = new FakeClock(1_000);
  return {
    clock,
    ctx: { sessionId: SESSION_ID, turnId: TURN_ID, now: () => clock.now() },
  };
}

/**
 * Threads `MapperState` through a message list the way `ClaudeCodeSession` does,
 * advancing the clock between messages so ordering assertions are exact and every
 * event stamped within one message shares an instant.
 */
function feed(
  messages: readonly SDKMessage[],
  h: Harness = harness(),
  initial: MapperState = initialMapperState(),
): { readonly events: readonly AgentEvent[]; readonly state: MapperState } {
  const events: AgentEvent[] = [];
  let state = initial;
  for (const message of messages) {
    h.clock.advance(STEP_MS);
    const result = mapSdkMessage(message, h.ctx, state);
    events.push(...result.events);
    state = result.state;
  }
  return { events, state };
}

function types(events: readonly AgentEvent[]): readonly string[] {
  return events.map((event) => event.type);
}

function only<T extends AgentEvent['type']>(
  events: readonly AgentEvent[],
  type: T,
): Extract<AgentEvent, { type: T }> {
  const matches = events.filter(
    (event): event is Extract<AgentEvent, { type: T }> => event.type === type,
  );
  const [match] = matches;
  if (matches.length !== 1 || match === undefined) {
    throw new Error(`expected exactly one ${type} event, got ${String(matches.length)}`);
  }
  return match;
}

/** A top-level message type the mapper deliberately does not name. */
function toolProgressMessage(): SDKMessage {
  const message: SDKToolProgressMessage = {
    type: 'tool_progress',
    tool_use_id: 'toolu_1',
    tool_name: 'Bash',
    parent_tool_use_id: null,
    elapsed_time_seconds: 2,
    uuid: randomUUID(),
    session_id: 'fixture-session',
  };
  return message;
}

describe('initialMapperState', () => {
  it('starts with no open blocks and no pending tool calls', () => {
    const state = initialMapperState();

    expect(state.blocks.size).toBe(0);
    expect(state.tools.size).toBe(0);
  });

  it('returns a fresh state on every call', () => {
    expect(initialMapperState()).not.toBe(initialMapperState());
  });
});

describe('mapSdkMessage: stream events', () => {
  it('emits nothing for message_start, message_stop or a text block start', () => {
    const { events } = feed([messageStart(), textBlockStart(0), messageStop()]);

    expect(events).toEqual([]);
  });

  it('maps a text delta to a text_delta carrying the chunk verbatim', () => {
    const h = harness();
    const { events } = feed([messageStart(), textBlockStart(0), textDelta(0, 'Hello ')], h);

    expect(types(events)).toEqual(['text_delta']);
    expect(only(events, 'text_delta')).toEqual({
      type: 'text_delta',
      text: 'Hello ',
      sessionId: SESSION_ID,
      turnId: TURN_ID,
      at: h.clock.now(),
    });
  });

  it('preserves an empty text delta rather than dropping it', () => {
    const { events } = feed([messageStart(), textBlockStart(0), textDelta(0, '')]);

    expect(types(events)).toEqual(['text_delta']);
    expect(only(events, 'text_delta').text).toBe('');
  });

  it('brackets a thinking block with thinking_start and thinking_end', () => {
    const { events } = feed([
      messageStart(),
      thinkingBlockStart(0),
      thinkingDelta(0, 'Let me '),
      thinkingDelta(0, 'check.'),
      signatureDelta(0, 'sig-abc'),
      blockStop(0),
    ]);

    expect(types(events)).toEqual([
      'thinking_start',
      'thinking_delta',
      'thinking_delta',
      'thinking_end',
    ]);
    expect(events.filter((e) => e.type === 'thinking_delta').map((e) => e.text)).toEqual([
      'Let me ',
      'check.',
    ]);
  });

  it('emits no event for a signature delta', () => {
    const { events } = feed([messageStart(), thinkingBlockStart(0), signatureDelta(0, 'sig')]);

    expect(types(events)).toEqual(['thinking_start']);
  });

  it('maps a tool_use block start to tool_call_start and its deltas to tool_call_delta', () => {
    const { events } = feed([
      messageStart(),
      toolUseBlockStart(0, 'toolu_read', 'Read'),
      inputJsonDelta(0, '{"file_path"'),
      inputJsonDelta(0, ':"/w/a.ts"}'),
      blockStop(0),
    ]);

    expect(types(events)).toEqual(['tool_call_start', 'tool_call_delta', 'tool_call_delta']);
    expect(only(events, 'tool_call_start').toolCallId).toBe('toolu_read');
    expect(only(events, 'tool_call_start').toolName).toBe('Read');
    expect(
      events.filter((e) => e.type === 'tool_call_delta').map((e) => e.toolCallId),
    ).toEqual(['toolu_read', 'toolu_read']);
  });

  it('assembles partial input JSON across deltas into the completed tool input', () => {
    const { events } = feed([
      messageStart(),
      toolUseBlockStart(0, 'toolu_write', 'Write'),
      inputJsonDelta(0, '{"file_path":'),
      inputJsonDelta(0, '"/w/a.ts",'),
      inputJsonDelta(0, '"content":"hi"'),
      inputJsonDelta(0, '}'),
      blockStop(0),
    ]);

    const assembled = events
      .filter((e) => e.type === 'tool_call_delta')
      .map((e) => e.inputJsonDelta)
      .join('');

    expect(assembled).toBe('{"file_path":"/w/a.ts","content":"hi"}');
    const parsed: unknown = JSON.parse(assembled);
    expect(parsed).toEqual({ file_path: '/w/a.ts', content: 'hi' });
  });

  it('emits nothing when a block stops that was never a thinking block', () => {
    const { events } = feed([
      messageStart(),
      textBlockStart(0),
      toolUseBlockStart(1, 'toolu_1', 'Read'),
      blockStop(0),
      blockStop(1),
    ]);

    expect(types(events)).toEqual(['tool_call_start']);
  });

  it('tolerates a block stop for an index that never started', () => {
    const { events, state } = feed([messageStart(), blockStop(7)]);

    expect(events).toEqual([]);
    expect(state.blocks.size).toBe(0);
  });

  it('does not emit thinking_end twice for a repeated block stop', () => {
    const { events } = feed([
      messageStart(),
      thinkingBlockStart(0),
      blockStop(0),
      blockStop(0),
    ]);

    expect(types(events)).toEqual(['thinking_start', 'thinking_end']);
  });
});

describe('mapSdkMessage: state threading', () => {
  it('routes input_json deltas to the tool call opened at the same index', () => {
    const { events } = feed([
      messageStart(),
      toolUseBlockStart(1, 'toolu_a', 'Read'),
      toolUseBlockStart(2, 'toolu_b', 'Grep'),
      inputJsonDelta(2, '{"pattern":"x"}'),
      inputJsonDelta(1, '{"file_path":"/w/a.ts"}'),
    ]);

    expect(
      events.filter((e) => e.type === 'tool_call_delta').map((e) => e.toolCallId),
    ).toEqual(['toolu_b', 'toolu_a']);
  });

  it('ignores an input_json delta aimed at a non-tool block', () => {
    const { events } = feed([
      messageStart(),
      textBlockStart(0),
      inputJsonDelta(0, '{"a":1}'),
    ]);

    expect(events).toEqual([]);
  });

  it('ignores an input_json delta for an index with no open block', () => {
    const { events } = feed([messageStart(), inputJsonDelta(4, '{"a":1}')]);

    expect(events).toEqual([]);
  });

  it('resets block indices at message_start but keeps pending tool calls', () => {
    const { events, state } = feed([
      messageStart(),
      toolUseBlockStart(0, 'toolu_keep', 'Read'),
      messageStart(),
      // Index 0 now means nothing, so this delta must not be attributed to the tool.
      inputJsonDelta(0, '{"file_path":"/w/a.ts"}'),
      toolResultMessage('toolu_keep', 'file body'),
    ]);

    expect(types(events)).toEqual(['tool_call_start', 'tool_call_result']);
    expect(state.blocks.size).toBe(0);
  });

  it('carries state forward across separate mapSdkMessage calls', () => {
    const h = harness();

    const started = mapSdkMessage(toolUseBlockStart(0, 'toolu_x', 'Bash'), h.ctx, initialMapperState());
    expect(started.state.tools.size).toBe(1);

    const delta = mapSdkMessage(inputJsonDelta(0, '{"command":"ls"}'), h.ctx, started.state);
    expect(only(delta.events, 'tool_call_delta').toolCallId).toBe('toolu_x');

    // The same delta against a fresh state has nothing to correlate with.
    const orphan = mapSdkMessage(inputJsonDelta(0, '{"command":"ls"}'), h.ctx, initialMapperState());
    expect(orphan.events).toEqual([]);
  });
});

describe('mapSdkMessage: assistant messages', () => {
  it('does not re-emit text that already streamed as deltas', () => {
    const { events } = feed([
      assistantMessage([{ type: 'text', text: 'Hello there', citations: null }]),
    ]);

    expect(events).toEqual([]);
  });

  it('derives file_edit_proposed from a completed Write tool input', () => {
    const { events } = feed([
      assistantMessage([
        {
          type: 'tool_use',
          id: 'toolu_write',
          name: 'Write',
          input: { file_path: '/w/a.ts', content: 'export const a = 1;\n' },
        },
      ]),
    ]);

    expect(types(events)).toEqual(['file_edit_proposed']);
    const edit = only(events, 'file_edit_proposed');
    expect(edit.path).toBe('/w/a.ts');
    expect(edit.afterContent).toBe('export const a = 1;\n');
    // Hashing the pre-edit file would need I/O, which this module never performs.
    expect(edit.beforeHash).toBeUndefined();
  });

  it('ignores a Write whose input does not carry both a path and content', () => {
    const { events } = feed([
      assistantMessage([
        { type: 'tool_use', id: 'toolu_write', name: 'Write', input: { file_path: '/w/a.ts' } },
      ]),
    ]);

    expect(events).toEqual([]);
  });

  it('derives plan_update with positional step ids from TodoWrite', () => {
    const { events } = feed([
      assistantMessage([
        {
          type: 'tool_use',
          id: 'toolu_todo',
          name: 'TodoWrite',
          input: {
            todos: [
              { content: 'Read the spec', status: 'completed' },
              { content: 'Write the tests', status: 'in_progress' },
              { content: 'Ship it', status: 'pending' },
            ],
          },
        },
      ]),
    ]);

    expect(types(events)).toEqual(['plan_update']);
    expect(only(events, 'plan_update').steps).toEqual([
      { id: 'step-0', title: 'Read the spec', status: 'completed' },
      { id: 'step-1', title: 'Write the tests', status: 'in_progress' },
      { id: 'step-2', title: 'Ship it', status: 'pending' },
    ]);
  });

  it('ignores a TodoWrite carrying an unrecognized status', () => {
    const { events } = feed([
      assistantMessage([
        {
          type: 'tool_use',
          id: 'toolu_todo',
          name: 'TodoWrite',
          input: { todos: [{ content: 'Do it', status: 'blocked' }] },
        },
      ]),
    ]);

    expect(events).toEqual([]);
  });

  it('emits no intent event for a tool whose intent needs disk access', () => {
    const { events, state } = feed([
      assistantMessage([
        {
          type: 'tool_use',
          id: 'toolu_edit',
          name: 'Edit',
          input: { file_path: '/w/a.ts', old_string: 'a', new_string: 'b' },
        },
      ]),
    ]);

    expect(events).toEqual([]);
    // Still recorded, so its result can be named later.
    expect(state.tools.has('toolu_edit')).toBe(true);
  });

  it('maps a retryable assistant error to a retryable error event', () => {
    const { events } = feed([assistantMessage([], 'rate_limit')]);

    expect(types(events)).toEqual(['error']);
    const error = only(events, 'error');
    expect(error.code).toBe('rate_limit');
    expect(error.retryable).toBe(true);
    expect(error.message).toBe('Rate limited. Retrying shortly should succeed.');
  });

  it('maps a non-retryable assistant error with its explanatory text', () => {
    const { events } = feed([assistantMessage([], 'authentication_failed')]);

    const error = only(events, 'error');
    expect(error.code).toBe('authentication_failed');
    expect(error.retryable).toBe(false);
    expect(error.message).toContain('Authentication failed.');
  });

  it('records a tool from the completed message when the partial stream missed it', () => {
    const { events } = feed([
      assistantMessage([
        { type: 'tool_use', id: 'toolu_late', name: 'Bash', input: { command: 'ls' } },
      ]),
      toolResultMessage('toolu_late', 'a.ts'),
    ]);

    expect(types(events)).toEqual(['tool_call_result']);
    expect(only(events, 'tool_call_result').toolName).toBe('Bash');
  });
});

describe('mapSdkMessage: tool results', () => {
  it('maps a successful tool result with its name, content and measured duration', () => {
    const { events } = feed([
      messageStart(),
      toolUseBlockStart(0, 'toolu_read', 'Read'),
      blockStop(0),
      toolResultMessage('toolu_read', 'file body'),
    ]);

    expect(types(events)).toEqual(['tool_call_start', 'tool_call_result']);
    const start = only(events, 'tool_call_start');
    const result = only(events, 'tool_call_result');
    expect(result.toolCallId).toBe('toolu_read');
    expect(result.toolName).toBe('Read');
    expect(result.isError).toBe(false);
    expect(result.content).toBe('file body');
    // Timed from the observed tool_use to the observed result on the injected clock.
    expect(result.durationMs).toBe(result.at - start.at);
    expect(result.durationMs).toBe(2 * STEP_MS);
  });

  it('flags a tool-reported failure with isError', () => {
    const { events } = feed([
      messageStart(),
      toolUseBlockStart(0, 'toolu_bash', 'Bash'),
      toolResultMessage('toolu_bash', 'command not found', true),
    ]);

    const result = only(events, 'tool_call_result');
    expect(result.isError).toBe(true);
    expect(result.content).toBe('command not found');
    expect(result.toolName).toBe('Bash');
  });

  it('drops an orphaned tool result rather than inventing a tool name', () => {
    const { events } = feed([toolResultMessage('toolu_unknown', 'output')]);

    expect(events).toEqual([]);
  });

  it('consumes the pending tool so a duplicate result is not emitted twice', () => {
    const { events, state } = feed([
      messageStart(),
      toolUseBlockStart(0, 'toolu_read', 'Read'),
      toolResultMessage('toolu_read', 'body'),
      toolResultMessage('toolu_read', 'body'),
    ]);

    expect(types(events)).toEqual(['tool_call_start', 'tool_call_result']);
    expect(state.tools.size).toBe(0);
  });
});

describe('mapSdkMessage: result messages', () => {
  it('carries token counts through as a usage event', () => {
    const { events } = feed([
      successResult({
        input_tokens: 1_234,
        output_tokens: 56,
        cache_read_input_tokens: 78,
        cache_creation_input_tokens: 90,
      }),
    ]);

    expect(types(events)).toEqual(['usage']);
    expect(only(events, 'usage')).toEqual({
      type: 'usage',
      inputTokens: 1_234,
      outputTokens: 56,
      cacheReadTokens: 78,
      cacheCreationTokens: 90,
      sessionId: SESSION_ID,
      turnId: TURN_ID,
      at: expect.any(Number) as number,
    });
  });

  it('emits usage and a non-retryable error when the turn hit the turn ceiling', () => {
    const { events } = feed([errorResult('error_max_turns')]);

    expect(types(events)).toEqual(['usage', 'error']);
    const error = only(events, 'error');
    expect(error.code).toBe('error_max_turns');
    expect(error.retryable).toBe(false);
    expect(error.message).toBe(
      'The turn stopped after reaching the configured maximum number of agent turns.',
    );
  });

  it('treats an execution failure as retryable and prefers the reported errors', () => {
    const { events } = feed([
      errorResult('error_during_execution', ['spawn failed', 'stream closed']),
    ]);

    const error = only(events, 'error');
    expect(error.code).toBe('error_during_execution');
    expect(error.retryable).toBe(true);
    expect(error.message).toBe('spawn failed\nstream closed');
  });

  it('leaves mapper state untouched', () => {
    const h = harness();
    const state = initialMapperState();

    const result = mapSdkMessage(successResult(), h.ctx, state);

    expect(result.state).toBe(state);
  });
});

describe('mapSdkMessage: system messages', () => {
  it('emits nothing for the init message', () => {
    const { events } = feed([initMessage()]);

    expect(events).toEqual([]);
  });

  it('surfaces an SDK-side permission denial as a non-retryable error', () => {
    const { events } = feed([
      permissionDeniedMessage('Bash', 'Bash is denied by workspace policy.'),
    ]);

    expect(types(events)).toEqual(['error']);
    const error = only(events, 'error');
    expect(error.code).toBe('permission_denied');
    expect(error.retryable).toBe(false);
    expect(error.message).toBe('Bash is denied by workspace policy.');
  });
});

describe('mapSdkMessage: unhandled message types', () => {
  it('ignores a message type the normalized union does not name', () => {
    const h = harness();
    const state = initialMapperState();

    const result = mapSdkMessage(toolProgressMessage(), h.ctx, state);

    expect(result.events).toEqual([]);
    expect(result.state).toBe(state);
  });

  it('does not disturb correlation state around an unhandled message', () => {
    const { events } = feed([
      messageStart(),
      toolUseBlockStart(0, 'toolu_read', 'Read'),
      toolProgressMessage(),
      inputJsonDelta(0, '{"file_path":"/w/a.ts"}'),
      toolResultMessage('toolu_read', 'body'),
    ]);

    expect(types(events)).toEqual(['tool_call_start', 'tool_call_delta', 'tool_call_result']);
  });
});

describe('mapSdkMessage: a realistic turn', () => {
  const stream = (): readonly SDKMessage[] => [
    messageStart(),
    textBlockStart(0),
    textDelta(0, 'Reading '),
    textDelta(0, 'the file.'),
    blockStop(0),
    toolUseBlockStart(1, 'toolu_read', 'Read'),
    inputJsonDelta(1, '{"file_path":'),
    inputJsonDelta(1, '"/w/a.ts"}'),
    blockStop(1),
    assistantMessage([
      { type: 'text', text: 'Reading the file.', citations: null },
      { type: 'tool_use', id: 'toolu_read', name: 'Read', input: { file_path: '/w/a.ts' } },
    ]),
    toolResultMessage('toolu_read', 'export const a = 1;\n'),
    messageStart(),
    textBlockStart(0),
    textDelta(0, 'Done.'),
    blockStop(0),
    successResult({ input_tokens: 100, output_tokens: 20 }),
  ];

  it('produces the ordered event sequence the UI replays', () => {
    const { events } = feed(stream());

    expect(types(events)).toEqual([
      'text_delta',
      'text_delta',
      'tool_call_start',
      'tool_call_delta',
      'tool_call_delta',
      'tool_call_result',
      'text_delta',
      'usage',
    ]);
    expect(events.filter((e) => e.type === 'text_delta').map((e) => e.text)).toEqual([
      'Reading ',
      'the file.',
      'Done.',
    ]);
  });

  it('stamps every event with the same session and turn', () => {
    const { events } = feed(stream());

    expect(events.length).toBeGreaterThan(0);
    for (const event of events) {
      expect(event.sessionId).toBe(SESSION_ID);
      expect(event.turnId).toBe(TURN_ID);
    }
  });

  it('takes monotonically non-decreasing timestamps from the injected clock', () => {
    const { events } = feed(stream());

    const stamps = events.map((event) => event.at);
    expect(stamps).toEqual([...stamps].sort((a, b) => a - b));
    expect(Math.min(...stamps)).toBeLessThan(Math.max(...stamps));
  });

  it('never emits turn boundaries, which TurnGuard owns', () => {
    const { events } = feed(stream());

    expect(types(events)).not.toContain('turn_start');
    expect(types(events)).not.toContain('turn_end');
  });

  it('ends with no pending tool calls and no open blocks', () => {
    const { state } = feed(stream());

    expect(state.tools.size).toBe(0);
    expect(state.blocks.size).toBe(0);
  });
});
