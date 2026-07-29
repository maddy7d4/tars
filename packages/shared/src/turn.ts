import type { TurnId } from './brand.js';

/** A file attached to a turn by `@`-mention or editor selection. */
export interface FileContextItem {
  readonly kind: 'file';
  readonly path: string;
}

/** A region of a file, resolved from the active selection. Lines are 1-based, `endLine` inclusive. */
export interface SelectionContextItem {
  readonly kind: 'selection';
  readonly path: string;
  readonly startLine: number;
  readonly endLine: number;
}

/** A workspace symbol resolved through the user's own language servers. */
export interface SymbolContextItem {
  readonly kind: 'symbol';
  readonly name: string;
  readonly path: string;
  readonly line: number;
}

/** A language-server diagnostic the user wants the agent to address. */
export interface DiagnosticContextItem {
  readonly kind: 'diagnostic';
  readonly path: string;
  readonly line: number;
  readonly severity: 'error' | 'warning' | 'information' | 'hint';
  readonly message: string;
}

/** Captured terminal output attached as context. */
export interface TerminalContextItem {
  readonly kind: 'terminal';
  readonly text: string;
}

/**
 * Everything the user can attach to a turn. Typed rather than flattened into
 * prompt text so the host can re-resolve paths and the UI can render chips.
 */
export type ContextItem =
  | FileContextItem
  | SelectionContextItem
  | SymbolContextItem
  | DiagnosticContextItem
  | TerminalContextItem;

/** One user message plus its curated context. */
export interface UserTurn {
  readonly id: TurnId;
  readonly text: string;
  readonly context: readonly ContextItem[];
}
