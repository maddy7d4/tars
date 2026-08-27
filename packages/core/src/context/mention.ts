import type { ContextItem } from '@tars/shared';
import type { Diagnostic } from '../ports/diagnostics-port.js';
import type { EditorSelection } from '../ports/workspace-port.js';
import type { FileIndex } from './file-index.js';

/**
 * A parsed `@`-mention, before it is resolved against the workspace.
 *
 * Parsing and resolution are separate steps so the UI can render a chip the
 * moment the user finishes typing, without waiting on the index, and so parsing
 * stays a pure function that is trivial to test.
 */
export interface Mention {
  /** Text as typed, without the `@`. */
  readonly query: string;
  /** Offset of the `@` in the source text, for replacing the span on accept. */
  readonly start: number;
  /** Offset one past the last character of the mention. */
  readonly end: number;
}

/**
 * Characters that terminate a mention.
 *
 * A trailing `.` or `,` is excluded so "check @src/index.ts, then…" mentions the
 * file rather than a path with a comma glued on. A `.` inside the name is kept,
 * because nearly every filename contains one.
 */
const MENTION_PATTERN = /(^|[\s([{])@([^\s@]+)/g;
const TRAILING_PUNCTUATION = /[.,;:!?)\]}]+$/;

/**
 * Extracts every `@`-mention from prompt text.
 *
 * A mention must start the string or follow whitespace or an opening bracket, so
 * `(@a.ts)` works while an email address like `me@example.com` — where the `@`
 * follows a word character — is not mistaken for one.
 */
export function parseMentions(text: string): readonly Mention[] {
  const mentions: Mention[] = [];

  for (const match of text.matchAll(MENTION_PATTERN)) {
    const leading = match[1] ?? '';
    const raw = match[2];
    if (raw === undefined || match.index === undefined) {
      continue;
    }

    const trimmed = raw.replace(TRAILING_PUNCTUATION, '');
    if (trimmed === '') {
      continue;
    }

    const start = match.index + leading.length;
    mentions.push({ query: trimmed, start, end: start + 1 + trimmed.length });
  }

  return mentions;
}

/** Everything resolution may draw on, so the resolver itself stays pure. */
export interface ResolutionSources {
  readonly index: FileIndex;
  readonly selection: EditorSelection | null;
  readonly diagnostics: readonly Diagnostic[];
}

/**
 * Mentions that resolved, and the queries that did not.
 *
 * Unresolved mentions are returned rather than dropped: silently ignoring
 * `@notafile.ts` would leave the user believing they attached something they did
 * not, which is worse than an explicit miss.
 */
export interface ResolvedContext {
  readonly items: readonly ContextItem[];
  readonly unresolved: readonly string[];
}

/**
 * Well-known mentions that name editor state rather than a path.
 *
 * These exist because the alternative — making the user paste a selection or
 * copy diagnostics by hand — is precisely the friction the context engine is for.
 */
const SELECTION_ALIASES: readonly string[] = ['selection', 'sel'];
const DIAGNOSTIC_ALIASES: readonly string[] = ['problems', 'diagnostics', 'errors'];

/**
 * Turns mentions into typed `ContextItem`s (Docs/TARS_SPEC.md §7.2).
 *
 * Resolution is exact-path-first, then a unique index match. An ambiguous
 * basename resolves to nothing rather than guessing: attaching the wrong file is
 * a silent correctness failure, while an unresolved mention is visible and
 * fixable.
 */
export function resolveMentions(
  mentions: readonly Mention[],
  sources: ResolutionSources,
): ResolvedContext {
  const items: ContextItem[] = [];
  const unresolved: string[] = [];
  const seenPaths = new Set<string>();

  for (const mention of mentions) {
    const query = mention.query;
    const lowered = query.toLowerCase();

    if (SELECTION_ALIASES.includes(lowered)) {
      const selection = sources.selection;
      if (selection === null) {
        unresolved.push(query);
        continue;
      }
      items.push({
        kind: 'selection',
        path: selection.path,
        startLine: selection.startLine,
        endLine: selection.endLine,
      });
      continue;
    }

    if (DIAGNOSTIC_ALIASES.includes(lowered)) {
      if (sources.diagnostics.length === 0) {
        unresolved.push(query);
        continue;
      }
      for (const diagnostic of sources.diagnostics) {
        items.push({
          kind: 'diagnostic',
          path: diagnostic.path,
          line: diagnostic.line,
          severity: diagnostic.severity,
          message: diagnostic.message,
        });
      }
      continue;
    }

    const exact = sources.index.get(query);
    if (exact !== null) {
      if (!seenPaths.has(exact.path)) {
        seenPaths.add(exact.path);
        items.push({ kind: 'file', path: exact.path });
      }
      continue;
    }

    const matches = sources.index.search(query, 2);
    const only = matches.length === 1 ? matches[0] : undefined;
    if (only === undefined) {
      unresolved.push(query);
      continue;
    }
    if (!seenPaths.has(only.path)) {
      seenPaths.add(only.path);
      items.push({ kind: 'file', path: only.path });
    }
  }

  return { items, unresolved };
}

/**
 * Removes mention spans from the prompt text.
 *
 * The mention is already carried as a typed `ContextItem`, so leaving `@foo.ts`
 * in the prose would present the model with the same reference twice — once
 * structured, once as ambiguous text.
 */
export function stripMentions(text: string, mentions: readonly Mention[]): string {
  if (mentions.length === 0) {
    return text;
  }
  // Right to left: removing a span shifts every offset after it.
  let result = text;
  for (let i = mentions.length - 1; i >= 0; i -= 1) {
    const mention = mentions[i];
    if (mention === undefined) continue;
    result = result.slice(0, mention.start) + result.slice(mention.end);
  }
  return result.replace(/[ \t]{2,}/g, ' ').trim();
}
