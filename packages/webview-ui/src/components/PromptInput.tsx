import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type FormEvent,
  type JSX,
  type KeyboardEvent,
} from 'react';
import type { MentionCandidate } from '@tars/shared';
import { applyCompletion, mentionAtCaret, type ActiveMention } from '../mention-input.js';
import { useTarsStore } from '../store.js';
import { postToHost } from '../vscode-api.js';
import { MentionPopup } from './MentionPopup.js';

const POPUP_ID = 'tars-mention-popup';

export function PromptInput(): JSX.Element {
  const busy = useTarsStore((state) => state.busy);
  const connected = useTarsStore((state) => state.connected);
  const sendPrompt = useTarsStore((state) => state.sendPrompt);
  const queryMentions = useTarsStore((state) => state.queryMentions);
  const candidates = useTarsStore((state) => state.mentionCandidates);

  const [text, setText] = useState('');
  const [mention, setMention] = useState<ActiveMention | null>(null);
  const [activeIndex, setActiveIndex] = useState(0);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const open = mention !== null && candidates.length > 0;

  /**
   * Re-reads the mention under the caret after any input or navigation.
   *
   * Driven from the element rather than from `text`, because moving the caret
   * with an arrow key changes what is being mentioned without changing a
   * character of the prompt.
   */
  const syncMention = useCallback(
    (element: HTMLTextAreaElement) => {
      const found = mentionAtCaret(element.value, element.selectionStart);
      setMention(found);
      setActiveIndex(0);
      queryMentions(found === null ? null : found.query);
    },
    [queryMentions],
  );

  const submit = useCallback(() => {
    if (busy || text.trim() === '') {
      return;
    }
    sendPrompt(text);
    setText('');
    setMention(null);
    queryMentions(null);
  }, [busy, queryMentions, sendPrompt, text]);

  const onSubmit = useCallback(
    (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      submit();
    },
    [submit],
  );

  const accept = useCallback(
    (candidate: MentionCandidate) => {
      if (mention === null) {
        return;
      }
      const result = applyCompletion(text, mention, candidate.insert);
      setText(result.text);
      setMention(null);
      queryMentions(null);
      // The caret is restored after React has painted the new value; setting it
      // now would be overwritten when the controlled value lands.
      requestAnimationFrame(() => {
        const element = textareaRef.current;
        element?.focus();
        element?.setSelectionRange(result.caret, result.caret);
      });
    },
    [mention, queryMentions, text],
  );

  const onKeyDown = useCallback(
    (event: KeyboardEvent<HTMLTextAreaElement>) => {
      // The popup owns these keys while it is open. It has to: focus stays in
      // the textarea, so nothing else is in a position to receive them.
      if (open) {
        if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
          event.preventDefault();
          const step = event.key === 'ArrowDown' ? 1 : -1;
          setActiveIndex((index) => (index + step + candidates.length) % candidates.length);
          return;
        }
        if (event.key === 'Enter' || event.key === 'Tab') {
          const candidate = candidates[activeIndex];
          if (candidate !== undefined) {
            event.preventDefault();
            accept(candidate);
            return;
          }
        }
        if (event.key === 'Escape') {
          event.preventDefault();
          setMention(null);
          queryMentions(null);
          return;
        }
      }

      // `isComposing` is why this reads the native event: mid-IME Enter commits a
      // candidate and must never submit, and React's synthetic event omits the flag.
      if (event.key !== 'Enter' || event.shiftKey || event.nativeEvent.isComposing) {
        return;
      }
      event.preventDefault();
      submit();
    },
    [accept, activeIndex, candidates, open, queryMentions, submit],
  );

  useEffect(() => {
    // A turn starting disables the textarea, which would strand an open popup
    // over an input nobody can type into.
    if (busy) {
      setMention(null);
    }
  }, [busy]);

  return (
    <form onSubmit={onSubmit} className="border-t border-panel-border px-3 py-2">
      {open && (
        <MentionPopup
          id={POPUP_ID}
          candidates={candidates}
          activeIndex={activeIndex}
          onPick={accept}
        />
      )}

      <label htmlFor="tars-prompt" className="sr-only">
        Message TARS
      </label>
      <textarea
        id="tars-prompt"
        ref={textareaRef}
        value={text}
        rows={3}
        disabled={busy}
        placeholder={busy ? 'TARS is working…' : 'Ask TARS… (Enter to send, Shift+Enter for a new line)'}
        // The ARIA combobox pattern: the input keeps focus and announces the
        // highlighted option, so the list is usable without sight.
        role="combobox"
        aria-expanded={open}
        aria-controls={POPUP_ID}
        aria-autocomplete="list"
        aria-activedescendant={
          open ? `${POPUP_ID}-option-${String(activeIndex)}` : undefined
        }
        onChange={(event) => {
          setText(event.target.value);
          syncMention(event.target);
        }}
        onKeyUp={(event) => {
          // Arrow keys and clicks move the caret without changing the text, so
          // `onChange` alone would leave the popup showing the wrong mention.
          if (!open) {
            syncMention(event.currentTarget);
          }
        }}
        onClick={(event) => {
          syncMention(event.currentTarget);
        }}
        onBlur={() => {
          setMention(null);
          queryMentions(null);
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
