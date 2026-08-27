import type { ClockPort } from '../ports/clock-port.js';
import type { FileSystemPort } from '../ports/file-system-port.js';
import type { LoggerPort } from '../ports/logger-port.js';
import type { StoragePort } from '../ports/storage-port.js';
import type { MemoryDraft, MemoryEntry, MemoryQuery } from './types.js';

/** Bumped when the on-disk shape changes incompatibly. */
export const MEMORY_FILE_VERSION = 1 as const;

interface MemoryFile {
  readonly version: number;
  readonly entries: readonly MemoryEntry[];
}

export interface MemoryStoreDeps {
  readonly fileSystem: FileSystemPort;
  readonly storage: StoragePort;
  readonly clock: ClockPort;
  readonly logger: LoggerPort;
  /**
   * Caps how many entries survive. Memory that grows without bound stops being
   * an asset the moment it no longer fits the context budget; the least recently
   * updated entries are dropped first.
   */
  readonly maxEntries?: number;
  /** Injected so ids are deterministic in tests; defaults to a counter-free UUID. */
  readonly newId?: () => string;
}

const DEFAULT_MAX_ENTRIES = 500;
const MEMORY_FILENAME = 'memory.json';

/**
 * Path of the memory file, or `null` when no workspace is open.
 *
 * Workspace memory is scoped to a workspace by definition, so with no folder open
 * there is nothing to scope it to. The store then runs in-memory only: recording
 * a fact still works for the current session, it simply is not persisted. That is
 * preferable to either crashing or silently writing workspace facts into global
 * storage where they would leak into unrelated projects.
 */
export function memoryPath(storage: StoragePort): string | null {
  const root = storage.workspaceStoragePath;
  return root === null ? null : `${root}/${MEMORY_FILENAME}`;
}

/**
 * Durable, workspace-scoped memory (Docs/TARS_SPEC.md §2, phase 5).
 *
 * Stored as a single JSON document rather than the append-only JSONL used for
 * session events, because memory is edited in place — entries are superseded and
 * pruned — whereas a session log is immutable history. Using the same shape for
 * both would force one of them into the wrong access pattern.
 */
export class MemoryStore {
  private entries: MemoryEntry[] = [];
  private loaded = false;
  private writing: Promise<void> = Promise.resolve();
  private readonly maxEntries: number;
  private readonly newId: () => string;
  private readonly logger: LoggerPort;

  constructor(private readonly deps: MemoryStoreDeps) {
    this.maxEntries = deps.maxEntries ?? DEFAULT_MAX_ENTRIES;
    this.newId = deps.newId ?? (() => globalThis.crypto.randomUUID());
    this.logger = deps.logger.child('memory');
  }

  get size(): number {
    return this.entries.length;
  }

  /**
   * Reads the memory file. Safe to call repeatedly; only the first call does work.
   *
   * A corrupt or unreadable file yields an empty store rather than throwing: losing
   * memory degrades the assistant, but failing to open a workspace breaks it.
   */
  async load(): Promise<void> {
    if (this.loaded) {
      return;
    }
    this.loaded = true;

    const path = memoryPath(this.deps.storage);
    if (path === null) {
      return;
    }
    const stat = await this.deps.fileSystem.stat(path);
    if (stat === null) {
      return;
    }

    try {
      const raw = await this.deps.fileSystem.readTextFile(path);
      const parsed: unknown = JSON.parse(raw);
      this.entries = [...readEntries(parsed)];
    } catch (error: unknown) {
      this.logger.log('error', 'memory file unreadable, starting empty', {
        path,
        error: error instanceof Error ? error.message : String(error),
      });
      this.entries = [];
    }
  }

  async remember(draft: MemoryDraft): Promise<MemoryEntry> {
    await this.load();
    const now = this.deps.clock.now();

    // Same text and kind is an update, not a duplicate: an agent re-learning a
    // fact it already recorded should refresh it rather than fork it.
    const existing = this.entries.find(
      (entry) => entry.kind === draft.kind && entry.text.trim() === draft.text.trim(),
    );
    if (existing !== undefined) {
      // Optional fields are spread conditionally rather than assigned: under
      // `exactOptionalPropertyTypes` an absent key and an explicit `undefined` are
      // different types, and only the absent form survives a JSON round-trip
      // unchanged. Spreading `existing` first keeps a value the draft omits.
      const rationale = draft.rationale ?? existing.rationale;
      const metadata = draft.metadata ?? existing.metadata;
      const merged: MemoryEntry = {
        ...existing,
        paths: draft.paths ?? existing.paths,
        updatedAt: now,
        ...(rationale === undefined ? {} : { rationale }),
        ...(metadata === undefined ? {} : { metadata }),
      };
      this.entries = this.entries.map((entry) => (entry.id === existing.id ? merged : entry));
      await this.persist();
      return merged;
    }

    const entry: MemoryEntry = {
      id: this.newId(),
      text: draft.text.trim(),
      kind: draft.kind,
      paths: draft.paths ?? [],
      createdAt: now,
      updatedAt: now,
      ...(draft.rationale === undefined ? {} : { rationale: draft.rationale }),
      ...(draft.metadata === undefined ? {} : { metadata: draft.metadata }),
    };
    this.entries.push(entry);
    this.prune();
    await this.persist();
    return entry;
  }

  async forget(id: string): Promise<boolean> {
    await this.load();
    const before = this.entries.length;
    this.entries = this.entries.filter((entry) => entry.id !== id);
    if (this.entries.length === before) {
      return false;
    }
    await this.persist();
    return true;
  }

  async clear(): Promise<void> {
    await this.load();
    this.entries = [];
    await this.persist();
  }

  /** Newest-updated first, so the most recently reinforced fact leads. */
  async recall(query: MemoryQuery = {}): Promise<readonly MemoryEntry[]> {
    await this.load();
    const search = query.search?.trim().toLowerCase();

    const matched = this.entries.filter((entry) => {
      if (query.kind !== undefined && entry.kind !== query.kind) {
        return false;
      }
      if (query.path !== undefined && entry.paths.length > 0 && !entry.paths.includes(query.path)) {
        return false;
      }
      if (search !== undefined && search !== '') {
        const haystack = `${entry.text} ${entry.rationale ?? ''}`.toLowerCase();
        if (!haystack.includes(search)) {
          return false;
        }
      }
      return true;
    });

    matched.sort((a, b) => b.updatedAt - a.updatedAt);
    return query.limit === undefined ? matched : matched.slice(0, query.limit);
  }

  /**
   * Renders memories as prompt text.
   *
   * Grouped by kind because an undifferentiated list reads as noise; the headings
   * tell the model whether a line is a hard constraint or a soft convention.
   * Returns an empty string when there is nothing to say, so a caller can
   * concatenate unconditionally without emitting a stray heading.
   */
  async toPromptSection(query: MemoryQuery = {}): Promise<string> {
    const entries = await this.recall(query);
    if (entries.length === 0) {
      return '';
    }

    const groups = new Map<string, MemoryEntry[]>();
    for (const entry of entries) {
      const bucket = groups.get(entry.kind) ?? [];
      bucket.push(entry);
      groups.set(entry.kind, bucket);
    }

    const lines: string[] = ['# Workspace memory'];
    for (const [kind, bucket] of groups) {
      lines.push('', `## ${kind}`);
      for (const entry of bucket) {
        const scope = entry.paths.length > 0 ? ` (${entry.paths.join(', ')})` : '';
        lines.push(`- ${entry.text}${scope}`);
        if (entry.rationale !== undefined && entry.rationale !== '') {
          lines.push(`  Why: ${entry.rationale}`);
        }
      }
    }
    return lines.join('\n');
  }

  private prune(): void {
    if (this.entries.length <= this.maxEntries) {
      return;
    }
    const sorted = [...this.entries].sort((a, b) => b.updatedAt - a.updatedAt);
    const kept = sorted.slice(0, this.maxEntries);
    this.logger.log('info', 'memory pruned', {
      dropped: this.entries.length - kept.length,
      kept: kept.length,
    });
    this.entries = kept;
  }

  /**
   * Writes the whole file, serialised against itself.
   *
   * Chaining on the previous write means two concurrent `remember` calls cannot
   * interleave a read-modify-write and lose one of the two entries.
   */
  private persist(): Promise<void> {
    const path = memoryPath(this.deps.storage);
    if (path === null) {
      // No workspace: the store is in-memory only for this session.
      return this.writing;
    }
    const snapshot: MemoryFile = { version: MEMORY_FILE_VERSION, entries: [...this.entries] };

    this.writing = this.writing.then(async () => {
      try {
        await this.deps.fileSystem.writeTextFile(path, `${JSON.stringify(snapshot, null, 2)}\n`);
      } catch (error: unknown) {
        // A failed write must not reject into the agent loop; the in-memory copy
        // stays authoritative for this session and the next write may succeed.
        this.logger.log('error', 'memory write failed', {
          path,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    });
    return this.writing;
  }
}

/** Validates the parsed file, dropping anything malformed rather than trusting it. */
function readEntries(parsed: unknown): readonly MemoryEntry[] {
  if (typeof parsed !== 'object' || parsed === null) {
    return [];
  }
  const file = parsed as { version?: unknown; entries?: unknown };
  if (file.version !== MEMORY_FILE_VERSION || !Array.isArray(file.entries)) {
    return [];
  }
  return file.entries.filter(isMemoryEntry);
}

function isMemoryEntry(value: unknown): value is MemoryEntry {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const entry = value as Record<string, unknown>;
  return (
    typeof entry['id'] === 'string' &&
    typeof entry['text'] === 'string' &&
    typeof entry['kind'] === 'string' &&
    Array.isArray(entry['paths']) &&
    typeof entry['createdAt'] === 'number' &&
    typeof entry['updatedAt'] === 'number'
  );
}
