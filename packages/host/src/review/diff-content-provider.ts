import * as vscode from 'vscode';

/**
 * Serves the "before" side of a proposed edit to VS Code's diff editor
 * (Docs/TARS_SPEC.md §6.2).
 *
 * TARS contributes the review *workflow*, not a diff renderer. The editor
 * already ships one that is accessible, theme-aware, and configured to the
 * user's own diff settings; reimplementing it in the webview would duplicate all
 * of that and then diverge from it. What the native viewer needs is two
 * documents, and a proposed edit only has one that exists on disk — so the
 * baseline is served from memory through a virtual document.
 *
 * The scheme is registered read-only. A user editing the left-hand pane of a
 * diff would be editing a snapshot that no longer corresponds to anything, and
 * the edit would vanish without explanation on the next refresh.
 */
export const TARS_DIFF_SCHEME = 'tars-diff';

export class DiffContentProvider implements vscode.TextDocumentContentProvider, vscode.Disposable {
  private readonly contents = new Map<string, string>();
  private readonly emitter = new vscode.EventEmitter<vscode.Uri>();
  private readonly registration: vscode.Disposable;

  readonly onDidChange = this.emitter.event;

  constructor() {
    this.registration = vscode.workspace.registerTextDocumentContentProvider(
      TARS_DIFF_SCHEME,
      this,
    );
  }

  /**
   * Publishes baseline content and returns the URI that serves it.
   *
   * Keyed by the real workspace path so the diff tab's label reads as the file
   * the user is reviewing rather than an opaque id, and so republishing the same
   * file replaces its content instead of accumulating stale tabs.
   */
  publish(path: string, content: string): vscode.Uri {
    const uri = this.uriFor(path);
    const key = uri.toString();
    const changed = this.contents.get(key) !== content;
    this.contents.set(key, content);
    if (changed) {
      // Only when it actually changed: firing unconditionally makes the editor
      // re-read on every publish, which flickers an open diff for no reason.
      this.emitter.fire(uri);
    }
    return uri;
  }

  provideTextDocumentContent(uri: vscode.Uri): string {
    // An unknown URI means the tab outlived the review it belonged to — a window
    // restored with a diff open, say. Empty content renders as "everything was
    // added", which is misleading, so this says plainly what happened.
    return (
      this.contents.get(uri.toString()) ??
      '// TARS: the baseline for this diff is no longer available.\n' +
        '// The review it belonged to has ended; close this tab and ask again.\n'
    );
  }

  /** Drops one baseline once its review is over. */
  retract(path: string): void {
    this.contents.delete(this.uriFor(path).toString());
  }

  /** Drops every baseline, e.g. when the session is discarded. */
  clear(): void {
    this.contents.clear();
  }

  private uriFor(path: string): vscode.Uri {
    return vscode.Uri.from({ scheme: TARS_DIFF_SCHEME, path: `/${path}` });
  }

  dispose(): void {
    this.registration.dispose();
    this.emitter.dispose();
    this.contents.clear();
  }
}
