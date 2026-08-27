/**
 * Line-level diffing, as the input to change sets (Docs/TARS_SPEC.md §6.1).
 *
 * TARS does not render diffs — the host hands the change set to VS Code's own
 * diff editor (§6.2). What core needs is the *structure*: which lines changed,
 * grouped into hunks, so a review workflow can accept or reject one region
 * without the user reasoning about the whole file. That structure also has to be
 * computed without the editor, because it is what the checkpoint store records
 * and what the tests assert against.
 */

/** One line's fate in the diff. */
export type DiffOpKind = 'equal' | 'delete' | 'insert';

export interface DiffOp {
  readonly kind: DiffOpKind;
  /** The line's text, without its terminator. */
  readonly text: string;
  /** 0-based line number in the before-text, or -1 for an insertion. */
  readonly beforeLine: number;
  /** 0-based line number in the after-text, or -1 for a deletion. */
  readonly afterLine: number;
}

/**
 * A contiguous region of change plus its surrounding context, in the shape a
 * unified diff header describes. Line numbers are 0-based; renderers that show
 * `@@` headers add one.
 */
export interface DiffHunk {
  readonly beforeStart: number;
  readonly beforeCount: number;
  readonly afterStart: number;
  readonly afterCount: number;
  readonly ops: readonly DiffOp[];
}

export interface DiffStats {
  readonly added: number;
  readonly removed: number;
}

export interface DiffOptions {
  /** Unchanged lines kept on each side of a change. */
  readonly context?: number;
  /**
   * Above this many lines on either side, the diff is reported as a single
   * whole-file replacement instead of being computed.
   *
   * The algorithm is O(n·d) in the number of differences, which is excellent for
   * ordinary edits and pathological for a large generated file rewritten
   * wholesale. A cap keeps one unlucky edit from freezing the extension host,
   * and the fallback is honest rather than wrong: it says the whole file changed,
   * which it did.
   */
  readonly maxLines?: number;
}

const DEFAULT_CONTEXT = 3;
const DEFAULT_MAX_LINES = 20_000;

/**
 * Splits text into lines for diffing.
 *
 * A trailing newline does not produce a final empty line: a file ending in `\n`
 * has the same lines as one that does not, and treating the terminator as a line
 * of its own makes "added a trailing newline" indistinguishable from "added a
 * blank line". `\r\n` is normalised so a line-ending change alone is not
 * reported as every line having changed — that difference belongs to the file's
 * encoding, not its content.
 */
export function splitLines(text: string): readonly string[] {
  if (text === '') {
    return [];
  }
  const normalized = text.replace(/\r\n/g, '\n');
  const lines = normalized.split('\n');
  if (lines[lines.length - 1] === '') {
    lines.pop();
  }
  return lines;
}

/**
 * Computes a line-level diff.
 *
 * Uses the greedy variant of Myers' algorithm: it walks diagonals of the edit
 * graph in increasing edit distance `d`, so a small change to a large file costs
 * O(n·d) rather than the O(n·m) of a full dynamic-programming table. That is the
 * common case here — an agent edits a few lines of a file it just read — and it
 * is the difference between a diff that is instant and one the user waits on.
 */
export function diffLines(
  before: readonly string[],
  after: readonly string[],
  options: DiffOptions = {},
): readonly DiffOp[] {
  const maxLines = options.maxLines ?? DEFAULT_MAX_LINES;
  if (before.length > maxLines || after.length > maxLines) {
    return wholeFileReplacement(before, after);
  }

  // Common affixes are stripped first. They are the bulk of a typical edit and
  // cost O(n) to find, which keeps `d` — the term the algorithm is sensitive
  // to — proportional to the actual change rather than the file.
  let prefix = 0;
  const shortest = Math.min(before.length, after.length);
  while (prefix < shortest && before[prefix] === after[prefix]) {
    prefix += 1;
  }
  let suffix = 0;
  while (
    suffix < shortest - prefix &&
    before[before.length - 1 - suffix] === after[after.length - 1 - suffix]
  ) {
    suffix += 1;
  }

  const beforeCore = before.slice(prefix, before.length - suffix);
  const afterCore = after.slice(prefix, after.length - suffix);

  const ops: DiffOp[] = [];
  for (let i = 0; i < prefix; i += 1) {
    ops.push(equalOp(before, i, i));
  }
  ops.push(...myers(beforeCore, afterCore, prefix));
  for (let i = 0; i < suffix; i += 1) {
    const beforeLine = before.length - suffix + i;
    ops.push(equalOp(before, beforeLine, after.length - suffix + i));
  }
  return ops;
}

function equalOp(before: readonly string[], beforeLine: number, afterLine: number): DiffOp {
  return { kind: 'equal', text: before[beforeLine] ?? '', beforeLine, afterLine };
}

/** The honest answer when the input is too large to diff: everything changed. */
function wholeFileReplacement(
  before: readonly string[],
  after: readonly string[],
): readonly DiffOp[] {
  const ops: DiffOp[] = [];
  before.forEach((text, index) => {
    ops.push({ kind: 'delete', text, beforeLine: index, afterLine: -1 });
  });
  after.forEach((text, index) => {
    ops.push({ kind: 'insert', text, beforeLine: -1, afterLine: index });
  });
  return ops;
}

/**
 * One step of the edit graph walk, recorded so the path can be rebuilt.
 *
 * The whole `v` array is snapshotted per `d` rather than storing back-pointers
 * per node. It costs O(d²) memory in the worst case, which for the edit sizes
 * this sees is far smaller than the file itself, and it makes the backtrack a
 * plain loop instead of a graph traversal.
 */
type Trace = readonly (readonly number[])[];

function myers(
  before: readonly string[],
  after: readonly string[],
  lineOffset: number,
): readonly DiffOp[] {
  const n = before.length;
  const m = after.length;

  if (n === 0 && m === 0) {
    return [];
  }
  // With one side empty there is nothing to align; the walk below would reach the
  // same answer, but this is the common case for file creation and deletion.
  if (n === 0) {
    return after.map((text, index) => ({
      kind: 'insert' as const,
      text,
      beforeLine: -1,
      afterLine: lineOffset + index,
    }));
  }
  if (m === 0) {
    return before.map((text, index) => ({
      kind: 'delete' as const,
      text,
      beforeLine: lineOffset + index,
      afterLine: -1,
    }));
  }

  const max = n + m;
  const size = 2 * max + 1;
  // `v[k + max]` is the furthest x reached on diagonal k. Offsetting by `max`
  // keeps negative diagonals in a plain array rather than a map.
  let v = new Array<number>(size).fill(0);
  const trace: number[][] = [];

  for (let d = 0; d <= max; d += 1) {
    trace.push([...v]);
    for (let k = -d; k <= d; k += 2) {
      const index = k + max;
      const goDown =
        k === -d || (k !== d && (v[index - 1] ?? 0) < (v[index + 1] ?? 0));
      let x = goDown ? (v[index + 1] ?? 0) : (v[index - 1] ?? 0) + 1;
      let y = x - k;

      // Follow the diagonal as far as the lines match: matches are free, and
      // taking all of them here is what keeps `d` equal to the edit distance.
      while (x < n && y < m && before[x] === after[y]) {
        x += 1;
        y += 1;
      }
      v[index] = x;

      if (x >= n && y >= m) {
        return backtrack(trace, before, after, lineOffset);
      }
    }
    v = [...v];
  }

  // Unreachable: the walk always terminates by d = n + m. Falling back rather
  // than throwing keeps a diff bug from taking down a turn.
  return wholeFileReplacement(before, after).map((op) => shiftOp(op, lineOffset));
}

function shiftOp(op: DiffOp, offset: number): DiffOp {
  return {
    ...op,
    beforeLine: op.beforeLine === -1 ? -1 : op.beforeLine + offset,
    afterLine: op.afterLine === -1 ? -1 : op.afterLine + offset,
  };
}

/** Walks the recorded traces backwards from (n, m) to the origin. */
function backtrack(
  trace: Trace,
  before: readonly string[],
  after: readonly string[],
  lineOffset: number,
): readonly DiffOp[] {
  const n = before.length;
  const m = after.length;
  const max = n + m;
  const ops: DiffOp[] = [];
  let x = n;
  let y = m;

  for (let d = trace.length - 1; d >= 0 && (x > 0 || y > 0); d -= 1) {
    const v = trace[d] ?? [];
    const k = x - y;
    const index = k + max;
    const goDown = k === -d || (k !== d && (v[index - 1] ?? 0) < (v[index + 1] ?? 0));
    const prevK = goDown ? k + 1 : k - 1;
    const prevX = v[prevK + max] ?? 0;
    const prevY = prevX - prevK;

    // Everything between the previous furthest point and here was a diagonal
    // run, so those lines are equal.
    while (x > prevX && y > prevY) {
      x -= 1;
      y -= 1;
      ops.push({
        kind: 'equal',
        text: before[x] ?? '',
        beforeLine: lineOffset + x,
        afterLine: lineOffset + y,
      });
    }

    if (d === 0) {
      break;
    }
    if (goDown) {
      y -= 1;
      ops.push({
        kind: 'insert',
        text: after[y] ?? '',
        beforeLine: -1,
        afterLine: lineOffset + y,
      });
    } else {
      x -= 1;
      ops.push({
        kind: 'delete',
        text: before[x] ?? '',
        beforeLine: lineOffset + x,
        afterLine: -1,
      });
    }
  }

  return ops.reverse();
}

/**
 * Groups a diff into hunks with surrounding context.
 *
 * Two changes closer together than twice the context window join into one hunk
 * rather than producing overlapping regions — that is what makes a hunk a unit a
 * user can accept or reject without the pieces contradicting each other.
 */
export function toHunks(ops: readonly DiffOp[], options: DiffOptions = {}): readonly DiffHunk[] {
  const context = options.context ?? DEFAULT_CONTEXT;
  const changedIndices: number[] = [];
  ops.forEach((op, index) => {
    if (op.kind !== 'equal') {
      changedIndices.push(index);
    }
  });
  if (changedIndices.length === 0) {
    return [];
  }

  const hunks: DiffHunk[] = [];
  let start = Math.max(0, (changedIndices[0] ?? 0) - context);
  let end = Math.min(ops.length - 1, (changedIndices[0] ?? 0) + context);

  for (const index of changedIndices.slice(1)) {
    if (index - context <= end + 1) {
      end = Math.min(ops.length - 1, index + context);
      continue;
    }
    hunks.push(buildHunk(ops, start, end));
    start = Math.max(0, index - context);
    end = Math.min(ops.length - 1, index + context);
  }
  hunks.push(buildHunk(ops, start, end));
  return hunks;
}

function buildHunk(ops: readonly DiffOp[], start: number, end: number): DiffHunk {
  const slice = ops.slice(start, end + 1);
  let beforeStart = -1;
  let afterStart = -1;
  let beforeCount = 0;
  let afterCount = 0;

  for (const op of slice) {
    if (op.kind !== 'insert') {
      if (beforeStart === -1) {
        beforeStart = op.beforeLine;
      }
      beforeCount += 1;
    }
    if (op.kind !== 'delete') {
      if (afterStart === -1) {
        afterStart = op.afterLine;
      }
      afterCount += 1;
    }
  }

  // A hunk made only of insertions has no before-line of its own; unified diff
  // convention anchors it at the line it follows.
  const anchoredBefore = beforeStart === -1 ? anchorBefore(ops, start) : beforeStart;
  const anchoredAfter = afterStart === -1 ? anchorAfter(ops, start) : afterStart;

  return {
    beforeStart: anchoredBefore,
    beforeCount,
    afterStart: anchoredAfter,
    afterCount,
    ops: slice,
  };
}

function anchorBefore(ops: readonly DiffOp[], start: number): number {
  for (let i = start - 1; i >= 0; i -= 1) {
    const op = ops[i];
    if (op !== undefined && op.beforeLine !== -1) {
      return op.beforeLine + 1;
    }
  }
  return 0;
}

function anchorAfter(ops: readonly DiffOp[], start: number): number {
  for (let i = start - 1; i >= 0; i -= 1) {
    const op = ops[i];
    if (op !== undefined && op.afterLine !== -1) {
      return op.afterLine + 1;
    }
  }
  return 0;
}

export function diffStats(ops: readonly DiffOp[]): DiffStats {
  let added = 0;
  let removed = 0;
  for (const op of ops) {
    if (op.kind === 'insert') {
      added += 1;
    } else if (op.kind === 'delete') {
      removed += 1;
    }
  }
  return { added, removed };
}

/**
 * Renders a diff in unified format.
 *
 * Not for the UI — the host uses the native diff editor. This is what goes in a
 * log, a test failure message, or a prompt when the model needs to be told what
 * it changed, and having one canonical text form keeps those three consistent.
 */
export function toUnifiedDiff(
  path: string,
  hunks: readonly DiffHunk[],
): string {
  if (hunks.length === 0) {
    return '';
  }
  const lines: string[] = [`--- a/${path}`, `+++ b/${path}`];
  for (const hunk of hunks) {
    lines.push(
      `@@ -${String(hunk.beforeStart + 1)},${String(hunk.beforeCount)} ` +
        `+${String(hunk.afterStart + 1)},${String(hunk.afterCount)} @@`,
    );
    for (const op of hunk.ops) {
      const marker = op.kind === 'equal' ? ' ' : op.kind === 'insert' ? '+' : '-';
      lines.push(`${marker}${op.text}`);
    }
  }
  return `${lines.join('\n')}\n`;
}
