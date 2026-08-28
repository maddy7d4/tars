import type { Unsubscribe } from './workspace-port.js';

/**
 * What happened to a file.
 *
 * `changed` is carried alongside creation and deletion even though the file
 * index only cares about the set of paths: consumers that cache *content* —
 * a baseline under review, a read the agent is about to act on — need to know a
 * file moved underneath them, and a watcher that reported only the path set
 * could not tell them.
 */
export type FileChangeKind = 'created' | 'changed' | 'deleted';

export interface WatchedFileChange {
  readonly kind: FileChangeKind;
  /** Absolute filesystem path. */
  readonly absolutePath: string;
  /** Workspace-relative, or `null` when the file lies outside every folder. */
  readonly relativePath: string | null;
}

/**
 * Filesystem change notifications (Docs/TARS_SPEC.md §7.2).
 *
 * A port rather than a direct `createFileSystemWatcher` call because the file
 * index is core's, and core cannot see `vscode`. The host supplies the editor's
 * watcher, which already honours `files.watcherExclude` and coalesces events —
 * reimplementing that over `fs.watch` would mean re-solving cross-platform
 * recursive watching, which is not a problem TARS needs to own.
 */
export interface FileWatcherPort {
  /**
   * Watches every workspace folder. The returned function stops the watcher.
   *
   * One subscription per consumer rather than a shared event, so a consumer that
   * goes away releases the underlying watcher with it.
   */
  watch(listener: (change: WatchedFileChange) => void): Unsubscribe;
}
