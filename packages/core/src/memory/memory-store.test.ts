import { describe, expect, it } from 'vitest';
import { BufferLogger, FakeClock, MemoryFileSystem, MemoryStorage } from '../testing/fakes.js';
import { MEMORY_FILE_VERSION, MemoryStore, memoryPath } from './memory-store.js';

/**
 * Workspace memory is what makes a disposable session cumulative
 * (Docs/TARS_SPEC.md §2, phase 5). The properties that matter are that it
 * survives a restart, never grows without bound, degrades to empty rather than
 * throwing on a corrupt file, and works at all when no workspace is open.
 */

const T0 = 1_700_000_000_000;

interface Harness {
  readonly store: MemoryStore;
  readonly fs: MemoryFileSystem;
  readonly storage: MemoryStorage;
  readonly clock: FakeClock;
  readonly logger: BufferLogger;
}

function harness(
  options: { readonly maxEntries?: number; readonly workspace?: string | null } = {},
): Harness {
  const fs = new MemoryFileSystem();
  const storage = new MemoryStorage('/global', options.workspace === undefined ? '/ws' : options.workspace);
  const clock = new FakeClock(T0);
  const logger = new BufferLogger();
  const store = new MemoryStore({
    fileSystem: fs,
    storage,
    clock,
    logger,
    ...(options.maxEntries === undefined ? {} : { maxEntries: options.maxEntries }),
    newId: idFactory(),
  });
  return { store, fs, storage, clock, logger };
}

/** Deterministic ids so assertions are literal rather than regex-matched. */
function idFactory(): () => string {
  let n = 0;
  return () => {
    n += 1;
    return `mem-${String(n)}`;
  };
}

describe('memoryPath', () => {
  it('is null when no workspace is open', () => {
    expect(memoryPath(new MemoryStorage('/global', null))).toBeNull();
  });

  it('sits under the workspace storage root', () => {
    expect(memoryPath(new MemoryStorage('/global', '/ws'))).toBe('/ws/memory.json');
  });
});

describe('MemoryStore.remember', () => {
  it('records an entry with identity and timestamps', async () => {
    const { store, clock } = harness();
    void clock;

    const entry = await store.remember({ text: 'Uses pnpm, never npm', kind: 'convention' });

    expect(entry.id).toBe('mem-1');
    expect(entry.text).toBe('Uses pnpm, never npm');
    expect(entry.createdAt).toBe(T0);
    expect(entry.updatedAt).toBe(T0);
    expect(entry.paths).toEqual([]);
    expect(store.size).toBe(1);
  });

  it('trims surrounding whitespace from the fact', async () => {
    const { store } = harness();
    const entry = await store.remember({ text: '  spaced  ', kind: 'context' });
    expect(entry.text).toBe('spaced');
  });

  it('updates rather than duplicating when the same fact is relearned', async () => {
    const { store, clock } = harness();
    await store.remember({ text: 'Uses pnpm', kind: 'convention' });
    clock.advance(5_000);
    const second = await store.remember({
      text: 'Uses pnpm',
      kind: 'convention',
      rationale: 'lockfile is pnpm-lock.yaml',
    });

    expect(store.size).toBe(1);
    expect(second.id).toBe('mem-1');
    expect(second.createdAt).toBe(T0);
    expect(second.updatedAt).toBe(T0 + 5_000);
    expect(second.rationale).toBe('lockfile is pnpm-lock.yaml');
  });

  it('treats the same text under a different kind as a distinct fact', async () => {
    const { store } = harness();
    await store.remember({ text: 'no any', kind: 'convention' });
    await store.remember({ text: 'no any', kind: 'constraint' });

    expect(store.size).toBe(2);
  });

  it('persists across a fresh store over the same filesystem', async () => {
    const { store, fs, storage, logger } = harness();
    await store.remember({ text: 'Node 24 required', kind: 'workflow' });

    const reopened = new MemoryStore({
      fileSystem: fs,
      storage,
      clock: new FakeClock(T0),
      logger,
    });

    expect(await reopened.recall()).toHaveLength(1);
  });
});

describe('MemoryStore.recall', () => {
  async function seeded(): Promise<MemoryStore> {
    const { store, clock } = harness();
    await store.remember({ text: 'Prefer composition', kind: 'convention' });
    clock.advance(1_000);
    await store.remember({ text: 'Never import vscode in core', kind: 'constraint' });
    clock.advance(1_000);
    await store.remember({
      text: 'Run pnpm verify',
      kind: 'workflow',
      paths: ['packages/core'],
    });
    return store;
  }

  it('returns most-recently-updated first', async () => {
    const store = await seeded();
    expect((await store.recall()).map((e) => e.kind)).toEqual([
      'workflow',
      'constraint',
      'convention',
    ]);
  });

  it('filters by kind', async () => {
    const store = await seeded();
    expect(await store.recall({ kind: 'constraint' })).toHaveLength(1);
  });

  it('matches a path-scoped entry and keeps workspace-wide entries', async () => {
    const store = await seeded();
    const found = await store.recall({ path: 'packages/core' });

    // Two unscoped entries always apply; the scoped one matches this path.
    expect(found).toHaveLength(3);
  });

  it('excludes an entry scoped to a different path', async () => {
    const store = await seeded();
    const found = await store.recall({ path: 'packages/host' });

    expect(found.map((e) => e.text)).not.toContain('Run pnpm verify');
  });

  it('searches text and rationale case-insensitively', async () => {
    const { store } = harness();
    await store.remember({ text: 'Alpha', kind: 'context', rationale: 'because BETA' });

    expect(await store.recall({ search: 'beta' })).toHaveLength(1);
    expect(await store.recall({ search: 'alpha' })).toHaveLength(1);
    expect(await store.recall({ search: 'gamma' })).toHaveLength(0);
  });

  it('honours limit', async () => {
    const store = await seeded();
    expect(await store.recall({ limit: 2 })).toHaveLength(2);
  });
});

describe('MemoryStore.forget and clear', () => {
  it('removes a single entry and reports success', async () => {
    const { store } = harness();
    const entry = await store.remember({ text: 'temp', kind: 'context' });

    expect(await store.forget(entry.id)).toBe(true);
    expect(store.size).toBe(0);
  });

  it('reports failure for an unknown id without mutating', async () => {
    const { store } = harness();
    await store.remember({ text: 'kept', kind: 'context' });

    expect(await store.forget('nope')).toBe(false);
    expect(store.size).toBe(1);
  });

  it('clear empties the store and the file', async () => {
    const { store, fs, storage } = harness();
    await store.remember({ text: 'a', kind: 'context' });
    await store.clear();

    const path = memoryPath(storage);
    expect(path).not.toBeNull();
    const raw = await fs.readTextFile(path ?? '');
    expect(JSON.parse(raw)).toEqual({ version: MEMORY_FILE_VERSION, entries: [] });
  });
});

describe('MemoryStore pruning', () => {
  it('keeps only the most recently updated entries', async () => {
    const { store, clock } = harness({ maxEntries: 2 });
    await store.remember({ text: 'oldest', kind: 'context' });
    clock.advance(1_000);
    await store.remember({ text: 'middle', kind: 'context' });
    clock.advance(1_000);
    await store.remember({ text: 'newest', kind: 'context' });

    const kept = (await store.recall()).map((e) => e.text);
    expect(kept).toEqual(['newest', 'middle']);
  });
});

describe('MemoryStore resilience', () => {
  it('starts empty when the file is corrupt rather than throwing', async () => {
    const { fs, storage, logger } = harness();
    await fs.writeTextFile('/ws/memory.json', '{ not json');

    const store = new MemoryStore({ fileSystem: fs, storage, clock: new FakeClock(T0), logger });

    expect(await store.recall()).toEqual([]);
    expect(logger.records.some((r) => r.message === 'memory file unreadable, starting empty')).toBe(
      true,
    );
  });

  it('ignores a file written by an incompatible future version', async () => {
    const { fs, storage, logger } = harness();
    await fs.writeTextFile(
      '/ws/memory.json',
      JSON.stringify({ version: MEMORY_FILE_VERSION + 1, entries: [{ id: 'x' }] }),
    );

    const store = new MemoryStore({ fileSystem: fs, storage, clock: new FakeClock(T0), logger });

    expect(await store.recall()).toEqual([]);
  });

  it('drops malformed entries but keeps well-formed ones', async () => {
    const { fs, storage, logger } = harness();
    await fs.writeTextFile(
      '/ws/memory.json',
      JSON.stringify({
        version: MEMORY_FILE_VERSION,
        entries: [
          { id: 'good', text: 'fine', kind: 'context', paths: [], createdAt: 1, updatedAt: 1 },
          { id: 'bad', text: 42 },
          null,
        ],
      }),
    );

    const store = new MemoryStore({ fileSystem: fs, storage, clock: new FakeClock(T0), logger });

    expect((await store.recall()).map((e) => e.id)).toEqual(['good']);
  });

  it('works in memory when no workspace is open', async () => {
    const { store } = harness({ workspace: null });

    await store.remember({ text: 'session-only', kind: 'context' });

    expect(await store.recall()).toHaveLength(1);
  });

  it('does not reject into the caller when the write fails', async () => {
    const { store, fs } = harness();
    fs.failOn = { operation: 'write', message: 'EACCES' };

    await expect(store.remember({ text: 'still returns', kind: 'context' })).resolves.toBeDefined();
    expect(store.size).toBe(1);
  });

  it('serialises concurrent writes without losing an entry', async () => {
    const { store } = harness();

    await Promise.all([
      store.remember({ text: 'one', kind: 'context' }),
      store.remember({ text: 'two', kind: 'context' }),
      store.remember({ text: 'three', kind: 'context' }),
    ]);

    expect(store.size).toBe(3);
  });
});

describe('MemoryStore.toPromptSection', () => {
  it('is empty when there is nothing to say', async () => {
    const { store } = harness();
    expect(await store.toPromptSection()).toBe('');
  });

  it('groups by kind and renders rationale and scope', async () => {
    const { store } = harness();
    await store.remember({
      text: 'Never import vscode in core',
      kind: 'constraint',
      rationale: 'keeps core unit-testable',
      paths: ['packages/core'],
    });

    const section = await store.toPromptSection();

    expect(section).toContain('# Workspace memory');
    expect(section).toContain('## constraint');
    expect(section).toContain('- Never import vscode in core (packages/core)');
    expect(section).toContain('Why: keeps core unit-testable');
  });
});
