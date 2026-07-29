import type * as vscode from 'vscode';
import type { StoragePort } from '@tars/core';
import type { JsonValue } from '@tars/shared';

export class VscodeStorage implements StoragePort {
  readonly globalStoragePath: string;
  readonly workspaceStoragePath: string | null;

  constructor(private readonly context: vscode.ExtensionContext) {
    this.globalStoragePath = context.globalStorageUri.fsPath;
    // `storageUri` is undefined when no folder is open — a state the editor allows.
    this.workspaceStoragePath = context.storageUri?.fsPath ?? null;
  }

  getWorkspaceState<T extends JsonValue>(key: string, defaultValue: T): T {
    return this.context.workspaceState.get<T>(key, defaultValue);
  }

  async setWorkspaceState(key: string, value: JsonValue): Promise<void> {
    await this.context.workspaceState.update(key, value);
  }

  getGlobalState<T extends JsonValue>(key: string, defaultValue: T): T {
    return this.context.globalState.get<T>(key, defaultValue);
  }

  async setGlobalState(key: string, value: JsonValue): Promise<void> {
    await this.context.globalState.update(key, value);
  }
}
