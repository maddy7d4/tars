import * as vscode from 'vscode';

/** Left of the language/problems cluster, but right of source control. */
const PRIORITY = 100;

/**
 * The one always-visible signal that TARS exists and whether it is working.
 *
 * The chat view can be hidden or in a collapsed container, so the panel cannot be
 * the only place a running turn is visible — a user who navigated away otherwise
 * has no way to tell an agent that is thinking from one that has stalled.
 */
export class TarsStatusBar implements vscode.Disposable {
  private readonly item: vscode.StatusBarItem;

  constructor(openChatCommand: string) {
    this.item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, PRIORITY);
    this.item.command = openChatCommand;
    this.setBusy(false);
    this.item.show();
  }

  setBusy(busy: boolean): void {
    // Codicons render in the status bar; the spinner is the affordance that reads
    // as "working" without needing a word for it.
    this.item.text = busy ? '$(sync~spin) TARS' : '$(robot) TARS';
    this.item.tooltip = busy
      ? 'TARS is working — click to open the chat'
      : 'TARS is idle — click to open the chat';
  }

  dispose(): void {
    this.item.dispose();
  }
}
