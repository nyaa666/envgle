import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import type { EnvFileKind, EnvParseIssueKind, EnvVarDecl } from '../src/types.js';
import { offsetToLineColumn } from '../src/utils/text.js';
import { parseEnvFile } from '../src/dotenv/parse.js';

type ParseOptions = Parameters<typeof parseEnvFile>[2];
type ParsedFile = ReturnType<typeof parseEnvFile>;

const DEFAULTS: ParseOptions = { kind: 'dev', shared: false, devOnly: true };
const DIAGNOSTIC_CODES = [
  'unterminated-quote',
  'invalid-key',
  'no-separator',
  'trailing-garbage',
  'control-characters',
  'line-too-long',
  'unknown',
] as const;
const ISSUE_KINDS: readonly EnvParseIssueKind[] = ['unterminated-quote', 'no-separator', 'unknown'];

const parse = (text: string, file = '.env', overrides: Partial<ParseOptions> = {}): ParsedFile =>
  parseEnvFile(file, text, { ...DEFAULTS, ...overrides });

const stripBom = (text: string): string => (text.startsWith('\ufeff') ? text.slice(1) : text);

const lineStarts = (text: string): number[] => {
  const starts: number[] = [0];
  let index = 0;
  while (index < text.length) {
    const code = text.charCodeAt(index);
    if (code === 13) {
      index += text.charCodeAt(index + 1) === 10 ? 2 : 1;
    } else if (code === 10) {
      index += 1;
    } else {
      index += 1;
      continue;
    }
    if (index < text.length) {
      starts.push(index);
    }
  }
  return starts;
};

const physicalLines = (text: string): string[] => stripBom(text).split(/\r\n|\n|\r/);

const lineRange = (text: string, line: number): { start: number; end: number } => {
  const body = stripBom(text);
  let start = 0;
  let index = 0;
  let current = 1;
  while (index <= body.length) {
    if (current === line) {
      let end = index;
      while (end < body.length) {
        const code = body.charCodeAt(end);
        if (code === 13 || code === 10) {
          break;
        }
        end += 1;
      }
      return { start, end };
    }
    const code = body.charCodeAt(index);
    if (code === 13) {
      index += body.charCodeAt(index + 1) === 10 ? 2 : 1;
      current += 1;
      start = index;
    } else if (code === 10) {
      index += 1;
      current += 1;
      start = index;
    } else {
      index += 1;
    }
  }
  return { start: 0, end: 0 };
};

/** The remainder of the physical line, starting at a 1-based line and column. */
const at = (text: string, line: number, column: number): string => {
  const range = lineRange(text, line);
  return stripBom(text).slice(range.start + column - 1, range.end);
};

const shape = (decl: EnvVarDecl) => ({
  name: decl.name,
  line: decl.line,
  column: decl.column,
  value: decl.value,
  hasValue: decl.hasValue,
  quoted: decl.quoted,
  exported: decl.exported,
  references: decl.references,
  duplicateOfLine: decl.duplicateOfLine,
});

const detail = (decl: EnvVarDecl) => ({
  ...shape(decl),
  leadingComments: decl.leadingComments,
  inlineComment: decl.inlineComment,
  unquotedInlineComment: decl.unquotedInlineComment,
  hasTrailingWhitespace: decl.hasTrailingWhitespace,
});

const shapes = (file: ParsedFile) => file.decls.map(shape);

const details = (file: ParsedFile) => file.decls.map(detail);

const codes = (file: ParsedFile) => file.diagnostics.map((diagnostic) => diagnostic.code);

const assertPosition = (text: string, decl: EnvVarDecl): void => {
  assert.ok(
    at(text, decl.line, decl.column).startsWith(decl.name),
    `line ${decl.line} column ${decl.column} must point at the key, got ${JSON.stringify(at(text, decl.line, decl.column).slice(0, 12))}`,
  );
  assert.ok(decl.line >= 1, 'line is 1-based');
  assert.ok(decl.column >= 1, 'column is 1-based');
  assert.equal(physicalLines(text)[decl.line - 1], at(text, decl.line, 1));
  assert.equal(at(text, decl.line, 1).length > 0, true);
};

const assertNoDiagnostics = (file: ParsedFile): void => {
  assert.deepEqual(file.diagnostics, []);
  assert.deepEqual(file.issues, []);
};

describe('parseEnvFile: file shape', () => {
  test('an empty file yields nothing at all', () => {
    const file = parse('', '.env.local');
    assert.deepEqual(file.decls, []);
    assert.deepEqual(file.issues, []);
    assert.deepEqual(file.diagnostics, []);
    assert.equal(file.bytes, 0);
    assert.equal(file.path, '.env.local');
    assert.equal(file.kind, 'dev');
  });

  test('a whitespace-only file yields no declarations', () => {
    for (const text of [' ', '\n', '   \n\t\n \t \n', '\r\n\r\n']) {
      const file = parse(text);
      assert.deepEqual(file.decls, [], JSON.stringify(text));
      assertNoDiagnostics(file);
    }
  });

  test('a comment-only file yields no declarations and no diagnostics', () => {
    const file = parse('# one\n#two\n#\n   # four\n');
    assert.deepEqual(file.decls, []);
    assertNoDiagnostics(file);
  });

  test('a file without a trailing newline parses every line', () => {
    const file = parse('A=1\nB=2');
    assert.deepEqual(
      shapes(file),
      [
        { name: 'A', line: 1, column: 1, value: '1', hasValue: true, quoted: null, exported: false, references: [], duplicateOfLine: null },
        { name: 'B', line: 2, column: 1, value: '2', hasValue: true, quoted: null, exported: false, references: [], duplicateOfLine: null },
      ],
    );
  });

  test('CRLF line endings keep the carriage return out of the value', () => {
    const text = 'A=1\r\nB=2\r\n';
    const file = parse(text);
    assert.deepEqual(
      shapes(file).map((decl) => [decl.name, decl.line, decl.column, decl.value]),
      [
        ['A', 1, 1, '1'],
        ['B', 2, 1, '2'],
      ],
    );
    for (const decl of file.decls) {
      assertPosition(text, decl);
    }
  });

  test('a lone carriage return is a line break too', () => {
    const text = 'A=1\rB=2\rC=3';
    const file = parse(text);
    assert.deepEqual(
      shapes(file).map((decl) => [decl.name, decl.line, decl.column, decl.value]),
      [
        ['A', 1, 1, '1'],
        ['B', 2, 1, '2'],
        ['C', 3, 1, '3'],
      ],
    );
    for (const decl of file.decls) {
      assertPosition(text, decl);
    }
  });

  test('a byte order mark is stripped and positions start at the first real character', () => {
    const text = '\ufeff# note\nA=1';
    const file = parse(text);
    assert.deepEqual(
      details(file).map((decl) => [decl.name, decl.line, decl.column, decl.value, decl.leadingComments]),
      [['A', 2, 1, '1', ['note']]],
    );
    assert.equal(file.bytes, Buffer.byteLength(text, 'utf8'));
  });

  test('bytes counts UTF-8 code units, not JavaScript characters', () => {
    const text = 'GREETING=héllo\nEMOJI=\u{1F44B}\n';
    const file = parse(text);
    assert.deepEqual(
      file.decls.map((decl) => decl.value),
      ['héllo', '\u{1F44B}'],
    );
    assert.equal(file.bytes, Buffer.byteLength(text, 'utf8'));
    assert.equal(file.bytes > text.length, true, 'multi-byte characters must add bytes');
  });

  test('kind, shared and devOnly are copied to the file and to every declaration', () => {
    const file = parse('A=1\nB=2', '.env.production', { kind: 'production', shared: true, devOnly: false });
    assert.equal(file.kind, 'production');
    for (const decl of file.decls) {
      assert.equal(decl.kind, 'production');
      assert.equal(decl.shared, true);
      assert.equal(decl.devOnly, false);
      assert.equal(decl.file, '.env.production');
    }
  });

  test('every file kind of the contract is accepted verbatim', () => {
    const kinds: readonly EnvFileKind[] = ['dev', 'test', 'production', 'local', 'example', 'template', 'unknown'];
    for (const kind of kinds) {
      assert.equal(parse('A=1', '.env', { kind }).kind, kind);
    }
  });

  test('parsing is deterministic', () => {
    const text = '# c\nA=${B}\nA=2\nBAD KEY=1\n';
    assert.deepEqual(parse(text), parse(text));
  });
});

describe('parseEnvFile: accepted forms', () => {
  test('KEY=value', () => {
    const text = 'KEY=value';
    const file = parse(text);
    assert.deepEqual(shapes(file), [
      { name: 'KEY', line: 1, column: 1, value: 'value', hasValue: true, quoted: null, exported: false, references: [], duplicateOfLine: null },
    ]);
    assertNoDiagnostics(file);
    assertPosition(text, file.decls[0] as EnvVarDecl);
  });

  test('whitespace around the key and the value is trimmed', () => {
    const file = parse('  KEY  =  value  \n');
    assert.deepEqual(
      details(file).map((decl) => [decl.name, decl.column, decl.value, decl.hasTrailingWhitespace]),
      [['KEY', 3, 'value', true]],
    );
  });

  test('tabs separate the key from the value', () => {
    const text = '\tKEY\t=\tvalue\t';
    const file = parse(text);
    assert.deepEqual(
      details(file).map((decl) => [decl.name, decl.column, decl.value, decl.hasTrailingWhitespace]),
      [['KEY', 2, 'value', true]],
    );
    assertPosition(text, file.decls[0] as EnvVarDecl);
  });

  test('KEY= with nothing after it has no value', () => {
    const file = parse('KEY=\n');
    assert.deepEqual(
      shapes(file).map((decl) => [decl.name, decl.value, decl.hasValue, decl.quoted]),
      [['KEY', '', false, null]],
    );
  });

  test('KEY= followed only by spaces has no value', () => {
    const file = parse('KEY=   \n');
    assert.deepEqual(
      shapes(file).map((decl) => [decl.value, decl.hasValue]),
      [['', false]],
    );
  });

  test('a bare key is a declaration with an empty value', () => {
    const file = parse('KEY\n');
    assert.deepEqual(
      shapes(file).map((decl) => [decl.name, decl.value, decl.hasValue, decl.quoted]),
      [['KEY', '', false, null]],
    );
  });

  test('a bare key followed by a blank line is still a declaration', () => {
    const file = parse('KEY\n\nOTHER=1\n');
    assert.deepEqual(
      shapes(file).map((decl) => [decl.name, decl.value, decl.hasValue]),
      [
        ['KEY', '', false],
        ['OTHER', '1', true],
      ],
    );
  });

  test('export KEY=value keeps the column on the key', () => {
    const text = 'export KEY=value';
    const file = parse(text);
    assert.deepEqual(shapes(file), [
      { name: 'KEY', line: 1, column: 8, value: 'value', hasValue: true, quoted: null, exported: true, references: [], duplicateOfLine: null },
    ]);
    assertPosition(text, file.decls[0] as EnvVarDecl);
  });

  test('export KEY without a separator is a declaration', () => {
    const file = parse('export KEY\n');
    assert.deepEqual(
      shapes(file).map((decl) => [decl.name, decl.column, decl.value, decl.hasValue, decl.exported]),
      [['KEY', 8, '', false, true]],
    );
  });

  test('a key that merely starts with the letters export is not the prefix', () => {
    const file = parse('export=1\nexported=2\n');
    assert.deepEqual(
      shapes(file).map((decl) => [decl.name, decl.value, decl.exported]),
      [
        ['export', '1', false],
        ['exported', '2', false],
      ],
    );
  });

  test('an unquoted value may contain equals signs', () => {
    const file = parse('A=a=b=c\n');
    assert.deepEqual(
      shapes(file).map((decl) => [decl.value, decl.hasValue]),
      [['a=b=c', true]],
    );
  });

  test('an unquoted value may contain a URL', () => {
    const value = 'postgres://user:PLACEHOLDER_1@db.internal:5432/appdb?sslmode=require';
    const file = parse(`DATABASE_URL=${value}\n`);
    assert.equal(file.decls[0]?.value, value);
    assert.deepEqual(file.decls[0]?.references, []);
  });

  test('an empty pair of quotes is a value', () => {
    const file = parse('A=""\nB=\'\'\n');
    assert.deepEqual(
      shapes(file).map((decl) => [decl.name, decl.value, decl.hasValue, decl.quoted]),
      [
        ['A', '', true, '"'],
        ['B', '', true, "'"],
      ],
    );
  });

  test('spaces inside quotes are part of the value', () => {
    const text = 'A="x   "\n';
    const file = parse(text);
    assert.deepEqual(
      details(file).map((decl) => [decl.value, decl.hasTrailingWhitespace]),
      [['x   ', false]],
    );
  });

  test('a hash directly after the equals sign is part of the value', () => {
    const file = parse('A=#not-a-comment\n');
    assert.deepEqual(
      details(file).map((decl) => [decl.value, decl.unquotedInlineComment]),
      [['#not-a-comment', null]],
    );
  });
});

describe('parseEnvFile: comments', () => {
  test('consecutive comment lines above an assignment become leadingComments', () => {
    const text = '# first\n#second\n  #  third  # inner\n#\nKEY=1\n';
    const file = parse(text);
    const decl = file.decls[0] as EnvVarDecl;
    assert.deepEqual(decl.leadingComments, ['first', 'second', 'third  # inner', '']);
    assert.equal(decl.line, 5);
    assert.equal(decl.inlineComment, null);
    assert.equal(decl.unquotedInlineComment, null);
  });

  test('a blank line breaks the comment run', () => {
    const text = '# one\n\n# two\nKEY=1\n';
    const file = parse(text);
    assert.deepEqual(file.decls[0]?.leadingComments, ['two']);
  });

  test('a comment at the end of the file belongs to no declaration', () => {
    const file = parse('KEY=1\n# dangling\n');
    assert.deepEqual(file.decls[0]?.leadingComments, []);
    assert.equal(file.decls.length, 1);
  });

  test('a comment line between two declarations belongs to the second one', () => {
    const file = parse('A=1\n# about b\nB=2\n');
    assert.deepEqual(file.decls[0]?.leadingComments, []);
    assert.deepEqual(file.decls[1]?.leadingComments, ['about b']);
  });

  test('a comment after a quoted value becomes the inline comment', () => {
    const file = parse('A="v" #   spaced note   \n');
    assert.deepEqual(
      details(file).map((decl) => [decl.value, decl.quoted, decl.inlineComment, decl.unquotedInlineComment]),
      [['v', '"', 'spaced note', null]],
    );
  });

  test('a comment after an unquoted value keeps the hash and stays unquoted', () => {
    const file = parse('A=v #note\n');
    assert.deepEqual(
      details(file).map((decl) => [decl.value, decl.quoted, decl.inlineComment, decl.unquotedInlineComment]),
      [['v', null, null, '#note']],
    );
  });

  test('a value with an inner hash is not truncated', () => {
    const file = parse('A=a#b\n');
    assert.deepEqual(
      details(file).map((decl) => [decl.value, decl.unquotedInlineComment]),
      [['a#b', null]],
    );
  });

  test('a hash after whitespace is a comment, with or without a space after it', () => {
    const file = parse('A=a #b\nB=b # c\n');
    assert.deepEqual(
      details(file).map((decl) => [decl.value, decl.unquotedInlineComment]),
      [
        ['a', '#b'],
        ['b', '# c'],
      ],
    );
  });

  test('a hash with no whitespace before it is a comment when whitespace separates the words', () => {
    const file = parse('COLOR=#ff00aa\n');
    assert.deepEqual(
      details(file).map((decl) => [decl.value, decl.unquotedInlineComment]),
      [['#ff00aa', null]],
    );
  });

  test('a comment after the equals sign leaves the declaration without a value', () => {
    const file = parse('A= # note\n');
    assert.deepEqual(
      details(file).map((decl) => [decl.value, decl.hasValue, decl.unquotedInlineComment]),
      [['', false, '# note']],
    );
  });
});

describe('parseEnvFile: quoting', () => {
  test('double-quoted escapes are resolved', () => {
    const file = parse('A="\\n\\r\\t\\f\\b\\v\\\\\\"\\\'\\$\\0\\x41"\n');
    assert.equal(file.decls[0]?.value, '\n\r\t\f\b\v\\"\'$\u0000' + 'A');
    assert.equal(file.decls[0]?.quoted, '"');
  });

  test('an unknown escape keeps the backslash', () => {
    const file = parse('A="\\q\\xZZ\\x4"\n');
    assert.equal(file.decls[0]?.value, '\\q\\xZZ\\x4');
  });

  test('a backslash at the end of a quoted value is kept', () => {
    const file = parse('A="trailing\\\\"\nB=1\n');
    assert.deepEqual(
      shapes(file).map((decl) => [decl.name, decl.value]),
      [
        ['A', 'trailing\\'],
        ['B', '1'],
      ],
    );
  });

  test('a double-quoted value may span lines and keeps its line breaks', () => {
    const text = 'PRIVATE_KEY="-----BEGIN-----\nline two\nline three"\nNEXT=1\n';
    const file = parse(text);
    const decl = file.decls[0] as EnvVarDecl;
    assert.equal(decl.value, '-----BEGIN-----\nline two\nline three');
    assert.equal(decl.quoted, '"');
    assert.equal(decl.line, 1);
    assert.equal(decl.column, 1);
    assert.equal(at(text, 1, 13), '"-----BEGIN-----');
    assert.equal(file.decls.length, 2, 'the closing line must not be parsed again');
    assert.equal(file.decls[1]?.name, 'NEXT');
    assert.equal(file.decls[1]?.line, 4);
    assertNoDiagnostics(file);
  });

  test('a single-quoted value is fully literal and may span lines', () => {
    const text = "S='a\\nb # $X ${Y}\nsecond'\n";
    const file = parse(text);
    const decl = file.decls[0] as EnvVarDecl;
    assert.equal(decl.value, 'a\\nb # $X ${Y}\nsecond');
    assert.equal(decl.quoted, "'");
    assert.deepEqual(decl.references, ['X', 'Y']);
    assert.equal(file.decls.length, 1);
  });

  test('the inline comment is taken from the line that closes the quote', () => {
    const text = 'A="one\ntwo" # trailing note\n';
    const file = parse(text);
    assert.deepEqual(
      details(file).map((decl) => [decl.value, decl.inlineComment]),
      [['one\ntwo', 'trailing note']],
    );
    assertNoDiagnostics(file);
  });

  test('text after the closing quote is dropped with a warning', () => {
    const text = 'A="v" leftover junk\nB=1\n';
    const file = parse(text);
    assert.deepEqual(
      shapes(file).map((decl) => [decl.name, decl.value]),
      [
        ['A', 'v'],
        ['B', '1'],
      ],
    );
    assert.deepEqual(file.diagnostics, [
      {
        line: 1,
        column: 7,
        message: 'Unexpected text after the closing quote at line 1, column 7 in .env: the rest of the line is ignored',
        severity: 'warn',
        code: 'trailing-garbage',
      },
    ]);
    assert.equal(at(text, 1, 7), 'leftover junk');
  });

  test('an unterminated double quote still yields a declaration', () => {
    const text = 'A="one\ntwo';
    const file = parse(text);
    const decl = file.decls[0] as EnvVarDecl;
    assert.equal(decl.value, 'one\ntwo');
    assert.equal(decl.quoted, '"');
    assert.deepEqual(file.issues, [
      {
        kind: 'unterminated-quote',
        message: 'Unterminated double-quoted value starting at line 1, column 3 in .env: the closing quote is missing at end of file',
        file: '.env',
        line: 1,
        column: 3,
      },
    ]);
    assert.deepEqual(codes(file), ['unterminated-quote']);
    assert.equal(file.diagnostics[0]?.severity, 'error');
  });

  test('an unterminated single quote still yields a declaration', () => {
    const file = parse("A='one\ntwo\nthree");
    const decl = file.decls[0] as EnvVarDecl;
    assert.equal(decl.value, 'one\ntwo\nthree');
    assert.equal(decl.quoted, "'");
    assert.equal(file.issues.length, 1);
    assert.equal(file.issues[0]?.kind, 'unterminated-quote');
    assert.equal(file.issues[0]?.line, 1);
    assert.equal(file.issues[0]?.column, 3);
  });

  test('an unterminated quote at the very end of the file is reported once', () => {
    const file = parse('A="');
    assert.equal(file.decls.length, 1);
    assert.equal(file.decls[0]?.value, '');
    assert.deepEqual(codes(file), ['unterminated-quote']);
  });
});

describe('parseEnvFile: malformed input', () => {
  test('an empty key is an error without a declaration', () => {
    const file = parse('=1\n');
    assert.deepEqual(file.decls, []);
    assert.deepEqual(file.issues, [
      { kind: 'unknown', message: 'Invalid key at line 1, column 1 in .env: expected NAME=value', file: '.env', line: 1, column: 1 },
    ]);
    assert.deepEqual(file.diagnostics, [
      {
        line: 1,
        column: 1,
        message: 'Invalid key at line 1, column 1 in .env: expected NAME=value',
        severity: 'error',
        code: 'invalid-key',
      },
    ]);
  });

  test('a key with internal whitespace is invalid', () => {
    const file = parse('MY KEY=1\n');
    assert.deepEqual(file.decls, []);
    assert.deepEqual(codes(file), ['invalid-key']);
    assert.equal(file.issues[0]?.kind, 'unknown');
  });

  test('a key with a quote is invalid', () => {
    for (const text of ['MY"KEY=1\n', "MY'KEY=1\n"]) {
      const file = parse(text);
      assert.deepEqual(file.decls, [], text);
      assert.deepEqual(codes(file), ['invalid-key'], text);
    }
  });

  test('a YAML-style assignment is invalid', () => {
    const file = parse('KEY: value\n');
    assert.deepEqual(file.decls, []);
    assert.equal(file.issues[0]?.kind, 'unknown');
    assert.equal(file.diagnostics[0]?.code, 'invalid-key');
    assert.equal(file.diagnostics[0]?.severity, 'error');
  });

  test('a key whose value is on the next line is a no-separator issue', () => {
    const file = parse('KEY\nvalue\n');
    assert.deepEqual(
      file.decls.map((decl) => decl.name),
      ['value'],
    );
    assert.deepEqual(file.issues, [
      {
        kind: 'no-separator',
        message: 'KEY at line 1, column 1 in .env has no "=" separator; the value appears to start on the next line',
        file: '.env',
        line: 1,
        column: 1,
      },
    ]);
    assert.deepEqual(codes(file), ['no-separator']);
    assert.equal(file.diagnostics[0]?.severity, 'error');
  });

  test('a comment line after a bare key does not look like a value', () => {
    const file = parse('KEY\n# note\nOTHER=1\n');
    assert.deepEqual(
      file.decls.map((decl) => decl.name),
      ['KEY', 'OTHER'],
    );
    assert.deepEqual(file.decls[0]?.leadingComments, []);
    assert.deepEqual(file.decls[1]?.leadingComments, ['note']);
  });

  test('a NUL byte in a value is kept and reported once per declaration', () => {
    const file = parse('A=a\u0000b\nB=1\n');
    assert.equal(file.decls[0]?.value, 'a\u0000b');
    assert.deepEqual(codes(file), ['control-characters']);
    assert.deepEqual(file.diagnostics, [
      {
        line: 1,
        column: 1,
        message: 'The value of A at line 1, column 1 in .env contains a NUL or control character',
        severity: 'warn',
        code: 'control-characters',
      },
    ]);
  });

  test('a line break inside a quoted value is not a control character', () => {
    const file = parse('A="one\ntwo"\n');
    assertNoDiagnostics(file);
  });

  test('a tab inside a quoted value is not a control character', () => {
    const file = parse('A="one\ttwo"\n');
    assertNoDiagnostics(file);
  });

  test('a line longer than the limit is reported once', () => {
    const file = parse(`LONG=${'x'.repeat(2100)}\n`);
    assert.equal(file.decls[0]?.value.length, 2100);
    assert.deepEqual(file.diagnostics, [
      {
        line: 1,
        column: 1,
        message: 'Line 1 in .env is 2105 characters long (limit 2048)',
        severity: 'warn',
        code: 'line-too-long',
      },
    ]);
  });

  test('a line of exactly the limit is accepted', () => {
    const file = parse(`A=${'x'.repeat(2046)}\n`);
    assert.equal(at(`A=${'x'.repeat(2046)}\n`, 1, 1).length, 2048);
    assertNoDiagnostics(file);
  });

  test('a long comment line is reported too', () => {
    const file = parse(`# ${'x'.repeat(2100)}\n`);
    assert.deepEqual(file.decls, []);
    assert.deepEqual(codes(file), ['line-too-long']);
  });

  test('malformed input never throws and never leaks an unknown code', () => {
    const nasty = [
      '"',
      "''",
      "'",
      '=',
      '= =',
      '#',
      '#=',
      'KEY="',
      "KEY='",
      'KEY="a\\',
      'KEY="\\x',
      'KEY=${',
      'KEY=$',
      'export',
      'export ',
      'export=',
      '   ',
      'A=1\n"',
      'A="\\\nB=',
      '\u0000',
      'A=\u0000\u0001',
      'KEY: 1',
      'KEY="a\'b"',
      'KEY=1\rB\nC\rD=2',
      'A=#',
      'KEY=#',
      'KEY="""',
      "KEY='''",
      'KEY="${A}${B}"',
      'A=1 B=2',
      'A'.repeat(5000) + '=1',
      ' =',
      'KEY\\=1',
    ];
    for (const text of nasty) {
      const file = parse(text, '.env.example', { kind: 'example', shared: true, devOnly: false });
      assert.equal(typeof file.bytes, 'number', JSON.stringify(text));
      for (const decl of file.decls) {
        assert.equal(typeof decl.name, 'string');
        assert.equal(typeof decl.value, 'string');
        assert.equal(typeof decl.hasValue, 'boolean');
        assert.ok(Number.isInteger(decl.line) && decl.line >= 1, `${JSON.stringify(text)} line`);
        assert.ok(Number.isInteger(decl.column) && decl.column >= 1, `${JSON.stringify(text)} column`);
        assert.ok([null, '"', "'"].includes(decl.quoted), `${JSON.stringify(text)} quoted`);
        assert.ok(Array.isArray(decl.references), `${JSON.stringify(text)} references`);
      }
      for (const issue of file.issues) {
        assert.ok(ISSUE_KINDS.includes(issue.kind), `${JSON.stringify(text)} issue kind ${issue.kind}`);
        assert.equal(typeof issue.message, 'string');
        assert.ok(issue.message.length > 0);
      }
      for (const diagnostic of file.diagnostics) {
        assert.ok(
          (DIAGNOSTIC_CODES as readonly string[]).includes(diagnostic.code),
          `${JSON.stringify(text)} diagnostic code ${diagnostic.code}`,
        );
        assert.ok(['error', 'warn'].includes(diagnostic.severity));
        assert.equal(typeof diagnostic.message, 'string');
      }
    }
  });

  test('diagnostic messages never echo a value', () => {
    const text = 'A="PLACEHOLDER_1" PLACEHOLDER_1\nB=PLACEHOLDER_1\u0000\n';
    const file = parse(text);
    assert.deepEqual(codes(file), ['trailing-garbage', 'control-characters']);
    for (const diagnostic of file.diagnostics) {
      assert.equal(diagnostic.message.includes('PLACEHOLDER_1'), false, diagnostic.message);
    }
  });
});

describe('parseEnvFile: references', () => {
  test('a chain of braced references keeps the order of appearance', () => {
    const file = parse('X=${A}${B}\n');
    assert.deepEqual(file.decls[0]?.references, ['A', 'B']);
  });

  test('a nested default yields both names', () => {
    const file = parse('X=${A:-${B:-c}}\n');
    assert.deepEqual(file.decls[0]?.references, ['A', 'B']);
  });

  test('every braced operator form is recognised', () => {
    const file = parse('A=${ONE}\nB=${TWO:-d}\nC=${THREE-d}\nD=${FOUR:?e}\nE=${FIVE?e}\nF=${SIX/x/y}\n');
    assert.deepEqual(
      file.decls.map((decl) => decl.references),
      [['ONE'], ['TWO'], ['THREE'], ['FOUR'], ['FIVE'], ['SIX']],
    );
  });

  test('bare dollar names are recognised and repeats are dropped', () => {
    const file = parse('A=$B-$C-$B\n');
    assert.deepEqual(file.decls[0]?.references, ['B', 'C']);
  });

  test('shell syntax that is not a variable reference is ignored', () => {
    const file = parse('A=$B $1 $? $(cmd) $((1+1)) \\$A\n');
    assert.deepEqual(file.decls[0]?.references, ['B']);
    assert.equal(file.decls[0]?.value, '$B $1 $? $(cmd) $((1+1)) \\$A');
  });

  test('a dollar sign directly before another dollar sign is not a reference', () => {
    const file = parse('A=$$B\n');
    assert.deepEqual(file.decls[0]?.references, []);
  });

  test('a brace that does not start with a name is not a reference', () => {
    const file = parse('A=${1B} ${}\n');
    assert.deepEqual(file.decls[0]?.references, []);
  });

  test('an escaped dollar sign suppresses the reference', () => {
    const file = parse('A="\\$A"\n');
    assert.deepEqual(file.decls[0]?.references, []);
    assert.equal(file.decls[0]?.value, '$A');
  });

  test('references are scanned from the raw text, not the decoded one', () => {
    const file = parse('A="${B}\\t${C}"\n');
    assert.deepEqual(file.decls[0]?.references, ['B', 'C']);
  });

  test('references in a trailing comment are not collected', () => {
    const file = parse('A=x # see $B\nB=1\n');
    assert.deepEqual(file.decls[0]?.references, []);
    assert.deepEqual(file.decls[1]?.references, []);
  });

  test('references are unique and never sorted', () => {
    const file = parse('A=${ZED}-${ALPHA}-${ZED}\n');
    assert.deepEqual(file.decls[0]?.references, ['ZED', 'ALPHA']);
  });

  test('a value without a dollar sign has no references', () => {
    const file = parse('A=plain\n');
    assert.deepEqual(file.decls[0]?.references, []);
  });
});

describe('parseEnvFile: duplicates and long files', () => {
  test('every repeat of a name points at the first declaration', () => {
    const text = 'DUP=1\nOTHER=2\nDUP=3\nDUP=4\n';
    const file = parse(text);
    assert.deepEqual(
      shapes(file).map((decl) => [decl.name, decl.line, decl.duplicateOfLine]),
      [
        ['DUP', 1, null],
        ['OTHER', 2, null],
        ['DUP', 3, 1],
        ['DUP', 4, 1],
      ],
    );
  });

  test('names are compared case-sensitively', () => {
    const file = parse('KEY=1\nkey=2\n');
    assert.deepEqual(
      file.decls.map((decl) => decl.duplicateOfLine),
      [null, null],
    );
  });

  test('unicode values survive the round trip', () => {
    const file = parse('GREETING=héllo\nEMOJI=\u{1F44B} wörld\n');
    assert.deepEqual(
      file.decls.map((decl) => decl.value),
      ['héllo', '\u{1F44B} wörld'],
    );
  });

  test('twenty thousand assignments are all found in order', () => {
    const count = 20_000;
    const text = Array.from({ length: count }, (_, index) => `KEY_${index}=value_${index}`).join('\n');
    const started = process.hrtime.bigint();
    const file = parse(text);
    const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;
    assert.equal(file.decls.length, count);
    assert.equal(file.decls[0]?.name, 'KEY_0');
    assert.equal(file.decls[0]?.line, 1);
    assert.equal(file.decls[count - 1]?.name, `KEY_${count - 1}`);
    assert.equal(file.decls[count - 1]?.line, count);
    assert.equal(file.decls[count - 1]?.value, `value_${count - 1}`);
    assertNoDiagnostics(file);
    assert.equal(elapsedMs < 300, true, `20000 assignments took ${elapsedMs.toFixed(1)} ms`);
  });

  test('a two megabyte file with twenty thousand assignments parses in time', () => {
    const count = 20_000;
    const filler = 'x'.repeat(90);
    const text = Array.from({ length: count }, (_, index) => `KEY_${index}=${filler}_${index}`).join('\n');
    assert.equal(Buffer.byteLength(text, 'utf8') > 2_000_000, true, 'the fixture must exceed 2 MB');
    const started = process.hrtime.bigint();
    const file = parse(text);
    const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;
    assert.equal(file.decls.length, count);
    assert.equal(file.decls[count - 1]?.line, count);
    assert.equal(file.bytes, Buffer.byteLength(text, 'utf8'));
    assert.equal(elapsedMs < 300, true, `2 MB took ${elapsedMs.toFixed(1)} ms`);
  });

  test('a file of comments only stays fast and empty', () => {
    const text = Array.from({ length: 40_000 }, (_, index) => `# comment ${index}`).join('\n');
    const started = process.hrtime.bigint();
    const file = parse(text);
    const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;
    assert.deepEqual(file.decls, []);
    assert.equal(elapsedMs < 300, true, `comment-only file took ${elapsedMs.toFixed(1)} ms`);
  });
});

describe('parseEnvFile: positions cross-checked against the shared helpers', () => {
  test('offsetToLineColumn agrees with every reported position', () => {
    const text = '# lead\n# lead\nA=1\n  export B=2\nC="multi\nline"\n';
    const file = parse(text);
    const starts = lineStarts(text);
    for (const decl of file.decls) {
      const offset = (starts[decl.line - 1] ?? 0) + decl.column - 1;
      assert.deepEqual(offsetToLineColumn(text, offset), { line: decl.line, column: decl.column });
    }
  });

  test('the reported position slices back to the key in the source', () => {
    const text = '\n\n\t# note\n   export  SPACED  =  1  \nLAST=2';
    const file = parse(text);
    for (const decl of file.decls) {
      assertPosition(text, decl);
    }
    assert.deepEqual(
      shapes(file).map((decl) => [decl.name, decl.line, decl.column]),
      [
        ['SPACED', 4, 12],
        ['LAST', 5, 1],
      ],
    );
  });
});
