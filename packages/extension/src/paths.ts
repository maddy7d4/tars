import * as path from 'node:path';
import * as vscode from 'vscode';

/**
 * Resolves a path that arrived from an agent event or the webview.
 *
 * Agent tool inputs carry absolute paths — the SDK runs with the workspace as
 * its cwd and its file tools report `file_path` absolutely — but a path that
 * reaches TARS from a model's prose, a persisted log, or a future tool may be
 * relative. Resolving both here rather than assuming one form is what keeps a
 * relative path from silently becoming a URI rooted at the filesystem root,
 * which is how an editor ends up offering to create `/src/index.ts`.
 *
 * Relative paths resolve against the first workspace folder, which is the one
 * VS Code itself treats as primary and the one the session's cwd is set to.
 */
export function resolveWorkspacePath(candidate: string): vscode.Uri {
  if (path.isAbsolute(candidate)) {
    return vscode.Uri.file(candidate);
  }
  const [folder] = vscode.workspace.workspaceFolders ?? [];
  if (folder === undefined) {
    // No workspace to resolve against. Treating it as absolute is wrong, but it
    // is at least a URI the editor will report as missing rather than one that
    // quietly points somewhere else.
    return vscode.Uri.file(candidate);
  }
  return vscode.Uri.joinPath(folder.uri, candidate);
}
