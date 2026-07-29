import { existsSync } from 'node:fs';
import * as vscode from 'vscode';
import type {
  EditorSelection,
  OpenDocument,
  Unsubscribe,
  WorkspaceFolder,
  WorkspacePort,
} from '@tars/core';

export class VscodeWorkspace implements WorkspacePort {
  get folders(): readonly WorkspaceFolder[] {
    return (vscode.workspace.workspaceFolders ?? []).map((folder) => ({
      name: folder.name,
      path: folder.uri.fsPath,
    }));
  }

  resolvePath(relativePath: string): string | null {
    const folders = vscode.workspace.workspaceFolders ?? [];
    // Multi-root workspaces make the same relative path ambiguous, so existence
    // on disk is the tiebreaker rather than "first folder wins".
    for (const folder of folders) {
      const candidate = vscode.Uri.joinPath(folder.uri, relativePath).fsPath;
      if (existsSync(candidate)) {
        return candidate;
      }
    }
    const first = folders[0];
    return first === undefined ? null : vscode.Uri.joinPath(first.uri, relativePath).fsPath;
  }

  relativePath(absolutePath: string): string | null {
    const relative = vscode.workspace.asRelativePath(vscode.Uri.file(absolutePath), false);
    // asRelativePath echoes the input when the path is outside every folder.
    return relative === absolutePath ? null : relative;
  }

  getConfiguration<T>(section: string, defaultValue: T): T {
    return vscode.workspace.getConfiguration().get<T>(section, defaultValue);
  }

  onConfigurationChanged(listener: (section: string) => void): Unsubscribe {
    const subscription = vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration('tars')) {
        listener('tars');
      }
    });
    return () => {
      subscription.dispose();
    };
  }

  get openDocuments(): readonly OpenDocument[] {
    return vscode.workspace.textDocuments
      .filter((document) => document.uri.scheme === 'file')
      .map((document) => ({
        path: document.uri.fsPath,
        languageId: document.languageId,
        isDirty: document.isDirty,
      }));
  }

  get activeSelection(): EditorSelection | null {
    const editor = vscode.window.activeTextEditor;
    if (editor === undefined || editor.selection.isEmpty) {
      return null;
    }
    const { start, end } = editor.selection;
    return {
      path: editor.document.uri.fsPath,
      startLine: start.line + 1,
      endLine: end.line + 1,
      text: editor.document.getText(editor.selection),
    };
  }
}
