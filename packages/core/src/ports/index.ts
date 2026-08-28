export type { DirectoryEntry, FileStat, FileSystemPort } from './file-system-port.js';
export type {
  FileChangeKind,
  FileWatcherPort,
  WatchedFileChange,
} from './file-watcher-port.js';
export type {
  EditorSelection,
  OpenDocument,
  Unsubscribe,
  WorkspaceFolder,
  WorkspacePort,
} from './workspace-port.js';
export type { ManagedTerminal, TerminalPort } from './terminal-port.js';
export type { GitFileChange, GitPort, GitRepository } from './git-port.js';
export type { Diagnostic, DiagnosticsPort } from './diagnostics-port.js';
export type { SecretsPort } from './secrets-port.js';
export type { StoragePort } from './storage-port.js';
export type { ClockPort } from './clock-port.js';
export type { LoggerPort, LogLevel } from './logger-port.js';

import type { ClockPort } from './clock-port.js';
import type { DiagnosticsPort } from './diagnostics-port.js';
import type { FileSystemPort } from './file-system-port.js';
import type { FileWatcherPort } from './file-watcher-port.js';
import type { GitPort } from './git-port.js';
import type { LoggerPort } from './logger-port.js';
import type { SecretsPort } from './secrets-port.js';
import type { StoragePort } from './storage-port.js';
import type { TerminalPort } from './terminal-port.js';
import type { WorkspacePort } from './workspace-port.js';

/**
 * The complete set of capabilities core needs from its environment. Bundling them
 * into one record means `host` has a single object to satisfy and a test has a
 * single object to fake — and adding a port becomes a compile error at every
 * construction site rather than a silently missing dependency.
 */
export interface HostPorts {
  readonly fileSystem: FileSystemPort;
  readonly workspace: WorkspacePort;
  readonly terminal: TerminalPort;
  readonly git: GitPort;
  readonly diagnostics: DiagnosticsPort;
  readonly fileWatcher: FileWatcherPort;
  readonly secrets: SecretsPort;
  readonly storage: StoragePort;
  readonly clock: ClockPort;
  readonly logger: LoggerPort;
}
