/**
 * Tracking the `@`-mention under the caret.
 *
 * Separate from the component because it is the part that is easy to get subtly
 * wrong and easy to test: the completion list must appear only while the caret
 * is genuinely inside a mention, and must not reappear once the user has moved
 * on. A component test could assert that, but only through the DOM, and far less
 * precisely than these can.
 *
 * The rules mirror `parseMentions` in core, so what the popup offers and what
 * the host later resolves cannot disagree: a mention starts the text or follows
 * whitespace or an opening bracket, which is what keeps `me@example.com` from
 * opening a file picker mid-sentence.
 */

export interface ActiveMention {
  /** Text between the `@` and the caret. Empty right after typing `@`. */
  readonly query: string;
  /** Offset of the `@`. */
  readonly start: number;
  /** Offset of the caret, i.e. one past the last character typed. */
  readonly end: number;
}

/** Characters that may precede a mention's `@`. */
const OPENERS = new Set([' ', '\t', '\n', '(', '[', '{']);

/**
 * Returns the mention the caret sits in, or `null`.
 *
 * Only text *before* the caret is considered. Scanning past it would make the
 * list flicker while the user arrow-keys through a finished sentence, and would
 * offer completions for a mention they are not editing.
 */
export function mentionAtCaret(text: string, caret: number): ActiveMention | null {
  const clamped = Math.min(Math.max(caret, 0), text.length);

  for (let i = clamped - 1; i >= 0; i -= 1) {
    const character = text[i];
    if (character === undefined) {
      return null;
    }
    // Whitespace ends the search: a mention cannot contain any, so a space
    // between here and the caret means the caret is not inside one.
    if (character === ' ' || character === '\t' || character === '\n') {
      return null;
    }
    if (character !== '@') {
      continue;
    }
    const preceding = i === 0 ? '' : (text[i - 1] ?? '');
    if (i !== 0 && !OPENERS.has(preceding)) {
      // An `@` glued to a word character is an email address, not a mention.
      return null;
    }
    return { query: text.slice(i + 1, clamped), start: i, end: clamped };
  }
  return null;
}

/**
 * Replaces the mention span with a chosen completion.
 *
 * A trailing space is appended so the user can keep typing without the next
 * word being absorbed into the mention they just completed — and it is what
 * closes the popup, since the caret is then no longer inside a mention.
 */
export function applyCompletion(
  text: string,
  mention: ActiveMention,
  insert: string,
): { readonly text: string; readonly caret: number } {
  const before = text.slice(0, mention.start);
  const after = text.slice(mention.end);
  const replacement = `@${insert} `;
  return {
    text: `${before}${replacement}${after}`,
    caret: before.length + replacement.length,
  };
}
