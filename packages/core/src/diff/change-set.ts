import type { FileEditProposedEvent } from '@tars/shared';
import { hashContent } from './content-hash.js';
import { diffLines, diffStats, splitLines, toHunks, type DiffHunk, type DiffStats } from './line-diff.js';

/**
 * Change sets: the reviewable unit of work (Docs/TARS_SPEC.md §6.1).
 *
 * `file_edit_proposed` events arrive one at a time and may touch the same file
 * more than once in a turn. A change set folds them into one entry per file,
 * because what the user reviews and applies is the *net* effect on the working
 * tree — showing three successive rewrites of one file as three proposals asks
 * them to mentally compose edits the editor is about to compose for them.
 *
 * Nothing here touches the filesystem. The baseline content is supplied by the
 * caller, so a change set is a pure value that can be built, compared and
 * serialised without a workspace — which is also what makes it testable.
 */

export type FileChangeKind = 'create' | 'modify' | 'delete';

export interface FileChange {
  /** Workspace-relative, as it arrived on the event. */
  readonly path: string;
  readonly kind: FileChangeKind;
  /** Baseline content, or `null` when the file is being created. */
  readonly beforeContent: string | null;
  /** Proposed content, or `null` when the file is being deleted. */
  readonly afterContent: string | null;
  readonly beforeHash: string | null;
  readonly afterHash: string | null;
  readonly hunks: readonly DiffHunk[];
  readonly stats: DiffStats;
  /**
   * True when the baseline the edit was computed against is not the baseline the
   * change set was built with — the file moved under the agent.
   *
   * Surfaced rather than resolved: silently rebasing onto the new content would
   * apply an edit the model never saw the context for, and silently dropping it
   * would lose work. The user decides, so the flag has to survive to the UI.
   */
  readonly stale: boolean;
}

export interface ChangeSet {
  readonly changes: readonly FileChange[];
  readonly stats: DiffStats;
  /** Every path in the set, in the order first proposed. Convenience for the host. */
  readonly paths: readonly string[];
  readonly hasStaleChanges: boolean;
}

/** What the caller knows about a file before the edit lands. */
export interface Baseline {
  /** On-disk content, or `null` if the file does not exist. */
  readonly content: string | null;
}

/** A proposal, decoupled from the event so a change set can be built from any source. */
export interface FileEditProposal {
  readonly path: string;
  /** SHA-256 of the content the edit was computed against; absent for a new file. */
  readonly beforeHash?: string;
  /** `null` proposes deletion. */
  readonly afterContent: string | null;
}

export function proposalFromEvent(event: FileEditProposedEvent): FileEditProposal {
  return event.beforeHash === undefined
    ? { path: event.path, afterContent: event.afterContent }
    : { path: event.path, beforeHash: event.beforeHash, afterContent: event.afterContent };
}

const EMPTY_STATS: DiffStats = { added: 0, removed: 0 };

/**
 * Accumulates proposals into a change set.
 *
 * Kept as a builder rather than a pure fold because proposals arrive
 * interleaved with the rest of the event stream, and the baseline for a file is
 * read once — the first time that file is proposed. Re-reading it per proposal
 * would let a later edit be diffed against content an earlier one already
 * changed, which reports the same work twice.
 */
export class ChangeSetBuilder {
  private readonly order: string[] = [];
  private readonly baselines = new Map<string, Baseline>();
  private readonly proposals = new Map<string, FileEditProposal>();
  private readonly staleness = new Map<string, boolean>();

  /**
   * Records one proposal.
   *
   * `baseline` is consulted only the first time a path appears. A second
   * proposal for the same file supersedes the first — the model rewrote its own
   * output — and the original baseline is what both must be measured against.
   */
  add(proposal: FileEditProposal, baseline: Baseline): void {
    const previous = this.proposals.get(proposal.path);
    if (previous === undefined) {
      this.order.push(proposal.path);
      this.baselines.set(proposal.path, baseline);
      this.staleness.set(proposal.path, isStale(proposal, baseline));
    } else {
      // Staleness is sticky: once an edit in the chain was computed against
      // content that had already moved, everything built on top of it inherits
      // that doubt, and clearing the flag on a later proposal would hide it.
      const wasStale = this.staleness.get(proposal.path) ?? false;
      this.staleness.set(proposal.path, wasStale || !continuesFrom(proposal, previous));
    }
    this.proposals.set(proposal.path, proposal);
  }

  /** True once any proposal has been recorded. */
  get isEmpty(): boolean {
    return this.order.length === 0;
  }

  build(): ChangeSet {
    const changes: FileChange[] = [];
    let added = 0;
    let removed = 0;

    for (const path of this.order) {
      const proposal = this.proposals.get(path);
      const baseline = this.baselines.get(path);
      if (proposal === undefined || baseline === undefined) {
        continue;
      }
      const change = buildChange(proposal, baseline, this.staleness.get(path) ?? false);
      // A proposal whose content equals the baseline is a no-op the agent
      // produced anyway; carrying it into review would ask the user to approve
      // nothing, and into apply would touch a file's mtime for no reason.
      if (change === null) {
        continue;
      }
      changes.push(change);
      added += change.stats.added;
      removed += change.stats.removed;
    }

    return {
      changes,
      stats: { added, removed },
      paths: changes.map((change) => change.path),
      hasStaleChanges: changes.some((change) => change.stale),
    };
  }
}

/** Builds a change set in one call, for callers that already have every proposal. */
export function buildChangeSet(
  entries: readonly { readonly proposal: FileEditProposal; readonly baseline: Baseline }[],
): ChangeSet {
  const builder = new ChangeSetBuilder();
  for (const entry of entries) {
    builder.add(entry.proposal, entry.baseline);
  }
  return builder.build();
}

/**
 * Whether the first proposal for a path was computed against different content
 * than the baseline shows.
 *
 * A missing `beforeHash` claims the file is new. That claim is checked too: if
 * the file exists, the agent is about to overwrite content it never read, which
 * is exactly the case a review step exists to catch.
 */
function isStale(proposal: FileEditProposal, baseline: Baseline): boolean {
  if (proposal.beforeHash === undefined) {
    return baseline.content !== null;
  }
  if (baseline.content === null) {
    // The edit was computed against a file that is no longer there.
    return true;
  }
  return hashContent(baseline.content) !== proposal.beforeHash;
}

/**
 * Whether a follow-up proposal builds on the previous one's output.
 *
 * A second edit to the same file within a turn is measured against what the
 * first one produced, not against the file on disk — the agent is editing its
 * own pending work, and comparing to disk would flag every chained edit stale.
 */
function continuesFrom(proposal: FileEditProposal, previous: FileEditProposal): boolean {
  if (proposal.beforeHash === undefined) {
    // Claims the file is new, but a pending proposal already gave it content.
    return previous.afterContent === null;
  }
  return previous.afterContent !== null && hashContent(previous.afterContent) === proposal.beforeHash;
}

/** Returns `null` when the proposal would not change the file. */
function buildChange(
  proposal: FileEditProposal,
  baseline: Baseline,
  stale: boolean,
): FileChange | null {
  const before = baseline.content;
  const after = proposal.afterContent;

  if (before === after) {
    return null;
  }
  if (before === null && after === null) {
    return null;
  }

  const kind: FileChangeKind = after === null ? 'delete' : before === null ? 'create' : 'modify';
  const ops = diffLines(splitLines(before ?? ''), splitLines(after ?? ''));

  return {
    path: proposal.path,
    kind,
    beforeContent: before,
    afterContent: after,
    beforeHash: before === null ? null : hashContent(before),
    afterHash: after === null ? null : hashContent(after),
    hunks: toHunks(ops),
    stats: ops.length === 0 ? EMPTY_STATS : diffStats(ops),
    stale,
  };
}
