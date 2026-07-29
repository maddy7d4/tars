import * as vscode from 'vscode';
import type { ManagedTerminal, TerminalPort } from '@tars/core';

class VscodeManagedTerminal implements ManagedTerminal {
  constructor(
    private readonly terminal: vscode.Terminal,
    private readonly onDisposed: (self: VscodeManagedTerminal) => void,
  ) {}

  get name(): string {
    return this.terminal.name;
  }

  /** Identity check used to reconcile editor-initiated closes with our registry. */
  owns(candidate: vscode.Terminal): boolean {
    return candidate === this.terminal;
  }

  sendText(text: string, newline: boolean): void {
    this.terminal.sendText(text, newline);
  }

  show(preserveFocus: boolean): void {
    this.terminal.show(preserveFocus);
  }

  dispose(): void {
    this.terminal.dispose();
    this.onDisposed(this);
  }

  /** Called when the user closed the terminal, so no editor dispose is needed. */
  forget(): void {
    this.onDisposed(this);
  }
}

export class VscodeTerminals implements TerminalPort, vscode.Disposable {
  private readonly terminals: VscodeManagedTerminal[] = [];
  private readonly closeSubscription: vscode.Disposable;

  constructor() {
    // A user closing a terminal must not leave a dangling handle in `managed`.
    this.closeSubscription = vscode.window.onDidCloseTerminal((closed) => {
      this.terminals.find((managed) => managed.owns(closed))?.forget();
    });
  }

  create(options: { readonly name: string; readonly cwd?: string }): ManagedTerminal {
    const terminal = vscode.window.createTerminal(
      options.cwd === undefined ? { name: options.name } : { name: options.name, cwd: options.cwd },
    );
    const managed = new VscodeManagedTerminal(terminal, (self) => {
      const index = this.terminals.indexOf(self);
      if (index !== -1) {
        this.terminals.splice(index, 1);
      }
    });
    this.terminals.push(managed);
    return managed;
  }

  get managed(): readonly ManagedTerminal[] {
    return [...this.terminals];
  }

  dispose(): void {
    this.closeSubscription.dispose();
    for (const terminal of [...this.terminals]) {
      terminal.dispose();
    }
  }
}
