import { memo, type JSX } from 'react';
import type { FileEditItem as FileEditData } from '../store.js';
import { FilePath } from './FilePath.js';

interface FileEditItemProps {
  readonly item: FileEditData;
}

/**
 * A proposed edit. Deliberately a pointer, not a diff: review happens in the native
 * diff editor the host opens (Docs/TARS_SPEC.md §6.2), which already has the user's
 * syntax highlighting, keybindings and merge affordances.
 */
export const FileEditItem = memo(function FileEditItem({ item }: FileEditItemProps): JSX.Element {
  return (
    <div className="mx-3 my-1 flex items-center gap-2 rounded border border-widget-border bg-widget-bg px-2 py-1">
      <span aria-hidden="true" className={item.isNewFile ? 'text-success-fg' : 'text-warning-fg'}>
        {item.isNewFile ? '+' : '±'}
      </span>
      <FilePath path={item.path} />
      <span className="text-description-fg">{item.summary}</span>
    </div>
  );
});
