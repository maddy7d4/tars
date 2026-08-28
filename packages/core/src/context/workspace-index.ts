import type { ContextItem } from '@tars/shared';
import type {
  DiagnosticsPort,
  FileSystemPort,
  FileWatcherPort,
  GitPort,
  LoggerPort,
  Unsubscribe,
  WatchedFileChange,
  WorkspacePort,
} from '../ports/index.js';
import { FileIndex, type IndexedFile } from './file-index.js';
import { GIT_ALIASES, resolveGitMention } from './git-context.js';
import {
  parseMentions,
  resolveMentions,
  stripMentions,
  type Mention,
  type ResolvedContext,
} from './mention.js';

/**
 * The live context engine (Docs/TARS_SPEC.md §7.2).
 *
 * Owns a `FileIndex`, keeps it current from the watcher, and turns prompt text
 * into typed context items. Everything here is over ports, so the whole engine
 * runs in tests against in-memory fakes — which matters because the failure mode
 * worth catching is a stale index, and staleness is only observable over time.
 *
 * The initial walk is deferred rather than done at construction: it is the most
 * expensive thing TARS does at startup, and a window where the user never opens
 * the panel should not pay for it.
 */

export interface WorkspaceIndexDeps {
  readonly fileSystem: FileSystemPort;
  readonly workspace: WorkspacePort;
  readonly diagnostics: DiagnosticsPort;
  readonly fileWatcher: FileWatcherPort;
  readonly git: GitPort;
  readonly logger: LoggerPort;
  readonly maxFiles?: number;
  readonly maxDepth?: number;
}

/**
 * Files whose change invalidates the *rules*, not just the file list.
 *
 * A new `.gitignore`, or an edit to one, can hide or reveal whole subtrees, and
 * no incremental update can express that — so it forces a rebuild.
 */
const IGNORE_FILENAME = '.gitignore';

/** How long to wait for a burst to settle before rebuilding. */
const REBUILD_DEBOUNCE_MS = 500;

export class WorkspaceIndex {
  private readonly index: FileIndex;
  private readonly log: LoggerPort;
  private unwatch: Unsubscribe | null = null;
  private ready: Promise<void> | null = null;
  private rebuildTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly deps: WorkspaceIndexDeps) {
    this.log = deps.logger.child('workspace-index');
    this.index = new FileIndex({
      fileSystem: deps.fileSystem,
      logger: deps.logger,
      ...(deps.maxFiles === undefined ? {} : { maxFiles: deps.maxFiles }),
      ...(deps.maxDepth === undefined ? {} : { maxDepth: deps.maxDepth }),
    });
  }

  get size(): number {
    return this.index.size;
  }

  get isTruncated(): boolean {
    return this.index.isTruncated;
  }

  /**
   * Builds the index and starts watching. Idempotent — later calls await the
   * first, so several callers can each "ensure" it without racing a second walk.
   */
  start(): Promise<void> {
    this.ready ??= this.build();
    return this.ready;
  }

  /** Ranked completions for an `@`-mention prefix. */
  async search(query: string, limit = 20): Promise<readonly IndexedFile[]> {
    await this.start();
    return this.index.search(query, limit);
  }

  /**
   * Turns a prompt into the text to send and the context to attach.
   *
   * Both halves are returned together because they are one decision: a mention
   * that resolved must leave the prose (it is carried structurally instead), and
   * one that did not must stay in it, or the user's sentence loses a word.
   */
  async resolve(text: string): Promise<{
    readonly text: string;
    readonly context: readonly ContextItem[];
    readonly unresolved: readonly string[];
  }> {
    await this.start();
    const mentions = parseMentions(text);
    if (mentions.length === 0) {
      return { text, context: [], unresolved: [] };
    }

    // Git aliases are resolved first and removed from what the file resolver
    // sees: `@diff` names repository state, and letting it fall through would
    // have it match a file that happens to be called `diff`.
    const gitItems: ContextItem[] = [];
    const gitQueries = new Set<string>();
    const remaining: Mention[] = [];
    for (const mention of mentions) {
      const alias = mention.query.toLowerCase();
      if (!GIT_ALIASES.includes(alias)) {
        remaining.push(mention);
        continue;
      }
      const item = await resolveGitMention(alias, {
        git: this.deps.git,
        logger: this.deps.logger,
      });
      if (item === null) {
        // Nothing to attach — no repository, no changes, detached HEAD. Reported
        // as unresolved so the user is told rather than sent an empty attachment.
        remaining.push(mention);
        continue;
      }
      gitItems.push(item);
      gitQueries.add(mention.query);
    }

    const resolved: ResolvedContext = resolveMentions(remaining, {
      index: this.index,
      selection: this.deps.workspace.activeSelection,
      diagnostics: this.deps.diagnostics.all(),
    });

    // Only the mentions that actually became context items are stripped. An
    // unresolved `@notafile.ts` stays in the prose, where the model can still
    // read it as the user's own words rather than losing it silently.
    const unresolvedSet = new Set(resolved.unresolved);
    const stripped = mentions.filter(
      (mention) => gitQueries.has(mention.query) || !unresolvedSet.has(mention.query),
    );

    return {
      text: stripMentions(text, stripped),
      context: [...gitItems, ...resolved.items],
      unresolved: resolved.unresolved,
    };
  }

  /** Stops watching and releases the index. */
  dispose(): void {
    if (this.rebuildTimer !== null) {
      clearTimeout(this.rebuildTimer);
      this.rebuildTimer = null;
    }
    this.unwatch?.();
    this.unwatch = null;
  }

  private async build(): Promise<void> {
    await this.index.build(this.deps.workspace.folders);
    // Watching starts only after the first walk. Starting earlier would apply
    // changes to an index still being built, and the walk would then overwrite them.
    this.unwatch ??= this.deps.fileWatcher.watch((change) => {
      this.apply(change);
    });
  }

  private apply(change: WatchedFileChange): void {
    const relative = change.relativePath;
    if (relative === null) {
      // Outside every workspace folder: nothing in the index can name it.
      return;
    }

    if (basename(relative) === IGNORE_FILENAME) {
      this.scheduleRebuild();
      return;
    }

    switch (change.kind) {
      case 'created':
        this.index.applyChange({ path: relative, absolutePath: change.absolutePath, kind: 'added' });
        return;
      case 'deleted':
        this.index.applyChange({
          path: relative,
          absolutePath: change.absolutePath,
          kind: 'removed',
        });
        return;
      case 'changed':
        // The index holds paths, not content, so an edit changes nothing about it.
        return;
      default:
        return;
    }
  }

  /**
   * Rebuilds after a burst settles.
   *
   * Debounced because the events that trigger it arrive in groups — a branch
   * switch rewrites `.gitignore` alongside everything else — and a full walk per
   * event would turn a checkout into a stall.
   */
  private scheduleRebuild(): void {
    if (this.rebuildTimer !== null) {
      clearTimeout(this.rebuildTimer);
    }
    this.rebuildTimer = setTimeout(() => {
      this.rebuildTimer = null;
      void this.index.build(this.deps.workspace.folders).catch((error: unknown) => {
        this.log.log('error', 'could not rebuild the file index', {
          error: error instanceof Error ? error.message : String(error),
        });
      });
    }, REBUILD_DEBOUNCE_MS);
  }
}

function basename(path: string): string {
  const at = path.lastIndexOf('/');
  return at === -1 ? path : path.slice(at + 1);
}
