import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { MentionCandidate } from '@tars/shared';
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

/**
 * `@`-mention completion.
 *
 * The popup is driven entirely from the caret, so these exercise it through real
 * typing rather than by setting store state: the bug worth catching is a list
 * that opens or closes at the wrong moment, and that only shows up in the
 * interaction.
 */
function candidates(): readonly MentionCandidate[] {
  return [
    { kind: 'file', label: 'index.ts', insert: 'src/index.ts', detail: 'src' },
    { kind: 'file', label: 'index.test.ts', insert: 'src/index.test.ts', detail: 'src' },
    { kind: 'selection', label: 'selection', insert: 'selection', detail: 'the code you selected' },
  ];
}

function respond(query: string): void {
  act(() => {
    useTarsStore.getState().receive({ type: 'mention_results', query, candidates: candidates() });
  });
}

describe('PromptInput mentions', () => {
  it('asks the host for completions as the mention is typed', async () => {
    useTarsStore.setState(CONNECTED);
    render(<PromptInput />);

    await userEvent.type(box(), 'open @ind');

    expect(vi.mocked(postToHost)).toHaveBeenCalledWith({ type: 'mention_query', query: 'ind' });
  });

  it('opens the list only once candidates arrive', async () => {
    useTarsStore.setState(CONNECTED);
    render(<PromptInput />);

    await userEvent.type(box(), 'open @ind');
    // The query is in flight; nothing is shown until there is something to show.
    expect(screen.queryByRole('listbox')).toBeNull();

    respond('ind');
    expect(screen.getByRole('listbox')).toBeTruthy();
    expect(screen.getAllByRole('option')).toHaveLength(3);
  });

  it('ignores a reply for a prefix the user has already typed past', async () => {
    useTarsStore.setState(CONNECTED);
    render(<PromptInput />);
    await userEvent.type(box(), 'open @index');

    // A slow language server answering "ind" must not repopulate the list with
    // matches for text that is no longer on screen.
    respond('ind');
    expect(screen.queryByRole('listbox')).toBeNull();
  });

  it('completes the mention into the prompt when a candidate is picked', async () => {
    useTarsStore.setState(CONNECTED);
    render(<PromptInput />);
    await userEvent.type(box(), 'open @ind');
    respond('ind');

    await userEvent.click(screen.getByRole('option', { name: /index\.ts src/ }));

    // The full path is inserted, not the label the user was shown.
    expect(box().value).toBe('open @src/index.ts ');
    expect(screen.queryByRole('listbox')).toBeNull();
  });

  it('marks the input as a combobox and announces the highlighted option', async () => {
    useTarsStore.setState(CONNECTED);
    render(<PromptInput />);
    await userEvent.type(box(), 'open @ind');
    respond('ind');

    // Focus stays in the textarea, so the ARIA combobox pattern is what makes
    // the list usable without sight.
    expect(box().getAttribute('aria-expanded')).toBe('true');
    expect(box().getAttribute('aria-activedescendant')).toBe('tars-mention-popup-option-0');
  });

  it('moves the highlight with the arrow keys and wraps around', async () => {
    useTarsStore.setState(CONNECTED);
    render(<PromptInput />);
    await userEvent.type(box(), 'open @ind');
    respond('ind');

    await userEvent.keyboard('{ArrowDown}');
    expect(box().getAttribute('aria-activedescendant')).toBe('tars-mention-popup-option-1');

    await userEvent.keyboard('{ArrowUp}{ArrowUp}');
    expect(box().getAttribute('aria-activedescendant')).toBe('tars-mention-popup-option-2');
  });

  it('accepts the highlighted candidate on Enter instead of sending', async () => {
    useTarsStore.setState(CONNECTED);
    render(<PromptInput />);
    await userEvent.type(box(), 'open @ind');
    respond('ind');

    await userEvent.keyboard('{Enter}');

    // Enter belongs to the popup while it is open; sending here would submit a
    // half-typed mention the user was in the middle of choosing.
    expect(box().value).toBe('open @src/index.ts ');
    expect(vi.mocked(postToHost)).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: 'send_prompt' }),
    );
  });

  it('accepts on Tab as well', async () => {
    useTarsStore.setState(CONNECTED);
    render(<PromptInput />);
    await userEvent.type(box(), 'open @ind');
    respond('ind');

    await userEvent.keyboard('{Tab}');
    expect(box().value).toBe('open @src/index.ts ');
  });

  it('dismisses on Escape without changing the prompt', async () => {
    useTarsStore.setState(CONNECTED);
    render(<PromptInput />);
    await userEvent.type(box(), 'open @ind');
    respond('ind');

    await userEvent.keyboard('{Escape}');

    expect(screen.queryByRole('listbox')).toBeNull();
    expect(box().value).toBe('open @ind');
  });

  it('sends normally once the popup is closed', async () => {
    useTarsStore.setState(CONNECTED);
    render(<PromptInput />);
    await userEvent.type(box(), 'open @ind');
    respond('ind');
    await userEvent.keyboard('{Escape}');
    await userEvent.keyboard('{Enter}');

    expect(vi.mocked(postToHost)).toHaveBeenCalledWith({
      type: 'send_prompt',
      text: 'open @ind',
      context: [],
    });
  });

  it('does not treat an email address as a mention', async () => {
    useTarsStore.setState(CONNECTED);
    render(<PromptInput />);

    await userEvent.type(box(), 'mail me@example');

    expect(vi.mocked(postToHost)).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: 'mention_query' }),
    );
  });

  it('closes the list when the mention is finished with a space', async () => {
    useTarsStore.setState(CONNECTED);
    render(<PromptInput />);
    await userEvent.type(box(), 'open @ind');
    respond('ind');
    expect(screen.getByRole('listbox')).toBeTruthy();

    await userEvent.type(box(), ' ');
    expect(screen.queryByRole('listbox')).toBeNull();
  });
});

describe('PromptInput mention caret tracking', () => {
  it('re-queries when the caret moves out of the mention it is showing', async () => {
    useTarsStore.setState(CONNECTED);
    render(<PromptInput />);
    await userEvent.type(box(), 'open @ind');
    respond('ind');
    expect(screen.getByRole('listbox')).toBeTruthy();

    vi.mocked(postToHost).mockClear();
    // Left past the `@` leaves the mention entirely. Vertical arrows belong to
    // the popup while it is open, but horizontal ones still move the caret.
    await userEvent.keyboard('{ArrowLeft>5/}');

    expect(screen.queryByRole('listbox')).toBeNull();
  });

  it('re-queries with the shorter prefix when the caret moves inside the mention', async () => {
    useTarsStore.setState(CONNECTED);
    render(<PromptInput />);
    await userEvent.type(box(), 'open @index');
    respond('index');

    vi.mocked(postToHost).mockClear();
    await userEvent.keyboard('{ArrowLeft}{ArrowLeft}');

    // Otherwise the list keeps offering completions for the mention behind you.
    expect(vi.mocked(postToHost)).toHaveBeenCalledWith({ type: 'mention_query', query: 'ind' });
  });
});
