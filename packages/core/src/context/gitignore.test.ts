import { describe, expect, it } from 'vitest';
import { GitignoreFile, IgnoreStack } from './gitignore.js';

/**
 * The walk is only as good as this matcher: a rule that fails to exclude
 * `node_modules` makes the index useless, and one that over-matches silently
 * hides the user's own source (Docs/TARS_SPEC.md §7.2).
 */

function root(content: string): GitignoreFile {
  return new GitignoreFile('', content);
}

describe('GitignoreFile', () => {
  it('ignores a bare name at any depth', () => {
    const file = root('node_modules');
    expect(file.match('node_modules', true)).toBe(true);
    expect(file.match('packages/core/node_modules', true)).toBe(true);
    expect(file.match('packages/core/node_modules/react/index.js', false)).toBe(true);
  });

  it('excludes the contents of an ignored directory', () => {
    const file = root('dist/');
    expect(file.match('dist', true)).toBe(true);
    expect(file.match('dist/bundle.js', false)).toBe(true);
  });

  it('applies a directory-only rule only to directories', () => {
    const file = root('build/');
    expect(file.match('build', true)).toBe(true);
    // A *file* named `build` is not covered by `build/`.
    expect(file.match('build', false)).toBeNull();
  });

  it('anchors a leading-slash pattern to the base directory', () => {
    const file = root('/dist');
    expect(file.match('dist', true)).toBe(true);
    expect(file.match('packages/dist', true)).toBeNull();
  });

  it('anchors a pattern containing a slash', () => {
    const file = root('src/generated');
    expect(file.match('src/generated', true)).toBe(true);
    expect(file.match('packages/src/generated', true)).toBeNull();
  });

  it('does not let a single star cross a path separator', () => {
    const file = root('src/*.ts');
    expect(file.match('src/index.ts', false)).toBe(true);
    expect(file.match('src/nested/index.ts', false)).toBeNull();
  });

  it('lets a double star cross separators', () => {
    const file = root('src/**/*.snap');
    expect(file.match('src/a/b/c.snap', false)).toBe(true);
  });

  it('matches zero directories for a/**/b', () => {
    const file = root('a/**/b');
    expect(file.match('a/b', false)).toBe(true);
    expect(file.match('a/x/y/b', false)).toBe(true);
  });

  it('honours ? as a single non-separator character', () => {
    const file = root('log?.txt');
    expect(file.match('log1.txt', false)).toBe(true);
    expect(file.match('log12.txt', false)).toBeNull();
  });

  it('lets a later negation re-include a file', () => {
    const file = root(['*.log', '!keep.log'].join('\n'));
    expect(file.match('debug.log', false)).toBe(true);
    expect(file.match('keep.log', false)).toBe(false);
  });

  it('gives the last matching rule the final say', () => {
    const file = root(['!keep.log', '*.log'].join('\n'));
    // Reversed order: the broad rule now wins.
    expect(file.match('keep.log', false)).toBe(true);
  });

  it('skips blank lines and comments', () => {
    const file = root(['', '# a comment', '   ', 'dist'].join('\n'));
    expect(file.match('dist', true)).toBe(true);
    expect(file.match('# a comment', false)).toBeNull();
  });

  it('treats an escaped hash as a literal name', () => {
    const file = root('\\#notacomment');
    expect(file.match('#notacomment', false)).toBe(true);
  });

  it('escapes regex metacharacters in literal names', () => {
    const file = root('file+v1.txt');
    expect(file.match('file+v1.txt', false)).toBe(true);
    // Would match if `+` were treated as a quantifier.
    expect(file.match('filee.txt', false)).toBeNull();
  });

  it('returns null for a path outside its base directory', () => {
    const nested = new GitignoreFile('packages/web', 'dist');
    expect(nested.match('packages/api/dist', true)).toBeNull();
    expect(nested.match('packages/web/dist', true)).toBe(true);
  });
});

describe('IgnoreStack', () => {
  it('has no opinion when empty', () => {
    expect(new IgnoreStack([]).isIgnored('src/index.ts', false)).toBe(false);
  });

  it('lets the deepest .gitignore override a shallower one', () => {
    const stack = new IgnoreStack([
      new GitignoreFile('', '*.log'),
      new GitignoreFile('packages/web', '!important.log'),
    ]);

    expect(stack.isIgnored('debug.log', false)).toBe(true);
    // The nested file re-includes it for its own subtree only.
    expect(stack.isIgnored('packages/web/important.log', false)).toBe(false);
    expect(stack.isIgnored('packages/api/important.log', false)).toBe(true);
  });

  it('falls through to a shallower file when the deeper one is silent', () => {
    const stack = new IgnoreStack([
      new GitignoreFile('', 'dist'),
      new GitignoreFile('packages/web', '*.tmp'),
    ]);
    expect(stack.isIgnored('packages/web/dist', true)).toBe(true);
  });

  it('with() returns a new stack and leaves the original untouched', () => {
    const base = new IgnoreStack([]);
    const extended = base.with(new GitignoreFile('', 'dist'));

    expect(base.isIgnored('dist', true)).toBe(false);
    expect(extended.isIgnored('dist', true)).toBe(true);
  });
});
