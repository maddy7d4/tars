import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { resetTarsStore, useTarsStore } from '../store.js';
import { postToHost } from '../vscode-api.js';
import { StatusHeader } from './StatusHeader.js';

vi.mock('../vscode-api.js', () => ({ postToHost: vi.fn(), isInsideWebview: false }));

beforeEach(() => {
  resetTarsStore();
  vi.mocked(postToHost).mockClear();
});

describe('StatusHeader', () => {
  it('reports the three connection states in words, not only colour', () => {
    const { rerender } = render(<StatusHeader />);
    expect(screen.getByText('connecting')).toBeTruthy();

    useTarsStore.setState({ connected: true });
    rerender(<StatusHeader />);
    expect(screen.getByText('ready')).toBeTruthy();

    useTarsStore.setState({ busy: true });
    rerender(<StatusHeader />);
    expect(screen.getByText('working')).toBeTruthy();
  });

  it('says so plainly when there is no workspace', () => {
    render(<StatusHeader />);
    expect(screen.getByText('no workspace')).toBeTruthy();
  });

  it('shows token usage only once the host has reported any', () => {
    const { rerender } = render(<StatusHeader />);
    expect(screen.queryByTitle('input / output tokens this turn')).toBeNull();

    useTarsStore.setState({
      usage: { inputTokens: 120, outputTokens: 34, cacheReadTokens: 0, cacheCreationTokens: 0 },
    });
    rerender(<StatusHeader />);
    expect(screen.getByTitle('input / output tokens this turn').textContent).toContain('120');
  });

  it('asks the host for a new session', async () => {
    render(<StatusHeader />);
    await userEvent.click(screen.getByRole('button', { name: 'New session' }));

    expect(vi.mocked(postToHost)).toHaveBeenCalledWith({ type: 'new_session' });
  });
});
