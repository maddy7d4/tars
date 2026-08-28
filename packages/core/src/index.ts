export type {
  ClockPort,
  Diagnostic,
  DiagnosticsPort,
  DirectoryEntry,
  EditorSelection,
  FileChangeKind as WatchedFileChangeKind,
  FileWatcherPort,
  FileStat,
  FileSystemPort,
  GitFileChange,
  GitPort,
  GitRepository,
  HostPorts,
  LoggerPort,
  LogLevel,
  ManagedTerminal,
  OpenDocument,
  SecretsPort,
  StoragePort,
  TerminalPort,
  Unsubscribe,
  WatchedFileChange,
  WorkspaceFolder,
  WorkspacePort,
} from './ports/index.js';

export type {
  AgentProvider,
  AgentSession,
  PermissionDecision,
  ProviderCapabilities,
  SessionOptions,
} from './provider/types.js';

export { TurnGuard } from './provider/turn-guard.js';
export type { TurnEndReason, TurnGuardContext } from './provider/turn-guard.js';

// Only the concrete provider is exported, never an SDK type. That is what keeps the
// blast radius of an SDK breaking change inside provider/claude-code (ADR 0004).
export {
  ANTHROPIC_API_KEY_SECRET_KEY,
  CLAUDE_CODE_CAPABILITIES,
  CLAUDE_CODE_PROVIDER_ID,
  ClaudeCodeProvider,
  DEFAULT_ASK_TOOLS,
  resolveToolPolicy,
} from './provider/claude-code/index.js';
export type { ClaudeCodeProviderDeps } from './provider/claude-code/index.js';

export {
  SESSION_LOG_RECORD_VERSION,
  SessionEventLog,
  SessionManager,
  sessionLogPath,
} from './session/index.js';
export type {
  ManagedSession,
  RecoveryOutcome,
  SessionEventLogDeps,
  SessionLogRecord,
  SessionManagerDeps,
} from './session/index.js';

export {
  ChangeSetBuilder,
  EMPTY_CONTENT_HASH,
  acceptAll,
  acceptHunk,
  buildChangeSet,
  diffLines,
  diffStats,
  hashContent,
  isContentHash,
  proposalFromEvent,
  rejectAll,
  rejectHunk,
  splitLines,
  toHunks,
  toUnifiedDiff,
  viewHunks,
} from './diff/index.js';
export type {
  Baseline,
  ChangeSet,
  DiffHunk,
  DiffOp,
  DiffOpKind,
  DiffOptions,
  DiffStats,
  FileChange,
  FileChangeKind,
  FileEditProposal,
  HunkContext,
  HunkView,
} from './diff/index.js';

export { BlobStore, CHECKPOINT_FILE_VERSION, CheckpointStore } from './checkpoint/index.js';
export type {
  BlobStoreDeps,
  Checkpoint,
  CheckpointFile,
  CheckpointStoreDeps,
  RestoreResult,
  RestoredFile,
  SnapshotInput,
} from './checkpoint/index.js';

export { ALWAYS_IGNORED, FileIndex, GitignoreFile, IgnoreStack, WorkspaceIndex } from './context/index.js';
export { parseMentions, resolveMentions, stripMentions } from './context/index.js';
export type {
  FileIndexDeps,
  IndexedFile,
  Mention,
  ResolutionSources,
  ResolvedContext,
  WorkspaceIndexDeps,
} from './context/index.js';

export { MEMORY_FILE_VERSION, MemoryStore, memoryPath } from './memory/index.js';
export type {
  MemoryDraft,
  MemoryEntry,
  MemoryKind,
  MemoryQuery,
  MemoryStoreDeps,
} from './memory/index.js';
