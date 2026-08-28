import * as vscode from 'vscode';

/**
 * Workspace symbol search (Docs/TARS_SPEC.md §7.2).
 *
 * Delegates to `vscode.executeWorkspaceSymbolProvider`, which asks whatever
 * language servers the user already has installed. That is the whole design:
 * TARS gets accurate symbols for every language the user's editor supports,
 * without shipping a parser for any of them, and it stays correct as they add
 * languages TARS has never heard of.
 *
 * Results are best-effort. A workspace with no language server for the file type
 * simply returns nothing, which is a quieter and more honest outcome than
 * falling back to a regex that would confidently return the wrong symbol.
 */

export interface SymbolMatch {
  readonly name: string;
  /** e.g. `'Class'`, `'Function'` — from the language server, not inferred. */
  readonly kind: string;
  /** Workspace-relative path of the file the symbol is defined in. */
  readonly path: string;
  /** 1-based, matching how the rest of TARS reports line numbers. */
  readonly line: number;
  /** The symbol's container, e.g. the enclosing class. Empty when top-level. */
  readonly container: string;
}

/** Beyond this, the list stops being a menu and becomes a haystack. */
const DEFAULT_LIMIT = 20;

export async function searchSymbols(
  query: string,
  limit: number = DEFAULT_LIMIT,
): Promise<readonly SymbolMatch[]> {
  if (query.trim() === '') {
    // An empty query asks every provider for everything, which on a large
    // workspace is a multi-second stall for a list nobody wants.
    return [];
  }

  let symbols: readonly vscode.SymbolInformation[] | undefined;
  try {
    symbols = await vscode.commands.executeCommand<vscode.SymbolInformation[]>(
      'vscode.executeWorkspaceSymbolProvider',
      query,
    );
  } catch {
    // A language server that is starting, crashed, or does not implement the
    // provider is an ordinary state, not a failure to report to the user.
    return [];
  }
  if (symbols === undefined) {
    return [];
  }

  const matches: SymbolMatch[] = [];
  for (const symbol of symbols) {
    if (matches.length >= limit) {
      break;
    }
    if (symbol.location.uri.scheme !== 'file') {
      continue;
    }
    matches.push({
      name: symbol.name,
      kind: vscode.SymbolKind[symbol.kind] ?? 'Symbol',
      path: vscode.workspace.asRelativePath(symbol.location.uri, false),
      line: symbol.location.range.start.line + 1,
      container: symbol.containerName,
    });
  }
  return matches;
}
