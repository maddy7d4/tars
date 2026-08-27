import { useCallback, useLayoutEffect, useRef, type JSX } from 'react';
import { assertNever } from '@tars/shared';
import { useTarsStore, useTranscript, type TranscriptItem } from '../store.js';
import { AssistantMessage } from './AssistantMessage.js';
import { ErrorItem } from './ErrorItem.js';
import { FileEditItem } from './FileEditItem.js';
import { PlanView } from './PlanView.js';
import { ThinkingBlock } from './ThinkingBlock.js';
import { ToolCall } from './ToolCall.js';
import { UserMessage } from './UserMessage.js';

/**
 * How close to the bottom still counts as "following along". A few pixels of slack
 * absorbs sub-pixel rounding and the reflow a just-arrived token causes, which would
 * otherwise unpin a user who never moved.
 */
const PIN_SLACK_PX = 32;

function renderItem(item: TranscriptItem): JSX.Element {
  switch (item.kind) {
    case 'user':
      return <UserMessage key={item.id} item={item} />;
    case 'assistant':
      return <AssistantMessage key={item.id} item={item} />;
    case 'thinking':
      return <ThinkingBlock key={item.id} item={item} />;
    case 'tool_call':
      return <ToolCall key={item.id} item={item} />;
    case 'plan':
      return <PlanView key={item.id} item={item} />;
    case 'file_edit':
      return <FileEditItem key={item.id} item={item} />;
    case 'error':
      return <ErrorItem key={item.id} item={item} />;
    default:
      return assertNever(item);
  }
}

export function MessageList(): JSX.Element {
  const items = useTranscript();
  // The transcript array is mutated in place so streaming stays O(1), so the
  // revision counter — not the array — is what says "something changed".
  const revision = useTarsStore((state) => state.revision);
  const containerRef = useRef<HTMLDivElement>(null);
  /**
   * Whether the view is following the stream. A ref, not state: it changes on every
   * scroll event and nothing renders differently because of it, so making it state
   * would re-render the entire transcript while the user drags a scrollbar.
   */
  const pinnedRef = useRef(true);

  const handleScroll = useCallback(() => {
    const element = containerRef.current;
    if (element === null) {
      return;
    }
    pinnedRef.current =
      element.scrollHeight - element.scrollTop - element.clientHeight <= PIN_SLACK_PX;
  }, []);

  useLayoutEffect(() => {
    const element = containerRef.current;
    // Only chase the bottom when the user was already there. Scrolling someone back
    // down mid-read while an agent streams for a minute is the fastest way to make
    // a chat UI unusable, and it cannot be undone by the user — the next token wins.
    if (element === null || !pinnedRef.current) {
      return;
    }
    element.scrollTop = element.scrollHeight;
  }, [revision]);

  return (
    <div
      ref={containerRef}
      onScroll={handleScroll}
      role="log"
      aria-live="polite"
      aria-label="Conversation"
      className="flex-1 overflow-y-auto py-2"
    >
      {items.length === 0 ? (
        <p className="px-3 py-2 text-description-fg">
          Ask TARS about this workspace. Attach files with @, or just describe what you want changed.
        </p>
      ) : (
        items.map(renderItem)
      )}
    </div>
  );
}
