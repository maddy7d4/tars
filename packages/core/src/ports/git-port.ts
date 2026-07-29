/** Working-tree status for one path, as the git extension reports it. */
export interface GitFileChange {
  readonly path: string;
  readonly status: 'added' | 'modified' | 'deleted' | 'renamed' | 'untracked' | 'conflicted';
}

/** A repository the editor has discovered. */
export interface GitRepository {
  /** Absolute path to the working-tree root. */
  readonly rootPath: string;
  readonly currentBranch: string | null;
  readonly changes: readonly GitFileChange[];
}

/**
 * Read-only git access via the built-in `vscode.git` extension API
 * (Docs/TARS_SPEC.md §3.2). Read-only by design: mutating history is the user's
 * prerogative, and the agent reaches git through the SDK's Bash tool where the
 * command is visible and permission-gated.
 */
export interface GitPort {
  /** Empty when the git extension is absent or no repository was discovered. */
  repositories(): Promise<readonly GitRepository[]>;

  /** The repository containing `path`, or `null` if it is untracked territory. */
  repositoryFor(path: string): Promise<GitRepository | null>;

  /**
   * Content of `path` at `ref` (e.g. `'HEAD'`), for diffing proposed edits against
   * committed state. `null` when the path does not exist at that ref.
   */
  showFileAtRef(path: string, ref: string): Promise<string | null>;
}
