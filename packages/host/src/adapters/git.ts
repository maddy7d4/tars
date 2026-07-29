import * as vscode from 'vscode';
import type { GitFileChange, GitPort, GitRepository } from '@tars/core';
import type { GitChange, GitExtensionApi, GitExtensionRepository } from './git-extension-api.js';
import { GitStatus, asGitExtensionExports } from './git-extension-api.js';

const GIT_EXTENSION_ID = 'vscode.git';

function toStatus(status: number): GitFileChange['status'] {
  switch (status) {
    case GitStatus.IndexAdded:
    case GitStatus.IntentToAdd:
    case GitStatus.BothAdded:
    case GitStatus.AddedByUs:
    case GitStatus.AddedByThem:
      return 'added';
    case GitStatus.IndexDeleted:
    case GitStatus.Deleted:
    case GitStatus.BothDeleted:
    case GitStatus.DeletedByUs:
    case GitStatus.DeletedByThem:
      return 'deleted';
    case GitStatus.IndexRenamed:
    case GitStatus.IndexCopied:
    case GitStatus.IntentToRename:
      return 'renamed';
    case GitStatus.Untracked:
    case GitStatus.Ignored:
      return 'untracked';
    case GitStatus.BothModified:
      return 'conflicted';
    default:
      return 'modified';
  }
}

function toChange(change: GitChange): GitFileChange {
  return { path: change.uri.fsPath, status: toStatus(change.status) };
}

function toRepository(repository: GitExtensionRepository): GitRepository {
  const { state } = repository;
  return {
    rootPath: repository.rootUri.fsPath,
    currentBranch: state.HEAD?.name ?? null,
    changes: [
      ...state.workingTreeChanges.map(toChange),
      ...state.indexChanges.map(toChange),
      // Conflicts are the actionable case for an agent, so they are not deduplicated away.
      ...state.mergeChanges.map(toChange),
    ],
  };
}

/**
 * Read-only git access through the built-in extension. The extension is resolved
 * lazily on first use rather than at activation: it activates asynchronously, and
 * TARS activates on view reveal, so it may not be ready yet — and TARS must still
 * function in a workspace with git disabled.
 */
export class VscodeGit implements GitPort {
  private api: GitExtensionApi | null = null;

  private async resolveApi(): Promise<GitExtensionApi | null> {
    if (this.api !== null) {
      return this.api;
    }
    const extension = vscode.extensions.getExtension(GIT_EXTENSION_ID);
    if (extension === undefined) {
      return null;
    }
    const exports = asGitExtensionExports(
      extension.isActive ? extension.exports : await extension.activate(),
    );
    if (exports === null || !exports.enabled) {
      return null;
    }
    this.api = exports.getAPI(1);
    return this.api;
  }

  async repositories(): Promise<readonly GitRepository[]> {
    const api = await this.resolveApi();
    return api === null ? [] : api.repositories.map(toRepository);
  }

  async repositoryFor(path: string): Promise<GitRepository | null> {
    const api = await this.resolveApi();
    if (api === null) {
      return null;
    }
    const repository = api.getRepository(vscode.Uri.file(path));
    return repository === null ? null : toRepository(repository);
  }

  async showFileAtRef(path: string, ref: string): Promise<string | null> {
    const api = await this.resolveApi();
    if (api === null) {
      return null;
    }
    const repository = api.getRepository(vscode.Uri.file(path));
    if (repository === null) {
      return null;
    }
    try {
      return await repository.show(ref, path);
    } catch {
      // git exits non-zero when the path does not exist at that ref; that is an
      // answer, not a failure.
      return null;
    }
  }
}
