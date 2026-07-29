import * as vscode from 'vscode';
import type { DirectoryEntry, FileStat, FileSystemPort } from '@tars/core';

function toEntryType(type: vscode.FileType): DirectoryEntry['type'] {
  // FileType is a bitmask: a symlink to a file is File | SymbolicLink.
  if ((type & vscode.FileType.SymbolicLink) !== 0) {
    return 'symlink';
  }
  if ((type & vscode.FileType.Directory) !== 0) {
    return 'directory';
  }
  return 'file';
}

function isFileNotFound(error: unknown): boolean {
  return error instanceof vscode.FileSystemError && error.code === 'FileNotFound';
}

/**
 * `vscode.workspace.fs` rather than `node:fs`: it routes through the editor's
 * filesystem providers, so TARS keeps working in remote, WSL and virtual
 * workspaces where `node:fs` would silently address the wrong machine.
 */
export class VscodeFileSystem implements FileSystemPort {
  private readonly decoder = new TextDecoder();
  private readonly encoder = new TextEncoder();

  async readFile(path: string): Promise<Uint8Array> {
    return await vscode.workspace.fs.readFile(vscode.Uri.file(path));
  }

  async readTextFile(path: string): Promise<string> {
    return this.decoder.decode(await this.readFile(path));
  }

  async writeTextFile(path: string, content: string): Promise<void> {
    const uri = vscode.Uri.file(path);
    await vscode.workspace.fs.createDirectory(uri.with({ path: dirnameOf(uri.path) }));
    await vscode.workspace.fs.writeFile(uri, this.encoder.encode(content));
  }

  async appendTextFile(path: string, content: string): Promise<void> {
    let existing: Uint8Array = new Uint8Array(0);
    try {
      existing = await this.readFile(path);
    } catch (error: unknown) {
      if (!isFileNotFound(error)) {
        throw error;
      }
    }
    const addition = this.encoder.encode(content);
    const combined = new Uint8Array(existing.byteLength + addition.byteLength);
    combined.set(existing, 0);
    combined.set(addition, existing.byteLength);

    const uri = vscode.Uri.file(path);
    await vscode.workspace.fs.createDirectory(uri.with({ path: dirnameOf(uri.path) }));
    await vscode.workspace.fs.writeFile(uri, combined);
  }

  async stat(path: string): Promise<FileStat | null> {
    try {
      const stat = await vscode.workspace.fs.stat(vscode.Uri.file(path));
      return { type: toEntryType(stat.type), size: stat.size, mtime: stat.mtime };
    } catch (error: unknown) {
      if (isFileNotFound(error)) {
        return null;
      }
      throw error;
    }
  }

  async readDirectory(path: string): Promise<readonly DirectoryEntry[]> {
    const entries = await vscode.workspace.fs.readDirectory(vscode.Uri.file(path));
    return entries.map(([name, type]) => ({ name, type: toEntryType(type) }));
  }

  async createDirectory(path: string): Promise<void> {
    await vscode.workspace.fs.createDirectory(vscode.Uri.file(path));
  }

  async delete(path: string, options?: { readonly recursive: boolean }): Promise<void> {
    await vscode.workspace.fs.delete(vscode.Uri.file(path), {
      recursive: options?.recursive ?? false,
      // Agent-driven deletion is always reviewable through checkpoints, and the
      // trash is not available on every filesystem provider.
      useTrash: false,
    });
  }

  async rename(from: string, to: string, options?: { readonly overwrite: boolean }): Promise<void> {
    await vscode.workspace.fs.rename(vscode.Uri.file(from), vscode.Uri.file(to), {
      overwrite: options?.overwrite ?? false,
    });
  }
}

/** Uri paths are always `/`-separated regardless of platform, so this is safe. */
function dirnameOf(uriPath: string): string {
  const index = uriPath.lastIndexOf('/');
  return index <= 0 ? '/' : uriPath.slice(0, index);
}
