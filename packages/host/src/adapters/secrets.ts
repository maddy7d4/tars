import type * as vscode from 'vscode';
import type { SecretsPort } from '@tars/core';

/** Namespaced so TARS keys cannot collide with another extension's in the keychain. */
const KEY_PREFIX = 'tars.';

export class VscodeSecrets implements SecretsPort {
  constructor(private readonly secrets: vscode.SecretStorage) {}

  async get(key: string): Promise<string | null> {
    return (await this.secrets.get(KEY_PREFIX + key)) ?? null;
  }

  async store(key: string, value: string): Promise<void> {
    await this.secrets.store(KEY_PREFIX + key, value);
  }

  async delete(key: string): Promise<void> {
    await this.secrets.delete(KEY_PREFIX + key);
  }
}
