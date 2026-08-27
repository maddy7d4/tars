import { memo, type JSX } from 'react';
import type { AssistantItem } from '../store.js';

interface AssistantMessageProps {
  readonly item: AssistantItem;
}

/**
 * One block of assistant prose.
 *
 * Memoized on the item reference: a token append replaces exactly one item, so the
 * whole scrollback re-renders as a list of cache hits and only the live block paints.
 */
export const AssistantMessage = memo(function AssistantMessage({
  item,
}: AssistantMessageProps): JSX.Element {
  return (
    <article aria-label="TARS" aria-busy={item.streaming} className="px-3 py-2">
      <p className="whitespace-pre-wrap break-words">
        {item.text}
        {item.streaming && (
          // A caret rather than a spinner: it sits inline with the text, so it cannot
          // shift layout as tokens arrive, and it disappears the moment the block closes.
          <span aria-hidden="true" className="ml-0.5 inline-block animate-pulse">
            ▍
          </span>
        )}
      </p>
    </article>
  );
});
