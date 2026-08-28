import type { HostPorts, WorkspaceIndex } from '@tars/core';
import { searchSymbols } from '@tars/host';
import type { MentionCandidate } from '@tars/shared';

/**
 * Completions for `@`-mentions (Docs/TARS_SPEC.md §7.2).
 *
 * Three sources, merged: the file index, workspace symbols from the user's own
 * language servers, and the editor-state aliases. Files come first because they
 * are what users mention overwhelmingly most, and a symbol list that pushed the
 * obvious file match below the fold would make the common case worse to serve
 * the rare one.
 *
 * Symbols are asked for concurrently with the file search but never awaited past
 * a deadline: a language server that is still starting must not make the
 * completion list arrive after the user has finished typing. It is better to
 * show files now than everything later.
 */

/** How long to wait on language servers before answering with what we have. */
const SYMBOL_DEADLINE_MS = 250;

const FILE_LIMIT = 12;
const SYMBOL_LIMIT = 8;

/** Editor state that has no path, offered whenever the query prefixes one. */
const ALIASES: readonly MentionCandidate[] = [
  {
    kind: 'selection',
    label: 'selection',
    insert: 'selection',
    detail: 'the code you have selected',
  },
  {
    kind: 'diagnostics',
    label: 'problems',
    insert: 'problems',
    detail: 'errors and warnings in the workspace',
  },
];

export interface MentionProviderDeps {
  readonly ports: HostPorts;
  readonly index: WorkspaceIndex;
}

export class MentionProvider {
  constructor(private readonly deps: MentionProviderDeps) {}

  async complete(query: string): Promise<readonly MentionCandidate[]> {
    const lowered = query.toLowerCase();

    // Started before the file search is awaited, so the two run concurrently.
    const symbols = withDeadline(searchSymbols(query, SYMBOL_LIMIT), SYMBOL_DEADLINE_MS, []);

    const files = await this.deps.index.search(query, FILE_LIMIT);
    const candidates: MentionCandidate[] = files.map((file) => ({
      kind: 'file',
      label: file.name,
      insert: file.path,
      detail: directoryOf(file.path),
    }));

    for (const alias of ALIASES) {
      if (alias.label.startsWith(lowered) || lowered === '') {
        candidates.push(alias);
      }
    }

    for (const symbol of await symbols) {
      candidates.push({
        kind: 'symbol',
        label: symbol.name,
        // Inserted as a path so it resolves through the same code path as a file
        // mention; the symbol's line is what makes it more precise than the file.
        insert: symbol.path,
        detail: symbol.container === '' ? symbol.kind : `${symbol.kind} in ${symbol.container}`,
      });
    }

    return candidates;
  }
}

/**
 * Resolves with `fallback` if the promise has not settled in time.
 *
 * The underlying work is not cancelled — there is nothing to cancel a command
 * invocation with — it is simply no longer waited on, and its result is dropped.
 */
function withDeadline<T>(promise: Promise<T>, ms: number, fallback: T): Promise<T> {
  return new Promise<T>((resolve) => {
    const timer = setTimeout(() => {
      resolve(fallback);
    }, ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      () => {
        clearTimeout(timer);
        resolve(fallback);
      },
    );
  });
}

function directoryOf(path: string): string {
  const at = path.lastIndexOf('/');
  return at === -1 ? '' : path.slice(0, at);
}
