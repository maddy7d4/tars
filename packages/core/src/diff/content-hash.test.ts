import { describe, expect, it } from 'vitest';
import { EMPTY_CONTENT_HASH, hashContent, isContentHash } from './content-hash.js';

/**
 * The hash is an identifier, not an incidental digest: it keys the checkpoint blob
 * store and names the baseline an edit was computed against. So these assert the
 * *stability* of the output, against literals, rather than that the function is
 * self-consistent — a change of encoding or digest would keep every round-trip
 * test passing while orphaning every blob already on disk.
 */
describe('hashContent', () => {
  it('produces the published SHA-256 of a known input', () => {
    expect(hashContent('abc')).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
  });

  it('hashes the empty string to the declared constant', () => {
    expect(hashContent('')).toBe(EMPTY_CONTENT_HASH);
  });

  it('encodes as UTF-8, not UTF-16, so a non-ASCII file hashes portably', () => {
    // SHA-256 over the two UTF-8 bytes of U+00E9.
    expect(hashContent('é')).toBe(
      '4a99557e4033c3539de2eb65472017cad5f9557f7a0625a09f1c3f6e2ba69c4c',
    );
    // The UTF-16LE digest of the same character, asserted as a non-match: it is the
    // value the store would key on if the encoding were ever dropped or changed,
    // and every blob already written would silently become unreachable.
    expect(hashContent('é')).not.toBe(
      '63e3c807f93f669a2625f37ee673726c36ef3e99b6b7db02c910be25087e0f9c',
    );
  });

  it('separates content that differs only by trailing newline', () => {
    expect(hashContent('a')).not.toBe(hashContent('a\n'));
  });

  it('returns lowercase hex of a fixed width, which is what the store paths assume', () => {
    const hash = hashContent('anything');
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('isContentHash', () => {
  it('accepts what hashContent produces', () => {
    expect(isContentHash(hashContent('x'))).toBe(true);
    expect(isContentHash(EMPTY_CONTENT_HASH)).toBe(true);
  });

  it('rejects anything that could escape the blob directory', () => {
    // The point of the check: a corrupt record must never become a path.
    expect(isContentHash('../../etc/passwd')).toBe(false);
    expect(isContentHash('a/b')).toBe(false);
    expect(isContentHash('')).toBe(false);
  });

  it('rejects the right shape at the wrong length or case', () => {
    expect(isContentHash('a'.repeat(63))).toBe(false);
    expect(isContentHash('a'.repeat(65))).toBe(false);
    expect(isContentHash(EMPTY_CONTENT_HASH.toUpperCase())).toBe(false);
  });

  it('rejects a full-length string with a non-hex character', () => {
    expect(isContentHash(`g${'0'.repeat(63)}`)).toBe(false);
  });
});
