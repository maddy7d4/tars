import type { JSX } from 'react';
import type { PendingChangeSummary } from '@tars/shared';
import { useTarsStore } from '../store.js';
import { postToHost } from '../vscode-api.js';

const KIND_GLYPH: Record<PendingChangeSummary['kind'], string> = {
  create: '+',
  modify: '±',
  delete: '−',
};

const KIND_LABEL: Record<PendingChangeSummary['kind'], string> = {
  create: 'created',
  modify: 'modified',
  delete: 'deleted',
};

/**
 * The review surface for what the agent changed (Docs/TARS_SPEC.md §6).
 *
 * The verbs are Keep and Revert rather than Apply and Discard, and that wording
 * is load-bearing: Claude Code's file tools write to the workspace themselves,
 * so these files are already on disk. Offering "Apply" would tell the user the
 * change is still pending when it is not, and someone who closed the panel
 * believing nothing had happened would be wrong in the most expensive direction.
 *
 * Revert restores the checkpoint taken before the turn's first write, and lands
 * as a `WorkspaceEdit`, so reverting by mistake is itself undoable with Ctrl+Z.
 */
export function ReviewBar(): JSX.Element | null {
  const changes = useTarsStore((state) => state.pendingChanges);
  const added = useTarsStore((state) => state.pendingAdded);
  const removed = useTarsStore((state) => state.pendingRemoved);

  if (changes.length === 0) {
    return null;
  }

  const stale = changes.filter((change) => change.stale).length;

  return (
    <section
      aria-label="Changes to review"
      className="border-t border-panel-border bg-widget-bg px-3 py-2"
    >
      <div className="flex items-baseline gap-2">
        <h2 className="font-mono">
          {changes.length} file{changes.length === 1 ? '' : 's'} changed
        </h2>
        <span className="text-success-fg">+{added}</span>
        <span className="text-error-fg">−{removed}</span>
      </div>

      <ul className="mt-1 flex max-h-40 flex-col overflow-y-auto">
        {changes.map((change) => (
          <li key={change.path} className="flex items-center gap-2">
            <span aria-hidden="true" className={change.stale ? 'text-warning-fg' : ''}>
              {KIND_GLYPH[change.kind]}
            </span>
            <button
              type="button"
              title={`Open a diff of ${change.path}`}
              onClick={() => {
                postToHost({ type: 'review_action', action: 'review', path: change.path });
              }}
              className="min-w-0 flex-1 truncate rounded px-1 text-left font-mono text-link-fg underline decoration-dotted underline-offset-2 hover:bg-hover-bg hover:text-link-active-fg focus-visible:outline-2 focus-visible:outline-focus-border"
            >
              {change.path}
            </button>
            <span className="sr-only">{KIND_LABEL[change.kind]}</span>
            <span className="text-description-fg">
              +{change.added} −{change.removed}
            </span>
          </li>
        ))}
      </ul>

      {stale > 0 && (
        // Worth its own line: a stale entry means the file moved between the
        // agent reading it and writing it, so what is on disk now may be a
        // silent overwrite of someone else's edit.
        <p role="status" className="mt-1 text-warning-fg">
          {stale} file{stale === 1 ? '' : 's'} changed after TARS read {stale === 1 ? 'it' : 'them'}.
          Review before keeping.
        </p>
      )}

      <div className="mt-2 flex items-center gap-2">
        <button
          type="button"
          onClick={() => {
            postToHost({ type: 'review_action', action: 'revert' });
          }}
          title="Restore every file to how it was before this turn"
          className="rounded bg-secondary-bg px-3 py-1 text-secondary-fg hover:bg-secondary-hover-bg focus-visible:outline-2 focus-visible:outline-focus-border"
        >
          Revert
        </button>
        <button
          type="button"
          onClick={() => {
            postToHost({ type: 'review_action', action: 'keep' });
          }}
          className="rounded bg-button-bg px-3 py-1 text-button-fg hover:bg-button-hover-bg focus-visible:outline-2 focus-visible:outline-focus-border"
        >
          Keep
        </button>
        <span className="text-description-fg">already written to disk</span>
      </div>
    </section>
  );
}
