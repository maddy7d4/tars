import * as vscode from 'vscode';
import type { InlineDiffController } from './inline-diff.js';

/**
 * Accept and Reject controls above each reviewable hunk (Docs/TARS_SPEC.md §6.5).
 *
 * CodeLens rather than a floating widget: it is a public API, it is keyboard
 * reachable, it scrolls with the code it belongs to, and it inherits the user's
 * own font and theme. A custom overlay would need absolute positioning that
 * breaks on wrapped lines and folded regions, and it would be invisible to a
 * screen reader.
 *
 * The lens indices are positional and recomputed on every provide, which is safe
 * for the same reason the rest of the review is: nothing caches a hunk. The
 * command receives the index it displayed, and if the file moved before the user
 * clicked, the resulting decision applies to whatever occupies that position
 * now — which is the same guarantee the editor's own inline actions give.
 */

export const ACCEPT_HUNK_COMMAND = 'tars.acceptHunk';
export const REJECT_HUNK_COMMAND = 'tars.rejectHunk';
export const ACCEPT_FILE_COMMAND = 'tars.acceptFile';
export const REJECT_FILE_COMMAND = 'tars.rejectFile';
export const OPEN_FULL_DIFF_COMMAND = 'tars.openFullDiff';

export class HunkLensProvider implements vscode.CodeLensProvider, vscode.Disposable {
  private readonly emitter = new vscode.EventEmitter<void>();
  private readonly registration: vscode.Disposable;

  readonly onDidChangeCodeLenses = this.emitter.event;

  constructor(private readonly inline: InlineDiffController) {
    this.registration = vscode.languages.registerCodeLensProvider({ scheme: 'file' }, this);
  }

  /** Called whenever a decision or an edit changes what is reviewable. */
  refresh(): void {
    this.emitter.fire();
  }

  provideCodeLenses(document: vscode.TextDocument): vscode.CodeLens[] {
    const hunks = this.inline.hunksFor(document.uri);
    if (hunks.length === 0) {
      return [];
    }

    const lenses: vscode.CodeLens[] = [];
    const first = anchor(document, hunks[0]?.afterStart ?? 0);

    // Whole-file actions ride above the first hunk rather than at line 0: for a
    // change deep in a long file, a control at the top is a control nobody sees.
    lenses.push(
      new vscode.CodeLens(first, {
        title: `$(check-all) Accept file (${String(hunks.length)})`,
        command: ACCEPT_FILE_COMMAND,
        arguments: [document.uri],
      }),
      new vscode.CodeLens(first, {
        title: '$(discard) Reject file',
        command: REJECT_FILE_COMMAND,
        arguments: [document.uri],
      }),
      new vscode.CodeLens(first, {
        title: '$(diff) Full diff',
        command: OPEN_FULL_DIFF_COMMAND,
        arguments: [document.uri],
      }),
    );

    hunks.forEach((hunk, index) => {
      const range = anchor(document, hunk.afterStart);
      lenses.push(
        new vscode.CodeLens(range, {
          title: '$(check) Accept',
          tooltip: 'Keep this change',
          command: ACCEPT_HUNK_COMMAND,
          arguments: [document.uri, index],
        }),
        new vscode.CodeLens(range, {
          title: '$(x) Reject',
          tooltip: 'Put this region back the way it was',
          command: REJECT_HUNK_COMMAND,
          arguments: [document.uri, index],
        }),
      );
    });

    return lenses;
  }

  dispose(): void {
    this.registration.dispose();
    this.emitter.dispose();
  }
}

/** Clamped: a hunk can name a line past the end after a concurrent edit. */
function anchor(document: vscode.TextDocument, line: number): vscode.Range {
  const safe = Math.min(Math.max(line, 0), Math.max(0, document.lineCount - 1));
  return document.lineAt(safe).range;
}
