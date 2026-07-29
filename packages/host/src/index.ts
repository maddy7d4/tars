import * as vscode from 'vscode';
import type { HostPorts } from '@tars/core';
import { SystemClock } from './adapters/clock.js';
import { VscodeDiagnostics } from './adapters/diagnostics.js';
import { VscodeFileSystem } from './adapters/file-system.js';
import { VscodeGit } from './adapters/git.js';
import { OutputChannelLogger } from './adapters/logger.js';
import { VscodeSecrets } from './adapters/secrets.js';
import { VscodeStorage } from './adapters/storage.js';
import { VscodeTerminals } from './adapters/terminal.js';
import { VscodeWorkspace } from './adapters/workspace.js';

const OUTPUT_CHANNEL_NAME = 'TARS';

/**
 * The one place `vscode` is bound to core's ports (Docs/TARS_SPEC.md §3.1).
 *
 * Disposables are registered on `context.subscriptions` here rather than returned
 * to the caller, so no call site can forget to release the output channel or the
 * terminal listener.
 */
export function createHostAdapters(context: vscode.ExtensionContext): HostPorts {
  const channel = vscode.window.createOutputChannel(OUTPUT_CHANNEL_NAME);
  const terminals = new VscodeTerminals();
  context.subscriptions.push(channel, terminals);

  return {
    fileSystem: new VscodeFileSystem(),
    workspace: new VscodeWorkspace(),
    terminal: terminals,
    git: new VscodeGit(),
    diagnostics: new VscodeDiagnostics(),
    secrets: new VscodeSecrets(context.secrets),
    storage: new VscodeStorage(context),
    clock: new SystemClock(),
    logger: new OutputChannelLogger(channel),
  };
}

export { SystemClock } from './adapters/clock.js';
export { VscodeDiagnostics } from './adapters/diagnostics.js';
export { VscodeFileSystem } from './adapters/file-system.js';
export { VscodeGit } from './adapters/git.js';
export { OutputChannelLogger } from './adapters/logger.js';
export { VscodeSecrets } from './adapters/secrets.js';
export { VscodeStorage } from './adapters/storage.js';
export { VscodeTerminals } from './adapters/terminal.js';
export { VscodeWorkspace } from './adapters/workspace.js';
