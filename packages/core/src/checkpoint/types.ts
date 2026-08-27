/**
 * Checkpoint records (Docs/TARS_SPEC.md §6.4).
 *
 * A checkpoint is the working tree as it stood immediately before an apply,
 * paired with the session event offset that produced it. Recording both is what
 * makes "undo this change" and "rewind the conversation to before it" the same
 * operation — the alternative is two histories that drift apart, where restoring
 * files leaves the transcript claiming work that no longer exists.
 */

/** One file as it stood when the checkpoint was taken. */
export interface CheckpointFile {
  /** Workspace-relative path. */
  readonly path: string;
  /**
   * Blob hash of the content before the apply, or `null` if the file did not
   * exist. `null` is what makes "the agent created this file" restorable: the
   * restore has to delete it, and a missing entry could not say so.
   */
  readonly beforeHash: string | null;
}

export interface Checkpoint {
  readonly id: string;
  /** Epoch millis, from `ClockPort`. */
  readonly at: number;
  /** Short description of what was about to be applied, for the restore list. */
  readonly label: string;
  readonly sessionId: string;
  /**
   * Number of events in the session log at the moment of the checkpoint.
   *
   * An offset rather than an event id, because rewinding means truncating the
   * log to a length, and a count is the only form that survives a log whose
   * events carry no stable ordering key of their own.
   */
  readonly eventOffset: number;
  readonly files: readonly CheckpointFile[];
}

/** What a restore actually managed to do. */
export interface RestoreResult {
  readonly checkpointId: string;
  /** Files whose prior content was recovered and should be written back. */
  readonly restored: readonly RestoredFile[];
  /**
   * Files that must be deleted to return to this checkpoint — they did not exist
   * when it was taken.
   */
  readonly deleted: readonly string[];
  /**
   * Files whose blob could not be read. Reported rather than thrown: a restore
   * that recovers nine of ten files and says which one it could not is far more
   * useful than one that refuses and recovers none.
   */
  readonly unrecoverable: readonly string[];
  readonly eventOffset: number;
}

export interface RestoredFile {
  readonly path: string;
  readonly content: string;
}
