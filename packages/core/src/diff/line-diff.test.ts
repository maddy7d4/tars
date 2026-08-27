import { describe, expect, it } from 'vitest';
import {
  diffLines,
  diffStats,
  splitLines,
  toHunks,
  toUnifiedDiff,
  type DiffOp,
} from './line-diff.js';

/**
 * Tests for the line diff behind change sets (Docs/TARS_SPEC.md §6.1).
 *
 * The property that matters most is not any particular alignment — several are
 * defensible — but that the diff *reconstructs*: applying it to the before-text
 * must produce the after-text exactly. `roundTrips` asserts that directly, and
 * every scenario below runs through it, because an alignment bug that produces a
 * plausible-looking diff would otherwise corrupt files silently on apply.
 */

/** Rebuilds both sides from the ops, so an invalid alignment cannot pass. */
function roundTrips(before: readonly string[], after: readonly string[]): void {
  const ops = diffLines(before, after);
  const rebuiltBefore = ops.filter((op) => op.kind !== 'insert').map((op) => op.text);
  const rebuiltAfter = ops.filter((op) => op.kind !== 'delete').map((op) => op.text);

  expect(rebuiltBefore).toEqual(before);
  expect(rebuiltAfter).toEqual(after);
  expectMonotonicLines(ops);
}

/**
 * Line numbers must increase in step with the text they label. A diff that
 * reconstructs but mislabels lines still corrupts a hunk-level apply.
 */
function expectMonotonicLines(ops: readonly DiffOp[]): void {
  let before = -1;
  let after = -1;
  for (const op of ops) {
    if (op.kind !== 'insert') {
      expect(op.beforeLine).toBe(before + 1);
      before = op.beforeLine;
    } else {
      expect(op.beforeLine).toBe(-1);
    }
    if (op.kind !== 'delete') {
      expect(op.afterLine).toBe(after + 1);
      after = op.afterLine;
    } else {
      expect(op.afterLine).toBe(-1);
    }
  }
}

function kinds(ops: readonly DiffOp[]): string {
  return ops.map((op) => op.kind[0]).join('');
}

describe('splitLines', () => {
  it('treats a trailing newline as a terminator, not an extra line', () => {
    // Otherwise "added a trailing newline" and "added a blank line" are the
    // same diff, and one of them is wrong.
    expect(splitLines('a\nb\n')).toEqual(['a', 'b']);
    expect(splitLines('a\nb')).toEqual(['a', 'b']);
  });

  it('keeps interior blank lines', () => {
    expect(splitLines('a\n\nb\n')).toEqual(['a', '', 'b']);
  });

  it('preserves a deliberate blank final line', () => {
    expect(splitLines('a\n\n')).toEqual(['a', '']);
  });

  it('normalises CRLF, so a line-ending change is not every line changing', () => {
    expect(splitLines('a\r\nb\r\n')).toEqual(['a', 'b']);
    expect(diffLines(splitLines('a\r\nb\r\n'), splitLines('a\nb\n'))).toEqual(
      diffLines(['a', 'b'], ['a', 'b']),
    );
  });

  it('has no lines at all for empty content', () => {
    expect(splitLines('')).toEqual([]);
  });
});

describe('diffLines', () => {
  it('reports an unchanged file as all equal', () => {
    const lines = ['a', 'b', 'c'];
    expect(kinds(diffLines(lines, lines))).toBe('eee');
    roundTrips(lines, lines);
  });

  it('finds a single changed line without disturbing its neighbours', () => {
    const before = ['a', 'b', 'c'];
    const after = ['a', 'B', 'c'];
    const ops = diffLines(before, after);

    expect(diffStats(ops)).toEqual({ added: 1, removed: 1 });
    roundTrips(before, after);
  });

  it('handles insertion at the head, middle and tail', () => {
    roundTrips(['b', 'c'], ['a', 'b', 'c']);
    roundTrips(['a', 'c'], ['a', 'b', 'c']);
    roundTrips(['a', 'b'], ['a', 'b', 'c']);
  });

  it('handles deletion at the head, middle and tail', () => {
    roundTrips(['a', 'b', 'c'], ['b', 'c']);
    roundTrips(['a', 'b', 'c'], ['a', 'c']);
    roundTrips(['a', 'b', 'c'], ['a', 'b']);
  });

  it('treats file creation as pure insertion', () => {
    const ops = diffLines([], ['a', 'b']);
    expect(kinds(ops)).toBe('ii');
    expect(diffStats(ops)).toEqual({ added: 2, removed: 0 });
    roundTrips([], ['a', 'b']);
  });

  it('treats file deletion as pure removal', () => {
    const ops = diffLines(['a', 'b'], []);
    expect(kinds(ops)).toBe('dd');
    expect(diffStats(ops)).toEqual({ added: 0, removed: 2 });
    roundTrips(['a', 'b'], []);
  });

  it('produces nothing for two empty files', () => {
    expect(diffLines([], [])).toEqual([]);
  });

  it('aligns a moved block rather than rewriting everything around it', () => {
    const before = ['x', 'a', 'b', 'c', 'y'];
    const after = ['a', 'b', 'c', 'x', 'y'];
    const ops = diffLines(before, after);

    roundTrips(before, after);
    // The shared run a-b-c must survive as equal; a diff that rewrote it would
    // be correct on reconstruction but useless to review.
    const equalText = ops.filter((op) => op.kind === 'equal').map((op) => op.text);
    expect(equalText).toEqual(expect.arrayContaining(['a', 'b', 'c']));
  });

  it('finds the minimal edit for the classic Myers example', () => {
    const before = ['A', 'B', 'C', 'A', 'B', 'B', 'A'];
    const after = ['C', 'B', 'A', 'B', 'A', 'C'];
    const ops = diffLines(before, after);
    const stats = diffStats(ops);

    roundTrips(before, after);
    // The published shortest edit script for this pair is 5 operations.
    expect(stats.added + stats.removed).toBe(5);
  });

  it('reconstructs a large file with a change at each end', () => {
    const before = Array.from({ length: 500 }, (_, i) => `line ${String(i)}`);
    const after = ['header', ...before.slice(1, 499), 'footer'];
    roundTrips(before, after);
  });

  it('reconstructs when every line differs', () => {
    const before = Array.from({ length: 50 }, (_, i) => `a${String(i)}`);
    const after = Array.from({ length: 50 }, (_, i) => `b${String(i)}`);
    roundTrips(before, after);
  });

  it('reports a whole-file replacement rather than stalling past the size cap', () => {
    const before = Array.from({ length: 12 }, (_, i) => `a${String(i)}`);
    const after = Array.from({ length: 12 }, (_, i) => `b${String(i)}`);
    const ops = diffLines(before, after, { maxLines: 10 });

    // Honest, not wrong: the whole file is reported as replaced, and it still
    // reconstructs both sides.
    expect(kinds(ops)).toBe('dddddddddddd' + 'ii'.repeat(6));
    expect(ops.filter((op) => op.kind !== 'insert').map((op) => op.text)).toEqual(before);
    expect(ops.filter((op) => op.kind !== 'delete').map((op) => op.text)).toEqual(after);
  });

  it('diffs within the cap normally', () => {
    const before = ['a', 'b'];
    const after = ['a', 'c'];
    expect(kinds(diffLines(before, after, { maxLines: 10 }))).not.toBe('ddii');
  });
});

describe('toHunks', () => {
  it('produces no hunks for an unchanged file', () => {
    expect(toHunks(diffLines(['a'], ['a']))).toEqual([]);
  });

  it('surrounds a change with the requested context', () => {
    const before = ['1', '2', '3', '4', '5', '6', '7'];
    const after = ['1', '2', '3', 'X', '5', '6', '7'];
    const hunks = toHunks(diffLines(before, after), { context: 1 });

    expect(hunks).toHaveLength(1);
    const hunk = hunks[0];
    expect(hunk).toBeDefined();
    expect(kinds(hunk?.ops ?? [])).toBe('edie');
    expect(hunk?.beforeStart).toBe(2);
    expect(hunk?.afterStart).toBe(2);
  });

  it('clamps context at the start and end of the file', () => {
    const hunks = toHunks(diffLines(['a', 'b'], ['A', 'b']), { context: 5 });
    expect(hunks).toHaveLength(1);
    expect(hunks[0]?.beforeStart).toBe(0);
  });

  it('splits changes that are far apart into separate hunks', () => {
    const before = Array.from({ length: 30 }, (_, i) => String(i));
    const after = [...before];
    after[1] = 'X';
    after[25] = 'Y';

    expect(toHunks(diffLines(before, after), { context: 2 })).toHaveLength(2);
  });

  it('merges changes that are close enough for their context to touch', () => {
    const before = Array.from({ length: 10 }, (_, i) => String(i));
    const after = [...before];
    after[3] = 'X';
    after[5] = 'Y';

    // Two changes two lines apart with three lines of context would produce
    // overlapping regions; a user cannot accept overlapping hunks coherently.
    expect(toHunks(diffLines(before, after), { context: 3 })).toHaveLength(1);
  });

  it('counts each side independently, since a hunk need not be balanced', () => {
    const before = ['a', 'b', 'c'];
    const after = ['a', 'b', 'x', 'y', 'c'];
    const hunk = toHunks(diffLines(before, after), { context: 1 })[0];

    expect(hunk).toBeDefined();
    expect(hunk?.beforeCount).toBe(2);
    expect(hunk?.afterCount).toBe(4);
  });

  it('anchors a pure insertion at the line it follows', () => {
    const hunks = toHunks(diffLines([], ['a']), { context: 3 });
    expect(hunks).toHaveLength(1);
    expect(hunks[0]?.beforeStart).toBe(0);
    expect(hunks[0]?.beforeCount).toBe(0);
  });
});

describe('toUnifiedDiff', () => {
  it('renders nothing when nothing changed', () => {
    expect(toUnifiedDiff('a.ts', [])).toBe('');
  });

  it('renders 1-based headers and the conventional markers', () => {
    const before = ['a', 'b', 'c'];
    const after = ['a', 'B', 'c'];
    const text = toUnifiedDiff('src/a.ts', toHunks(diffLines(before, after), { context: 1 }));

    expect(text).toBe(
      ['--- a/src/a.ts', '+++ b/src/a.ts', '@@ -1,3 +1,3 @@', ' a', '-b', '+B', ' c', ''].join('\n'),
    );
  });
});
