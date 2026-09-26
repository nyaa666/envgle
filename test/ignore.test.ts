import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createIgnoreMatcher } from '../src/utils/ignore.js';

interface Case {
  readonly label: string;
  readonly patterns: readonly string[];
  readonly path: string;
  readonly isDirectory: boolean;
  readonly expected: 'ignored' | 'not-ignored';
}

const expectAll = (cases: readonly Case[]): void => {
  for (const entry of cases) {
    const matcher = createIgnoreMatcher(entry.patterns);
    assert.equal(
      matcher.test(entry.path, entry.isDirectory),
      entry.expected,
      `${entry.label}: [${entry.patterns.join(' ')}] vs ${entry.path} (dir=${String(entry.isDirectory)})`,
    );
  }
};

test('gitignore documentation examples', () => {
  expectAll([
    { label: 'a blank line matches no files', patterns: [''], path: 'a.txt', isDirectory: false, expected: 'not-ignored' },
    { label: 'a comment matches no files', patterns: ['# comment'], path: 'a.txt', isDirectory: false, expected: 'not-ignored' },
    { label: 'an escaped hash is a literal hash', patterns: ['\\#foo'], path: '#foo', isDirectory: false, expected: 'ignored' },
    { label: 'a leading slash anchors the pattern', patterns: ['/foo'], path: 'foo', isDirectory: false, expected: 'ignored' },
    { label: 'a leading slash anchors the pattern', patterns: ['/foo'], path: 'a/foo', isDirectory: false, expected: 'not-ignored' },
    { label: 'no slash matches at any level', patterns: ['foo'], path: 'a/b/foo', isDirectory: false, expected: 'ignored' },
    { label: 'no slash matches at any level', patterns: ['man'], path: 'doc/man', isDirectory: true, expected: 'ignored' },
    { label: 'a slash in the middle anchors the pattern', patterns: ['doc/frotz'], path: 'a/doc/frotz', isDirectory: true, expected: 'not-ignored' },
    { label: 'a slash in the middle anchors the pattern', patterns: ['doc/frotz'], path: 'doc/frotz/f.txt', isDirectory: false, expected: 'ignored' },
    { label: 'a trailing slash matches directories only', patterns: ['frotz/'], path: 'frotz', isDirectory: true, expected: 'ignored' },
    { label: 'a trailing slash matches directories only', patterns: ['frotz/'], path: 'frotz', isDirectory: false, expected: 'not-ignored' },
    { label: 'a trailing slash matches everything inside', patterns: ['frotz/'], path: 'a/frotz/b/c.txt', isDirectory: false, expected: 'ignored' },
    { label: 'a trailing slash matches everything inside', patterns: ['/frotz/'], path: 'a/frotz/b.txt', isDirectory: false, expected: 'not-ignored' },
    { label: 'a leading doublestar matches at any depth', patterns: ['**/foo'], path: 'foo', isDirectory: false, expected: 'ignored' },
    { label: 'a leading doublestar matches at any depth', patterns: ['**/foo'], path: 'a/b/c/foo', isDirectory: false, expected: 'ignored' },
    { label: 'a leading doublestar matches at any depth', patterns: ['**/foo'], path: 'a/b/c/foobar', isDirectory: false, expected: 'not-ignored' },
    { label: 'a middle doublestar matches zero directories', patterns: ['a/**/b'], path: 'a/b', isDirectory: true, expected: 'ignored' },
    { label: 'a middle doublestar matches one directory', patterns: ['a/**/b'], path: 'a/x/b', isDirectory: true, expected: 'ignored' },
    { label: 'a middle doublestar matches many directories', patterns: ['a/**/b'], path: 'a/x/y/z/b', isDirectory: true, expected: 'ignored' },
    { label: 'a middle doublestar does not match below', patterns: ['a/**/b'], path: 'z/a/b/c', isDirectory: true, expected: 'not-ignored' },
    { label: 'a matching directory prunes everything below it', patterns: ['a/**/b'], path: 'a/b/c', isDirectory: true, expected: 'ignored' },
    { label: 'a trailing doublestar matches everything inside', patterns: ['abc/**'], path: 'abc/x', isDirectory: false, expected: 'ignored' },
    { label: 'a trailing doublestar matches everything inside', patterns: ['abc/**'], path: 'abc/x/y/z.txt', isDirectory: false, expected: 'ignored' },
    { label: 'a trailing doublestar does not match the directory itself', patterns: ['abc/**'], path: 'abc', isDirectory: true, expected: 'not-ignored' },
    { label: 'a trailing doublestar does not match a sibling', patterns: ['abc/**'], path: 'abcd', isDirectory: false, expected: 'not-ignored' },
    { label: 'a lone doublestar matches everything', patterns: ['**'], path: 'a/b/c.txt', isDirectory: false, expected: 'ignored' },
    { label: 'a single star stops at a slash', patterns: ['a/*.c'], path: 'a/b.c', isDirectory: false, expected: 'ignored' },
    { label: 'a single star stops at a slash', patterns: ['a/*.c'], path: 'a/b/c.c', isDirectory: false, expected: 'not-ignored' },
    { label: 'a question mark is one character', patterns: ['a?.c'], path: 'ab.c', isDirectory: false, expected: 'ignored' },
    { label: 'a question mark is one character', patterns: ['a?.c'], path: 'a/b.c', isDirectory: false, expected: 'not-ignored' },
    { label: 'a question mark is one character', patterns: ['a?.c'], path: 'abc.c', isDirectory: false, expected: 'not-ignored' },
    { label: 'a character class', patterns: ['*.[oa]'], path: 'x.o', isDirectory: false, expected: 'ignored' },
    { label: 'a character class', patterns: ['*.[oa]'], path: 'a/b.a', isDirectory: false, expected: 'ignored' },
    { label: 'a character class', patterns: ['*.[oa]'], path: 'x.c', isDirectory: false, expected: 'not-ignored' },
    { label: 'a negated character class with !', patterns: ['*.[!oa]'], path: 'x.o', isDirectory: false, expected: 'not-ignored' },
    { label: 'a negated character class with !', patterns: ['*.[!oa]'], path: 'x.c', isDirectory: false, expected: 'ignored' },
    { label: 'a negated character class with ^', patterns: ['*.[^oa]'], path: 'x.o', isDirectory: false, expected: 'not-ignored' },
    { label: 'a character range', patterns: ['[a-c].txt'], path: 'b.txt', isDirectory: false, expected: 'ignored' },
    { label: 'a character range is case sensitive', patterns: ['[a-c].txt'], path: 'B.txt', isDirectory: false, expected: 'not-ignored' },
    { label: 'an escaped bang is a literal bang', patterns: ['\\!important!.txt'], path: '!important!.txt', isDirectory: false, expected: 'ignored' },
    { label: 'a directory rule ignores nested files', patterns: ['logs/'], path: 'a/b/logs/today/app.log', isDirectory: false, expected: 'ignored' },
    { label: 'a bare name ignores nested files', patterns: ['cache'], path: 'a/b/cache/x.txt', isDirectory: false, expected: 'ignored' },
  ]);
});

test('the last matching pattern wins', () => {
  const matcher = createIgnoreMatcher(['*.log', '!keep.log', 'keep.log', '!keep.log']);
  assert.equal(matcher.test('debug.log', false), 'ignored');
  assert.equal(matcher.test('keep.log', false), 'not-ignored');
  const reordered = createIgnoreMatcher(['!keep.log', '*.log']);
  assert.equal(reordered.test('keep.log', false), 'ignored');
  const reinclude = createIgnoreMatcher(['*.log', '!important.log']);
  assert.equal(reinclude.test('a/important.log', false), 'not-ignored');
  assert.equal(reinclude.test('a/other.log', false), 'ignored');
});

test('a negation cannot resurrect a pruned directory', () => {
  const matcher = createIgnoreMatcher(['node_modules/', '!node_modules/keep.txt']);
  assert.equal(matcher.test('node_modules/keep.txt', false), 'ignored');
  assert.equal(matcher.test('node_modules/dep/index.js', false), 'ignored');
  assert.equal(matcher.test('a/node_modules/keep.txt', false), 'ignored');
  const reopened = createIgnoreMatcher(['node_modules/', '!node_modules/', '!node_modules/keep.txt']);
  assert.equal(reopened.test('node_modules/keep.txt', false), 'not-ignored');
  const prunedAgain = createIgnoreMatcher(['node_modules/', '!node_modules/', 'node_modules/']);
  assert.equal(prunedAgain.test('node_modules/keep.txt', false), 'ignored');
  const fileRule = createIgnoreMatcher(['build/output.js', '!build/output.js', '!build/output.js']);
  assert.equal(fileRule.test('build/output.js', false), 'not-ignored');
});

test('comments, blank lines and escaped markers', () => {
  const matcher = createIgnoreMatcher(['', '   ', '# comment', '  # indented is a pattern', '#', '\\#real', 'node_modules']);
  assert.equal(matcher.test('a.txt', false), 'not-ignored');
  assert.equal(matcher.test('#real', false), 'ignored');
  assert.equal(matcher.test('node_modules', true), 'ignored');
  assert.equal(createIgnoreMatcher(['  # indented']).test('  # indented', false), 'ignored');
  assert.equal(createIgnoreMatcher(['\\# comment']).test('# comment', false), 'ignored');
});

test('an empty pattern list ignores nothing', () => {
  const matcher = createIgnoreMatcher([]);
  for (const path of ['', '.', 'a', 'a/b/c.txt', 'node_modules', '/', '//', 'a//b']) {
    assert.equal(matcher.test(path, false), 'not-ignored');
    assert.equal(matcher.test(path, true), 'not-ignored');
  }
});

test('odd input is normalised without throwing', () => {
  const matcher = createIgnoreMatcher(['a/b', '*.txt', '!keep.txt']);
  assert.equal(matcher.test('a\\b\\c.txt', false), 'ignored');
  assert.equal(matcher.test('a/b', false), 'ignored');
  assert.equal(matcher.test('a//b', false), 'ignored');
  assert.equal(matcher.test('./a/b', false), 'ignored');
  assert.equal(matcher.test('/a/b', false), 'ignored');
  assert.equal(matcher.test('a/b/', true), 'ignored');
  assert.equal(matcher.test('a/../b', false), 'not-ignored');
  assert.equal(matcher.test('..', false), 'not-ignored');
  assert.equal(matcher.test('../../etc/passwd', false), 'not-ignored');
  assert.equal(matcher.test('keep.txt', false), 'not-ignored');
  const windows = createIgnoreMatcher(['b/c.txt', 'c.txt']);
  assert.equal(windows.test('a\\b\\c.txt', false), 'ignored');
  const anchored = createIgnoreMatcher(['b/c.txt']);
  assert.equal(anchored.test('a\\b\\c.txt', false), 'not-ignored');
  const long = `${'a/'.repeat(4000)}file.txt`;
  assert.equal(matcher.test(long, false), 'ignored');
  assert.equal(createIgnoreMatcher(['*']).test(long, false), 'ignored');
});

test('trailing whitespace is stripped unless escaped', () => {
  assert.equal(createIgnoreMatcher(['build   ']).test('build', true), 'ignored');
  assert.equal(createIgnoreMatcher(['build\t']).test('build', true), 'ignored');
  assert.equal(createIgnoreMatcher(['build\\ ']).test('build', true), 'not-ignored');
  assert.equal(createIgnoreMatcher(['build\r\n']).test('build', true), 'ignored');
  assert.equal(createIgnoreMatcher(['/']).test('anything', true), 'not-ignored');
  assert.equal(createIgnoreMatcher(['!/']).test('anything', false), 'not-ignored');
});

test('star patterns and character classes stay inside one segment', () => {
  expectAll([
    { label: 'star crosses directories for a bare name', patterns: ['*'], path: 'a/b/c', isDirectory: true, expected: 'ignored' },
    { label: 'star does not cross a slash when anchored', patterns: ['a/*'], path: 'z/a/b/c', isDirectory: false, expected: 'not-ignored' },
    { label: 'star does not cross a slash when anchored', patterns: ['a/*'], path: 'a/b', isDirectory: false, expected: 'ignored' },
    { label: 'an excluded directory prunes everything below it', patterns: ['a/*'], path: 'a/b/c.txt', isDirectory: false, expected: 'ignored' },
    { label: 'embedded doublestar is a plain star', patterns: ['a**b'], path: 'axxb', isDirectory: false, expected: 'ignored' },
    { label: 'embedded doublestar is a plain star', patterns: ['a**b'], path: 'a/b', isDirectory: false, expected: 'not-ignored' },
    { label: 'unclosed class is a literal bracket', patterns: ['a[bc'], path: 'a[bc', isDirectory: false, expected: 'ignored' },
    { label: 'class with a dash', patterns: ['[a-c]x'], path: 'bx', isDirectory: false, expected: 'ignored' },
    { label: 'question marks match a name', patterns: ['??'], path: 'ab', isDirectory: false, expected: 'ignored' },
    { label: 'question marks match a name', patterns: ['??'], path: 'abc', isDirectory: false, expected: 'not-ignored' },
  ]);
});
