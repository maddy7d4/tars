import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  Diagnostic,
  DiagnosticsPort,
  GitPort,
  GitRepository,
  EditorSelection,
  OpenDocument,
  Unsubscribe,
  WorkspaceFolder,
  WorkspacePort,
} from '../ports/index.js';
import { BufferLogger, MemoryFileSystem, MemoryFileWatcher } from '../testing/fakes.js';
import { WorkspaceIndex } from './workspace-index.js';

/**
 * Tests for the live context engine (Docs/TARS_SPEC.md §7.2).
 *
 * The failure worth catching here is a *stale* index — completions that name
 * files which no longer exist, or miss ones that do — because staleness is
 * silent and only appears after time has passed. So these drive the watcher
 * explicitly rather than asserting on a freshly built index.
 */

const ROOT = '/repo';
const FOLDERS: readonly WorkspaceFolder[] = [{ name: 'repo', path: ROOT }];

class FakeWorkspace implements WorkspacePort {
  folders: readonly WorkspaceFolder[] = FOLDERS;
  activeSelection: EditorSelection | null = null;
  readonly openDocuments: readonly OpenDocument[] = [];

  resolvePath(relativePath: string): string | null {
    return `${ROOT}/${relativePath}`;
  }

  relativePath(absolutePath: string): string | null {
    return absolutePath.startsWith(`${ROOT}/`) ? absolutePath.slice(ROOT.length + 1) : null;
  }

  getConfiguration<T>(_section: string, defaultValue: T): T {
    return defaultValue;
  }

  onConfigurationChanged(): Unsubscribe {
    return () => undefined;
  }
}

class FakeDiagnostics implements DiagnosticsPort {
  diagnostics: Diagnostic[] = [];

  all(path?: string): readonly Diagnostic[] {
    return path === undefined
      ? this.diagnostics
      : this.diagnostics.filter((entry) => entry.path === path);
  }

  onDidChange(): Unsubscribe {
    return () => undefined;
  }
}

class FakeGit implements GitPort {
  repos: GitRepository[] = [];

  repositories(): Promise<readonly GitRepository[]> {
    return Promise.resolve(this.repos);
  }

  repositoryFor(): Promise<GitRepository | null> {
    return Promise.resolve(this.repos[0] ?? null);
  }

  showFileAtRef(): Promise<string | null> {
    return Promise.resolve(null);
  }
}

interface Harness {
  readonly index: WorkspaceIndex;
  readonly fs: MemoryFileSystem;
  readonly watcher: MemoryFileWatcher;
  readonly workspace: FakeWorkspace;
  readonly diagnostics: FakeDiagnostics;
  readonly git: FakeGit;
  readonly logger: BufferLogger;
}

function harness(files: Readonly<Record<string, string>> = {}): Harness {
  const fs = new MemoryFileSystem();
  for (const [path, content] of Object.entries(files)) {
    fs.files.set(`${ROOT}/${path}`, content);
  }
  const watcher = new MemoryFileWatcher();
  const workspace = new FakeWorkspace();
  const diagnostics = new FakeDiagnostics();
  const git = new FakeGit();
  const logger = new BufferLogger();

  return {
    index: new WorkspaceIndex({
      fileSystem: fs,
      workspace,
      diagnostics,
      fileWatcher: watcher,
      git,
      logger,
    }),
    fs,
    watcher,
    workspace,
    diagnostics,
    git,
    logger,
  };
}

function created(relativePath: string): {
  kind: 'created';
  absolutePath: string;
  relativePath: string;
} {
  return { kind: 'created', absolutePath: `${ROOT}/${relativePath}`, relativePath };
}

function deleted(relativePath: string): {
  kind: 'deleted';
  absolutePath: string;
  relativePath: string;
} {
  return { kind: 'deleted', absolutePath: `${ROOT}/${relativePath}`, relativePath };
}

let h: Harness;
beforeEach(() => {
  h = harness({
    'src/index.ts': 'export {};\n',
    'src/util/format.ts': 'export {};\n',
    'README.md': '# hi\n',
  });
});

afterEach(() => {
  h.index.dispose();
});

describe('WorkspaceIndex.start', () => {
  it('indexes the workspace', async () => {
    await h.index.start();
    expect(h.index.size).toBe(3);
  });

  it('walks once however many callers ensure it', async () => {
    const first = h.index.start();
    const second = h.index.start();
    await Promise.all([first, second]);

    // One "workspace indexed" record, not two: a second walk would be pure waste
    // and would race the watcher subscription the first one installs.
    expect(h.logger.records.filter((record) => record.message === 'workspace indexed')).toHaveLength(
      1,
    );
  });

  it('watches only after the first walk finishes', async () => {
    // Watching earlier would apply changes to an index still being built, and
    // the walk would then overwrite them.
    expect(h.watcher.isWatching).toBe(false);
    await h.index.start();
    expect(h.watcher.isWatching).toBe(true);
  });

  it('releases the watcher on dispose', async () => {
    await h.index.start();
    h.index.dispose();
    expect(h.watcher.isWatching).toBe(false);
  });
});

describe('WorkspaceIndex incremental updates', () => {
  it('picks up a created file without a rebuild', async () => {
    await h.index.start();
    h.watcher.emit(created('src/added.ts'));

    expect(await h.index.search('added.ts')).toHaveLength(1);
    expect(h.index.size).toBe(4);
  });

  it('drops a deleted file', async () => {
    await h.index.start();
    h.watcher.emit(deleted('README.md'));

    expect(await h.index.search('README')).toEqual([]);
  });

  it('ignores an edit, since the index holds paths and not content', async () => {
    await h.index.start();
    const before = h.index.size;
    h.watcher.emit({
      kind: 'changed',
      absolutePath: `${ROOT}/src/index.ts`,
      relativePath: 'src/index.ts',
    });

    expect(h.index.size).toBe(before);
  });

  it('ignores a change outside every workspace folder', async () => {
    await h.index.start();
    const before = h.index.size;
    h.watcher.emit({ kind: 'created', absolutePath: '/elsewhere/x.ts', relativePath: null });

    expect(h.index.size).toBe(before);
  });

  it('does not index a created file the ignore rules exclude', async () => {
    const ignored = harness({
      '.gitignore': 'dist/\n',
      'src/index.ts': 'export {};\n',
    });
    await ignored.index.start();
    const before = ignored.index.size;

    // The watcher reports build output, and a project that compiles into `dist/`
    // would otherwise fill the index the moment it was built.
    ignored.watcher.emit(created('dist/bundle.js'));

    expect(ignored.index.size).toBe(before);
    expect(await ignored.index.search('bundle')).toEqual([]);
    ignored.index.dispose();
  });

  it('never indexes anything under .git', async () => {
    await h.index.start();
    h.watcher.emit(created('.git/COMMIT_EDITMSG'));

    expect(await h.index.search('COMMIT')).toEqual([]);
  });
});

describe('WorkspaceIndex rebuilds', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('rebuilds when an ignore file changes, since rules can hide whole subtrees', async () => {
    const rebuilt = harness({ 'src/index.ts': 'export {};\n', 'dist/bundle.js': 'x\n' });
    await rebuilt.index.start();
    expect(rebuilt.index.size).toBe(2);

    rebuilt.fs.files.set(`${ROOT}/.gitignore`, 'dist/\n');
    rebuilt.watcher.emit(created('.gitignore'));
    await vi.advanceTimersByTimeAsync(600);

    // `.gitignore` is now indexed and `dist/bundle.js` is not: no incremental
    // update could have expressed that.
    expect(await rebuilt.index.search('bundle')).toEqual([]);
    rebuilt.index.dispose();
  });

  it('coalesces a burst into one rebuild', async () => {
    await h.index.start();
    const before = h.logger.records.filter((r) => r.message === 'workspace indexed').length;

    for (let i = 0; i < 5; i += 1) {
      h.watcher.emit(created('.gitignore'));
    }
    await vi.advanceTimersByTimeAsync(600);

    // A branch switch rewrites .gitignore alongside everything else; a walk per
    // event would turn a checkout into a stall.
    const after = h.logger.records.filter((r) => r.message === 'workspace indexed').length;
    expect(after - before).toBe(1);
  });

  it('cancels a pending rebuild on dispose', async () => {
    await h.index.start();
    const before = h.logger.records.filter((r) => r.message === 'workspace indexed').length;

    h.watcher.emit(created('.gitignore'));
    h.index.dispose();
    await vi.advanceTimersByTimeAsync(600);

    expect(h.logger.records.filter((r) => r.message === 'workspace indexed')).toHaveLength(before);
  });
});

describe('WorkspaceIndex.resolve', () => {
  it('leaves a prompt without mentions alone', async () => {
    const result = await h.index.resolve('fix the build');
    expect(result).toEqual({ text: 'fix the build', context: [], unresolved: [] });
  });

  it('attaches a mentioned file and removes it from the prose', async () => {
    const result = await h.index.resolve('explain @src/index.ts please');

    expect(result.context).toEqual([{ kind: 'file', path: 'src/index.ts' }]);
    // The reference is carried structurally, so leaving it in the text would
    // present the model with the same file twice.
    expect(result.text).toBe('explain please');
    expect(result.unresolved).toEqual([]);
  });

  it('resolves a bare basename when it is unambiguous', async () => {
    const result = await h.index.resolve('look at @format.ts');
    expect(result.context).toEqual([{ kind: 'file', path: 'src/util/format.ts' }]);
  });

  it('keeps an unresolved mention in the prose rather than losing the word', async () => {
    const result = await h.index.resolve('check @nothing.ts for me');

    expect(result.context).toEqual([]);
    expect(result.unresolved).toEqual(['nothing.ts']);
    expect(result.text).toBe('check @nothing.ts for me');
  });

  it('strips only what resolved, in a prompt that mixes both', async () => {
    const result = await h.index.resolve('compare @src/index.ts with @ghost.ts');

    expect(result.context).toEqual([{ kind: 'file', path: 'src/index.ts' }]);
    expect(result.unresolved).toEqual(['ghost.ts']);
    expect(result.text).toBe('compare with @ghost.ts');
  });

  it('attaches the editor selection', async () => {
    h.workspace.activeSelection = {
      path: 'src/index.ts',
      startLine: 3,
      endLine: 9,
      text: 'body',
    };

    const result = await h.index.resolve('rewrite @selection');
    expect(result.context).toEqual([
      { kind: 'selection', path: 'src/index.ts', startLine: 3, endLine: 9 },
    ]);
  });

  it('reports a selection mention with nothing selected as unresolved', async () => {
    const result = await h.index.resolve('rewrite @selection');
    expect(result.unresolved).toEqual(['selection']);
  });

  it('attaches diagnostics', async () => {
    h.diagnostics.diagnostics = [
      { path: 'src/index.ts', line: 2, column: 1, severity: 'error', message: 'boom' },
    ];

    const result = await h.index.resolve('fix @problems');
    expect(result.context).toEqual([
      { kind: 'diagnostic', path: 'src/index.ts', line: 2, severity: 'error', message: 'boom' },
    ]);
  });

  it('resolves a file created since the walk', async () => {
    await h.index.start();
    h.watcher.emit(created('src/fresh.ts'));

    const result = await h.index.resolve('read @src/fresh.ts');
    expect(result.context).toEqual([{ kind: 'file', path: 'src/fresh.ts' }]);
  });

  it('builds the index on first use, so no caller has to remember to start it', async () => {
    const lazy = harness({ 'a.ts': 'x\n' });
    const result = await lazy.index.resolve('read @a.ts');

    expect(result.context).toEqual([{ kind: 'file', path: 'a.ts' }]);
    lazy.index.dispose();
  });
});

describe('WorkspaceIndex.search', () => {
  it('ranks an exact basename above a path substring', async () => {
    const ranked = harness({
      'index.ts': 'x\n',
      'src/index-helpers.ts': 'x\n',
      'vendor/lib/index/thing.ts': 'x\n',
    });

    const results = await ranked.index.search('index.ts');
    expect(results[0]?.path).toBe('index.ts');
    ranked.index.dispose();
  });

  it('honours the limit', async () => {
    const many = harness(
      Object.fromEntries(Array.from({ length: 40 }, (_, i) => [`file${String(i)}.ts`, 'x\n'])),
    );

    expect(await many.index.search('file', 5)).toHaveLength(5);
    many.index.dispose();
  });
});

describe('WorkspaceIndex git mentions', () => {
  it('attaches the working tree when there are changes', async () => {
    h.git.repos = [
      {
        rootPath: ROOT,
        currentBranch: 'main',
        changes: [
          { path: 'src/index.ts', status: 'modified' },
          { path: 'new.ts', status: 'untracked' },
        ],
      },
    ];

    const result = await h.index.resolve('review @diff');

    expect(result.context).toEqual([
      {
        kind: 'git',
        label: 'working tree (2 file(s) on main)',
        text: 'modified\tsrc/index.ts\nuntracked\tnew.ts',
      },
    ]);
    expect(result.text).toBe('review');
    expect(result.unresolved).toEqual([]);
  });

  it('attaches the branch', async () => {
    h.git.repos = [{ rootPath: ROOT, currentBranch: 'feature/x', changes: [] }];

    const result = await h.index.resolve('what is @branch');
    expect(result.context).toEqual([{ kind: 'git', label: 'branch', text: 'feature/x' }]);
  });

  it('reports a clean tree as unresolved rather than attaching nothing', async () => {
    h.git.repos = [{ rootPath: ROOT, currentBranch: 'main', changes: [] }];

    const result = await h.index.resolve('review @diff');

    // An empty attachment tells the model nothing and tells the user nothing;
    // an unresolved mention at least says why there is no diff.
    expect(result.context).toEqual([]);
    expect(result.unresolved).toEqual(['diff']);
    expect(result.text).toBe('review @diff');
  });

  it('reports a detached HEAD as unresolved for @branch', async () => {
    h.git.repos = [{ rootPath: ROOT, currentBranch: null, changes: [] }];
    expect((await h.index.resolve('@branch')).unresolved).toEqual(['branch']);
  });

  it('resolves nothing when there is no repository', async () => {
    expect((await h.index.resolve('@diff')).unresolved).toEqual(['diff']);
  });

  it('survives the git extension being absent or still activating', async () => {
    h.git.repositories = () => Promise.reject(new Error('git extension not activated'));

    // Not worth failing a turn over: the mention simply does not resolve.
    const result = await h.index.resolve('@diff');
    expect(result.unresolved).toEqual(['diff']);
  });

  it('does not let a git alias fall through to a file of the same name', async () => {
    const named = harness({ 'diff': 'x\n' });
    named.git.repos = [
      { rootPath: ROOT, currentBranch: 'main', changes: [{ path: 'a.ts', status: 'modified' }] },
    ];

    const result = await named.index.resolve('@diff');
    expect(result.context.map((item) => item.kind)).toEqual(['git']);
    named.index.dispose();
  });

  it('mixes git and file context in one prompt', async () => {
    h.git.repos = [
      { rootPath: ROOT, currentBranch: 'main', changes: [{ path: 'a.ts', status: 'modified' }] },
    ];

    const result = await h.index.resolve('compare @diff with @src/index.ts');

    expect(result.context.map((item) => item.kind)).toEqual(['git', 'file']);
    expect(result.text).toBe('compare with');
  });
});
