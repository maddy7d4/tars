/** A directory entry, discriminated by `type` rather than a boolean pair. */
export interface DirectoryEntry {
  readonly name: string;
  readonly type: 'file' | 'directory' | 'symlink';
}

/** Metadata needed to detect concurrent modification before applying an edit. */
export interface FileStat {
  readonly type: 'file' | 'directory' | 'symlink';
  readonly size: number;
  /** Milliseconds since epoch. */
  readonly mtime: number;
}

/**
 * File access, backed by `vscode.workspace.fs` in host and an in-memory volume in
 * tests (Docs/TARS_SPEC.md §3.2). Paths are absolute filesystem paths; the editor
 * URI type never crosses into core.
 */
export interface FileSystemPort {
  /** Rejects if the path does not exist. Callers that tolerate absence use `stat` first. */
  readFile(path: string): Promise<Uint8Array>;

  /** Decodes as UTF-8. Separate from `readFile` so binary reads are an explicit choice. */
  readTextFile(path: string): Promise<string>;

  /** Creates parent directories as needed; overwrites an existing file. */
  writeTextFile(path: string, content: string): Promise<void>;

  /** Appends without rewriting the file — the session event log depends on this. */
  appendTextFile(path: string, content: string): Promise<void>;

  /** Resolves `null` rather than rejecting when the path does not exist. */
  stat(path: string): Promise<FileStat | null>;

  readDirectory(path: string): Promise<readonly DirectoryEntry[]>;

  createDirectory(path: string): Promise<void>;

  delete(path: string, options?: { readonly recursive: boolean }): Promise<void>;

  rename(from: string, to: string, options?: { readonly overwrite: boolean }): Promise<void>;
}
