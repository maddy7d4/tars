import * as vscode from 'vscode';
import type { ChangeSet, FileChange, RestoreResult } from '@tars/core';

/**
 * Applies change sets and restores through the editor (Docs/TARS_SPEC.md §6.3).
 *
 * Everything goes through a single `vscode.WorkspaceEdit`. That is not merely
 * tidy: a `WorkspaceEdit` is atomic, and it lands in the editor's *own* undo
 * stack, so `Ctrl+Z` reverses an AI edit exactly as it reverses a human one.
 * Writing files through the filesystem port instead would produce changes the
 * user cannot undo, in files the editor believes are unmodified — the single
 * most surprising thing an editing agent can do.
 *
 * A restore is applied the same way, so undoing an undo is also just `Ctrl+Z`.
 */

export interface ApplyOutcome {
  readonly applied: boolean;
  /** Paths written, in the order they appeared in the change set. */
  readonly paths: readonly string[];
  /** Why the apply did not happen, when `applied` is false. */
  readonly reason?: string;
}

export interface ChangeApplierDeps {
  /** Resolves a workspace-relative path to a URI. Injected so it can be tested. */
  readonly resolve: (path: string) => vscode.Uri;
}

export class ChangeApplier {
  constructor(private readonly deps: ChangeApplierDeps) {}

  /**
   * Applies a change set.
   *
   * `changes` is taken rather than the whole set so a caller can apply the
   * subset the user accepted — per-file review is the point of a change set, and
   * an all-or-nothing signature would push callers into applying rejected edits.
   */
  async apply(changes: readonly FileChange[]): Promise<ApplyOutcome> {
    if (changes.length === 0) {
      return { applied: false, paths: [], reason: 'nothing to apply' };
    }

    const edit = new vscode.WorkspaceEdit();
    for (const change of changes) {
      this.stage(edit, change);
    }

    const applied = await vscode.workspace.applyEdit(edit);
    if (!applied) {
      // The editor refuses an edit it cannot make atomically — a file made
      // read-only, or changed underneath by another extension. Reporting the
      // refusal is the whole value: a partial write would be worse.
      return { applied: false, paths: [], reason: 'the editor declined the edit' };
    }
    return { applied: true, paths: changes.map((change) => change.path) };
  }

  /** Convenience for applying an entire set. */
  applySet(set: ChangeSet): Promise<ApplyOutcome> {
    return this.apply(set.changes);
  }

  /**
   * Applies a checkpoint restore.
   *
   * Files the checkpoint could not recover are left untouched rather than
   * emptied. A restore that silently blanks a file it failed to read would turn
   * a recoverable loss into an unrecoverable one.
   */
  async restore(result: RestoreResult): Promise<ApplyOutcome> {
    const edit = new vscode.WorkspaceEdit();

    for (const file of result.restored) {
      const uri = this.deps.resolve(file.path);
      edit.createFile(uri, { overwrite: true, ignoreIfExists: false, contents: encode(file.content) });
    }
    for (const path of result.deleted) {
      // The file did not exist at checkpoint time, so returning there removes it.
      // `ignoreIfNotExists` because the user may already have deleted it.
      edit.deleteFile(this.deps.resolve(path), { recursive: false, ignoreIfNotExists: true });
    }

    const touched = [...result.restored.map((file) => file.path), ...result.deleted];
    if (touched.length === 0) {
      return { applied: false, paths: [], reason: 'the checkpoint recovered nothing' };
    }

    const applied = await vscode.workspace.applyEdit(edit);
    return applied
      ? { applied: true, paths: touched }
      : { applied: false, paths: [], reason: 'the editor declined the restore' };
  }

  /**
   * Stages one file change.
   *
   * `createFile` with `overwrite` is used for content replacement rather than a
   * full-document `replace`. It does not require the document to be open or its
   * line count to be known, and it produces one undo entry per file either way.
   */
  private stage(edit: vscode.WorkspaceEdit, change: FileChange): void {
    const uri = this.deps.resolve(change.path);

    if (change.kind === 'delete') {
      edit.deleteFile(uri, { recursive: false, ignoreIfNotExists: true });
      return;
    }
    if (change.afterContent === null) {
      return;
    }
    edit.createFile(uri, {
      overwrite: true,
      ignoreIfExists: false,
      contents: encode(change.afterContent),
    });
  }
}

function encode(content: string): Uint8Array {
  return new TextEncoder().encode(content);
}
