import { useCallback, useState, type FormEvent, type JSX, type KeyboardEvent } from 'react';
import { useTarsStore } from '../store.js';
import { postToHost } from '../vscode-api.js';

export function PromptInput(): JSX.Element {
  const busy = useTarsStore((state) => state.busy);
  const connected = useTarsStore((state) => state.connected);
  const sendPrompt = useTarsStore((state) => state.sendPrompt);
  const [text, setText] = useState('');

  const submit = useCallback(() => {
    if (busy || text.trim() === '') {
      return;
    }
    sendPrompt(text);
    setText('');
  }, [busy, sendPrompt, text]);

  const onSubmit = useCallback(
    (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      submit();
    },
    [submit],
  );

  const onKeyDown = useCallback(
    (event: KeyboardEvent<HTMLTextAreaElement>) => {
      // `isComposing` is why this reads the native event: mid-IME Enter commits a
      // candidate and must never submit, and React's synthetic event omits the flag.
      if (event.key !== 'Enter' || event.shiftKey || event.nativeEvent.isComposing) {
        return;
      }
      event.preventDefault();
      submit();
    },
    [submit],
  );

  return (
    <form onSubmit={onSubmit} className="border-t border-panel-border px-3 py-2">
      <label htmlFor="tars-prompt" className="sr-only">
        Message TARS
      </label>
      <textarea
        id="tars-prompt"
        value={text}
        rows={3}
        disabled={busy}
        placeholder={busy ? 'TARS is working…' : 'Ask TARS… (Enter to send, Shift+Enter for a new line)'}
        onChange={(event) => {
          setText(event.target.value);
        }}
        onKeyDown={onKeyDown}
        className="w-full resize-y rounded border border-input-border bg-input-bg px-2 py-1 font-sans text-input-fg placeholder:text-input-placeholder-fg focus-visible:outline-2 focus-visible:outline-focus-border disabled:opacity-60"
      />

      <div className="mt-1 flex items-center justify-end gap-2">
        {busy ? (
          // Interrupting is the only control that stays live during a turn, so it
          // replaces Send rather than sitting beside it — one button, one meaning.
          <button
            type="button"
            onClick={() => {
              postToHost({ type: 'interrupt' });
            }}
            className="rounded bg-secondary-bg px-3 py-1 text-secondary-fg hover:bg-secondary-hover-bg focus-visible:outline-2 focus-visible:outline-focus-border"
          >
            Stop
          </button>
        ) : (
          <button
            type="submit"
            disabled={!connected || text.trim() === ''}
            className="rounded bg-button-bg px-3 py-1 text-button-fg hover:bg-button-hover-bg focus-visible:outline-2 focus-visible:outline-focus-border disabled:opacity-50"
          >
            Send
          </button>
        )}
      </div>
    </form>
  );
}
