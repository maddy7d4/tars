import { describe, expect, it } from 'vitest';
import { applyCompletion, mentionAtCaret } from './mention-input.js';

/**
 * Tests for the `@`-mention caret logic.
 *
 * Two failure modes matter and both are silent: a popup that opens when the user
 * is not writing a mention (typing an email address, editing a finished
 * sentence), and one that stays closed when they are. Everything below is one of
 * those two.
 */

describe('mentionAtCaret', () => {
  it('finds a mention being typed at the end', () => {
    expect(mentionAtCaret('open @src/ind', 13)).toEqual({
      query: 'src/ind',
      start: 5,
      end: 13,
    });
  });

  it('opens on a bare @ with nothing typed yet', () => {
    // The list is most useful the instant the user commits to a mention.
    expect(mentionAtCaret('open @', 6)).toEqual({ query: '', start: 5, end: 6 });
  });

  it('finds a mention at the very start of the prompt', () => {
    expect(mentionAtCaret('@a.ts', 5)).toEqual({ query: 'a.ts', start: 0, end: 5 });
  });

  it('finds a mention after an opening bracket', () => {
    expect(mentionAtCaret('see (@a.ts', 10)).toEqual({ query: 'a.ts', start: 5, end: 10 });
  });

  it('ignores an @ glued to a word, which is an email address', () => {
    expect(mentionAtCaret('mail me@example.com', 19)).toBeNull();
  });

  it('closes once a space is typed after the mention', () => {
    expect(mentionAtCaret('open @a.ts ', 11)).toBeNull();
  });

  it('stays closed while the caret is past a finished mention', () => {
    // Arrowing through a sentence must not reopen the list.
    expect(mentionAtCaret('open @a.ts and fix it', 21)).toBeNull();
  });

  it('reads only the text before the caret', () => {
    // The caret sits mid-mention; the rest is not part of what is being typed.
    expect(mentionAtCaret('open @src/index.ts', 10)).toEqual({
      query: 'src/',
      start: 5,
      end: 10,
    });
  });

  it('finds the mention on the current line of a multi-line prompt', () => {
    expect(mentionAtCaret('first line\n@a.ts', 16)).toEqual({
      query: 'a.ts',
      start: 11,
      end: 16,
    });
  });

  it('returns nothing for text with no mention', () => {
    expect(mentionAtCaret('fix the build', 13)).toBeNull();
  });

  it('returns nothing for an empty prompt', () => {
    expect(mentionAtCaret('', 0)).toBeNull();
  });

  it('clamps a caret outside the text rather than throwing', () => {
    expect(mentionAtCaret('@a', 99)).toEqual({ query: 'a', start: 0, end: 2 });
    expect(mentionAtCaret('@a', -5)).toBeNull();
  });
});

describe('applyCompletion', () => {
  it('replaces the typed prefix with the full path', () => {
    const mention = mentionAtCaret('open @ind', 9);
    expect(mention).not.toBeNull();

    expect(applyCompletion('open @ind', mention!, 'src/index.ts')).toEqual({
      text: 'open @src/index.ts ',
      caret: 19,
    });
  });

  it('keeps text that follows the mention', () => {
    const mention = mentionAtCaret('open @ind and stop', 9);
    expect(mention).not.toBeNull();

    expect(applyCompletion('open @ind and stop', mention!, 'src/index.ts').text).toBe(
      'open @src/index.ts  and stop',
    );
  });

  it('appends a space, which is what closes the popup', () => {
    const mention = mentionAtCaret('@a', 2);
    const result = applyCompletion('@a', mention!, 'a.ts');

    expect(result.text).toBe('@a.ts ');
    // The caret is now past a space, so no mention is active.
    expect(mentionAtCaret(result.text, result.caret)).toBeNull();
  });

  it('completes a bare @ into a full mention', () => {
    const mention = mentionAtCaret('@', 1);
    expect(applyCompletion('@', mention!, 'deep/nested/file.ts').text).toBe(
      '@deep/nested/file.ts ',
    );
  });
});
