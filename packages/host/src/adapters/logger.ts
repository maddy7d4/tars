import type * as vscode from 'vscode';
import type { LoggerPort, LogLevel } from '@tars/core';

function formatFields(fields: Readonly<Record<string, unknown>>): string {
  const parts = Object.entries(fields).map(([key, value]) => {
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
      return `${key}=${String(value)}`;
    }
    if (value instanceof Error) {
      return `${key}=${value.name}: ${value.message}`;
    }
    return `${key}=${JSON.stringify(value) ?? 'undefined'}`;
  });
  return parts.length === 0 ? '' : ` ${parts.join(' ')}`;
}

/**
 * Writes to a plain `OutputChannel` rather than a `LogOutputChannel`. The latter
 * owns its own level filtering and timestamps, which differ across VS Code forks;
 * a plain channel produces byte-identical output everywhere TARS runs
 * (Docs/TARS_SPEC.md §8.4).
 */
export class OutputChannelLogger implements LoggerPort {
  constructor(
    private readonly channel: vscode.OutputChannel,
    private readonly scope: string = 'tars',
  ) {}

  log(level: LogLevel, message: string, fields?: Readonly<Record<string, unknown>>): void {
    const timestamp = new Date().toISOString();
    const suffix = fields === undefined ? '' : formatFields(fields);
    this.channel.appendLine(
      `${timestamp} ${level.toUpperCase().padEnd(5)} [${this.scope}] ${message}${suffix}`,
    );
  }

  child(name: string): LoggerPort {
    return new OutputChannelLogger(this.channel, `${this.scope}.${name}`);
  }
}
