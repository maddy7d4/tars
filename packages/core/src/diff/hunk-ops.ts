import { diffLines, splitLines, toHunks, type DiffHunk, type DiffOptions } from './line-diff.js';

/**
 * Per-hunk accept and reject (Docs/TARS_SPEC.md §6.5).
 *
 * The agent's edit is already in the file. Reviewing it means deciding, region
 * by region, whether to keep what is there or put back what was there before —
 * so both operations are expressed as *content transforms* between two strings,
 * with no editor, no offsets held across time, and no mutable hunk state.
 *
 * That statelessness is the design. The obvious implementation caches hunks with
 * their line ranges and patches them in place, which breaks the moment anything
 * else edits the file — the user typing while they review, a formatter on save,
 * a second agent turn. Here the hunks are recomputed from (baseline, current)
 * every time, so a stale range cannot exist: if the file moved, the next
 * computation simply sees different hunks.
 */

/** The two texts a review compares: what the file was, and what it is now. */
export interface HunkContext {
  /** Content before the agent touched the file. */
  readonly baseline: string;
  /** Content as it stands in the editor right now. */
  readonly current: string;
}

export interface HunkView {
  readonly hunks: readonly DiffHunk[];
  /** True when the two texts agree, i.e. there is nothing left to review. */
  readonly settled: boolean;
}

/** Recomputes the reviewable hunks. Cheap enough to call on every document change. */
export function viewHunks(context: HunkContext, options: DiffOptions = {}): HunkView {
  if (context.baseline === context.current) {
    return { hunks: [], settled: true };
  }
  const ops = diffLines(splitLines(context.baseline), splitLines(context.current), options);
  const hunks = toHunks(ops, options);
  return { hunks, settled: hunks.length === 0 };
}

/**
 * Accepting a hunk: the file keeps what the agent wrote, and the *baseline*
 * moves forward to absorb it.
 *
 * Returns the new baseline, not new file content — accepting changes nothing on
 * disk. Moving the baseline is what makes the hunk stop being a hunk, which is
 * both the correct model and the reason no separate "accepted" bookkeeping is
 * needed: the next `viewHunks` simply does not produce it.
 */
export function acceptHunk(context: HunkContext, index: number): string {
  const hunk = hunkAt(context, index);
  if (hunk === null) {
    return context.baseline;
  }
  const baselineLines = splitLines(context.baseline);
  const replacement = hunk.ops.filter((op) => op.kind !== 'delete').map((op) => op.text);
  const coversTail = hunk.beforeStart + hunk.beforeCount >= baselineLines.length;

  return join(
    splice(baselineLines, hunk.beforeStart, hunk.beforeCount, replacement),
    // The trailing newline belongs to the last line, so it comes from whichever
    // text supplies it. Only when the hunk reaches the end of the file does that
    // change hands.
    coversTail ? context.current : context.baseline,
  );
}

/**
 * Rejecting a hunk: the file goes back to what it held before, for that region
 * only.
 *
 * Returns the new file content. Every other hunk is left exactly as it is, which
 * is what makes rejecting one part of an edit while keeping the rest possible at
 * all.
 */
export function rejectHunk(context: HunkContext, index: number): string {
  const hunk = hunkAt(context, index);
  if (hunk === null) {
    return context.current;
  }
  const currentLines = splitLines(context.current);
  const replacement = hunk.ops.filter((op) => op.kind !== 'insert').map((op) => op.text);
  const coversTail = hunk.afterStart + hunk.afterCount >= currentLines.length;

  return join(
    splice(currentLines, hunk.afterStart, hunk.afterCount, replacement),
    coversTail ? context.baseline : context.current,
  );
}

/** Accepting everything: the baseline becomes the current content. */
export function acceptAll(context: HunkContext): string {
  return context.current;
}

/** Rejecting everything: the file goes back to the baseline. */
export function rejectAll(context: HunkContext): string {
  return context.baseline;
}

function hunkAt(context: HunkContext, index: number): DiffHunk | null {
  const { hunks } = viewHunks(context);
  return hunks[index] ?? null;
}

function splice(
  lines: readonly string[],
  start: number,
  count: number,
  replacement: readonly string[],
): readonly string[] {
  return [...lines.slice(0, start), ...replacement, ...lines.slice(start + count)];
}

/**
 * Rejoins lines, taking the trailing terminator from whichever text now owns the
 * end of the file.
 *
 * `splitLines` deliberately drops a trailing terminator, so rebuilding without
 * this would strip the final newline off every file it touched — a one-character
 * change that shows up in every later diff and in most linters. Taking it from
 * the *source of the last line* rather than from the text being edited is what
 * makes restoring a file that was emptied, or emptying one that was created,
 * come out right.
 */
function join(lines: readonly string[], terminatorSource: string): string {
  if (lines.length === 0) {
    // No lines means no last line to terminate. Returning "\n" here would turn a
    // deleted file's content into a single blank line.
    return '';
  }
  const text = lines.join('\n');
  return terminatorSource.endsWith('\n') ? `${text}\n` : text;
}
