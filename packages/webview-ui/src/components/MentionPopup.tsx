import { useEffect, useRef, type JSX } from 'react';
import type { MentionCandidate } from '@tars/shared';

const KIND_GLYPH: Record<MentionCandidate['kind'], string> = {
  file: '◇',
  symbol: '◈',
  selection: '▨',
  diagnostics: '⚠',
};

interface MentionPopupProps {
  readonly candidates: readonly MentionCandidate[];
  readonly activeIndex: number;
  readonly onPick: (candidate: MentionCandidate) => void;
  /** Id of the listbox, so the textarea can point `aria-controls` at it. */
  readonly id: string;
}

/**
 * The `@`-mention completion list.
 *
 * A `listbox` owned by the textarea rather than a focusable widget of its own:
 * focus must stay in the prompt while the user arrows through candidates, or
 * every keystroke would need to be forwarded back. That is also why selection is
 * announced with `aria-activedescendant` on the input — the ARIA combobox
 * pattern exists for exactly this shape, and following it is what makes the list
 * usable without sight.
 *
 * Rendered above the input because the input sits at the bottom of the panel; a
 * list below it would open off-screen.
 */
export function MentionPopup({
  candidates,
  activeIndex,
  onPick,
  id,
}: MentionPopupProps): JSX.Element | null {
  const activeRef = useRef<HTMLLIElement>(null);

  useEffect(() => {
    // Keeps the highlighted row in view while arrowing past the fold. `nearest`
    // rather than `center` so the list does not jump on every keypress.
    activeRef.current?.scrollIntoView({ block: 'nearest' });
  }, [activeIndex]);

  if (candidates.length === 0) {
    return null;
  }

  return (
    <ul
      id={id}
      role="listbox"
      aria-label="Mention suggestions"
      className="max-h-48 overflow-y-auto rounded border border-widget-border bg-widget-bg"
    >
      {candidates.map((candidate, index) => (
        <li
          key={`${candidate.kind}:${candidate.insert}:${candidate.label}`}
          id={`${id}-option-${String(index)}`}
          role="option"
          aria-selected={index === activeIndex}
          ref={index === activeIndex ? activeRef : null}
          // `onMouseDown` with the default prevented, not `onClick`: a click
          // would blur the textarea first, and blurring is what closes the list.
          onMouseDown={(event) => {
            event.preventDefault();
            onPick(candidate);
          }}
          className={`flex cursor-pointer items-baseline gap-2 px-2 py-1 ${
            index === activeIndex ? 'bg-list-active-bg text-list-active-fg' : 'hover:bg-hover-bg'
          }`}
        >
          <span aria-hidden="true" className="text-description-fg">
            {KIND_GLYPH[candidate.kind]}
          </span>
          <span className="font-mono">{candidate.label}</span>
          <span className="min-w-0 flex-1 truncate text-right text-description-fg">
            {candidate.detail}
          </span>
        </li>
      ))}
    </ul>
  );
}
