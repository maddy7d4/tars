import type { JsonValue } from '@tars/shared';

/**
 * Extension-owned storage locations and key/value state
 * (Docs/TARS_SPEC.md §3.2). Session logs, the content-addressed checkpoint store
 * and the file index all live under these directories.
 */
export interface StoragePort {
  /** Absolute path, stable across workspaces. Session logs and checkpoints live here. */
  readonly globalStoragePath: string;

  /**
   * Absolute path scoped to the current workspace, or `null` when no folder is
   * open — a real state VS Code allows, so callers must handle it rather than
   * assume a workspace exists.
   */
  readonly workspaceStoragePath: string | null;

  /** Workspace-scoped key/value state, e.g. the last active session id. */
  getWorkspaceState<T extends JsonValue>(key: string, defaultValue: T): T;

  setWorkspaceState(key: string, value: JsonValue): Promise<void>;

  /** Machine-scoped key/value state, e.g. per-tool permission decisions. */
  getGlobalState<T extends JsonValue>(key: string, defaultValue: T): T;

  setGlobalState(key: string, value: JsonValue): Promise<void>;
}
