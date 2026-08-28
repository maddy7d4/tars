import * as vscode from 'vscode';
import type { HostPorts } from '@tars/core';
import { SystemClock } from './adapters/clock.js';
import { VscodeDiagnostics } from './adapters/diagnostics.js';
import { VscodeFileSystem } from './adapters/file-system.js';
import { VscodeFileWatcher } from './adapters/file-watcher.js';
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
    fileWatcher: new VscodeFileWatcher(),
    secrets: new VscodeSecrets(context.secrets),
    storage: new VscodeStorage(context),
    clock: new SystemClock(),
    logger: new OutputChannelLogger(channel),
  };
}

export { SystemClock } from './adapters/clock.js';
export { VscodeDiagnostics } from './adapters/diagnostics.js';
export { VscodeFileSystem } from './adapters/file-system.js';
export { VscodeFileWatcher } from './adapters/file-watcher.js';
export { VscodeGit } from './adapters/git.js';
export { OutputChannelLogger } from './adapters/logger.js';
export { VscodeSecrets } from './adapters/secrets.js';
export { VscodeStorage } from './adapters/storage.js';
export { VscodeTerminals } from './adapters/terminal.js';
export { VscodeWorkspace } from './adapters/workspace.js';

export { searchSymbols } from './context/index.js';
export type { SymbolMatch } from './context/index.js';

export {
  ACCEPT_FILE_COMMAND,
  ACCEPT_HUNK_COMMAND,
  ChangeApplier,
  DiffContentProvider,
  HunkLensProvider,
  InlineDiffController,
  OPEN_FULL_DIFF_COMMAND,
  REJECT_FILE_COMMAND,
  REJECT_HUNK_COMMAND,
  TARS_DIFF_SCHEME,
} from './review/index.js';
export type {
  ApplyOutcome,
  ChangeApplierDeps,
  InlineDiffControllerDeps,
  InlineDiffState,
} from './review/index.js';
