export { EMPTY_CONTENT_HASH, hashContent, isContentHash } from './content-hash.js';
export { ChangeSetBuilder, buildChangeSet, proposalFromEvent } from './change-set.js';
export type {
  Baseline,
  ChangeSet,
  FileChange,
  FileChangeKind,
  FileEditProposal,
} from './change-set.js';
export { diffLines, diffStats, splitLines, toHunks, toUnifiedDiff } from './line-diff.js';
export type { DiffHunk, DiffOp, DiffOpKind, DiffOptions, DiffStats } from './line-diff.js';
