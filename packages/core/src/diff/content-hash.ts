import { createHash } from 'node:crypto';

/**
 * SHA-256 of UTF-8 content as lowercase hex.
 *
 * One helper rather than a `createHash` call per site because the hash is a
 * *name*, not an incidental digest: it keys the content-addressed checkpoint
 * store (Docs/TARS_SPEC.md §6.4) and identifies the baseline a proposed edit was
 * computed against (§6.1). Two call sites disagreeing about encoding or digest
 * format would silently break deduplication and staleness detection alike.
 */
export function hashContent(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex');
}

/**
 * SHA-256 of the empty string. Written out rather than computed at module load so
 * that a test comparing it against `hashContent('')` is a real check of the
 * digest, not a tautology — an empty file is a legitimate checkpoint blob and
 * must hash to something stable.
 */
export const EMPTY_CONTENT_HASH =
  'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';

/**
 * Whether a string is well-formed as a content hash.
 *
 * Used when reading persisted data: a checkpoint record recovered from a damaged
 * file, or a stray filename in the blob directory, must not be turned into a
 * filesystem path. Validating the shape keeps a corrupt record from addressing
 * anything outside the store.
 */
export function isContentHash(value: string): boolean {
  return /^[0-9a-f]{64}$/.test(value);
}
