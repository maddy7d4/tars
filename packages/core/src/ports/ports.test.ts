import { describe, expect, it } from 'vitest';
import type { ClockPort } from './clock-port.js';
import type { FileSystemPort, FileStat } from './file-system-port.js';
import type { LoggerPort, LogLevel } from './logger-port.js';

/**
 * An in-memory `FileSystemPort` — the test double named in Docs/TARS_SPEC.md §3.2.
 * The `implements` clause is the assertion that matters: if a method is added to
 * the interface, this file stops compiling, so `pnpm typecheck` catches the drift
 * before any test runs.
 */
class MemoryFileSystem implements FileSystemPort {
  private readonly files = new Map<string, string>();
  private readonly directories = new Set<string>();

  readFile(path: string): Promise<Uint8Array> {
    return this.readTextFile(path).then((text) => new TextEncoder().encode(text));
  }

  readTextFile(path: string): Promise<string> {
    const content = this.files.get(path);
    if (content === undefined) {
      return Promise.reject(new Error(`ENOENT: ${path}`));
    }
    return Promise.resolve(content);
  }

  writeTextFile(path: string, content: string): Promise<void> {
    this.files.set(path, content);
    return Promise.resolve();
  }

  appendTextFile(path: string, content: string): Promise<void> {
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

  readDirectory(path: string): Promise<readonly { name: string; type: 'file' }[]> {
    const prefix = path.endsWith('/') ? path : `${path}/`;
    const entries = [...this.files.keys()]
      .filter((candidate) => candidate.startsWith(prefix))
      .map((candidate) => ({ name: candidate.slice(prefix.length), type: 'file' as const }));
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
}

/** The deterministic counter from Docs/TARS_SPEC.md §3.2. */
class CountingClock implements ClockPort {
  private current: number;

  constructor(start: number) {
    this.current = start;
  }

  now(): number {
    this.current += 1;
    return this.current;
  }

  nowIso(): string {
    return new Date(this.now()).toISOString();
  }

  sleep(ms: number): Promise<void> {
    this.current += ms;
    return Promise.resolve();
  }
}

/** The buffering logger from Docs/TARS_SPEC.md §3.2. */
class BufferLogger implements LoggerPort {
  constructor(
    // The buffer is shared with every child so one handle sees all scopes in order.
    readonly records: { level: LogLevel; message: string; scope: string }[] = [],
    private readonly scope: string = 'root',
  ) {}

  log(level: LogLevel, message: string): void {
    this.records.push({ level, message, scope: this.scope });
  }

  child(name: string): LoggerPort {
    return new BufferLogger(this.records, `${this.scope}.${name}`);
  }
}

describe('ports', () => {
  it('accepts an in-memory FileSystemPort implementation', async () => {
    const fs: FileSystemPort = new MemoryFileSystem();

    const first = '{"type":"turn_end"}\n';
    const second = '{"type":"usage"}\n';

    await fs.writeTextFile('/w/session.jsonl', first);
    await fs.appendTextFile('/w/session.jsonl', second);

    expect(await fs.readTextFile('/w/session.jsonl')).toBe(first + second);
    expect(await fs.stat('/w/session.jsonl')).toEqual({
      type: 'file',
      size: first.length + second.length,
      mtime: 0,
    });
    expect(await fs.stat('/w/missing.jsonl')).toBeNull();
  });

  it('accepts a deterministic ClockPort implementation', async () => {
    const clock: ClockPort = new CountingClock(1_000);

    expect(clock.now()).toBe(1_001);
    await clock.sleep(500);
    expect(clock.now()).toBe(1_502);
  });

  it('accepts a buffering LoggerPort implementation', () => {
    const logger = new BufferLogger();

    logger.log('info', 'started');
    logger.child('provider').log('warn', 'sdk pre-1.0');

    expect(logger.records).toEqual([
      { level: 'info', message: 'started', scope: 'root' },
      { level: 'warn', message: 'sdk pre-1.0', scope: 'root.provider' },
    ]);
  });
});
