import type { ClockPort, FileSystemPort, LoggerPort, StoragePort } from '../ports/index.js';
import { BlobStore } from './blob-store.js';
import type { Checkpoint, CheckpointFile, RestoreResult, RestoredFile } from './types.js';

/**
 * The checkpoint store (Docs/TARS_SPEC.md §6.4).
 *
 * Every apply is preceded by a snapshot, so any change the agent makes is
 * reversible without relying on the editor's undo stack surviving a reload, a
 * crash, or a file the user closed. Content lives in a content-addressed
 * `BlobStore`; this class owns only the records that point into it.
 *
 * Records live under `globalStorageUri` rather than workspace storage because
 * the blobs are deduplicated across every workspace — the same `package.json`
 * boilerplate in ten projects is one blob — and because a checkpoint must
 * survive a workspace being closed.
 */

export const CHECKPOINT_FILE_VERSION = 1;

const CHECKPOINTS_DIRNAME = 'checkpoints';
const INDEX_FILENAME = 'index.json';
const BLOBS_DIRNAME = 'blobs';
const DEFAULT_MAX_CHECKPOINTS = 100;

export interface CheckpointStoreDeps {
  readonly fileSystem: FileSystemPort;
  readonly storage: StoragePort;
  readonly clock: ClockPort;
  readonly logger: LoggerPort;
  /**
   * How many checkpoints to keep. Older ones are dropped oldest-first and their
   * blobs collected, so the store cannot grow without bound across a long-lived
   * installation.
   */
  readonly maxCheckpoints?: number;
  /** Injected so ids are deterministic in tests. */
  readonly newId?: () => string;
}

/** A file to snapshot, with the content it currently holds. */
export interface SnapshotInput {
  readonly path: string;
  /** Current on-disk content, or `null` if the file does not exist yet. */
  readonly content: string | null;
}

interface PersistedIndex {
  readonly version: number;
  readonly checkpoints: readonly Checkpoint[];
}

export class CheckpointStore {
  private readonly log: LoggerPort;
  private readonly blobs: BlobStore;
  private readonly maxCheckpoints: number;
  private readonly newId: () => string;
  private readonly root: string;
  private checkpoints: Checkpoint[] = [];
  private loaded = false;
  /**
   * Serialises writes. Two applies overlapping — a second turn starting before
   * the first finished writing — would otherwise read, modify and write the same
   * index concurrently, and the later write would silently drop the earlier
   * checkpoint along with the only record of how to undo it.
   */
  private writing: Promise<void> = Promise.resolve();

  constructor(private readonly deps: CheckpointStoreDeps) {
    this.log = deps.logger.child('checkpoints');
    this.maxCheckpoints = deps.maxCheckpoints ?? DEFAULT_MAX_CHECKPOINTS;
    this.newId = deps.newId ?? (() => globalThis.crypto.randomUUID());
    this.root = `${deps.storage.globalStoragePath}/${CHECKPOINTS_DIRNAME}`;
    this.blobs = new BlobStore({
      fileSystem: deps.fileSystem,
      directory: `${this.root}/${BLOBS_DIRNAME}`,
      logger: deps.logger,
    });
  }

  /** Newest first, which is the order a restore picker wants. */
  async list(sessionId?: string): Promise<readonly Checkpoint[]> {
    await this.load();
    const all = [...this.checkpoints].reverse();
    return sessionId === undefined
      ? all
      : all.filter((checkpoint) => checkpoint.sessionId === sessionId);
  }

  async get(id: string): Promise<Checkpoint | null> {
    await this.load();
    return this.checkpoints.find((checkpoint) => checkpoint.id === id) ?? null;
  }

  /**
   * Snapshots the given files and records a checkpoint.
   *
   * Called *before* an apply, with the content as it stands now. Taking the
   * snapshot after would record the agent's own output as the thing to restore,
   * which is the one state nobody needs to get back to.
   */
  async create(input: {
    readonly label: string;
    readonly sessionId: string;
    readonly eventOffset: number;
    readonly files: readonly SnapshotInput[];
  }): Promise<Checkpoint> {
    await this.load();

    const files: CheckpointFile[] = [];
    for (const file of input.files) {
      const beforeHash = file.content === null ? null : await this.blobs.put(file.content);
      files.push({ path: file.path, beforeHash });
    }

    const checkpoint: Checkpoint = {
      id: this.newId(),
      at: this.deps.clock.now(),
      label: input.label,
      sessionId: input.sessionId,
      eventOffset: input.eventOffset,
      files,
    };

    this.checkpoints.push(checkpoint);
    await this.prune();
    await this.persist();
    this.log.log('info', 'checkpoint recorded', {
      id: checkpoint.id,
      files: files.length,
      label: input.label,
    });
    return checkpoint;
  }

  /**
   * Adds files to a checkpoint that already exists.
   *
   * A turn writes files one at a time, and the checkpoint has to be durable
   * after each one: if the record were only written when the turn ended, a crash
   * mid-turn would leave the workspace edited with no way back. Paths already in
   * the checkpoint are left alone — the first snapshot is the one that predates
   * every edit, and overwriting it with a later baseline would record the agent's
   * own output as the state to restore.
   */
  async addFiles(id: string, files: readonly SnapshotInput[]): Promise<Checkpoint | null> {
    await this.load();
    const index = this.checkpoints.findIndex((checkpoint) => checkpoint.id === id);
    const existing = this.checkpoints[index];
    if (existing === undefined) {
      return null;
    }

    const known = new Set(existing.files.map((file) => file.path));
    const added: CheckpointFile[] = [];
    for (const file of files) {
      if (known.has(file.path)) {
        continue;
      }
      const beforeHash = file.content === null ? null : await this.blobs.put(file.content);
      added.push({ path: file.path, beforeHash });
      known.add(file.path);
    }
    if (added.length === 0) {
      return existing;
    }

    const updated: Checkpoint = { ...existing, files: [...existing.files, ...added] };
    this.checkpoints[index] = updated;
    await this.persist();
    return updated;
  }

  /**
   * Reads back what it would take to return to a checkpoint.
   *
   * Deliberately does not write anything. Applying the result is a
   * `WorkspaceEdit` in the host (§6.3), so that a restore lands in the editor's
   * own undo stack exactly as the original edit did — writing files directly
   * from core would produce changes the user could not `Ctrl+Z`.
   */
  async restore(id: string): Promise<RestoreResult | null> {
    await this.load();
    const checkpoint = this.checkpoints.find((entry) => entry.id === id);
    if (checkpoint === undefined) {
      this.log.log('warn', 'no such checkpoint', { id });
      return null;
    }

    const restored: RestoredFile[] = [];
    const deleted: string[] = [];
    const unrecoverable: string[] = [];

    for (const file of checkpoint.files) {
      if (file.beforeHash === null) {
        // The file did not exist at checkpoint time, so returning to it means
        // removing what the agent created.
        deleted.push(file.path);
        continue;
      }
      const content = await this.blobs.get(file.beforeHash);
      if (content === null) {
        unrecoverable.push(file.path);
        continue;
      }
      restored.push({ path: file.path, content });
    }

    if (unrecoverable.length > 0) {
      this.log.log('error', 'checkpoint is missing blobs', {
        id,
        missing: unrecoverable.length,
      });
    }
    return {
      checkpointId: checkpoint.id,
      restored,
      deleted,
      unrecoverable,
      eventOffset: checkpoint.eventOffset,
    };
  }

  /** Drops one checkpoint and any blob it alone was keeping alive. */
  async forget(id: string): Promise<boolean> {
    await this.load();
    const before = this.checkpoints.length;
    this.checkpoints = this.checkpoints.filter((checkpoint) => checkpoint.id !== id);
    if (this.checkpoints.length === before) {
      return false;
    }
    await this.persist();
    await this.blobs.collectGarbage(this.reachableHashes());
    return true;
  }

  /** Drops every checkpoint for one session, e.g. when its transcript is discarded. */
  async forgetSession(sessionId: string): Promise<number> {
    await this.load();
    const before = this.checkpoints.length;
    this.checkpoints = this.checkpoints.filter(
      (checkpoint) => checkpoint.sessionId !== sessionId,
    );
    const removed = before - this.checkpoints.length;
    if (removed > 0) {
      await this.persist();
      await this.blobs.collectGarbage(this.reachableHashes());
    }
    return removed;
  }

  /**
   * Loads the index once.
   *
   * A damaged index yields an empty store rather than an exception. Checkpoints
   * are a safety net: refusing to start because the net is torn would take away
   * the ability to work at all, which is strictly worse than working without it.
   */
  private async load(): Promise<void> {
    if (this.loaded) {
      return;
    }
    this.loaded = true;

    const path = this.indexPath();
    if ((await this.deps.fileSystem.stat(path)) === null) {
      return;
    }
    try {
      const raw = await this.deps.fileSystem.readTextFile(path);
      const parsed: unknown = JSON.parse(raw);
      this.checkpoints = [...readIndex(parsed)];
    } catch (error: unknown) {
      this.log.log('error', 'checkpoint index unreadable, starting empty', {
        path,
        error: error instanceof Error ? error.message : String(error),
      });
      this.checkpoints = [];
    }
  }

  private async prune(): Promise<void> {
    if (this.checkpoints.length <= this.maxCheckpoints) {
      return;
    }
    const dropped = this.checkpoints.length - this.maxCheckpoints;
    // Oldest first: the most recent checkpoints are the ones a user reaches for.
    this.checkpoints = this.checkpoints.slice(dropped);
    this.log.log('info', 'pruned old checkpoints', { dropped });
    await this.blobs.collectGarbage(this.reachableHashes());
  }

  private reachableHashes(): ReadonlySet<string> {
    const hashes = new Set<string>();
    for (const checkpoint of this.checkpoints) {
      for (const file of checkpoint.files) {
        if (file.beforeHash !== null) {
          hashes.add(file.beforeHash);
        }
      }
    }
    return hashes;
  }

  private persist(): Promise<void> {
    const snapshot: PersistedIndex = {
      version: CHECKPOINT_FILE_VERSION,
      checkpoints: [...this.checkpoints],
    };
    this.writing = this.writing.then(async () => {
      await this.deps.fileSystem.createDirectory(this.root);
      await this.deps.fileSystem.writeTextFile(
        this.indexPath(),
        `${JSON.stringify(snapshot, null, 2)}\n`,
      );
    });
    return this.writing;
  }

  private indexPath(): string {
    return `${this.root}/${INDEX_FILENAME}`;
  }
}

/**
 * Reads persisted checkpoints, dropping anything malformed.
 *
 * Per-record rather than all-or-nothing: one truncated entry at the tail of a
 * file interrupted mid-write must not cost the user every checkpoint before it.
 */
function readIndex(parsed: unknown): readonly Checkpoint[] {
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return [];
  }
  const record = parsed as Record<string, unknown>;
  if (record['version'] !== CHECKPOINT_FILE_VERSION) {
    return [];
  }
  const raw = record['checkpoints'];
  if (!Array.isArray(raw)) {
    return [];
  }
  const checkpoints: Checkpoint[] = [];
  for (const entry of raw as readonly unknown[]) {
    const checkpoint = readCheckpoint(entry);
    if (checkpoint !== null) {
      checkpoints.push(checkpoint);
    }
  }
  return checkpoints;
}

function readCheckpoint(value: unknown): Checkpoint | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }
  const record = value as Record<string, unknown>;
  const id = record['id'];
  const at = record['at'];
  const label = record['label'];
  const sessionId = record['sessionId'];
  const eventOffset = record['eventOffset'];
  const files = record['files'];

  if (
    typeof id !== 'string' ||
    typeof at !== 'number' ||
    typeof label !== 'string' ||
    typeof sessionId !== 'string' ||
    typeof eventOffset !== 'number' ||
    !Array.isArray(files)
  ) {
    return null;
  }

  const parsedFiles: CheckpointFile[] = [];
  for (const entry of files as readonly unknown[]) {
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
      return null;
    }
    const fileRecord = entry as Record<string, unknown>;
    const path = fileRecord['path'];
    const beforeHash = fileRecord['beforeHash'];
    if (typeof path !== 'string') {
      return null;
    }
    if (beforeHash !== null && typeof beforeHash !== 'string') {
      return null;
    }
    parsedFiles.push({ path, beforeHash });
  }

  return { id, at, label, sessionId, eventOffset, files: parsedFiles };
}
