import type { FileSystemPort, LoggerPort } from '../ports/index.js';
import { hashContent, isContentHash } from '../diff/content-hash.js';

/**
 * A content-addressed blob store (Docs/TARS_SPEC.md §6.4).
 *
 * Checkpoints snapshot every file an apply is about to touch. Across a session
 * that is the same handful of files over and over, usually unchanged between
 * checkpoints — a naive per-checkpoint copy would store the same bytes dozens of
 * times. Keying by SHA-256 makes identical content one file on disk, so the cost
 * of a checkpoint is proportional to what actually changed, not to how many
 * files it covers.
 *
 * Blobs are immutable and never overwritten: a hash that already exists is by
 * definition the same content, so a re-`put` is a no-op rather than a write.
 * That is also what makes the store safe to share between checkpoints — nothing
 * can mutate a blob another checkpoint still references.
 */
export interface BlobStoreDeps {
  readonly fileSystem: FileSystemPort;
  /** Directory the blobs live in. Created on first write. */
  readonly directory: string;
  readonly logger: LoggerPort;
}

export class BlobStore {
  private readonly log: LoggerPort;
  /** Hashes known to exist, so a repeated snapshot of one file costs no I/O. */
  private readonly known = new Set<string>();
  private directoryReady = false;

  constructor(private readonly deps: BlobStoreDeps) {
    this.log = deps.logger.child('blobs');
  }

  /** Stores content if it is not already present and returns its hash. */
  async put(content: string): Promise<string> {
    const hash = hashContent(content);
    if (this.known.has(hash)) {
      return hash;
    }
    const path = this.pathFor(hash);
    if ((await this.deps.fileSystem.stat(path)) !== null) {
      this.known.add(hash);
      return hash;
    }
    await this.ensureDirectory();
    await this.deps.fileSystem.writeTextFile(path, content);
    this.known.add(hash);
    return hash;
  }

  /**
   * Reads a blob back, or `null` if it is missing.
   *
   * Missing is a real state, not an error: a user may have cleared global
   * storage, or a partially-written checkpoint may reference a blob that never
   * landed. Restore has to be able to report which files it could not recover
   * rather than failing wholesale, so absence is returned, not thrown.
   */
  async get(hash: string): Promise<string | null> {
    if (!isContentHash(hash)) {
      // Refusing here is what keeps a corrupt record from addressing a path
      // outside the store — the hash goes straight into a filename.
      this.log.log('warn', 'refusing to read a malformed blob id', { hash });
      return null;
    }
    const path = this.pathFor(hash);
    if ((await this.deps.fileSystem.stat(path)) === null) {
      return null;
    }
    try {
      return await this.deps.fileSystem.readTextFile(path);
    } catch (error: unknown) {
      this.log.log('error', 'blob unreadable', { hash, error: describe(error) });
      return null;
    }
  }

  async has(hash: string): Promise<boolean> {
    if (!isContentHash(hash)) {
      return false;
    }
    if (this.known.has(hash)) {
      return true;
    }
    return (await this.deps.fileSystem.stat(this.pathFor(hash))) !== null;
  }

  /**
   * Deletes every blob no live checkpoint references.
   *
   * Takes the reachable set rather than a list to delete: the caller knows which
   * checkpoints survive, and deriving "unreachable" here means a blob can only
   * be dropped when nothing claims it. Inverting that — passing hashes to
   * remove — would make an incomplete caller silently delete live data.
   */
  async collectGarbage(reachable: ReadonlySet<string>): Promise<number> {
    let removed = 0;
    let entries: readonly { readonly name: string; readonly type: string }[];
    try {
      entries = await this.deps.fileSystem.readDirectory(this.deps.directory);
    } catch {
      // No directory yet means no blobs, which is not a failure.
      return 0;
    }

    for (const entry of entries) {
      if (entry.type !== 'file' || !isContentHash(entry.name) || reachable.has(entry.name)) {
        continue;
      }
      try {
        await this.deps.fileSystem.delete(this.pathFor(entry.name));
        this.known.delete(entry.name);
        removed += 1;
      } catch (error: unknown) {
        // One undeletable blob wastes space; failing the sweep would leave every
        // later one behind too.
        this.log.log('warn', 'could not delete an unreferenced blob', {
          hash: entry.name,
          error: describe(error),
        });
      }
    }
    if (removed > 0) {
      this.log.log('info', 'collected unreferenced blobs', { removed });
    }
    return removed;
  }

  private pathFor(hash: string): string {
    return `${this.deps.directory}/${hash}`;
  }

  private async ensureDirectory(): Promise<void> {
    if (this.directoryReady) {
      return;
    }
    await this.deps.fileSystem.createDirectory(this.deps.directory);
    this.directoryReady = true;
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
