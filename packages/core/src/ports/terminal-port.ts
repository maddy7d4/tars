/** A terminal TARS created and therefore owns. */
export interface ManagedTerminal {
  readonly name: string;
  /** Sends text; `newline` false lets the caller compose a command incrementally. */
  sendText(text: string, newline: boolean): void;
  show(preserveFocus: boolean): void;
  dispose(): void;
}

/**
 * Terminal creation (Docs/TARS_SPEC.md §3.2). Deliberately write-only: VS Code's
 * stable API cannot read a terminal's buffer, so TARS never pretends to. Command
 * output the agent needs is captured by running it through the SDK's Bash tool,
 * which owns its own process and streams real output.
 */
export interface TerminalPort {
  create(options: { readonly name: string; readonly cwd?: string }): ManagedTerminal;

  /** Terminals created through this port, so a session can dispose only its own. */
  readonly managed: readonly ManagedTerminal[];
}
