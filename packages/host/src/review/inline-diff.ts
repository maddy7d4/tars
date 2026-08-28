import * as vscode from 'vscode';
import { acceptAll, acceptHunk, rejectAll, rejectHunk, viewHunks, type DiffHunk } from '@tars/core';

/**
 * In-editor review of the agent's edits (Docs/TARS_SPEC.md §6.5).
 *
 * The agent's write has already landed in the file, so review happens where the
 * change is: coloured hunks in the editor with Accept and Reject on each one,
 * rather than a separate diff tab the user has to go and open. A change you have
 * to navigate to is a change most people will not look at.
 *
 * State is one string per file — the baseline. Hunks are never stored: they are
 * recomputed from `(baseline, document text)` whenever anything moves, so the
 * user can type in the middle of a review, undo, save, or let the agent write
 * again, and the next render is simply correct. A cached hunk range would be
 * wrong after the first decision.
 *
 * ### On rendering deletions
 *
 * Removed lines are not in the document, and VS Code's public API has no way to
 * insert a phantom line — the editors that show deletions as red rows do it by
 * patching the editor itself, which TARS will not do (constraint C1). So a
 * deletion is rendered as a red marker on the line that replaced it, carrying
 * the removed text in an `after` decoration and the full block in the hover. It
 * is less pretty than a phantom row and it loses nothing: the removed content is
 * still readable in place, and "Open full diff" is one click away for anything
 * large.
 */

const ADDED = vscode.window.createTextEditorDecorationType({
  backgroundColor: new vscode.ThemeColor('diffEditor.insertedLineBackground'),
  isWholeLine: true,
  overviewRulerColor: new vscode.ThemeColor('diffEditor.insertedTextBackground'),
  overviewRulerLane: vscode.OverviewRulerLane.Left,
});

const REMOVED = vscode.window.createTextEditorDecorationType({
  // Not whole-line: this marks the line that *replaced* the removed content, so
  // colouring the whole row would claim the surviving line was deleted.
  borderWidth: '0 0 0 2px',
  borderStyle: 'solid',
  borderColor: new vscode.ThemeColor('diffEditor.removedTextBackground'),
  overviewRulerColor: new vscode.ThemeColor('diffEditor.removedTextBackground'),
  overviewRulerLane: vscode.OverviewRulerLane.Left,
});

/** How much removed text to inline before deferring to the hover. */
const INLINE_REMOVED_BUDGET = 80;

export interface InlineDiffControllerDeps {
  readonly resolve: (path: string) => vscode.Uri;
  /** Notified whenever the set of reviewable hunks changes, so the UI can refresh. */
  readonly onChanged: () => void;
}

export class InlineDiffController implements vscode.Disposable {
  private readonly baselines = new Map<string, string>();
  private readonly subscriptions: vscode.Disposable[] = [];

  constructor(private readonly deps: InlineDiffControllerDeps) {
    this.subscriptions.push(
      vscode.window.onDidChangeVisibleTextEditors(() => {
        this.render();
      }),
      vscode.workspace.onDidChangeTextDocument((event) => {
        // Only re-render for a file actually under review: the callback fires for
        // every keystroke in every open document, including the output channel.
        if (this.baselines.has(key(event.document.uri))) {
          this.render();
        }
      }),
    );
  }

  /**
   * Registers what a file looked like before the agent edited it.
   *
   * Only the first baseline for a path is kept. A second call within the same
   * review would be recording the agent's own output as the state to return to.
   */
  track(path: string, baseline: string): void {
    const uriKey = key(this.deps.resolve(path));
    if (this.baselines.has(uriKey)) {
      return;
    }
    this.baselines.set(uriKey, baseline);
    this.render();
  }

  /** Current hunks for one file, recomputed from the document as it stands. */
  hunksFor(uri: vscode.Uri): readonly DiffHunk[] {
    const baseline = this.baselines.get(key(uri));
    if (baseline === undefined) {
      return [];
    }
    const document = vscode.workspace.textDocuments.find(
      (candidate) => key(candidate.uri) === key(uri),
    );
    if (document === undefined) {
      return [];
    }
    return viewHunks({ baseline, current: document.getText() }).hunks;
  }

  /** Keeps one hunk: the file is untouched and the baseline absorbs the change. */
  async accept(uri: vscode.Uri, index: number): Promise<void> {
    const context = await this.contextFor(uri);
    if (context === null) {
      return;
    }
    this.settle(uri, acceptHunk(context, index));
  }

  /** Puts one hunk back the way it was, through the editor's undo stack. */
  async reject(uri: vscode.Uri, index: number): Promise<void> {
    const context = await this.contextFor(uri);
    if (context === null) {
      return;
    }
    await this.write(uri, rejectHunk(context, index));
    this.settle(uri, context.baseline);
  }

  async acceptFile(uri: vscode.Uri): Promise<void> {
    const context = await this.contextFor(uri);
    if (context === null) {
      return;
    }
    this.settle(uri, acceptAll(context));
  }

  async rejectFile(uri: vscode.Uri): Promise<void> {
    const context = await this.contextFor(uri);
    if (context === null) {
      return;
    }
    await this.write(uri, rejectAll(context));
    this.settle(uri, context.baseline);
  }

  /** Accepts every file under review at once. */
  acceptEverything(): void {
    this.baselines.clear();
    this.render();
    this.deps.onChanged();
  }

  /** Drops all review state without touching any file. */
  clear(): void {
    this.baselines.clear();
    this.render();
  }

  dispose(): void {
    for (const subscription of this.subscriptions) {
      subscription.dispose();
    }
    ADDED.dispose();
    REMOVED.dispose();
  }

  /**
   * Records the post-decision baseline, dropping the file from review once the
   * two texts agree. Called after both accept and reject, because both converge
   * on "nothing left to decide" — just from opposite directions.
   */
  private settle(uri: vscode.Uri, baseline: string): void {
    const uriKey = key(uri);
    const document = vscode.workspace.textDocuments.find(
      (candidate) => key(candidate.uri) === uriKey,
    );
    if (document !== undefined && document.getText() === baseline) {
      this.baselines.delete(uriKey);
    } else {
      this.baselines.set(uriKey, baseline);
    }
    this.render();
    this.deps.onChanged();
  }

  private async contextFor(
    uri: vscode.Uri,
  ): Promise<{ readonly baseline: string; readonly current: string } | null> {
    const baseline = this.baselines.get(key(uri));
    if (baseline === undefined) {
      return null;
    }
    const document = await vscode.workspace.openTextDocument(uri);
    return { baseline, current: document.getText() };
  }

  /**
   * Writes through a `WorkspaceEdit` rather than the filesystem, so a rejection
   * lands in the editor's own undo stack (§6.3): a user who rejects by mistake
   * presses Ctrl+Z, not another TARS command.
   */
  private async write(uri: vscode.Uri, content: string): Promise<void> {
    const document = await vscode.workspace.openTextDocument(uri);
    const edit = new vscode.WorkspaceEdit();
    const whole = new vscode.Range(
      document.positionAt(0),
      document.positionAt(document.getText().length),
    );
    edit.replace(uri, whole, content);
    await vscode.workspace.applyEdit(edit);
  }

  /** Repaints every visible editor that is under review. */
  private render(): void {
    for (const editor of vscode.window.visibleTextEditors) {
      const baseline = this.baselines.get(key(editor.document.uri));
      if (baseline === undefined) {
        editor.setDecorations(ADDED, []);
        editor.setDecorations(REMOVED, []);
        continue;
      }
      const { hunks } = viewHunks({ baseline, current: editor.document.getText() });
      editor.setDecorations(ADDED, addedRanges(hunks, editor.document));
      editor.setDecorations(REMOVED, removedMarkers(hunks, editor.document));
    }
  }
}

function key(uri: vscode.Uri): string {
  return uri.toString();
}

function addedRanges(
  hunks: readonly DiffHunk[],
  document: vscode.TextDocument,
): readonly vscode.Range[] {
  const ranges: vscode.Range[] = [];
  for (const hunk of hunks) {
    for (const op of hunk.ops) {
      if (op.kind !== 'insert' || op.afterLine >= document.lineCount) {
        continue;
      }
      ranges.push(document.lineAt(op.afterLine).range);
    }
  }
  return ranges;
}

/**
 * Places one marker per run of removed lines, on the line that now stands where
 * they were.
 *
 * Grouped into runs rather than one marker per deleted line, because they all
 * anchor to the same surviving line: separate decorations would stack their
 * `after` text on top of each other and render as gibberish.
 */
function removedMarkers(
  hunks: readonly DiffHunk[],
  document: vscode.TextDocument,
): readonly vscode.DecorationOptions[] {
  const markers: vscode.DecorationOptions[] = [];

  for (const hunk of hunks) {
    let run: string[] = [];
    let anchor = 0;

    const flush = (): void => {
      if (run.length === 0) {
        return;
      }
      markers.push(marker(document, anchor, run));
      run = [];
    };

    for (const op of hunk.ops) {
      if (op.kind === 'delete') {
        run.push(op.text);
        continue;
      }
      // The line that follows the run is where it is anchored — that is the line
      // the user's eye lands on when looking for what used to be there.
      anchor = op.afterLine;
      flush();
    }
    // A run that reaches the end of the hunk has no following line to sit on, so
    // it anchors to the hunk's own last line. Anchoring to the end of the *file*
    // would be right only when the deletion happens to be the last thing in it —
    // true with the default context, and silently false without it.
    anchor = Math.max(0, hunk.afterStart + hunk.afterCount - 1);
    flush();
  }
  return markers;
}

function marker(
  document: vscode.TextDocument,
  line: number,
  removed: readonly string[],
): vscode.DecorationOptions {
  const safeLine = Math.min(Math.max(line, 0), Math.max(0, document.lineCount - 1));
  const range = document.lineAt(safeLine).range;
  const joined = removed.join(' ⏎ ').trim();
  const inline =
    joined.length > INLINE_REMOVED_BUDGET
      ? `${joined.slice(0, INLINE_REMOVED_BUDGET)}… (${String(removed.length)} lines)`
      : joined;

  const hover = new vscode.MarkdownString();
  hover.appendMarkdown(`**TARS removed ${String(removed.length)} line(s):**\n\n`);
  hover.appendCodeblock(removed.join('\n'), document.languageId);

  return {
    range,
    hoverMessage: hover,
    renderOptions: {
      after: {
        contentText: `  − ${inline}`,
        color: new vscode.ThemeColor('descriptionForeground'),
        backgroundColor: new vscode.ThemeColor('diffEditor.removedTextBackground'),
        fontStyle: 'italic',
      },
    },
  };
}
