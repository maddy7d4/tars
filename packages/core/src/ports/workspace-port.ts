/** One root of a possibly multi-root workspace. */
export interface WorkspaceFolder {
  readonly name: string;
  /** Absolute filesystem path. */
  readonly path: string;
}

/** An editor the user currently has open, in tab order. */
export interface OpenDocument {
  readonly path: string;
  readonly languageId: string;
  readonly isDirty: boolean;
}

/** The user's current selection, if any. Lines are 1-based and `endLine` is inclusive. */
export interface EditorSelection {
  readonly path: string;
  readonly startLine: number;
  readonly endLine: number;
  readonly text: string;
}

/** Unsubscribes a listener. Returned rather than an `off()` method so callers cannot mismatch. */
export type Unsubscribe = () => void;

/**
 * Workspace shape and user-facing configuration (Docs/TARS_SPEC.md §3.2).
 * Configuration reads are typed by the caller because the schema lives in the
 * extension manifest, which core cannot see.
 */
export interface WorkspacePort {
  readonly folders: readonly WorkspaceFolder[];

  /** Resolves a workspace-relative path against the folder that contains it. */
  resolvePath(relativePath: string): string | null;

  /** Inverse of `resolvePath`; `null` when the path lies outside every folder. */
  relativePath(absolutePath: string): string | null;

  /** Returns `defaultValue` when the setting is unset, so callers never handle `undefined`. */
  getConfiguration<T>(section: string, defaultValue: T): T;

  onConfigurationChanged(listener: (section: string) => void): Unsubscribe;

  readonly openDocuments: readonly OpenDocument[];

  readonly activeSelection: EditorSelection | null;
}
