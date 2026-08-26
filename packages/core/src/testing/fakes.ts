import type { JsonValue } from '@tars/shared';
import type { ClockPort } from '../ports/clock-port.js';
import type { DirectoryEntry, FileStat, FileSystemPort } from '../ports/file-system-port.js';
import type { LoggerPort, LogLevel } from '../ports/logger-port.js';
import type { SecretsPort } from '../ports/secrets-port.js';
import type { StoragePort } from '../ports/storage-port.js';

/**
 * The test doubles named in Docs TARS_SPEC §3.2, in one place so every test in
 * `core` shares one definition of "fake port". The `implements` clauses are the
 * point: adding a method to a port breaks `pnpm typecheck` here before any test
 * runs, so the fakes cannot silently drift from the interfaces they stand in for.
 *
 * This module is intentionally absent from the package's public exports. It is
 * built because tests live inside the TypeScript program (see
 * `packages/core/tsconfig.json`), not because anything ships it.
 */

/**
 * A clock that moves only when told to.
 *
 * Deliberately *not* auto-incrementing on read: several events are stamped within
 * one logical instant (a `thinking_end` synthesized immediately before a
 * `turn_end`, for example), and a counter that ticks per read would make those
 * timestamps differ and turn "same instant" assertions into arithmetic.
 */
export class FakeClock implements ClockPort {
  constructor(private current = 1_700_000_000_000) {}

  now(): number {
    return this.current;
  }

  nowIso(): string {
    return new Date(this.current).toISOString();
  }

  /** Records every requested sleep and advances instantly. */
  readonly sleeps: number[] = [];

  sleep(ms: number): Promise<void> {
    this.sleeps.push(ms);
    this.current += ms;
    return Promise.resolve();
  }

  advance(ms: number): void {
    this.current += ms;
  }
}

/** In-memory `FileSystemPort`. Paths are treated as opaque `/`-separated keys. */
export class MemoryFileSystem implements FileSystemPort {
  readonly files = new Map<string, string>();
  readonly directories = new Set<string>();

  /** Set to make the next matching operation fail, for error-path tests. */
  failOn: { readonly operation: 'append' | 'write' | 'read'; readonly message: string } | null =
    null;

  async readFile(path: string): Promise<Uint8Array> {
    return new TextEncoder().encode(await this.readTextFile(path));
  }

  readTextFile(path: string): Promise<string> {
    this.maybeFail('read');
    const content = this.files.get(path);
    if (content === undefined) {
      return Promise.reject(new Error(`ENOENT: ${path}`));
    }
    return Promise.resolve(content);
  }

  writeTextFile(path: string, content: string): Promise<void> {
    this.maybeFail('write');
    this.files.set(path, content);
    return Promise.resolve();
  }

  appendTextFile(path: string, content: string): Promise<void> {
    this.maybeFail('append');
    this.files.set(path, (this.files.get(path) ?? '') + content);
    return Promise.resolve();
  }

  stat(path: string): Promise<FileStat | null> {
    const content = this.files.get(path);
    if (content !== undefined) {
      return Promise.resolve({ type: 'file', size: content.length, mtime: 0 });
    }
    if (this.directories.has(path)) {
      return Promise.resolve({ type: 'directory', size: 0, mtime: 0 });
    }
    return Promise.resolve(null);
  }

  readDirectory(path: string): Promise<readonly DirectoryEntry[]> {
    const prefix = path.endsWith('/') ? path : `${path}/`;
    const entries: DirectoryEntry[] = [];
    for (const key of this.files.keys()) {
      if (key.startsWith(prefix) && !key.slice(prefix.length).includes('/')) {
        entries.push({ name: key.slice(prefix.length), type: 'file' });
      }
    }
    return Promise.resolve(entries);
  }

  createDirectory(path: string): Promise<void> {
    this.directories.add(path);
    return Promise.resolve();
  }

  delete(path: string): Promise<void> {
    this.files.delete(path);
    this.directories.delete(path);
    return Promise.resolve();
  }

  rename(from: string, to: string): Promise<void> {
    const content = this.files.get(from);
    if (content === undefined) {
      return Promise.reject(new Error(`ENOENT: ${from}`));
    }
    this.files.delete(from);
    this.files.set(to, content);
    return Promise.resolve();
  }

  private maybeFail(operation: 'append' | 'write' | 'read'): void {
    const failure = this.failOn;
    if (failure !== null && failure.operation === operation) {
      throw new Error(failure.message);
    }
  }
}

/** In-memory `StoragePort` over a fixed pair of storage roots. */
export class MemoryStorage implements StoragePort {
  private readonly workspaceState = new Map<string, JsonValue>();
  private readonly globalState = new Map<string, JsonValue>();

  constructor(
    readonly globalStoragePath = '/global',
    readonly workspaceStoragePath: string | null = '/workspace',
  ) {}

  getWorkspaceState<T extends JsonValue>(key: string, defaultValue: T): T {
    const stored = this.workspaceState.get(key);
    return stored === undefined ? defaultValue : (stored as T);
  }

  setWorkspaceState(key: string, value: JsonValue): Promise<void> {
    this.workspaceState.set(key, value);
    return Promise.resolve();
  }

  getGlobalState<T extends JsonValue>(key: string, defaultValue: T): T {
    const stored = this.globalState.get(key);
    return stored === undefined ? defaultValue : (stored as T);
  }

  setGlobalState(key: string, value: JsonValue): Promise<void> {
    this.globalState.set(key, value);
    return Promise.resolve();
  }
}

/** In-memory keychain. `failOnGet` exercises the locked-keychain degradation path. */
export class MemorySecrets implements SecretsPort {
  private readonly values = new Map<string, string>();
  failOnGet: Error | null = null;

  get(key: string): Promise<string | null> {
    if (this.failOnGet !== null) {
      return Promise.reject(this.failOnGet);
    }
    return Promise.resolve(this.values.get(key) ?? null);
  }

  store(key: string, value: string): Promise<void> {
    this.values.set(key, value);
    return Promise.resolve();
  }

  delete(key: string): Promise<void> {
    this.values.delete(key);
    return Promise.resolve();
  }
}

/** One log record captured by `BufferLogger`. */
export interface LogRecord {
  readonly level: LogLevel;
  readonly message: string;
  readonly scope: string;
  readonly fields: Readonly<Record<string, unknown>> | undefined;
}

/** Buffering `LoggerPort`. Children share the parent's buffer so order is global. */
export class BufferLogger implements LoggerPort {
  constructor(
    readonly records: LogRecord[] = [],
    private readonly scope = 'root',
  ) {}

  log(level: LogLevel, message: string, fields?: Readonly<Record<string, unknown>>): void {
    this.records.push({ level, message, scope: this.scope, fields });
  }

  child(name: string): LoggerPort {
    return new BufferLogger(this.records, `${this.scope}.${name}`);
  }

  /** Records at or above `level`, for asserting that a failure was reported. */
  at(level: LogLevel): readonly LogRecord[] {
    return this.records.filter((record) => record.level === level);
  }
}
