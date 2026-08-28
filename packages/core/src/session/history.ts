import type { SessionId } from '@tars/shared';
import { toSessionId } from '@tars/shared';
import type { ClockPort, FileSystemPort, LoggerPort, StoragePort } from '../ports/index.js';
import { SessionEventLog } from './event-log.js';

/**
 * Conversation history (Docs/TARS_SPEC.md §4.4).
 *
 * The session log is already the durable record of every conversation (ADR
 * 0006), so history needs no second store: listing past conversations is
 * listing that directory, and resuming one is replaying its log. Adding an index
 * alongside it would create two sources of truth that can disagree — and the
 * one that disagreed would be the index, silently, after a crash.
 *
 * Summaries are derived by reading the head of each log rather than stored,
 * because a stored summary would be written at a moment when the conversation
 * had not happened yet.
 */

const SESSIONS_DIRNAME = 'sessions';
const LOG_SUFFIX = '.jsonl';

/** How much of a log to read when deriving its title. */
const HEAD_EVENT_LIMIT = 40;

/** Long enough to recognise a conversation, short enough for a quick-pick row. */
const TITLE_BUDGET = 80;

export interface ConversationSummary {
  readonly sessionId: SessionId;
  /** First line of the conversation's first assistant reply, or a fallback. */
  readonly title: string;
  /** Epoch millis of the first event, i.e. when the conversation began. */
  readonly startedAt: number;
  /**
   * Epoch millis of the log file's last write, i.e. when the conversation was
   * last active.
   *
   * Taken from the filesystem rather than from an event, because only the head
   * of the log is read: a conversation longer than the head limit would
   * otherwise report its *start* as its last activity, and a week-old
   * conversation resumed today would sort as though it had never been touched.
   */
  readonly updatedAt: number;
  readonly eventCount: number;
}

export interface ConversationHistoryDeps {
  readonly fileSystem: FileSystemPort;
  readonly storage: StoragePort;
  readonly clock: ClockPort;
  readonly logger: LoggerPort;
}

export class ConversationHistory {
  private readonly log: LoggerPort;

  constructor(private readonly deps: ConversationHistoryDeps) {
    this.log = deps.logger.child('history');
  }

  /**
   * Past conversations, most recently updated first.
   *
   * A log that cannot be read is skipped rather than failing the listing: one
   * damaged file must not cost the user access to every other conversation.
   */
  async list(limit = 50): Promise<readonly ConversationSummary[]> {
    const directory = `${this.deps.storage.globalStoragePath}/${SESSIONS_DIRNAME}`;

    let entries: readonly { readonly name: string; readonly type: string }[];
    try {
      entries = await this.deps.fileSystem.readDirectory(directory);
    } catch {
      // No directory yet means no conversations, which is not a failure.
      return [];
    }

    const summaries: ConversationSummary[] = [];
    for (const entry of entries) {
      if (entry.type !== 'file' || !entry.name.endsWith(LOG_SUFFIX)) {
        continue;
      }
      const sessionId = toSessionId(entry.name.slice(0, -LOG_SUFFIX.length));
      const stat = await this.deps.fileSystem.stat(`${directory}/${entry.name}`);
      if (stat === null) {
        // Deleted between listing the directory and reading it.
        continue;
      }
      const summary = await this.summarise(sessionId, stat.mtime);
      if (summary !== null) {
        summaries.push(summary);
      }
    }

    summaries.sort((a, b) => b.updatedAt - a.updatedAt);
    return summaries.slice(0, limit);
  }

  /** Removes one conversation's log. Returns whether anything was deleted. */
  async forget(sessionId: SessionId): Promise<boolean> {
    const path = `${this.deps.storage.globalStoragePath}/${SESSIONS_DIRNAME}/${sessionId}${LOG_SUFFIX}`;
    if ((await this.deps.fileSystem.stat(path)) === null) {
      return false;
    }
    try {
      await this.deps.fileSystem.delete(path);
      return true;
    } catch (error: unknown) {
      this.log.log('error', 'could not delete a conversation log', {
        sessionId,
        error: error instanceof Error ? error.message : String(error),
      });
      return false;
    }
  }

  /**
   * Derives a summary by reading the head of a log.
   *
   * Only the head: a long conversation's log can be large, and the title comes
   * from its opening either way. That is exactly why `updatedAt` comes from the
   * caller as the file's mtime — an event timestamp here would describe where
   * reading stopped, not when the conversation was last active.
   */
  private async summarise(
    sessionId: SessionId,
    updatedAt: number,
  ): Promise<ConversationSummary | null> {
    const log = new SessionEventLog(
      {
        fileSystem: this.deps.fileSystem,
        storage: this.deps.storage,
        clock: this.deps.clock,
        logger: this.deps.logger,
      },
      sessionId,
    );

    let startedAt: number | null = null;
    let count = 0;
    let title = '';

    try {
      for await (const record of log.replay()) {
        count += 1;
        startedAt ??= record.event.at;

        // The first prose the agent produced makes a far better label than the
        // session id, and unlike the user's prompt it is always in the log —
        // user messages are echoed locally and never recorded as events.
        if (title === '' && record.event.type === 'text_delta') {
          title = firstLine(record.event.text);
        }
        if (count >= HEAD_EVENT_LIMIT && title !== '') {
          break;
        }
        if (count >= HEAD_EVENT_LIMIT * 4) {
          // A long preamble of tool calls with no prose: stop rather than read
          // the whole log for a title we are not going to find.
          break;
        }
      }
    } catch (error: unknown) {
      this.log.log('warn', 'skipping an unreadable conversation log', {
        sessionId,
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }

    if (count === 0 || startedAt === null) {
      // An empty log is a session that was opened and never used. Listing it
      // would offer the user a conversation with nothing in it.
      return null;
    }

    return {
      sessionId,
      title: title === '' ? 'Untitled conversation' : title,
      startedAt,
      updatedAt,
      eventCount: count,
    };
  }
}

function firstLine(text: string): string {
  const line = text.split('\n').find((candidate) => candidate.trim() !== '') ?? '';
  const trimmed = line.trim();
  return trimmed.length > TITLE_BUDGET ? `${trimmed.slice(0, TITLE_BUDGET)}…` : trimmed;
}
