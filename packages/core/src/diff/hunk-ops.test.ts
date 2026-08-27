import { describe, expect, it } from 'vitest';
import { acceptAll, acceptHunk, rejectAll, rejectHunk, viewHunks } from './hunk-ops.js';

/**
 * Tests for per-hunk review (Docs/TARS_SPEC.md §6.5).
 *
 * The property under test throughout is *convergence*: whatever order the user
 * accepts and rejects in, the file ends up holding exactly the regions they kept
 * and none of the ones they rejected, and the review then reports itself
 * settled. Order-independence is the part worth asserting directly — the bug
 * this design exists to prevent is a stale line range, and a stale range only
 * misbehaves once a *previous* decision has shifted the lines under it.
 */

const BASELINE = ['one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine'].join(
  '\n',
);

/** Two edits far enough apart to be separate hunks. */
const EDITED = ['ONE', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'NINE'].join('\n');

function context(baseline: string, current: string): { baseline: string; current: string } {
  return { baseline, current };
}

describe('viewHunks', () => {
  it('reports nothing to review when the texts agree', () => {
    expect(viewHunks(context(BASELINE, BASELINE))).toEqual({ hunks: [], settled: true });
  });

  it('finds one hunk per separated change', () => {
    expect(viewHunks(context(BASELINE, EDITED)).hunks).toHaveLength(2);
  });

  it('treats a whole-file rewrite as a single region', () => {
    const rewritten = 'totally\ndifferent\n';
    expect(viewHunks(context(BASELINE, rewritten)).hunks).toHaveLength(1);
  });

  it('reports a created file as one hunk', () => {
    expect(viewHunks(context('', 'new\ncontent\n')).hunks).toHaveLength(1);
  });
});

describe('acceptHunk', () => {
  it('moves the baseline forward without touching the file', () => {
    const next = acceptHunk(context(BASELINE, EDITED), 0);

    // The first change is absorbed; the second is still outstanding.
    expect(next).toContain('ONE');
    expect(next).toContain('nine');
    expect(viewHunks(context(next, EDITED)).hunks).toHaveLength(1);
  });

  it('settles the review once every hunk is accepted', () => {
    let baseline = BASELINE;
    baseline = acceptHunk(context(baseline, EDITED), 0);
    baseline = acceptHunk(context(baseline, EDITED), 0);

    expect(baseline).toBe(EDITED);
    expect(viewHunks(context(baseline, EDITED)).settled).toBe(true);
  });

  it('accepts the last hunk first without disturbing the first', () => {
    // The case a cached line range gets wrong: deciding out of order.
    const baseline = acceptHunk(context(BASELINE, EDITED), 1);

    expect(baseline).toContain('NINE');
    expect(baseline).toContain('one');
    expect(viewHunks(context(baseline, EDITED)).hunks).toHaveLength(1);
  });

  it('is a no-op for an index that does not exist', () => {
    expect(acceptHunk(context(BASELINE, EDITED), 9)).toBe(BASELINE);
  });
});

describe('rejectHunk', () => {
  it('puts back the original content for that region only', () => {
    const next = rejectHunk(context(BASELINE, EDITED), 0);

    expect(next).toContain('one');
    // The other edit survives: rejecting part of a change is the whole point.
    expect(next).toContain('NINE');
  });

  it('settles the review once every hunk is rejected', () => {
    let current = EDITED;
    current = rejectHunk(context(BASELINE, current), 0);
    current = rejectHunk(context(BASELINE, current), 0);

    expect(current).toBe(BASELINE);
    expect(viewHunks(context(BASELINE, current)).settled).toBe(true);
  });

  it('rejects the last hunk first without disturbing the first', () => {
    const next = rejectHunk(context(BASELINE, EDITED), 1);

    expect(next).toContain('nine');
    expect(next).toContain('ONE');
  });

  it('is a no-op for an index that does not exist', () => {
    expect(rejectHunk(context(BASELINE, EDITED), 9)).toBe(EDITED);
  });
});

describe('mixed decisions', () => {
  it('keeps what was accepted and restores what was rejected', () => {
    let baseline = BASELINE;
    let current = EDITED;

    baseline = acceptHunk(context(baseline, current), 0);
    current = rejectHunk(context(baseline, current), 0);

    expect(current).toBe(['ONE', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine'].join('\n'));
    expect(viewHunks(context(baseline, current)).settled).toBe(true);
  });

  it('reaches the same result whichever hunk is decided first', () => {
    const forward = (): string => {
      let baseline = BASELINE;
      let current = EDITED;
      baseline = acceptHunk(context(baseline, current), 0);
      current = rejectHunk(context(baseline, current), 0);
      return current;
    };
    const backward = (): string => {
      let baseline = BASELINE;
      let current = EDITED;
      current = rejectHunk(context(baseline, current), 1);
      baseline = acceptHunk(context(baseline, current), 0);
      return current;
    };

    expect(forward()).toBe(backward());
  });

  it('survives the user editing the file mid-review', () => {
    // Hunks are recomputed from the two texts, so an unrelated edit does not
    // invalidate a pending decision — it just becomes part of what is compared.
    // The file has to be long enough for the hand edit to stay its own region.
    const lines = Array.from({ length: 30 }, (_, i) => `line ${String(i)}`);
    const baseline = lines.join('\n');
    const agentEdited = [...lines];
    agentEdited[0] = 'AGENT FIRST';
    agentEdited[29] = 'AGENT LAST';
    const handEdited = [...agentEdited];
    handEdited[15] = 'USER TYPED THIS';

    const next = rejectHunk(context(baseline, handEdited.join('\n')), 0);

    expect(next).toContain('line 0');
    expect(next).toContain('USER TYPED THIS');
    expect(next).toContain('AGENT LAST');
  });

  it('reverts an adjacent hand edit along with the hunk it merged into', () => {
    // Inherent to hunk granularity rather than a flaw: two changes close enough
    // for their context to overlap are one region, and every diff tool treats
    // them that way. Asserted so the behaviour is a decision, not a surprise.
    const handEdited = EDITED.replace('four', 'FOUR');
    // The hand edit sits between the agent's two, close enough that all three
    // contexts overlap, so the file now reviews as one region rather than two.
    expect(viewHunks(context(BASELINE, handEdited)).hunks).toHaveLength(1);

    const next = rejectHunk(context(BASELINE, handEdited), 0);
    expect(next).toBe(BASELINE);
  });
});

describe('whole-file decisions', () => {
  it('accepting everything settles immediately', () => {
    const baseline = acceptAll(context(BASELINE, EDITED));
    expect(viewHunks(context(baseline, EDITED)).settled).toBe(true);
  });

  it('rejecting everything restores the file', () => {
    expect(rejectAll(context(BASELINE, EDITED))).toBe(BASELINE);
  });
});

describe('newline handling', () => {
  it('preserves a trailing newline through a reject', () => {
    const baseline = 'a\nb\n';
    const current = 'a\nB\n';
    // `splitLines` drops the terminator, so a naive rejoin silently strips the
    // final newline off every file it touches.
    expect(rejectHunk(context(baseline, current), 0)).toBe('a\nb\n');
  });

  it('preserves the absence of a trailing newline through a reject', () => {
    expect(rejectHunk(context('a\nb', 'a\nB'), 0)).toBe('a\nb');
  });

  it('preserves a trailing newline through an accept', () => {
    expect(acceptHunk(context('a\nb\n', 'a\nB\n'), 0)).toBe('a\nB\n');
  });

  it('restores an emptied file', () => {
    expect(rejectHunk(context('a\nb\n', ''), 0)).toBe('a\nb\n');
  });

  it('rejects a file the agent created back to nothing', () => {
    expect(rejectHunk(context('', 'new\n'), 0)).toBe('');
  });
});
