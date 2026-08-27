import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  PROTOCOL_VERSION,
  toSessionId,
  toTurnId,
  type AgentEvent,
  type HostToWebview,
} from '@tars/shared';
import { resetTarsStore, useTarsStore } from './store.js';
import { postToHost } from './vscode-api.js';

vi.mock('./vscode-api.js', () => ({
  postToHost: vi.fn(),
  isInsideWebview: false,
}));

const SESSION = toSessionId('session-1');
const TURN = toTurnId('turn-1');

const HISTORY: readonly AgentEvent[] = [
  { sessionId: SESSION, turnId: TURN, at: 1, type: 'turn_start' },
  { sessionId: SESSION, turnId: TURN, at: 2, type: 'text_delta', text: 'part one ' },
  { sessionId: SESSION, turnId: TURN, at: 3, type: 'tool_call_start', toolCallId: 'c1', toolName: 'Read' },
  {
    sessionId: SESSION,
    turnId: TURN,
    at: 4,
    type: 'tool_call_result',
    toolCallId: 'c1',
    toolName: 'Read',
    isError: false,
    content: 'body',
    durationMs: 4,
  },
  { sessionId: SESSION, turnId: TURN, at: 5, type: 'text_delta', text: 'part two' },
  { sessionId: SESSION, turnId: TURN, at: 6, type: 'turn_end', reason: 'completed' },
];

function receive(message: HostToWebview): void {
  useTarsStore.getState().receive(message);
}

/**
 * Builds a `ready` announcing a version this bundle cannot read.
 *
 * `ReadyMessage` pins `protocolVersion` to the literal the bundle compiled
 * against, so the mismatch the store guards against is unrepresentable in the
 * type system: it can only arise between two differently-versioned builds — a
 * live window keeping a stale webview across an extension update. The cast
 * reproduces that cross-build condition, and is the only reason to write one.
 */
function staleReady(version: number): HostToWebview {
  return { type: 'ready', protocolVersion: version } as unknown as HostToWebview;
}

beforeEach(() => {
  resetTarsStore();
  vi.mocked(postToHost).mockClear();
});

describe('store protocol handling', () => {
  it('connects on a matching protocol version', () => {
    receive({ type: 'ready', protocolVersion: PROTOCOL_VERSION });

    expect(useTarsStore.getState().connected).toBe(true);
    expect(useTarsStore.getState().protocolMismatch).toBe(false);
  });

  it('surfaces an unknown protocol version instead of parsing the traffic', () => {
    receive(staleReady(99));

    const state = useTarsStore.getState();
    expect(state.connected).toBe(false);
    expect(state.protocolMismatch).toBe(true);
    expect(state.lastError).toContain('protocol mismatch');

    // And nothing after it is interpreted.
    receive({ type: 'session_state', sessionId: SESSION, busy: true, history: HISTORY });
    expect(useTarsStore.getState().transcript).toHaveLength(0);
    expect(useTarsStore.getState().sessionId).toBeNull();
  });
});

describe('store transcript', () => {
  it('renders a replayed session identically to a live one', () => {
    for (const event of HISTORY) {
      receive({ type: 'agent_event', event });
    }
    const live = [...useTarsStore.getState().transcript];

    resetTarsStore();
    receive({ type: 'session_state', sessionId: SESSION, busy: false, history: HISTORY });

    expect([...useTarsStore.getState().transcript]).toEqual(live);
    expect(useTarsStore.getState().sessionId).toBe(SESSION);
  });

  it('trusts the host for busy after a replay, since the log ends before the turn does', () => {
    receive({ type: 'session_state', sessionId: SESSION, busy: true, history: HISTORY });

    expect(useTarsStore.getState().busy).toBe(true);
  });

  it('bumps revision on every transcript change, because the array identity cannot', () => {
    const before = useTarsStore.getState().revision;
    const array = useTarsStore.getState().transcript;

    receive({
      type: 'agent_event',
      event: { sessionId: SESSION, turnId: TURN, at: 1, type: 'text_delta', text: 'hi' },
    });

    expect(useTarsStore.getState().revision).toBe(before + 1);
    expect(useTarsStore.getState().transcript).toBe(array);
  });

  it('adds and retires permission prompts', () => {
    receive({
      type: 'agent_event',
      event: {
        sessionId: SESSION,
        turnId: TURN,
        at: 1,
        type: 'permission_request',
        requestId: 'r1',
        toolName: 'Bash',
        input: { command: 'ls' },
        affectedPaths: ['src'],
        defaultPolicy: 'ask',
      },
    });
    expect(useTarsStore.getState().pendingPermissions).toHaveLength(1);

    receive({ type: 'permission_resolved', requestId: 'r1', decision: 'deny' });
    expect(useTarsStore.getState().pendingPermissions).toHaveLength(0);
  });

  it('places a host failure in the transcript', () => {
    receive({ type: 'host_error', message: 'claude CLI not found' });

    expect(useTarsStore.getState().transcript[0]).toMatchObject({
      kind: 'error',
      message: 'claude CLI not found',
    });
    expect(useTarsStore.getState().lastError).toBe('claude CLI not found');
  });

  it('applies host configuration', () => {
    receive({ type: 'config', permissionPolicy: 'always_allow', workspaceName: 'tars' });

    expect(useTarsStore.getState().permissionPolicy).toBe('always_allow');
    expect(useTarsStore.getState().workspaceName).toBe('tars');
  });
});

describe('store sendPrompt', () => {
  it('echoes the prompt, locks the input and hands the text to the host', () => {
    useTarsStore.getState().sendPrompt('  fix the build  ');

    expect(useTarsStore.getState().transcript[0]).toMatchObject({
      kind: 'user',
      text: 'fix the build',
    });
    expect(useTarsStore.getState().busy).toBe(true);
    expect(vi.mocked(postToHost)).toHaveBeenCalledWith({
      type: 'send_prompt',
      text: 'fix the build',
      context: [],
    });
  });

  it('drops an empty prompt and a prompt sent during a turn', () => {
    useTarsStore.getState().sendPrompt('   ');
    expect(vi.mocked(postToHost)).not.toHaveBeenCalled();

    useTarsStore.setState({ busy: true });
    useTarsStore.getState().sendPrompt('later');
    expect(vi.mocked(postToHost)).not.toHaveBeenCalled();
    expect(useTarsStore.getState().transcript).toHaveLength(0);
  });
});
