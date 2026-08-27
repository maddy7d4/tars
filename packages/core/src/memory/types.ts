import type { JsonValue } from '@tars/shared';

/**
 * One durable fact about a workspace.
 *
 * Memory exists because a session is disposable but what the agent learned about
 * a repository should not be (Docs/TARS_SPEC.md §2, phase 5). Each entry is one
 * fact rather than a free-text blob so entries can be superseded, scoped and
 * pruned individually — a single growing document can only be appended to, and
 * would eventually consume the context budget it was meant to save.
 */
export interface MemoryEntry {
  readonly id: string;
  /** Short human- and model-readable statement of the fact. */
  readonly text: string;
  /**
   * Why the fact matters. Stored separately so a future reader can judge whether
   * it still applies rather than obeying it blindly.
   */
  readonly rationale?: string;
  readonly kind: MemoryKind;
  /**
   * Workspace-relative paths the fact concerns. Empty means workspace-wide.
   * Used to surface only the memories relevant to what the turn touches.
   */
  readonly paths: readonly string[];
  /** Epoch millis, from `ClockPort` so tests are deterministic. */
  readonly createdAt: number;
  readonly updatedAt: number;
  /** Free-form provenance, e.g. the session that recorded it. */
  readonly metadata?: Readonly<Record<string, JsonValue>>;
}

/**
 * Deliberately a closed set. An open `string` tag would drift into synonyms
 * ("style", "styling", "conventions") that no retrieval step could unify.
 */
export type MemoryKind =
  /** How this project does things: conventions, idioms, house style. */
  | 'convention'
  /** A constraint that must hold: invariants, forbidden approaches. */
  | 'constraint'
  /** How to run, build, test, or deploy. */
  | 'workflow'
  /** Durable context about intent or history that the code does not record. */
  | 'context'
  /** A correction the user made, kept so the same mistake is not repeated. */
  | 'correction';

/** Fields a caller supplies; identity and timestamps are assigned by the store. */
export interface MemoryDraft {
  readonly text: string;
  readonly rationale?: string;
  readonly kind: MemoryKind;
  readonly paths?: readonly string[];
  readonly metadata?: Readonly<Record<string, JsonValue>>;
}

/** Narrows which memories are returned. Every field is optional and ANDed. */
export interface MemoryQuery {
  readonly kind?: MemoryKind;
  /** Matches entries scoped to this path, plus every workspace-wide entry. */
  readonly path?: string;
  /** Case-insensitive substring over `text` and `rationale`. */
  readonly search?: string;
  readonly limit?: number;
}
