import { memo, type JSX } from 'react';
import type { ThinkingItem } from '../store.js';

interface ThinkingBlockProps {
  readonly item: ThinkingItem;
}

/**
 * Extended thinking, collapsed by default.
 *
 * `<details>` rather than a button plus conditional render: it is keyboard-operable
 * and announced correctly with no ARIA of our own, and its open state survives
 * re-renders, so a user reading a thinking block does not have it snap shut on the
 * next token.
 */
export const ThinkingBlock = memo(function ThinkingBlock({ item }: ThinkingBlockProps): JSX.Element {
  return (
    <details className="mx-3 my-1 rounded border border-widget-border bg-widget-bg">
      <summary className="flex items-center gap-2 px-2 py-1 text-description-fg hover:bg-hover-bg focus-visible:outline-2 focus-visible:outline-focus-border">
        <span aria-hidden="true">✻</span>
        <span>{item.streaming ? 'Thinking…' : 'Thought'}</span>
        <span className="text-description-fg">({item.text.length} chars)</span>
      </summary>
      <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-words px-3 py-2 font-mono text-description-fg">
        {item.text}
      </pre>
    </details>
  );
});
