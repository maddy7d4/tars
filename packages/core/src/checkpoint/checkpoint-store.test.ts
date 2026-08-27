import { beforeEach, describe, expect, it } from 'vitest';
import { hashContent } from '../diff/content-hash.js';
import { BufferLogger, FakeClock, MemoryFileSystem, MemoryStorage } from '../testing/fakes.js';
import { BlobStore } from './blob-store.js';
import { CHECKPOINT_FILE_VERSION, CheckpointStore } from './checkpoint-store.js';

/**
 * Tests for checkpoints (Docs/TARS_SPEC.md §6.4).
 *
 * A checkpoint is the safety net under every apply, so the failure that matters
 * is not "restore threw" but "restore quietly returned the wrong content" — or
 * worse, "the blob was collected while a checkpoint still referenced it". Those
 * are asserted directly rather than inferred from a happy path.
 */

const T0 = 1_700_000_000_000;
const SESSION = 'session-1';

interface Harness {
  readonly store: CheckpointStore;
  readonly fs: MemoryFileSystem;
  readonly clock: FakeClock;
  readonly logger: BufferLogger;
  readonly storage: MemoryStorage;
}

function idFactory(): () => string {
  let n = 0;
  return () => {
    n += 1;
    return `cp-${String(n)}`;
  };
}

function harness(options: { readonly maxCheckpoints?: number } = {}): Harness {
  const fs = new MemoryFileSystem();
  const storage = new MemoryStorage('/global', '/workspace');
  const clock = new FakeClock(T0);
  const logger = new BufferLogger();
  const store = new CheckpointStore({
    fileSystem: fs,
    storage,
    clock,
    logger,
    newId: idFactory(),
    ...(options.maxCheckpoints === undefined ? {} : { maxCheckpoints: options.maxCheckpoints }),
  });
  return { store, fs, clock, logger, storage };
}

/** Reopens the same storage, the way a new window would. */
function reopen(existing: Harness): CheckpointStore {
  return new CheckpointStore({
    fileSystem: existing.fs,
    storage: existing.storage,
    clock: existing.clock,
    logger: existing.logger,
    newId: idFactory(),
  });
}

function blobPaths(fs: MemoryFileSystem): readonly string[] {
  return [...fs.files.keys()].filter((path) => path.startsWith('/global/checkpoints/blobs/'));
}

let h: Harness;
beforeEach(() => {
  h = harness();
});

describe('CheckpointStore.create', () => {
  it('records a checkpoint with the content as it stands before the apply', async () => {
    const checkpoint = await h.store.create({
      label: 'Refactor the parser',
      sessionId: SESSION,
      eventOffset: 12,
      files: [{ path: 'a.ts', content: 'original\n' }],
    });

    expect(checkpoint.id).toBe('cp-1');
    expect(checkpoint.at).toBe(T0);
    expect(checkpoint.eventOffset).toBe(12);
    expect(checkpoint.files).toEqual([{ path: 'a.ts', beforeHash: hashContent('original\n') }]);
  });

  it('records a file that does not exist yet as a null hash', async () => {
    // Not an omission: returning to this checkpoint means deleting the file the
    // agent is about to create, and only an explicit entry can say that.
    const checkpoint = await h.store.create({
      label: 'Add a module',
      sessionId: SESSION,
      eventOffset: 0,
      files: [{ path: 'new.ts', content: null }],
    });

    expect(checkpoint.files).toEqual([{ path: 'new.ts', beforeHash: null }]);
    expect(blobPaths(h.fs)).toEqual([]);
  });

  it('stores identical content once across checkpoints', async () => {
    await h.store.create({
      label: 'first',
      sessionId: SESSION,
      eventOffset: 1,
      files: [{ path: 'a.ts', content: 'same\n' }, { path: 'b.ts', content: 'same\n' }],
    });
    await h.store.create({
      label: 'second',
      sessionId: SESSION,
      eventOffset: 2,
      files: [{ path: 'c.ts', content: 'same\n' }],
    });

    // Three files, three checkpointed entries, one blob. This is the whole point
    // of keying by hash: a session that touches the same files repeatedly must
    // not grow storage linearly in checkpoints.
    expect(blobPaths(h.fs)).toHaveLength(1);
  });

  it('lists checkpoints newest first', async () => {
    await h.store.create({ label: 'one', sessionId: SESSION, eventOffset: 1, files: [] });
    h.clock.advance(1000);
    await h.store.create({ label: 'two', sessionId: SESSION, eventOffset: 2, files: [] });

    expect((await h.store.list()).map((entry) => entry.label)).toEqual(['two', 'one']);
  });

  it('filters the list by session', async () => {
    await h.store.create({ label: 'a', sessionId: SESSION, eventOffset: 1, files: [] });
    await h.store.create({ label: 'b', sessionId: 'other', eventOffset: 1, files: [] });

    expect((await h.store.list(SESSION)).map((entry) => entry.label)).toEqual(['a']);
  });
});

describe('CheckpointStore.restore', () => {
  it('returns the content to write back, without writing anything itself', async () => {
    const created = await h.store.create({
      label: 'edit',
      sessionId: SESSION,
      eventOffset: 7,
      files: [{ path: 'a.ts', content: 'original\n' }],
    });
    const blobsBefore = blobPaths(h.fs).length;

    const result = await h.store.restore(created.id);

    expect(result?.restored).toEqual([{ path: 'a.ts', content: 'original\n' }]);
    expect(result?.deleted).toEqual([]);
    expect(result?.eventOffset).toBe(7);
    // Applying is the host's job, so that a restore lands in the editor's undo
    // stack exactly as the edit did (§6.3).
    expect(blobPaths(h.fs)).toHaveLength(blobsBefore);
    expect(h.fs.files.has('a.ts')).toBe(false);
  });

  it('asks for deletion of files that did not exist at checkpoint time', async () => {
    const created = await h.store.create({
      label: 'create',
      sessionId: SESSION,
      eventOffset: 1,
      files: [{ path: 'new.ts', content: null }, { path: 'old.ts', content: 'kept\n' }],
    });

    const result = await h.store.restore(created.id);

    expect(result?.deleted).toEqual(['new.ts']);
    expect(result?.restored).toEqual([{ path: 'old.ts', content: 'kept\n' }]);
  });

  it('reports an unreadable blob instead of failing the whole restore', async () => {
    const created = await h.store.create({
      label: 'edit',
      sessionId: SESSION,
      eventOffset: 1,
      files: [{ path: 'a.ts', content: 'gone\n' }, { path: 'b.ts', content: 'here\n' }],
    });
    h.fs.files.delete(`/global/checkpoints/blobs/${hashContent('gone\n')}`);

    const result = await h.store.restore(created.id);

    // Nine of ten files recovered plus a named casualty beats an all-or-nothing
    // refusal that recovers none.
    expect(result?.unrecoverable).toEqual(['a.ts']);
    expect(result?.restored).toEqual([{ path: 'b.ts', content: 'here\n' }]);
    expect(h.logger.at('error')).toHaveLength(1);
  });

  it('returns null for an unknown checkpoint', async () => {
    expect(await h.store.restore('nope')).toBeNull();
  });
});

describe('CheckpointStore persistence', () => {
  it('survives a reopen', async () => {
    await h.store.create({
      label: 'edit',
      sessionId: SESSION,
      eventOffset: 3,
      files: [{ path: 'a.ts', content: 'original\n' }],
    });

    const reopened = reopen(h);
    const restored = await reopened.restore('cp-1');

    expect(restored?.restored).toEqual([{ path: 'a.ts', content: 'original\n' }]);
    expect(restored?.eventOffset).toBe(3);
  });

  it('writes a versioned index', async () => {
    await h.store.create({ label: 'x', sessionId: SESSION, eventOffset: 1, files: [] });
    const raw = h.fs.files.get('/global/checkpoints/index.json') ?? '';

    expect(JSON.parse(raw)).toMatchObject({ version: CHECKPOINT_FILE_VERSION });
  });

  it('starts empty rather than throwing when the index is corrupt', async () => {
    await h.store.create({ label: 'x', sessionId: SESSION, eventOffset: 1, files: [] });
    h.fs.files.set('/global/checkpoints/index.json', '{ not json');

    const reopened = reopen(h);
    // A torn safety net must not stop the user working.
    expect(await reopened.list()).toEqual([]);
    expect(h.logger.at('error')).toHaveLength(1);
  });

  it('ignores an index written by a future version', async () => {
    h.fs.files.set(
      '/global/checkpoints/index.json',
      JSON.stringify({ version: CHECKPOINT_FILE_VERSION + 1, checkpoints: [{ id: 'x' }] }),
    );

    expect(await reopen(h).list()).toEqual([]);
  });

  it('drops only the malformed records, keeping the rest', async () => {
    h.fs.files.set(
      '/global/checkpoints/index.json',
      JSON.stringify({
        version: CHECKPOINT_FILE_VERSION,
        checkpoints: [
          { id: 'good', at: 1, label: 'l', sessionId: SESSION, eventOffset: 0, files: [] },
          { id: 'bad', at: 'not a number', label: 'l', sessionId: SESSION, eventOffset: 0, files: [] },
          { id: 'also-good', at: 2, label: 'l', sessionId: SESSION, eventOffset: 0, files: [] },
        ],
      }),
    );

    // One truncated entry must not cost the user every checkpoint before it.
    expect((await reopen(h).list()).map((entry) => entry.id)).toEqual(['also-good', 'good']);
  });

  it('serialises concurrent writes so neither checkpoint is lost', async () => {
    await Promise.all([
      h.store.create({ label: 'a', sessionId: SESSION, eventOffset: 1, files: [] }),
      h.store.create({ label: 'b', sessionId: SESSION, eventOffset: 2, files: [] }),
    ]);

    expect(await reopen(h).list()).toHaveLength(2);
  });
});

describe('CheckpointStore pruning and forgetting', () => {
  it('keeps only the newest checkpoints', async () => {
    const limited = harness({ maxCheckpoints: 2 });
    for (const label of ['one', 'two', 'three']) {
      await limited.store.create({ label, sessionId: SESSION, eventOffset: 1, files: [] });
    }

    expect((await limited.store.list()).map((entry) => entry.label)).toEqual(['three', 'two']);
  });

  it('collects the blobs a pruned checkpoint alone was holding', async () => {
    const limited = harness({ maxCheckpoints: 1 });
    await limited.store.create({
      label: 'one',
      sessionId: SESSION,
      eventOffset: 1,
      files: [{ path: 'a.ts', content: 'first\n' }],
    });
    await limited.store.create({
      label: 'two',
      sessionId: SESSION,
      eventOffset: 2,
      files: [{ path: 'a.ts', content: 'second\n' }],
    });

    expect(blobPaths(limited.fs)).toEqual([
      `/global/checkpoints/blobs/${hashContent('second\n')}`,
    ]);
  });

  it('keeps a blob another checkpoint still references', async () => {
    const limited = harness({ maxCheckpoints: 1 });
    await limited.store.create({
      label: 'one',
      sessionId: SESSION,
      eventOffset: 1,
      files: [{ path: 'a.ts', content: 'shared\n' }],
    });
    await limited.store.create({
      label: 'two',
      sessionId: SESSION,
      eventOffset: 2,
      files: [{ path: 'b.ts', content: 'shared\n' }],
    });

    // Deduplication means one blob backs both files; pruning the first
    // checkpoint must not pull it out from under the second.
    expect(blobPaths(limited.fs)).toHaveLength(1);
    const survivor = await limited.store.restore('cp-2');
    expect(survivor?.restored).toEqual([{ path: 'b.ts', content: 'shared\n' }]);
  });

  it('forgets one checkpoint and reclaims its blob', async () => {
    await h.store.create({
      label: 'x',
      sessionId: SESSION,
      eventOffset: 1,
      files: [{ path: 'a.ts', content: 'only\n' }],
    });

    expect(await h.store.forget('cp-1')).toBe(true);
    expect(await h.store.list()).toEqual([]);
    expect(blobPaths(h.fs)).toEqual([]);
  });

  it('reports forgetting an unknown checkpoint rather than pretending', async () => {
    expect(await h.store.forget('nope')).toBe(false);
  });

  it('forgets every checkpoint of one session and leaves the others alone', async () => {
    await h.store.create({
      label: 'a',
      sessionId: SESSION,
      eventOffset: 1,
      files: [{ path: 'a.ts', content: 'a\n' }],
    });
    await h.store.create({
      label: 'b',
      sessionId: 'other',
      eventOffset: 1,
      files: [{ path: 'b.ts', content: 'b\n' }],
    });

    expect(await h.store.forgetSession(SESSION)).toBe(1);
    expect((await h.store.list()).map((entry) => entry.sessionId)).toEqual(['other']);
    expect(blobPaths(h.fs)).toEqual([`/global/checkpoints/blobs/${hashContent('b\n')}`]);
  });
});

describe('BlobStore', () => {
  function blobs(): { readonly store: BlobStore; readonly fs: MemoryFileSystem } {
    const fs = new MemoryFileSystem();
    return {
      store: new BlobStore({ fileSystem: fs, directory: '/blobs', logger: new BufferLogger() }),
      fs,
    };
  }

  it('round-trips content through its hash', async () => {
    const { store } = blobs();
    const hash = await store.put('hello\n');

    expect(hash).toBe(hashContent('hello\n'));
    expect(await store.get(hash)).toBe('hello\n');
  });

  it('stores the empty string, which is a legitimate file', async () => {
    const { store } = blobs();
    const hash = await store.put('');
    expect(await store.get(hash)).toBe('');
  });

  it('writes identical content only once', async () => {
    const { store, fs } = blobs();
    await store.put('same\n');
    await store.put('same\n');

    expect([...fs.files.keys()]).toHaveLength(1);
  });

  it('reports a missing blob as absent rather than throwing', async () => {
    const { store } = blobs();
    expect(await store.get(hashContent('never stored'))).toBeNull();
  });

  it('refuses a malformed id instead of turning it into a path', async () => {
    const fs = new MemoryFileSystem();
    const logger = new BufferLogger();
    const store = new BlobStore({ fileSystem: fs, directory: '/blobs', logger });
    fs.files.set('/etc/passwd', 'secret');

    // The id goes straight into a filename; anything but a hash is refused.
    expect(await store.get('../../etc/passwd')).toBeNull();
    expect(await store.has('../../etc/passwd')).toBe(false);
    expect(logger.at('warn')).toHaveLength(1);
  });

  it('sweeps only what nothing references', async () => {
    const { store, fs } = blobs();
    const kept = await store.put('kept\n');
    await store.put('dropped\n');

    expect(await store.collectGarbage(new Set([kept]))).toBe(1);
    expect([...fs.files.keys()]).toEqual([`/blobs/${kept}`]);
  });

  it('leaves foreign files in the directory alone', async () => {
    const { store, fs } = blobs();
    await store.put('kept\n');
    fs.files.set('/blobs/README.txt', 'not a blob');

    await store.collectGarbage(new Set());
    // Only hash-shaped names are ours to delete.
    expect(fs.files.has('/blobs/README.txt')).toBe(true);
  });

  it('sweeping an empty store is not an error', async () => {
    const { store } = blobs();
    expect(await store.collectGarbage(new Set())).toBe(0);
  });
});

describe('CheckpointStore.addFiles', () => {
  it('extends a checkpoint as a turn touches more files', async () => {
    const created = await h.store.create({
      label: 'turn',
      sessionId: SESSION,
      eventOffset: 1,
      files: [{ path: 'a.ts', content: 'a\n' }],
    });

    const updated = await h.store.addFiles(created.id, [{ path: 'b.ts', content: 'b\n' }]);

    expect(updated?.files.map((file) => file.path)).toEqual(['a.ts', 'b.ts']);
    const restored = await h.store.restore(created.id);
    expect(restored?.restored).toEqual([
      { path: 'a.ts', content: 'a\n' },
      { path: 'b.ts', content: 'b\n' },
    ]);
  });

  it('keeps the first snapshot of a path, not the latest', async () => {
    const created = await h.store.create({
      label: 'turn',
      sessionId: SESSION,
      eventOffset: 1,
      files: [{ path: 'a.ts', content: 'original\n' }],
    });

    // A second edit to the same file in one turn arrives with the agent's own
    // output as its baseline. Recording that would checkpoint the state nobody
    // needs to get back to.
    await h.store.addFiles(created.id, [{ path: 'a.ts', content: 'agent wrote this\n' }]);

    const restored = await h.store.restore(created.id);
    expect(restored?.restored).toEqual([{ path: 'a.ts', content: 'original\n' }]);
  });

  it('persists after every addition, so a crash mid-turn still leaves a way back', async () => {
    const created = await h.store.create({
      label: 'turn',
      sessionId: SESSION,
      eventOffset: 1,
      files: [{ path: 'a.ts', content: 'a\n' }],
    });
    await h.store.addFiles(created.id, [{ path: 'b.ts', content: 'b\n' }]);

    const restored = await reopen(h).restore(created.id);
    expect(restored?.restored).toHaveLength(2);
  });

  it('records a file that does not exist yet as a deletion on restore', async () => {
    const created = await h.store.create({
      label: 'turn',
      sessionId: SESSION,
      eventOffset: 1,
      files: [{ path: 'a.ts', content: 'a\n' }],
    });
    await h.store.addFiles(created.id, [{ path: 'new.ts', content: null }]);

    expect((await h.store.restore(created.id))?.deleted).toEqual(['new.ts']);
  });

  it('reports an unknown checkpoint rather than creating one', async () => {
    expect(await h.store.addFiles('nope', [{ path: 'a.ts', content: 'a\n' }])).toBeNull();
    expect(await h.store.list()).toEqual([]);
  });

  it('is a no-op when every path is already covered', async () => {
    const created = await h.store.create({
      label: 'turn',
      sessionId: SESSION,
      eventOffset: 1,
      files: [{ path: 'a.ts', content: 'a\n' }],
    });

    const updated = await h.store.addFiles(created.id, [{ path: 'a.ts', content: 'a\n' }]);
    expect(updated?.files).toHaveLength(1);
  });
});
