import type * as vscode from 'vscode';

/**
 * The slice of the built-in `vscode.git` extension API that TARS uses.
 *
 * Declared locally rather than depending on a published `git.d.ts`: the git
 * extension ships no types on npm, and `extension.exports` is otherwise `any`,
 * which the repo forbids. Narrowing `unknown` through these interfaces keeps the
 * boundary typed and makes a shape change a compile error here rather than a
 * runtime `undefined` deep inside the adapter.
 */

/** Numeric values of the git extension's `Status` enum, in its declared order. */
export const GitStatus = {
  IndexModified: 0,
  IndexAdded: 1,
  IndexDeleted: 2,
  IndexRenamed: 3,
  IndexCopied: 4,
  Modified: 5,
  Deleted: 6,
  Untracked: 7,
  Ignored: 8,
  IntentToAdd: 9,
  IntentToRename: 10,
  TypeChanged: 11,
  AddedByUs: 12,
  AddedByThem: 13,
  DeletedByUs: 14,
  DeletedByThem: 15,
  BothAdded: 16,
  BothDeleted: 17,
  BothModified: 18,
} as const;

export interface GitBranch {
  readonly name?: string | undefined;
}

export interface GitChange {
  readonly uri: vscode.Uri;
  readonly originalUri: vscode.Uri;
  readonly status: number;
}

export interface GitRepositoryState {
  readonly HEAD?: GitBranch | undefined;
  readonly workingTreeChanges: readonly GitChange[];
  readonly indexChanges: readonly GitChange[];
  readonly mergeChanges: readonly GitChange[];
}

export interface GitExtensionRepository {
  readonly rootUri: vscode.Uri;
  readonly state: GitRepositoryState;
  show(ref: string, path: string): Promise<string>;
}

export interface GitExtensionApi {
  readonly repositories: readonly GitExtensionRepository[];
  getRepository(uri: vscode.Uri): GitExtensionRepository | null;
}

interface GitExtensionExports {
  readonly enabled: boolean;
  getAPI(version: 1): GitExtensionApi;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/** Structural check, so a future extension version cannot crash activation. */
export function asGitExtensionExports(value: unknown): GitExtensionExports | null {
  if (!isRecord(value)) {
    return null;
  }
  if (typeof value['getAPI'] !== 'function' || typeof value['enabled'] !== 'boolean') {
    return null;
  }
  return value as unknown as GitExtensionExports;
}
