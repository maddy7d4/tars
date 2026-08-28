import * as vscode from 'vscode';
import type { FileWatcherPort, Unsubscribe, WatchedFileChange } from '@tars/core';

/**
 * `FileWatcherPort` over the editor's own watcher (Docs/TARS_SPEC.md §7.2).
 *
 * Uses `createFileSystemWatcher` rather than `fs.watch` because the editor's
 * watcher already honours the user's `files.watcherExclude`, coalesces bursts,
 * and handles recursive watching consistently across platforms. Rebuilding that
 * would mean re-solving a problem the editor has already solved, and getting it
 * subtly wrong on one OS.
 *
 * The glob is `**` across the whole workspace rather than one watcher per
 * folder: VS Code resolves a relative pattern against every workspace folder
 * itself, so a single watcher covers a multi-root workspace and keeps folder
 * changes from needing a re-subscription.
 */
export class VscodeFileWatcher implements FileWatcherPort {
  watch(listener: (change: WatchedFileChange) => void): Unsubscribe {
    const watcher = vscode.workspace.createFileSystemWatcher('**/*');

    const emit = (kind: WatchedFileChange['kind']) => (uri: vscode.Uri) => {
      // Only files on disk. The watcher also reports virtual documents — output
      // channels, git's own `gitfs:` URIs, our `tars-diff:` baselines — and
      // indexing those would put entries in the file index that no path resolves.
      if (uri.scheme !== 'file') {
        return;
      }
      listener({ kind, absolutePath: uri.fsPath, relativePath: relativeTo(uri) });
    };

    const subscriptions = [
      watcher.onDidCreate(emit('created')),
      watcher.onDidChange(emit('changed')),
      watcher.onDidDelete(emit('deleted')),
    ];

    return () => {
      for (const subscription of subscriptions) {
        subscription.dispose();
      }
      watcher.dispose();
    };
  }
}

/**
 * Workspace-relative path, or `null` when the file is outside every folder.
 *
 * `asRelativePath` is not usable here: it returns the absolute path unchanged
 * for a file outside the workspace, so it cannot express "outside" — and a
 * consumer would silently index an absolute path as if it were relative.
 */
function relativeTo(uri: vscode.Uri): string | null {
  const folder = vscode.workspace.getWorkspaceFolder(uri);
  if (folder === undefined) {
    return null;
  }
  const root = folder.uri.path.endsWith('/') ? folder.uri.path : `${folder.uri.path}/`;
  return uri.path.startsWith(root) ? uri.path.slice(root.length) : null;
}
