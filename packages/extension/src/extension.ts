import * as vscode from 'vscode';
import { createHostAdapters } from '@tars/host';
import { CHAT_VIEW_ID, ChatViewProvider } from './chat-view-provider.js';

/**
 * Composition root: the only place where host implementations are bound to core's
 * ports (Docs/TARS_SPEC.md §3). Nothing below this file knows how it was wired.
 */
export function activate(context: vscode.ExtensionContext): void {
  const ports = createHostAdapters(context);
  const logger = ports.logger.child('activate');

  const provider = new ChatViewProvider(context.extensionUri, ports);

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(CHAT_VIEW_ID, provider, {
      // The agent conversation is expensive to rebuild, so the webview keeps its
      // DOM while the view is hidden instead of remounting on every reveal.
      webviewOptions: { retainContextWhenHidden: true },
    }),
    vscode.commands.registerCommand('tars.openChat', () => {
      void provider.reveal();
    }),
  );

  logger.log('info', 'TARS activated', {
    extensionId: context.extension.id,
    workspaceFolders: ports.workspace.folders.length,
  });
}

/**
 * Every resource is registered on `context.subscriptions`, which VS Code disposes
 * for us; an empty body here is the correct implementation, not an omission.
 */
export function deactivate(): void {
  // Intentionally empty — see the note above.
}
