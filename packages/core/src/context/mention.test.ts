import { describe, expect, it } from 'vitest';
import type { Diagnostic } from '../ports/diagnostics-port.js';
import type { EditorSelection, WorkspaceFolder } from '../ports/workspace-port.js';
import { BufferLogger, MemoryFileSystem } from '../testing/fakes.js';
import { FileIndex } from './file-index.js';
import { parseMentions, resolveMentions, stripMentions } from './mention.js';

/**
 * Mentions are how the user curates context (Docs/TARS_SPEC.md §7.1). The
 * load-bearing property is that an ambiguous mention resolves to nothing rather
 * than to a guess: attaching the wrong file is a silent correctness failure,
 * while an unresolved mention is visible and fixable.
 */

const FOLDER: WorkspaceFolder = { name: 'repo', path: '/repo' };

async function indexOf(paths: readonly string[]): Promise<FileIndex> {
  const fs = new MemoryFileSystem();
  for (const path of paths) {
    await fs.writeTextFile(`/repo/${path}`, '');
  }
  const index = new FileIndex({ fileSystem: fs, logger: new BufferLogger() });
  await index.build([FOLDER]);
  return index;
}

const NO_SELECTION: EditorSelection | null = null;
const NO_DIAGNOSTICS: readonly Diagnostic[] = [];

describe('parseMentions', () => {
  it('finds a mention at the start of the text', () => {
    expect(parseMentions('@src/a.ts explain this').map((m) => m.query)).toEqual(['src/a.ts']);
  });

  it('finds several mentions', () => {
    expect(parseMentions('compare @a.ts and @b.ts').map((m) => m.query)).toEqual(['a.ts', 'b.ts']);
  });

  it('ignores an @ that does not follow whitespace', () => {
    // An email address or a decorator in pasted code must not become a mention.
    expect(parseMentions('mail me at me@example.com')).toEqual([]);
  });

  it('keeps a dot inside a filename but drops trailing punctuation', () => {
    expect(parseMentions('open @src/index.ts, then stop').map((m) => m.query)).toEqual([
      'src/index.ts',
    ]);
  });

  it('drops a trailing closing bracket', () => {
    expect(parseMentions('see (@a.ts)').map((m) => m.query)).toEqual(['a.ts']);
  });

  it('reports offsets that span the mention including the @', () => {
    const [mention] = parseMentions('go @a.ts now');
    expect(mention).toBeDefined();
    expect(mention?.start).toBe(3);
    expect(mention?.end).toBe(8);
  });

  it('returns nothing for text without mentions', () => {
    expect(parseMentions('no mentions here')).toEqual([]);
  });

  it('ignores a bare @', () => {
    expect(parseMentions('what about @ this')).toEqual([]);
  });
});

describe('resolveMentions', () => {
  it('resolves an exact workspace-relative path', async () => {
    const index = await indexOf(['src/app.ts']);
    const result = resolveMentions(parseMentions('@src/app.ts'), {
      index,
      selection: NO_SELECTION,
      diagnostics: NO_DIAGNOSTICS,
    });

    expect(result.items).toEqual([{ kind: 'file', path: 'src/app.ts' }]);
    expect(result.unresolved).toEqual([]);
  });

  it('resolves a unique basename', async () => {
    const index = await indexOf(['src/deeply/nested/unique.ts']);
    const result = resolveMentions(parseMentions('@unique.ts'), {
      index,
      selection: NO_SELECTION,
      diagnostics: NO_DIAGNOSTICS,
    });

    expect(result.items).toEqual([{ kind: 'file', path: 'src/deeply/nested/unique.ts' }]);
  });

  it('refuses to guess between two equally plausible matches', async () => {
    const index = await indexOf(['a/config.ts', 'b/config.ts']);
    const result = resolveMentions(parseMentions('@config.ts'), {
      index,
      selection: NO_SELECTION,
      diagnostics: NO_DIAGNOSTICS,
    });

    expect(result.items).toEqual([]);
    expect(result.unresolved).toEqual(['config.ts']);
  });

  it('reports an unknown path as unresolved rather than dropping it', async () => {
    const index = await indexOf(['src/a.ts']);
    const result = resolveMentions(parseMentions('@nope.ts'), {
      index,
      selection: NO_SELECTION,
      diagnostics: NO_DIAGNOSTICS,
    });

    expect(result.items).toEqual([]);
    expect(result.unresolved).toEqual(['nope.ts']);
  });

  it('de-duplicates a file mentioned twice', async () => {
    const index = await indexOf(['src/a.ts']);
    const result = resolveMentions(parseMentions('@src/a.ts and again @src/a.ts'), {
      index,
      selection: NO_SELECTION,
      diagnostics: NO_DIAGNOSTICS,
    });

    expect(result.items).toHaveLength(1);
  });

  it('resolves @selection from editor state', async () => {
    const index = await indexOf(['src/a.ts']);
    const selection: EditorSelection = {
      path: '/repo/src/a.ts',
      startLine: 10,
      endLine: 20,
      text: 'code',
    };
    const result = resolveMentions(parseMentions('explain @selection'), {
      index,
      selection,
      diagnostics: NO_DIAGNOSTICS,
    });

    expect(result.items).toEqual([
      { kind: 'selection', path: '/repo/src/a.ts', startLine: 10, endLine: 20 },
    ]);
  });

  it('reports @selection as unresolved when nothing is selected', async () => {
    const index = await indexOf(['src/a.ts']);
    const result = resolveMentions(parseMentions('@selection'), {
      index,
      selection: NO_SELECTION,
      diagnostics: NO_DIAGNOSTICS,
    });

    expect(result.unresolved).toEqual(['selection']);
  });

  it('expands @problems into one item per diagnostic', async () => {
    const index = await indexOf(['src/a.ts']);
    const diagnostics: readonly Diagnostic[] = [
      { path: '/repo/src/a.ts', line: 3, column: 1, severity: 'error', message: 'boom' },
      { path: '/repo/src/a.ts', line: 9, column: 2, severity: 'warning', message: 'meh' },
    ];
    const result = resolveMentions(parseMentions('fix @problems'), {
      index,
      selection: NO_SELECTION,
      diagnostics,
    });

    expect(result.items).toHaveLength(2);
    expect(result.items[0]).toEqual({
      kind: 'diagnostic',
      path: '/repo/src/a.ts',
      line: 3,
      severity: 'error',
      message: 'boom',
    });
  });

  it('accepts documented aliases for editor state', async () => {
    const index = await indexOf(['src/a.ts']);
    const selection: EditorSelection = {
      path: '/repo/src/a.ts',
      startLine: 1,
      endLine: 2,
      text: '',
    };
    const result = resolveMentions(parseMentions('@sel and @errors'), {
      index,
      selection,
      diagnostics: [
        { path: '/repo/src/a.ts', line: 1, column: 1, severity: 'error', message: 'x' },
      ],
    });

    expect(result.items.map((i) => i.kind)).toEqual(['selection', 'diagnostic']);
  });
});

describe('stripMentions', () => {
  it('removes a mention span from the prose', () => {
    const text = 'explain @src/a.ts please';
    expect(stripMentions(text, parseMentions(text))).toBe('explain please');
  });

  it('removes several mentions without corrupting offsets', () => {
    const text = 'compare @a.ts with @b.ts now';
    expect(stripMentions(text, parseMentions(text))).toBe('compare with now');
  });

  it('returns the text unchanged when there are no mentions', () => {
    expect(stripMentions('nothing here', [])).toBe('nothing here');
  });

  it('leaves trailing punctuation that was not part of the mention', () => {
    const text = 'open @a.ts, then stop';
    expect(stripMentions(text, parseMentions(text))).toBe('open , then stop');
  });
});
