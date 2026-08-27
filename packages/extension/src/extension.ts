import * as vscode from 'vscode';
import { createHostAdapters } from '@tars/host';
import { CHAT_VIEW_ID, ChatViewProvider } from './chat-view-provider.js';
import { TarsStatusBar } from './status-bar.js';

/**
 * Command ids, mirroring `contributes.commands` in package.json.
 *
 * `tars.openChat` is bound to `ctrl+alt+a` (`cmd+alt+a` on macOS) there. JSON takes
 * no comments, so the reasoning lives here: VS Code ships no default for that
 * chord on any platform, no major AI extension claims it (Copilot Chat takes
 * `ctrl+alt+i`, Continue `ctrl+L`), and neither GNOME nor Windows reserves it —
 * unlike `ctrl+alt+t`, the obvious mnemonic, which GNOME turns into a terminal.
 * `a` for agent. Users who disagree rebind it; a colliding default they cannot
 * discover is the failure worth avoiding.
 */
const OPEN_CHAT_COMMAND = 'tars.openChat';
const NEW_SESSION_COMMAND = 'tars.newSession';
const INTERRUPT_COMMAND = 'tars.interrupt';
const RESTORE_CHECKPOINT_COMMAND = 'tars.restoreCheckpoint';

/**
 * Releases the agent sessions. Module-level because `deactivate` has no handle on
 * anything `activate` built, and letting the window close while a `claude`
 * subprocess is still running is the one leak that outlives the extension host.
 */
let releaseSessions: (() => Promise<void>) | null = null;

/**
 * Composition root: the only place where host implementations are bound to core's
 * ports (Docs/TARS_SPEC.md §3). Nothing below this file knows how it was wired.
 */
export function activate(context: vscode.ExtensionContext): void {
  const ports = createHostAdapters(context);
  const logger = ports.logger.child('activate');

  const statusBar = new TarsStatusBar(OPEN_CHAT_COMMAND);
  const provider = new ChatViewProvider(context.extensionUri, ports, (busy) => {
    statusBar.setBusy(busy);
  });
  releaseSessions = () => provider.dispose();

  context.subscriptions.push(
    statusBar,
    // Disposal of the sessions is registered as well as awaited from `deactivate`:
    // subscriptions run on window close *and* on an extension host restart, and
    // `dispose` is idempotent so doing both costs nothing.
    new vscode.Disposable(() => {
      void provider.dispose();
    }),
    vscode.window.registerWebviewViewProvider(CHAT_VIEW_ID, provider, {
      // The agent conversation is expensive to rebuild, so the webview keeps its
      // DOM while the view is hidden instead of remounting on every reveal.
      webviewOptions: { retainContextWhenHidden: true },
    }),
    vscode.commands.registerCommand(OPEN_CHAT_COMMAND, () => {
      void provider.reveal();
    }),
    vscode.commands.registerCommand(NEW_SESSION_COMMAND, () => {
      void provider.newSession();
    }),
    vscode.commands.registerCommand(INTERRUPT_COMMAND, () => {
      provider.interrupt();
    }),
    // Reachable with the panel closed on purpose: the reason to reach for a
    // checkpoint is usually that the workspace looks wrong, not the chat.
    vscode.commands.registerCommand(RESTORE_CHECKPOINT_COMMAND, () => {
      void provider.restoreCheckpoint();
    }),
  );

  logger.log('info', 'TARS activated', {
    extensionId: context.extension.id,
    workspaceFolders: ports.workspace.folders.length,
  });
}

/**
 * Returns the promise so VS Code waits for the SDK subprocesses to be torn down.
 * Everything else is on `context.subscriptions`, which VS Code disposes for us.
 */
export function deactivate(): Promise<void> {
  const release = releaseSessions;
  releaseSessions = null;
  return release === null ? Promise.resolve() : release();
}
