import { describe, expect, it } from 'vitest';
import { toSessionId, toTurnId } from '@tars/shared';
import { hashContent } from './content-hash.js';
import {
  buildChangeSet,
  ChangeSetBuilder,
  proposalFromEvent,
  type Baseline,
  type FileEditProposal,
} from './change-set.js';

/**
 * Tests for change sets (Docs/TARS_SPEC.md §6.1).
 *
 * The behaviour worth guarding is not the diff — that is tested next door — but
 * the bookkeeping around it: folding repeated proposals for one file, refusing
 * to report a no-op as work, and above all detecting when an edit was computed
 * against content that has since moved. That last one is the case where being
 * wrong means silently overwriting something the user changed by hand.
 */

const exists = (content: string): Baseline => ({ content });
const missing: Baseline = { content: null };

function proposal(
  path: string,
  afterContent: string | null,
  beforeContent?: string,
): FileEditProposal {
  return beforeContent === undefined
    ? { path, afterContent }
    : { path, beforeHash: hashContent(beforeContent), afterContent };
}

describe('proposalFromEvent', () => {
  const base = {
    sessionId: toSessionId('s1'),
    turnId: toTurnId('t1'),
    at: 1,
    type: 'file_edit_proposed',
  } as const;

  it('carries a beforeHash through when the event has one', () => {
    expect(
      proposalFromEvent({ ...base, path: 'a.ts', beforeHash: 'abc', afterContent: 'x' }),
    ).toEqual({ path: 'a.ts', beforeHash: 'abc', afterContent: 'x' });
  });

  it('omits the key entirely for a new file, rather than sending undefined', () => {
    const result = proposalFromEvent({ ...base, path: 'a.ts', afterContent: 'x' });
    expect('beforeHash' in result).toBe(false);
  });
});

describe('ChangeSetBuilder', () => {
  it('starts empty', () => {
    const builder = new ChangeSetBuilder();
    expect(builder.isEmpty).toBe(true);
    expect(builder.build()).toEqual({
      changes: [],
      stats: { added: 0, removed: 0 },
      paths: [],
      hasStaleChanges: false,
    });
  });

  it('classifies a modification and counts both sides', () => {
    const set = buildChangeSet([
      { proposal: proposal('a.ts', 'one\ntwo\n', 'one\n'), baseline: exists('one\n') },
    ]);

    expect(set.changes).toHaveLength(1);
    const change = set.changes[0];
    expect(change?.kind).toBe('modify');
    expect(change?.stats).toEqual({ added: 1, removed: 0 });
    expect(change?.stale).toBe(false);
    expect(set.stats).toEqual({ added: 1, removed: 0 });
  });

  it('classifies a creation, with no before content or hash', () => {
    const set = buildChangeSet([
      { proposal: proposal('new.ts', 'hello\n'), baseline: missing },
    ]);

    const change = set.changes[0];
    expect(change?.kind).toBe('create');
    expect(change?.beforeContent).toBeNull();
    expect(change?.beforeHash).toBeNull();
    expect(change?.afterHash).toBe(hashContent('hello\n'));
  });

  it('classifies a deletion, with no after content or hash', () => {
    const set = buildChangeSet([
      { proposal: proposal('old.ts', null, 'bye\n'), baseline: exists('bye\n') },
    ]);

    const change = set.changes[0];
    expect(change?.kind).toBe('delete');
    expect(change?.afterContent).toBeNull();
    expect(change?.afterHash).toBeNull();
    expect(change?.stats).toEqual({ added: 0, removed: 1 });
  });

  it('drops a proposal that changes nothing', () => {
    // The agent rewriting a file to its current contents is not work to review.
    const set = buildChangeSet([
      { proposal: proposal('a.ts', 'same\n', 'same\n'), baseline: exists('same\n') },
    ]);

    expect(set.changes).toEqual([]);
    expect(set.paths).toEqual([]);
  });

  it('keeps one entry per file when a file is edited twice in a turn', () => {
    const builder = new ChangeSetBuilder();
    builder.add(proposal('a.ts', 'v2\n', 'v1\n'), exists('v1\n'));
    builder.add(proposal('a.ts', 'v3\n', 'v2\n'), exists('v1\n'));
    const set = builder.build();

    expect(set.changes).toHaveLength(1);
    // Measured against the original baseline, not the intermediate state: what
    // lands on disk is v1 -> v3, and that is what the user is approving.
    expect(set.changes[0]?.beforeContent).toBe('v1\n');
    expect(set.changes[0]?.afterContent).toBe('v3\n');
  });

  it('reports files in the order first proposed', () => {
    const builder = new ChangeSetBuilder();
    builder.add(proposal('b.ts', 'b\n'), missing);
    builder.add(proposal('a.ts', 'a\n'), missing);
    builder.add(proposal('b.ts', 'bb\n', 'b\n'), missing);

    expect(builder.build().paths).toEqual(['b.ts', 'a.ts']);
  });

  it('folds a create-then-edit chain into a single creation', () => {
    const builder = new ChangeSetBuilder();
    builder.add(proposal('a.ts', 'first\n'), missing);
    builder.add(proposal('a.ts', 'second\n', 'first\n'), missing);
    const change = builder.build().changes[0];

    expect(change?.kind).toBe('create');
    expect(change?.afterContent).toBe('second\n');
    expect(change?.stale).toBe(false);
  });

  it('collapses an edit the agent then reverts', () => {
    const builder = new ChangeSetBuilder();
    builder.add(proposal('a.ts', 'changed\n', 'original\n'), exists('original\n'));
    builder.add(proposal('a.ts', 'original\n', 'changed\n'), exists('original\n'));

    expect(builder.build().changes).toEqual([]);
  });
});

describe('ChangeSetBuilder staleness', () => {
  it('flags an edit computed against content that has since changed', () => {
    // The agent read 'v1' and edited it; the file on disk now says 'edited by hand'.
    const set = buildChangeSet([
      { proposal: proposal('a.ts', 'v2\n', 'v1\n'), baseline: exists('edited by hand\n') },
    ]);

    expect(set.changes[0]?.stale).toBe(true);
    expect(set.hasStaleChanges).toBe(true);
  });

  it('flags an edit whose baseline file has been deleted', () => {
    const set = buildChangeSet([
      { proposal: proposal('a.ts', 'v2\n', 'v1\n'), baseline: missing },
    ]);

    expect(set.changes[0]?.stale).toBe(true);
  });

  it('flags a create that would clobber a file that already exists', () => {
    // No beforeHash claims the file is new. It is not, so the agent is about to
    // overwrite content it never read — precisely what review exists to catch.
    const set = buildChangeSet([
      { proposal: proposal('a.ts', 'brand new\n'), baseline: exists('someone else wrote this\n') },
    ]);

    expect(set.changes[0]?.stale).toBe(true);
    expect(set.changes[0]?.kind).toBe('modify');
  });

  it('does not flag a chained edit that builds on the previous proposal', () => {
    const builder = new ChangeSetBuilder();
    builder.add(proposal('a.ts', 'v2\n', 'v1\n'), exists('v1\n'));
    // Computed against v2, which is not on disk — but is what the agent just proposed.
    builder.add(proposal('a.ts', 'v3\n', 'v2\n'), exists('v1\n'));

    expect(builder.build().changes[0]?.stale).toBe(false);
  });

  it('flags a chained edit that skipped the previous proposal', () => {
    const builder = new ChangeSetBuilder();
    builder.add(proposal('a.ts', 'v2\n', 'v1\n'), exists('v1\n'));
    // Still computed against v1, so it would undo the pending edit without saying so.
    builder.add(proposal('a.ts', 'other\n', 'v1\n'), exists('v1\n'));

    expect(builder.build().changes[0]?.stale).toBe(true);
  });

  it('keeps staleness sticky once any link in the chain was stale', () => {
    const builder = new ChangeSetBuilder();
    builder.add(proposal('a.ts', 'v2\n', 'v1\n'), exists('moved\n'));
    // This link is internally consistent, but the edit it builds on was not.
    builder.add(proposal('a.ts', 'v3\n', 'v2\n'), exists('moved\n'));

    expect(builder.build().changes[0]?.stale).toBe(true);
  });

  it('reports a clean set as having no stale changes', () => {
    const set = buildChangeSet([
      { proposal: proposal('a.ts', 'x\n', 'a\n'), baseline: exists('a\n') },
      { proposal: proposal('b.ts', 'y\n'), baseline: missing },
    ]);

    expect(set.hasStaleChanges).toBe(false);
  });

  it('flags the whole set when any one file is stale', () => {
    const set = buildChangeSet([
      { proposal: proposal('a.ts', 'x\n', 'a\n'), baseline: exists('a\n') },
      { proposal: proposal('b.ts', 'y\n', 'b\n'), baseline: exists('moved\n') },
    ]);

    expect(set.hasStaleChanges).toBe(true);
    expect(set.changes.filter((change) => change.stale).map((change) => change.path)).toEqual([
      'b.ts',
    ]);
  });
});

describe('ChangeSet hunks', () => {
  it('carries reviewable hunks for a modification', () => {
    const before = Array.from({ length: 20 }, (_, i) => `line ${String(i)}`).join('\n');
    const after = before.replace('line 5', 'line five').replace('line 15', 'line fifteen');
    const change = buildChangeSet([
      { proposal: proposal('a.ts', after, before), baseline: exists(before) },
    ]).changes[0];

    // Two changes fifteen lines apart do not belong in one region.
    expect(change?.hunks).toHaveLength(2);
    expect(change?.stats).toEqual({ added: 2, removed: 2 });
  });

  it('gives a creation one hunk covering the whole file', () => {
    const change = buildChangeSet([
      { proposal: proposal('a.ts', 'a\nb\nc\n'), baseline: missing },
    ]).changes[0];

    expect(change?.hunks).toHaveLength(1);
    expect(change?.hunks[0]?.beforeCount).toBe(0);
    expect(change?.hunks[0]?.afterCount).toBe(3);
  });
});
