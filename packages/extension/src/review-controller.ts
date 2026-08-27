import * as vscode from 'vscode';
import type { Baseline, FileChange, HostPorts, LoggerPort } from '@tars/core';
import { ChangeSetBuilder, CheckpointStore, proposalFromEvent } from '@tars/core';
import { ChangeApplier, DiffContentProvider } from '@tars/host';
import type { AgentEvent, HostToWebview, PendingChangeSummary } from '@tars/shared';

/**
 * The review workflow of Docs/TARS_SPEC.md §6.
 *
 * Review here is **post-hoc**, and that is forced by how the agent works rather
 * than chosen. Claude Code's `Write` and `Edit` are the SDK's own tools and they
 * write to the workspace themselves; TARS gates them at the permission prompt
 * (§4.2) but never holds their output. So by the time a user could look at a
 * change, it is already on disk.
 *
 * What makes that safe is the checkpoint, not the prompt. Every file is
 * snapshotted the moment the agent announces it is about to write — before the
 * tool runs — so the review bar offers a real choice: keep the change, or revert
 * to the content that predates the whole turn. The checkpoint is written after
 * each file rather than at turn end, so a crash mid-turn still leaves a way back.
 *
 * Kept separate from `SessionController` because the two answer different
 * questions: that one owns the conversation, this one owns the working tree.
 */

export interface ReviewControllerDeps {
  readonly ports: HostPorts;
  readonly post: (message: HostToWebview) => void;
  /** Resolves a path from an agent event to a URI. */
  readonly resolve: (path: string) => vscode.Uri;
}

export class ReviewController implements vscode.Disposable {
  private readonly log: LoggerPort;
  private readonly checkpoints: CheckpointStore;
  private readonly diffs = new DiffContentProvider();
  private readonly applier: ChangeApplier;

  private builder = new ChangeSetBuilder();
  /**
   * Baselines, read once per path, the first time the agent announces an edit to
   * it. Re-reading later would pick up the agent's own writes and record them as
   * the state to restore — the one state nobody needs to get back to.
   */
  private readonly baselines = new Map<string, Baseline>();
  private changes: readonly FileChange[] = [];
  private checkpointId: string | null = null;
  private sessionId = '';
  private eventCount = 0;
  /**
   * Serialises event handling. `observe` reads files and writes the checkpoint,
   * and events arrive faster than that: without a queue two proposals for the
   * same path could both miss the baseline cache and both snapshot it.
   */
  private queue: Promise<void> = Promise.resolve();

  constructor(private readonly deps: ReviewControllerDeps) {
    this.log = deps.ports.logger.child('review');
    this.checkpoints = new CheckpointStore({
      fileSystem: deps.ports.fileSystem,
      storage: deps.ports.storage,
      clock: deps.ports.clock,
      logger: deps.ports.logger,
    });
    this.applier = new ChangeApplier({ resolve: deps.resolve });
  }

  /** Files awaiting review. Empty when there is nothing to decide. */
  get pendingChanges(): readonly FileChange[] {
    return this.changes;
  }

  /**
   * Observes the event stream.
   *
   * Counts every event, not only proposals: the count is the session log offset
   * the checkpoint records, and it is what makes restoring files and rewinding
   * the conversation the same operation (§6.4).
   */
  observe(event: AgentEvent): Promise<void> {
    this.eventCount += 1;
    this.sessionId = event.sessionId;
    if (event.type !== 'file_edit_proposed') {
      return Promise.resolve();
    }
    this.queue = this.queue.then(() => this.record(event));
    return this.queue;
  }

  private async record(event: AgentEvent & { readonly type: 'file_edit_proposed' }): Promise<void> {
    try {
      const baseline = await this.baselineFor(event.path);
      await this.snapshot(event.path, baseline);
      this.builder.add(proposalFromEvent(event), baseline);
      this.publish();
    } catch (error: unknown) {
      // Reported, never swallowed: without a baseline there is no checkpoint, and
      // a user who is not told that has lost the ability to revert without knowing it.
      this.fail('could not snapshot the file before the agent edited it', error);
    }
  }

  /** Opens one changed file in the editor's native diff viewer (§6.2). */
  async review(path: string): Promise<void> {
    const change = this.changes.find((candidate) => candidate.path === path);
    if (change === undefined) {
      this.log.log('warn', 'asked to review a file with no pending change', { path });
      return;
    }

    // The left pane comes from memory: for a modification the baseline is no
    // longer on disk, and for a creation it never was.
    const left = this.diffs.publish(`${path} (before TARS)`, change.beforeContent ?? '');
    const right =
      change.afterContent === null
        ? this.diffs.publish(`${path} (deleted)`, '')
        : this.deps.resolve(path);

    await vscode.commands.executeCommand('vscode.diff', left, right, `TARS: ${path}`);
  }

  /** Accepts the changes and retires the review. Nothing is written: they are already on disk. */
  keep(): void {
    const count = this.changes.length;
    this.reset();
    if (count > 0) {
      this.log.log('info', 'kept agent changes', { files: count });
    }
  }

  /**
   * Restores every file to the state it had before this turn's edits.
   *
   * Goes through a `WorkspaceEdit` so the revert lands in the editor's own undo
   * stack (§6.3) — a user who reverts by mistake gets it back with `Ctrl+Z`,
   * rather than needing a second TARS command to undo the first.
   */
  async revert(): Promise<void> {
    const checkpointId = this.checkpointId;
    if (checkpointId === null || this.changes.length === 0) {
      void vscode.window.showInformationMessage('TARS has no changes to revert.');
      return;
    }

    try {
      const result = await this.checkpoints.restore(checkpointId);
      if (result === null) {
        this.fail('could not revert', new Error('the checkpoint is gone'));
        return;
      }
      const outcome = await this.applier.restore(result);
      if (!outcome.applied) {
        this.fail('the revert was not applied', new Error(outcome.reason ?? 'unknown reason'));
        return;
      }
      this.warnUnrecoverable(result.unrecoverable, outcome.paths.length);
      this.log.log('info', 'reverted agent changes', { files: outcome.paths.length });
      this.reset();
    } catch (error: unknown) {
      this.fail('could not revert the changes', error);
    }
  }

  /** Offers every checkpoint and restores the chosen one. */
  async restoreCheckpoint(): Promise<void> {
    try {
      const available = await this.checkpoints.list();
      if (available.length === 0) {
        void vscode.window.showInformationMessage('TARS has no checkpoints to restore.');
        return;
      }

      const picked = await vscode.window.showQuickPick(
        available.map((checkpoint) => ({
          label: checkpoint.label,
          description: new Date(checkpoint.at).toLocaleString(),
          detail: `${String(checkpoint.files.length)} file(s)`,
          id: checkpoint.id,
        })),
        { title: 'Restore a TARS checkpoint', placeHolder: 'Newest first' },
      );
      if (picked === undefined) {
        return;
      }

      const result = await this.checkpoints.restore(picked.id);
      if (result === null) {
        this.fail('could not restore', new Error('the checkpoint disappeared'));
        return;
      }
      const outcome = await this.applier.restore(result);
      if (!outcome.applied) {
        this.fail('the restore was not applied', new Error(outcome.reason ?? 'unknown reason'));
        return;
      }
      this.warnUnrecoverable(result.unrecoverable, outcome.paths.length);
      this.reset();
    } catch (error: unknown) {
      this.fail('could not restore the checkpoint', error);
    }
  }

  /** Clears review state, e.g. when the session is replaced. */
  reset(): void {
    this.builder = new ChangeSetBuilder();
    this.baselines.clear();
    this.changes = [];
    this.checkpointId = null;
    this.eventCount = 0;
    this.diffs.clear();
    this.publish();
  }

  dispose(): void {
    this.diffs.dispose();
  }

  /**
   * Records the file's pre-edit content in a checkpoint, creating one for this
   * review if there is not one yet.
   *
   * One checkpoint per review rather than per file: the user reverts a change,
   * not a write, and a restore list littered with one entry per file would bury
   * the entry they actually want.
   */
  private async snapshot(path: string, baseline: Baseline): Promise<void> {
    const file = { path, content: baseline.content };
    if (this.checkpointId === null) {
      const created = await this.checkpoints.create({
        label: `Before TARS edited ${path}`,
        sessionId: this.sessionId,
        eventOffset: this.eventCount,
        files: [file],
      });
      this.checkpointId = created.id;
      return;
    }
    await this.checkpoints.addFiles(this.checkpointId, [file]);
  }

  private async baselineFor(path: string): Promise<Baseline> {
    const cached = this.baselines.get(path);
    if (cached !== undefined) {
      return cached;
    }
    const absolute = this.deps.resolve(path).fsPath;
    const stat = await this.deps.ports.fileSystem.stat(absolute);
    const baseline: Baseline = {
      content: stat === null ? null : await this.deps.ports.fileSystem.readTextFile(absolute),
    };
    this.baselines.set(path, baseline);
    return baseline;
  }

  private publish(): void {
    const set = this.builder.build();
    this.changes = set.changes;
    this.deps.post({
      type: 'change_set',
      changes: set.changes.map(summarise),
      added: set.stats.added,
      removed: set.stats.removed,
    });
  }

  /** Named, not swallowed: the user must know which files are still as the agent left them. */
  private warnUnrecoverable(unrecoverable: readonly string[], restored: number): void {
    if (unrecoverable.length === 0) {
      return;
    }
    void vscode.window.showWarningMessage(
      `TARS restored ${String(restored)} file(s). Could not recover: ${unrecoverable.join(', ')}`,
    );
  }

  private fail(what: string, error: unknown): void {
    const detail = error instanceof Error ? error.message : String(error);
    this.log.log('error', what, { error: detail });
    this.deps.post({ type: 'host_error', message: `${what}: ${detail}` });
  }
}

function summarise(change: FileChange): PendingChangeSummary {
  return {
    path: change.path,
    kind: change.kind,
    added: change.stats.added,
    removed: change.stats.removed,
    stale: change.stale,
  };
}
