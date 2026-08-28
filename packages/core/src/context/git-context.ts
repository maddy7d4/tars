import type { GitContextItem } from '@tars/shared';
import type { GitPort, GitRepository, LoggerPort } from '../ports/index.js';

/**
 * Repository state as attachable context (Docs/TARS_SPEC.md §7.2).
 *
 * `@diff` and `@branch` exist because "what have I changed so far" is the single
 * most common thing a user wants the agent to look at, and the alternative is
 * asking it to run `git diff` through Bash — which costs a permission prompt, a
 * subprocess, and a round trip to say something the editor already knows.
 *
 * Read-only, through `GitPort`. Mutating history stays the user's prerogative
 * and reaches git through the SDK's Bash tool, where the command is visible and
 * permission-gated.
 */

export const GIT_ALIASES: readonly string[] = ['diff', 'changes', 'branch', 'git'];

/**
 * Caps the diff attached to one turn.
 *
 * A large refactor's diff can exceed the context window on its own, and a turn
 * that fails because its attachment was too big is worse than one that says what
 * it truncated. The model still has `Bash` if it needs the rest.
 */
const MAX_DIFF_CHARS = 20_000;

export interface GitContextDeps {
  readonly git: GitPort;
  readonly logger: LoggerPort;
}

/**
 * Resolves a git alias to context, or `null` when there is nothing to attach.
 *
 * `null` rather than an empty item: a repository with no changes should report
 * the mention as unresolved, so the user is told rather than sending the model
 * an attachment that says nothing.
 */
export async function resolveGitMention(
  alias: string,
  deps: GitContextDeps,
): Promise<GitContextItem | null> {
  const repositories = await safely(deps, () => deps.git.repositories());
  const repository = repositories[0];
  if (repository === undefined) {
    return null;
  }

  return alias === 'branch' ? branchItem(repository) : changesItem(repository);
}

function branchItem(repository: GitRepository): GitContextItem | null {
  if (repository.currentBranch === null) {
    // Detached HEAD, or a repository with no commits yet.
    return null;
  }
  return { kind: 'git', label: 'branch', text: repository.currentBranch };
}

/**
 * The working tree as a status listing rather than a patch.
 *
 * `GitPort` is deliberately read-only and exposes no `diff` — so this reports
 * *which* files changed and how, and leaves reading them to the model's own
 * `Read` tool. That is the "curate, do not replace" principle of §7.1: TARS says
 * where to look, the agent decides what it needs.
 */
function changesItem(repository: GitRepository): GitContextItem | null {
  if (repository.changes.length === 0) {
    return null;
  }
  const lines = repository.changes.map((change) => `${change.status}\t${change.path}`);
  const text = lines.join('\n');

  return {
    kind: 'git',
    label: `working tree (${String(repository.changes.length)} file(s) on ${repository.currentBranch ?? 'detached HEAD'})`,
    text: text.length > MAX_DIFF_CHARS ? `${text.slice(0, MAX_DIFF_CHARS)}\n… truncated` : text,
  };
}

/**
 * The git extension may be absent, disabled, or still activating.
 *
 * None of those is worth failing a turn over — the mention simply does not
 * resolve, and the user is told that through the ordinary unresolved path.
 */
async function safely(
  deps: GitContextDeps,
  read: () => Promise<readonly GitRepository[]>,
): Promise<readonly GitRepository[]> {
  try {
    return await read();
  } catch (error: unknown) {
    deps.logger.child('git-context').log('debug', 'git unavailable', {
      error: error instanceof Error ? error.message : String(error),
    });
    return [];
  }
}
