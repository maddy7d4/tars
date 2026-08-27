import { memo, type JSX } from 'react';
import type { UserItem } from '../store.js';

interface UserMessageProps {
  readonly item: UserItem;
}

/**
 * The user's own prompt, echoed. Rendered with `whitespace-pre-wrap` rather than
 * any markup pass: prompt text is user input and never becomes markup.
 */
export const UserMessage = memo(function UserMessage({ item }: UserMessageProps): JSX.Element {
  return (
    <article aria-label="Your message" className="px-3 py-2">
      <div className="rounded border border-widget-border bg-quote-bg px-3 py-2">
        <p className="whitespace-pre-wrap break-words">{item.text}</p>
      </div>
    </article>
  );
});
