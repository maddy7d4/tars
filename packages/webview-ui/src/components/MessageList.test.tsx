import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { toSessionId, toTurnId, type AgentEvent } from '@tars/shared';
import { resetTarsStore, useTarsStore } from '../store.js';
import { MessageList } from './MessageList.js';

vi.mock('../vscode-api.js', () => ({ postToHost: vi.fn(), isInsideWebview: false }));

const SESSION = toSessionId('session-1');
const TURN = toTurnId('turn-1');

function feed(...events: readonly AgentEvent[]): void {
  for (const event of events) {
    useTarsStore.getState().receive({ type: 'agent_event', event });
  }
}

const base = { sessionId: SESSION, turnId: TURN, at: 1 } as const;

beforeEach(() => {
  resetTarsStore();
});

describe('MessageList', () => {
  it('invites a first prompt when the transcript is empty', () => {
    render(<MessageList />);
    expect(screen.getByText(/Ask TARS about this workspace/)).toBeTruthy();
  });

  it('renders every item kind the reducer can produce', () => {
    useTarsStore.getState().sendPrompt('do the thing');
    feed(
      { ...base, type: 'text_delta', text: 'working on it' },
      { ...base, type: 'thinking_start' },
      { ...base, type: 'thinking_delta', text: 'considering' },
      { ...base, type: 'thinking_end' },
      { ...base, type: 'tool_call_start', toolCallId: 'c1', toolName: 'Read' },
      {
        ...base,
        type: 'tool_call_result',
        toolCallId: 'c1',
        toolName: 'Read',
        isError: false,
        content: 'file body',
        durationMs: 12,
      },
      { ...base, type: 'plan_update', steps: [{ id: 's1', title: 'Write the test', status: 'completed' }] },
      { ...base, type: 'file_edit_proposed', path: 'src/a.ts', afterContent: 'x\ny', beforeHash: 'h' },
      { ...base, type: 'error', message: 'the model refused', code: 'refusal', retryable: false },
    );

    render(<MessageList />);

    expect(screen.getByText('do the thing')).toBeTruthy();
    expect(screen.getByText(/working on it/)).toBeTruthy();
    expect(screen.getByText('Thought')).toBeTruthy();
    expect(screen.getByText('Read')).toBeTruthy();
    expect(screen.getByText('Plan (1/1)')).toBeTruthy();
    expect(screen.getByText('Write the test')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'src/a.ts' })).toBeTruthy();
    expect(screen.getByRole('alert').textContent).toContain('the model refused');
  });

  it('keeps the items in arrival order, since prose and tool calls interleave', () => {
    feed(
      { ...base, type: 'text_delta', text: 'before' },
      { ...base, type: 'tool_call_start', toolCallId: 'c1', toolName: 'Grep' },
      { ...base, type: 'text_delta', text: 'after' },
    );

    render(<MessageList />);
    const text = screen.getByRole('log').textContent ?? '';

    expect(text.indexOf('before')).toBeLessThan(text.indexOf('Grep'));
    expect(text.indexOf('Grep')).toBeLessThan(text.indexOf('after'));
  });

  it('marks a streaming block busy and clears it when the turn ends', () => {
    feed({ ...base, type: 'text_delta', text: 'partial' });
    const { rerender } = render(<MessageList />);
    expect(screen.getByLabelText('TARS').getAttribute('aria-busy')).toBe('true');

    feed({ ...base, type: 'turn_end', reason: 'completed' });
    rerender(<MessageList />);
    expect(screen.getByLabelText('TARS').getAttribute('aria-busy')).toBe('false');
  });
});
