import { memo, type JSX } from 'react';
import type { ErrorItem as ErrorData } from '../store.js';

interface ErrorItemProps {
  readonly item: ErrorData;
}

/**
 * A failure, in the transcript at the point it happened.
 *
 * `role="alert"` because a turn dying silently mid-stream is indistinguishable from
 * a slow model; the user has to be told without having to notice.
 */
export const ErrorItem = memo(function ErrorItem({ item }: ErrorItemProps): JSX.Element {
  return (
    <div
      role="alert"
      className="mx-3 my-1 rounded border border-error-fg px-3 py-2 text-error-fg"
    >
      <p className="break-words">{item.message}</p>
      <p className="text-description-fg">
        <span className="font-mono">{item.code}</span>
        {item.retryable ? ' · retryable' : ''}
      </p>
    </div>
  );
});
