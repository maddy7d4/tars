import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { resetTarsStore, useTarsStore } from '../store.js';
import { postToHost } from '../vscode-api.js';
import { PromptInput } from './PromptInput.js';

vi.mock('../vscode-api.js', () => ({ postToHost: vi.fn(), isInsideWebview: false }));

const CONNECTED = { connected: true, busy: false } as const;

beforeEach(() => {
  resetTarsStore();
  vi.mocked(postToHost).mockClear();
});

function box(): HTMLTextAreaElement {
  return screen.getByLabelText('Message TARS');
}

describe('PromptInput', () => {
  it('submits on Enter and clears the box', async () => {
    useTarsStore.setState(CONNECTED);
    render(<PromptInput />);

    await userEvent.type(box(), 'fix the build{Enter}');

    expect(vi.mocked(postToHost)).toHaveBeenCalledWith({
      type: 'send_prompt',
      text: 'fix the build',
      context: [],
    });
    expect(box().value).toBe('');
  });

  it('inserts a newline on Shift+Enter instead of sending', async () => {
    useTarsStore.setState(CONNECTED);
    render(<PromptInput />);

    await userEvent.type(box(), 'one{Shift>}{Enter}{/Shift}two');

    expect(vi.mocked(postToHost)).not.toHaveBeenCalled();
    expect(box().value).toBe('one\ntwo');
  });

  it('ignores Enter that is committing an IME candidate', async () => {
    useTarsStore.setState(CONNECTED);
    render(<PromptInput />);
    const textarea = box();
    await userEvent.type(textarea, 'にほんご');

    // React's synthetic event drops `isComposing`, which is why the component reads
    // the native one. Dispatching natively is the only way to reproduce mid-IME Enter.
    textarea.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, composed: true, isComposing: true }),
    );

    expect(vi.mocked(postToHost)).not.toHaveBeenCalled();
    expect(textarea.value).toBe('にほんご');
  });

  it('refuses to send whitespace', async () => {
    useTarsStore.setState(CONNECTED);
    render(<PromptInput />);

    await userEvent.type(box(), '   {Enter}');

    expect(vi.mocked(postToHost)).not.toHaveBeenCalled();
  });

  it('keeps Send disabled until there is text and a connection', async () => {
    render(<PromptInput />);
    const send = (): HTMLButtonElement => screen.getByRole('button', { name: 'Send' });

    expect(send().disabled).toBe(true);

    await userEvent.type(box(), 'hello');
    // Text alone is not enough: the host owns every privilege, so a prompt sent
    // before `ready` would be dropped on the floor with no feedback.
    expect(send().disabled).toBe(true);

    // Written from outside React, so the update has to be flushed before asserting.
    act(() => {
      useTarsStore.setState({ connected: true });
    });
    expect(send().disabled).toBe(false);
  });

  it('replaces Send with Stop during a turn, and locks the box', () => {
    useTarsStore.setState({ connected: true, busy: true });
    render(<PromptInput />);

    expect(screen.queryByRole('button', { name: 'Send' })).toBeNull();
    expect(box().disabled).toBe(true);
    expect(screen.getByRole('button', { name: 'Stop' })).toBeTruthy();
  });

  it('interrupts the turn from Stop', async () => {
    useTarsStore.setState({ connected: true, busy: true });
    render(<PromptInput />);

    await userEvent.click(screen.getByRole('button', { name: 'Stop' }));

    expect(vi.mocked(postToHost)).toHaveBeenCalledWith({ type: 'interrupt' });
  });
});
