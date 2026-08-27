/**
 * A `.gitignore` matcher.
 *
 * The file index walks the workspace, and a walk that ignores `.gitignore` is
 * useless in practice: `node_modules` alone can outnumber real source files by
 * two orders of magnitude, and indexing build output wastes the user's context
 * budget on generated code (Docs/TARS_SPEC.md §7.2).
 *
 * This implements the subset of the gitignore specification that actually
 * governs a source tree — anchoring, directory-only rules, negation, `**`, and
 * per-directory nesting. It deliberately does not implement `.gitattributes`,
 * `core.excludesFile`, or `[a-z]` character classes; a rule using one is treated
 * as literal text rather than silently matching the wrong files.
 */

/** One parsed pattern. Order is preserved because later rules override earlier ones. */
interface GitignoreRule {
  /** Matched against a workspace-relative POSIX path. */
  readonly regex: RegExp;
  /** Matches only paths strictly beneath the pattern, for directory-only rules. */
  readonly contentsRegex: RegExp;
  /** A `!`-prefixed rule re-includes a path an earlier rule excluded. */
  readonly negated: boolean;
  /** A trailing `/` restricts the rule to directories. */
  readonly directoryOnly: boolean;
}

/** Characters that are literal in a glob but special in a regular expression. */
const REGEX_SPECIAL = /[.+^${}()|[\]\\]/g;

function escapeLiteral(text: string): string {
  return text.replace(REGEX_SPECIAL, '\\$&');
}

/**
 * Translates one glob into an anchored regular expression.
 *
 * `**` is handled before `*` because the single-star rule must not match a path
 * separator — `src/*.ts` matching `src/a/b.ts` is the classic bug here.
 */
function globToRegexSource(glob: string): string {
  let source = '';
  let index = 0;

  while (index < glob.length) {
    const char = glob[index];

    if (char === '*') {
      const isDoubleStar = glob[index + 1] === '*';
      if (isDoubleStar) {
        const followedBySlash = glob[index + 2] === '/';
        if (followedBySlash) {
          // `a/**/b` must also match `a/b`, so the separator is part of the
          // optional group rather than a mandatory character after it.
          source += '(?:.*/)?';
          index += 3;
          continue;
        }
        source += '.*';
        index += 2;
        continue;
      }
      source += '[^/]*';
      index += 1;
      continue;
    }

    if (char === '?') {
      source += '[^/]';
      index += 1;
      continue;
    }

    source += escapeLiteral(char ?? '');
    index += 1;
  }

  return source;
}

function compileRule(rawLine: string): GitignoreRule | null {
  let line = rawLine;

  // A trailing backslash escapes the whitespace before it; otherwise trailing
  // spaces are insignificant, matching git's own parsing.
  if (!line.endsWith('\\ ')) {
    line = line.replace(/\s+$/, '');
  }

  if (line === '' || line.startsWith('#')) {
    return null;
  }

  const negated = line.startsWith('!');
  if (negated) {
    line = line.slice(1);
  }

  // `\#foo` and `\!foo` are literal names, not a comment or a negation.
  if (line.startsWith('\\#') || line.startsWith('\\!')) {
    line = line.slice(1);
  }

  const directoryOnly = line.endsWith('/');
  if (directoryOnly) {
    line = line.slice(0, -1);
  }

  if (line === '') {
    return null;
  }

  // A slash anywhere but the end anchors the pattern to the directory holding the
  // .gitignore. Without one, the pattern matches at any depth — which is why
  // `node_modules` excludes every nested copy, not just the top-level one.
  const anchored = line.includes('/');
  const normalised = anchored && line.startsWith('/') ? line.slice(1) : line;
  const body = globToRegexSource(normalised);
  const prefix = anchored ? '^' : '^(?:.*/)?';

  // Two regexes because a directory-only rule has two jobs. `regex` matches the
  // directory itself and only applies when the path IS a directory. `contentsRegex`
  // matches anything beneath it and applies regardless — `dist/` must exclude
  // `dist/bundle.js`, which is a file.
  return {
    regex: new RegExp(`${prefix}${body}(?:/.*)?$`),
    contentsRegex: new RegExp(`${prefix}${body}/.+$`),
    negated,
    directoryOnly,
  };
}

/**
 * The rules from one `.gitignore`, scoped to the directory that contained it.
 *
 * Scoping matters: a rule in `packages/web/.gitignore` must not affect
 * `packages/api`, and git resolves that by directory, not by pattern text.
 */
export class GitignoreFile {
  private readonly rules: readonly GitignoreRule[];

  /** @param baseDir Workspace-relative POSIX directory, `''` for the root. */
  constructor(
    readonly baseDir: string,
    content: string,
  ) {
    const rules: GitignoreRule[] = [];
    for (const line of content.split(/\r?\n/)) {
      const rule = compileRule(line);
      if (rule !== null) {
        rules.push(rule);
      }
    }
    this.rules = rules;
  }

  /**
   * `true` ignored, `false` explicitly re-included, `null` no opinion.
   *
   * Three states rather than a boolean because "no opinion" and "explicitly
   * unignored" must be distinguishable — a parent directory's rule may still
   * apply to the former but must not override the latter.
   */
  match(relativePath: string, isDirectory: boolean): boolean | null {
    if (!this.covers(relativePath)) {
      return null;
    }
    const scoped = this.baseDir === '' ? relativePath : relativePath.slice(this.baseDir.length + 1);

    let verdict: boolean | null = null;
    // Last matching rule wins, so this cannot early-return on the first hit.
    for (const rule of this.rules) {
      // A directory-only rule applies to the directory itself, and to everything
      // under it whether or not that thing is a directory.
      const matched =
        rule.directoryOnly && !isDirectory
          ? rule.contentsRegex.test(scoped)
          : rule.regex.test(scoped);
      if (matched) {
        verdict = !rule.negated;
      }
    }
    return verdict;
  }

  private covers(relativePath: string): boolean {
    return this.baseDir === '' || relativePath.startsWith(`${this.baseDir}/`);
  }
}

/**
 * A stack of `.gitignore` files, nearest-first.
 *
 * Git gives the deepest `.gitignore` the final say, so the stack is consulted
 * from the deepest base directory outward and stops at the first file with an
 * opinion.
 */
export class IgnoreStack {
  private readonly files: readonly GitignoreFile[];

  constructor(files: readonly GitignoreFile[]) {
    // Deepest first: sorting once here keeps `isIgnored` a linear scan.
    this.files = [...files].sort((a, b) => b.baseDir.length - a.baseDir.length);
  }

  /** Returns a new stack with `file` added, leaving this one untouched. */
  with(file: GitignoreFile): IgnoreStack {
    return new IgnoreStack([...this.files, file]);
  }

  isIgnored(relativePath: string, isDirectory: boolean): boolean {
    for (const file of this.files) {
      const verdict = file.match(relativePath, isDirectory);
      if (verdict !== null) {
        return verdict;
      }
    }
    return false;
  }
}

/**
 * Always excluded, regardless of `.gitignore`.
 *
 * `.git` is excluded because walking it is pure waste — it is large, entirely
 * generated, and never something the user means by "my code".
 */
export const ALWAYS_IGNORED: readonly string[] = ['.git'];
