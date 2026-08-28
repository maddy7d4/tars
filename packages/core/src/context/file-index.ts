import type { FileSystemPort } from '../ports/file-system-port.js';
import type { LoggerPort } from '../ports/logger-port.js';
import type { WorkspaceFolder } from '../ports/workspace-port.js';
import { ALWAYS_IGNORED, GitignoreFile, IgnoreStack } from './gitignore.js';

/**
 * An indexed file, stored workspace-relative because that is what the user types
 * in an `@`-mention and what the UI renders.
 */
export interface IndexedFile {
  /** Workspace-relative POSIX path, e.g. `packages/core/src/index.ts`. */
  readonly path: string;
  /** Absolute path, kept so callers never re-resolve against the wrong folder. */
  readonly absolutePath: string;
  /** Final path segment, matched separately because users search by basename. */
  readonly name: string;
}

export interface FileIndexDeps {
  readonly fileSystem: FileSystemPort;
  readonly logger: LoggerPort;
  /**
   * Bounds a pathological tree — a symlink cycle or a checked-in dependency
   * directory that no `.gitignore` covers. Reaching it degrades completion
   * quality; not bounding it hangs the extension host.
   */
  readonly maxFiles?: number;
  readonly maxDepth?: number;
}

const DEFAULT_MAX_FILES = 50_000;
const DEFAULT_MAX_DEPTH = 32;

/**
 * An in-memory index of workspace files powering `@`-mention completion and path
 * resolution (Docs/TARS_SPEC.md §7.2).
 *
 * Deliberately a plain path list, not an embedding index: v1 curates what enters
 * context rather than rebuilding retrieval the Agent SDK's own `Glob`/`Grep`
 * already do (§7.1, ADR 0008).
 */
export class FileIndex {
  private files: IndexedFile[] = [];
  private byPath = new Map<string, IndexedFile>();
  private truncated = false;
  /**
   * Every `.gitignore` seen during the walk, retained.
   *
   * Without this, `applyChange` would index anything the watcher reported —
   * and the watcher reports build output. A project that compiles into `dist/`
   * would fill the index with generated files the moment it was built, which is
   * exactly when a user is least likely to notice their completions went bad.
   */
  private ignores = new IgnoreStack([]);
  private readonly maxFiles: number;
  private readonly maxDepth: number;
  private readonly logger: LoggerPort;

  constructor(private readonly deps: FileIndexDeps) {
    this.maxFiles = deps.maxFiles ?? DEFAULT_MAX_FILES;
    this.maxDepth = deps.maxDepth ?? DEFAULT_MAX_DEPTH;
    this.logger = deps.logger.child('file-index');
  }

  get size(): number {
    return this.files.length;
  }

  /** `true` when the walk hit `maxFiles`, so callers can warn instead of implying completeness. */
  get isTruncated(): boolean {
    return this.truncated;
  }

  all(): readonly IndexedFile[] {
    return this.files;
  }

  get(relativePath: string): IndexedFile | null {
    return this.byPath.get(relativePath) ?? null;
  }

  /** Replaces the index by walking every folder. Safe to call repeatedly. */
  async build(folders: readonly WorkspaceFolder[]): Promise<void> {
    const collected: IndexedFile[] = [];
    const ignoreFiles: GitignoreFile[] = [];
    this.truncated = false;

    for (const folder of folders) {
      await this.walk(folder, '', new IgnoreStack([]), 0, collected, ignoreFiles);
    }
    this.ignores = new IgnoreStack(ignoreFiles);

    // Sorted once at build time so every query returns a stable order without
    // re-sorting per keystroke.
    collected.sort((a, b) => a.path.localeCompare(b.path));
    this.files = collected;
    this.byPath = new Map(collected.map((file) => [file.path, file]));

    this.logger.log('info', 'workspace indexed', {
      files: collected.length,
      truncated: this.truncated,
    });
  }

  /**
   * Applies a single filesystem change without re-walking.
   *
   * A full rebuild on every save would make the index the most expensive thing in
   * the extension; incremental updates keep an edit O(1).
   */
  applyChange(change: { readonly path: string; readonly absolutePath: string; readonly kind: 'added' | 'removed' }): void {
    if (change.kind === 'removed') {
      if (this.byPath.delete(change.path)) {
        this.files = this.files.filter((file) => file.path !== change.path);
      }
      return;
    }

    if (this.byPath.has(change.path) || this.isIgnored(change.path)) {
      return;
    }
    const file: IndexedFile = {
      path: change.path,
      absolutePath: change.absolutePath,
      name: basename(change.path),
    };
    this.byPath.set(change.path, file);
    // Insertion sort into the already-sorted array beats re-sorting the whole list.
    const at = lowerBound(this.files, file.path);
    this.files.splice(at, 0, file);
  }

  /**
   * Ranked completion for `@`-mentions.
   *
   * Ranking rules, strongest first: exact basename, basename prefix, basename
   * substring, then path substring. Users overwhelmingly type a basename, so a
   * naive path-substring match would bury `index.ts` under every path containing
   * the word "index".
   */
  search(query: string, limit = 20): readonly IndexedFile[] {
    const needle = query.trim().toLowerCase();
    if (needle === '') {
      return this.files.slice(0, limit);
    }

    const scored: { file: IndexedFile; score: number }[] = [];
    for (const file of this.files) {
      const name = file.name.toLowerCase();
      const path = file.path.toLowerCase();

      let score = -1;
      if (name === needle) {
        score = 0;
      } else if (name.startsWith(needle)) {
        score = 1;
      } else if (name.includes(needle)) {
        score = 2;
      } else if (path.includes(needle)) {
        score = 3;
      }

      if (score >= 0) {
        scored.push({ file, score });
      }
    }

    // Shallower paths win ties: a match at the repository root is far more often
    // the one meant than an identically-named file six directories down.
    scored.sort((a, b) => {
      if (a.score !== b.score) return a.score - b.score;
      const depthA = a.file.path.split('/').length;
      const depthB = b.file.path.split('/').length;
      if (depthA !== depthB) return depthA - depthB;
      return a.file.path.localeCompare(b.file.path);
    });

    return scored.slice(0, limit).map((entry) => entry.file);
  }

  /**
   * Whether a path is excluded, using the rules gathered by the last build.
   *
   * Public because the incremental path needs it and so does anything else that
   * decides whether a file belongs in context at all.
   */
  isIgnored(relativePath: string, isDirectory = false): boolean {
    const segments = relativePath.split('/');
    if (segments.some((segment) => ALWAYS_IGNORED.includes(segment))) {
      return true;
    }
    return this.ignores.isIgnored(relativePath, isDirectory);
  }

  private async walk(
    folder: WorkspaceFolder,
    relativeDir: string,
    inherited: IgnoreStack,
    depth: number,
    collected: IndexedFile[],
    ignoreFiles: GitignoreFile[],
  ): Promise<void> {
    if (depth > this.maxDepth || collected.length >= this.maxFiles) {
      return;
    }

    const absoluteDir = relativeDir === '' ? folder.path : `${folder.path}/${relativeDir}`;

    let entries: readonly { name: string; type: 'file' | 'directory' | 'symlink' }[];
    try {
      entries = await this.deps.fileSystem.readDirectory(absoluteDir);
    } catch (error: unknown) {
      // An unreadable directory is normal (permissions, a race with a delete) and
      // must not abort the whole walk.
      this.logger.log('debug', 'directory unreadable, skipped', {
        path: absoluteDir,
        error: error instanceof Error ? error.message : String(error),
      });
      return;
    }

    // The directory's own .gitignore is loaded before its children are visited, so
    // it governs them — which is exactly git's ordering.
    let stack = inherited;
    if (entries.some((entry) => entry.name === '.gitignore' && entry.type === 'file')) {
      try {
        const content = await this.deps.fileSystem.readTextFile(`${absoluteDir}/.gitignore`);
        const file = new GitignoreFile(relativeDir, content);
        ignoreFiles.push(file);
        stack = stack.with(file);
      } catch {
        // A .gitignore that vanished mid-walk simply contributes no rules.
      }
    }

    for (const entry of entries) {
      if (collected.length >= this.maxFiles) {
        this.truncated = true;
        return;
      }
      if (ALWAYS_IGNORED.includes(entry.name)) {
        continue;
      }

      const relativePath = relativeDir === '' ? entry.name : `${relativeDir}/${entry.name}`;
      const isDirectory = entry.type === 'directory';

      if (stack.isIgnored(relativePath, isDirectory)) {
        continue;
      }

      if (isDirectory) {
        await this.walk(folder, relativePath, stack, depth + 1, collected, ignoreFiles);
        continue;
      }

      // Symlinks are indexed as files but never followed as directories: following
      // them is how a walk finds a cycle and never returns.
      collected.push({
        path: relativePath,
        absolutePath: `${folder.path}/${relativePath}`,
        name: entry.name,
      });
    }
  }
}

function basename(path: string): string {
  const at = path.lastIndexOf('/');
  return at === -1 ? path : path.slice(at + 1);
}

/** Index of the first element whose path sorts at or after `path`. */
function lowerBound(files: readonly IndexedFile[], path: string): number {
  let low = 0;
  let high = files.length;
  while (low < high) {
    const mid = (low + high) >>> 1;
    const candidate = files[mid];
    if (candidate !== undefined && candidate.path.localeCompare(path) < 0) {
      low = mid + 1;
    } else {
      high = mid;
    }
  }
  return low;
}
