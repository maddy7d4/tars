import { describe, expect, it } from 'vitest';
import type { WorkspaceFolder } from '../ports/workspace-port.js';
import { BufferLogger, MemoryFileSystem } from '../testing/fakes.js';
import { FileIndex } from './file-index.js';

/**
 * The index backs `@`-mention completion, so the properties that matter are that
 * it excludes what `.gitignore` excludes, ranks a basename above an incidental
 * path substring, and cannot hang the extension host on a pathological tree
 * (Docs/TARS_SPEC.md §7.2).
 */

const FOLDER: WorkspaceFolder = { name: 'repo', path: '/repo' };

async function seed(files: Readonly<Record<string, string>>): Promise<MemoryFileSystem> {
  const fs = new MemoryFileSystem();
  for (const [path, content] of Object.entries(files)) {
    await fs.writeTextFile(path, content);
  }
  return fs;
}

async function build(
  files: Readonly<Record<string, string>>,
  options: { readonly maxFiles?: number; readonly maxDepth?: number } = {},
): Promise<FileIndex> {
  const fs = await seed(files);
  const index = new FileIndex({ fileSystem: fs, logger: new BufferLogger(), ...options });
  await index.build([FOLDER]);
  return index;
}

describe('FileIndex.build', () => {
  it('indexes files as workspace-relative paths', async () => {
    const index = await build({
      '/repo/src/index.ts': 'export {};',
      '/repo/README.md': '# hi',
    });

    expect(index.all().map((f) => f.path)).toEqual(['README.md', 'src/index.ts']);
    expect(index.get('src/index.ts')?.absolutePath).toBe('/repo/src/index.ts');
    expect(index.get('src/index.ts')?.name).toBe('index.ts');
  });

  it('excludes paths matched by .gitignore', async () => {
    const index = await build({
      '/repo/.gitignore': 'node_modules\ndist/\n',
      '/repo/src/app.ts': '',
      '/repo/node_modules/react/index.js': '',
      '/repo/dist/bundle.js': '',
    });

    expect(index.all().map((f) => f.path)).toEqual(['.gitignore', 'src/app.ts']);
  });

  it('lets a nested .gitignore govern its own subtree only', async () => {
    const index = await build({
      '/repo/.gitignore': '*.log\n',
      '/repo/packages/web/.gitignore': '!keep.log\n',
      '/repo/packages/web/keep.log': '',
      '/repo/packages/api/keep.log': '',
    });

    const paths = index.all().map((f) => f.path);
    expect(paths).toContain('packages/web/keep.log');
    expect(paths).not.toContain('packages/api/keep.log');
  });

  it('always excludes .git regardless of .gitignore', async () => {
    const index = await build({
      '/repo/.git/config': '',
      '/repo/src/a.ts': '',
    });

    expect(index.all().map((f) => f.path)).toEqual(['src/a.ts']);
  });

  it('stops at maxFiles and reports truncation', async () => {
    const files: Record<string, string> = {};
    for (let i = 0; i < 30; i += 1) {
      files[`/repo/f${String(i)}.ts`] = '';
    }
    const index = await build(files, { maxFiles: 10 });

    expect(index.size).toBeLessThanOrEqual(10);
    expect(index.isTruncated).toBe(true);
  });

  it('does not report truncation for a tree that fits', async () => {
    const index = await build({ '/repo/a.ts': '', '/repo/b.ts': '' });
    expect(index.isTruncated).toBe(false);
  });

  it('stops descending past maxDepth', async () => {
    const index = await build({ '/repo/a/b/c/d/deep.ts': '', '/repo/top.ts': '' }, { maxDepth: 2 });

    const paths = index.all().map((f) => f.path);
    expect(paths).toContain('top.ts');
    expect(paths).not.toContain('a/b/c/d/deep.ts');
  });

  it('rebuilds cleanly rather than accumulating', async () => {
    const fs = await seed({ '/repo/a.ts': '' });
    const index = new FileIndex({ fileSystem: fs, logger: new BufferLogger() });
    await index.build([FOLDER]);
    await index.build([FOLDER]);

    expect(index.size).toBe(1);
  });

  it('survives an unreadable directory instead of aborting the walk', async () => {
    const fs = await seed({ '/repo/ok.ts': '' });
    const guarded = new (class extends MemoryFileSystem {
      override readDirectory(path: string): Promise<readonly { name: string; type: 'file' | 'directory' | 'symlink' }[]> {
        if (path === '/repo/secret') {
          return Promise.reject(new Error('EACCES'));
        }
        return super.readDirectory(path);
      }
    })();
    await guarded.writeTextFile('/repo/ok.ts', '');
    await guarded.createDirectory('/repo/secret');
    void fs;

    const index = new FileIndex({ fileSystem: guarded, logger: new BufferLogger() });
    await index.build([FOLDER]);

    expect(index.all().map((f) => f.path)).toContain('ok.ts');
  });
});

describe('FileIndex.search', () => {
  it('ranks an exact basename above a prefix and a path substring', async () => {
    const index = await build({
      '/repo/src/index.ts': '',
      '/repo/src/indexer.ts': '',
      '/repo/docs/index/notes.md': '',
    });

    expect(index.search('index.ts').map((f) => f.path)[0]).toBe('src/index.ts');
  });

  it('prefers a shallower path when scores tie', async () => {
    const index = await build({
      '/repo/util.ts': '',
      '/repo/a/b/util.ts': '',
    });

    expect(index.search('util.ts').map((f) => f.path)).toEqual(['util.ts', 'a/b/util.ts']);
  });

  it('matches case-insensitively', async () => {
    const index = await build({ '/repo/src/README.md': '' });
    expect(index.search('readme')).toHaveLength(1);
  });

  it('returns the head of the index for an empty query', async () => {
    const index = await build({ '/repo/a.ts': '', '/repo/b.ts': '' });
    expect(index.search('', 1)).toHaveLength(1);
  });

  it('honours the limit', async () => {
    const index = await build({ '/repo/a1.ts': '', '/repo/a2.ts': '', '/repo/a3.ts': '' });
    expect(index.search('a', 2)).toHaveLength(2);
  });

  it('returns nothing when no file matches', async () => {
    const index = await build({ '/repo/a.ts': '' });
    expect(index.search('nonexistent')).toEqual([]);
  });
});

describe('FileIndex.applyChange', () => {
  it('adds a file in sorted position without a rebuild', async () => {
    const index = await build({ '/repo/a.ts': '', '/repo/c.ts': '' });

    index.applyChange({ path: 'b.ts', absolutePath: '/repo/b.ts', kind: 'added' });

    expect(index.all().map((f) => f.path)).toEqual(['a.ts', 'b.ts', 'c.ts']);
    expect(index.get('b.ts')?.name).toBe('b.ts');
  });

  it('removes a file', async () => {
    const index = await build({ '/repo/a.ts': '', '/repo/b.ts': '' });

    index.applyChange({ path: 'a.ts', absolutePath: '/repo/a.ts', kind: 'removed' });

    expect(index.all().map((f) => f.path)).toEqual(['b.ts']);
    expect(index.get('a.ts')).toBeNull();
  });

  it('is idempotent when adding a file already indexed', async () => {
    const index = await build({ '/repo/a.ts': '' });

    index.applyChange({ path: 'a.ts', absolutePath: '/repo/a.ts', kind: 'added' });

    expect(index.size).toBe(1);
  });

  it('ignores removal of a file that was never indexed', async () => {
    const index = await build({ '/repo/a.ts': '' });

    index.applyChange({ path: 'ghost.ts', absolutePath: '/repo/ghost.ts', kind: 'removed' });

    expect(index.size).toBe(1);
  });
});
