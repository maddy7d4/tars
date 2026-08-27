import type { JSX } from 'react';
import { postToHost } from '../vscode-api.js';

interface FilePathProps {
  readonly path: string;
  readonly line?: number;
}

/**
 * A workspace path rendered as a real button.
 *
 * The webview cannot open a file and must not learn how: opening is a privileged
 * operation the host performs after re-resolving the path against the workspace
 * (Docs/TARS_SPEC.md §5.1). All this control does is state an intent.
 */
export function FilePath({ path, line }: FilePathProps): JSX.Element {
  return (
    <button
      type="button"
      title={`Open ${path}`}
      onClick={() => {
        // `exactOptionalPropertyTypes` forbids sending an explicit `undefined` line.
        postToHost(line === undefined ? { type: 'open_file', path } : { type: 'open_file', path, line });
      }}
      className="max-w-full truncate rounded px-1 font-mono text-link-fg underline decoration-dotted underline-offset-2 hover:text-link-active-fg hover:bg-hover-bg focus-visible:outline-2 focus-visible:outline-focus-border"
    >
      {path}
    </button>
  );
}
