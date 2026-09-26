import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { test } from 'node:test';
import { blockOf, findInterpolations, parseYaml, refLocation } from '../src/scan/yaml.js';
import { countLines, lineText } from '../src/utils/text.js';
import type { InfraRef } from '../src/types.js';
import type { YamlLine } from '../src/scan/yaml.js';

interface LineShape {
  readonly number: number;
  readonly indent: number;
  readonly text: string;
  readonly content: string;
  readonly blank: boolean;
  readonly comment: boolean;
}

interface RefShape {
  readonly name: string;
  readonly line: number;
  readonly column: number;
  readonly required: boolean;
}

const shapeOf = (line: YamlLine): LineShape => ({
  number: line.number,
  indent: line.indent,
  text: line.text,
  content: line.content,
  blank: line.blank,
  comment: line.comment,
});

const shapeAll = (lines: readonly YamlLine[]): LineShape[] => lines.map(shapeOf);

const shapeRefs = (refs: readonly InfraRef[]): RefShape[] =>
  refs.map((ref) => ({ name: ref.name, line: ref.line, column: ref.column, required: ref.required }));

const contents = (source: string): string[] => parseYaml(source).lines.map((line) => line.content);

test('parseYaml reads the block-style subset line by line', () => {
  const cases: readonly { readonly title: string; readonly source: string; readonly expected: readonly LineShape[] }[] = [
    {
      title: 'indentation, values, a comment, a blank line and trailing spaces',
      source: ['services:', '  web:', '    image: nginx   ', '    # a comment', '', "    tag: '1.2'", ''].join('\n'),
      expected: [
        { number: 1, indent: 0, text: 'services:', content: 'services:', blank: false, comment: false },
        { number: 2, indent: 2, text: '  web:', content: 'web:', blank: false, comment: false },
        { number: 3, indent: 4, text: '    image: nginx', content: 'image: nginx', blank: false, comment: false },
        { number: 4, indent: 4, text: '    # a comment', content: '# a comment', blank: false, comment: true },
        { number: 5, indent: 0, text: '', content: '', blank: true, comment: false },
        { number: 6, indent: 4, text: "    tag: '1.2'", content: "tag: '1.2'", blank: false, comment: false },
        { number: 7, indent: 0, text: '', content: '', blank: true, comment: false },
      ],
    },
    {
      title: 'carriage returns are dropped and columns stay correct',
      source: 'a: 1\r\n  b: 2\r\n',
      expected: [
        { number: 1, indent: 0, text: 'a: 1', content: 'a: 1', blank: false, comment: false },
        { number: 2, indent: 2, text: '  b: 2', content: 'b: 2', blank: false, comment: false },
        { number: 3, indent: 0, text: '', content: '', blank: true, comment: false },
      ],
    },
    {
      title: 'a leading byte order mark is not part of the first line',
      source: '\ufeffa: 1\nb: 2',
      expected: [
        { number: 1, indent: 0, text: 'a: 1', content: 'a: 1', blank: false, comment: false },
        { number: 2, indent: 0, text: 'b: 2', content: 'b: 2', blank: false, comment: false },
      ],
    },
    {
      title: 'a tab in the indentation reports indent -1',
      source: 'a:\n\tb: 1\n  \tc: 2\n  d: 3',
      expected: [
        { number: 1, indent: 0, text: 'a:', content: 'a:', blank: false, comment: false },
        { number: 2, indent: -1, text: '\tb: 1', content: 'b: 1', blank: false, comment: false },
        { number: 3, indent: -1, text: '  \tc: 2', content: 'c: 2', blank: false, comment: false },
        { number: 4, indent: 2, text: '  d: 3', content: 'd: 3', blank: false, comment: false },
      ],
    },
    {
      title: 'a document marker is ignored but keeps its line number',
      source: '---\nservices:\n---\n  web: 1',
      expected: [
        { number: 1, indent: 0, text: '---', content: '', blank: true, comment: false },
        { number: 2, indent: 0, text: 'services:', content: 'services:', blank: false, comment: false },
        { number: 3, indent: 0, text: '---', content: '', blank: true, comment: false },
        { number: 4, indent: 2, text: '  web: 1', content: 'web: 1', blank: false, comment: false },
      ],
    },
    {
      title: 'an empty document is a single blank line',
      source: '',
      expected: [{ number: 1, indent: 0, text: '', content: '', blank: true, comment: false }],
    },
  ];
  for (const testCase of cases) {
    const document = parseYaml(testCase.source);
    assert.deepEqual(shapeAll(document.lines), testCase.expected, testCase.title);
  }
});

test('parseYaml numbers every line from 1 and indexes by that number', () => {
  const source = '---\nservices:\n  web:\n    environment:\n      - A=1\n';
  const document = parseYaml(source);
  assert.equal(document.lines.length, countLines(source));
  document.lines.forEach((line, index) => {
    assert.equal(line.number, index + 1, `line ${index + 1} is numbered ${line.number}`);
    assert.equal(document.byNumber.get(index + 1), line, `byNumber misses line ${index + 1}`);
  });
  assert.equal(document.byNumber.size, document.lines.length);
  assert.equal(document.byNumber.get(4)?.content, 'environment:');
  assert.equal(document.byNumber.get(99), undefined);
});

test('parseYaml strips trailing comments but never inside quotes', () => {
  const cases: readonly (readonly [string, string])[] = [
    ['KEY: value # comment', 'KEY: value'],
    ['KEY: value#nospace', 'KEY: value#nospace'],
    ['KEY: "a # b" # comment', 'KEY: "a # b"'],
    ["KEY: 'a # b'", "KEY: 'a # b'"],
    ['KEY: "escaped \\" # not a comment', 'KEY: "escaped \\" # not a comment'],
    ['KEY: "unterminated # still here', 'KEY: "unterminated # still here'],
    ["KEY: 'it''s # still here'", "KEY: 'it''s # still here'"],
    ['"quoted key": value # comment', '"quoted key": value'],
    ["KEY: it's fine # gone", "KEY: it's fine"],
    ['#whole line', '#whole line'],
    ['   # indented comment', '# indented comment'],
    ['KEY:', 'KEY:'],
    ['not a mapping line', 'not a mapping line'],
  ];
  for (const [source, expected] of cases) {
    assert.deepEqual(contents(source), [expected], source);
  }
});

test('parseYaml keeps a full-line comment as a comment and not as a blank', () => {
  const document = parseYaml('# note\n\n  # nested note\nkey: 1');
  assert.deepEqual(
    document.lines.map((line) => [line.comment, line.blank]),
    [
      [true, false],
      [false, true],
      [true, false],
      [false, false],
    ],
  );
});

test('blockOf returns the nested lines of a key', () => {
  const source = ['services:', '  web:', '    image: a', '', '    ports:', '      - "1:1"', '  api:', '    image: b', ''].join('\n');
  const document = parseYaml(source);
  assert.deepEqual(
    blockOf(document, 'services', 0).map((line) => `${line.number}:${line.content}`),
    ['2:web:', '3:image: a', '5:ports:', '6:- "1:1"', '7:api:', '8:image: b'],
  );
  assert.deepEqual(
    blockOf(document, 'ports').map((line) => `${line.number}:${line.content}`),
    ['6:- "1:1"'],
  );
  assert.deepEqual(
    blockOf(document, 'web', 2).map((line) => `${line.number}:${line.content}`),
    ['3:image: a', '5:ports:', '6:- "1:1"'],
  );
});

test('blockOf matches a quoted key and ignores list items', () => {
  const document = parseYaml(['"env_file":', '  - .env', '  - .env.local', 'steps:', '  - name: build'].join('\n'));
  assert.deepEqual(
    blockOf(document, 'env_file', 0).map((line) => line.content),
    ['- .env', '- .env.local'],
  );
  assert.deepEqual(
    blockOf(document, 'name', 2).map((line) => line.content),
    [],
    'a list item is not a mapping key',
  );
  assert.deepEqual(blockOf(document, 'build'), []);
});

test('blockOf returns an empty list for a missing key, a scalar and a foreign indent', () => {
  const source = ['version: "3.9"', 'services:', '  web:', '    environment:', '      A: 1'].join('\n');
  const document = parseYaml(source);
  assert.deepEqual(blockOf(document, 'volumes'), []);
  assert.deepEqual(blockOf(document, 'version', 0), []);
  assert.deepEqual(blockOf(document, 'environment', 0), []);
  assert.deepEqual(
    blockOf(document, 'environment').map((line) => line.content),
    ['A: 1'],
  );
});

test('blockOf picks the shallowest match when no indent is given', () => {
  const document = parseYaml(['jobs:', '  build:', '    env_file: deep', '  test:', '    env_file: shallow', 'env_file: top'].join('\n'));
  assert.deepEqual(
    blockOf(document, 'env_file').map((line) => line.content),
    [],
    'the shallowest env_file is a scalar, so it owns no lines',
  );
  assert.deepEqual(
    blockOf(document, 'jobs', 0).map((line) => line.content),
    ['build:', 'env_file: deep', 'test:', 'env_file: shallow'],
  );
});

test('blockOf never throws on malformed input', () => {
  const sources = ['', '   ', 'key', 'key:', ':value', '- - -', 'a:\n  b:\n\tc:\n      d:', '\u0000\u0001:\n  - \ud83d\ude00'];
  for (const source of sources) {
    assert.doesNotThrow(() => blockOf(parseYaml(source), 'a', 0), JSON.stringify(source));
    assert.doesNotThrow(() => blockOf(parseYaml(source), 'b'), JSON.stringify(source));
  }
});

test('findInterpolations records ${NAME} forms with their position', () => {
  const cases: readonly { readonly title: string; readonly text: string; readonly expected: readonly RefShape[] }[] = [
    { title: 'plain', text: '${A}', expected: [{ name: 'A', line: 7, column: 1, required: false }] },
    { title: 'default with colon', text: '${A:-fallback}', expected: [{ name: 'A', line: 7, column: 1, required: false }] },
    { title: 'default without colon', text: '${A-fallback}', expected: [{ name: 'A', line: 7, column: 1, required: false }] },
    { title: 'error with colon', text: '${A:?boom}', expected: [{ name: 'A', line: 7, column: 1, required: true }] },
    { title: 'error without colon', text: '${A?boom}', expected: [{ name: 'A', line: 7, column: 1, required: true }] },
    { title: 'suffix', text: '${A:boom}', expected: [{ name: 'A', line: 7, column: 1, required: false }] },
    { title: 'slash form', text: '${A/a/b}', expected: [{ name: 'A', line: 7, column: 1, required: false }] },
    { title: 'inside a word', text: 'url: postgres://u:${PG}@db/app', expected: [{ name: 'PG', line: 7, column: 19, required: false }] },
    { title: 'two on one line', text: '${A}-${B}', expected: [
      { name: 'A', line: 7, column: 1, required: false },
      { name: 'B', line: 7, column: 6, required: false },
    ] },
    { title: 'nested default keeps the outer name', text: '${A:-${B}}', expected: [{ name: 'A', line: 7, column: 1, required: false }] },
    { title: 'leading underscore and digits', text: '${_A1}', expected: [{ name: '_A1', line: 7, column: 1, required: false }] },
    { title: 'a list item', text: '- ${A}', expected: [{ name: 'A', line: 7, column: 3, required: false }] },
    { title: 'column offset shifts the position', text: '${A}', expected: [{ name: 'A', line: 7, column: 6, required: false }] },
  ];
  for (const testCase of cases) {
    const offset = testCase.title === 'column offset shifts the position' ? 5 : 0;
    const refs = findInterpolations(testCase.text, 7, offset, ['compose-interpolation']);
    assert.deepEqual(shapeRefs(refs), testCase.expected, testCase.title);
    for (const ref of refs) {
      assert.equal(ref.kind, 'compose-interpolation', testCase.title);
      assert.equal(ref.interpolation, true, testCase.title);
      assert.equal(ref.refersToFile, false, testCase.title);
    }
  }
});

test('findInterpolations records $NAME only as a full identifier', () => {
  const cases: readonly { readonly title: string; readonly text: string; readonly expected: readonly RefShape[] }[] = [
    { title: 'bare', text: '$A', expected: [{ name: 'A', line: 7, column: 1, required: false }] },
    { title: 'after a space', text: 'env: $PORT:3000', expected: [{ name: 'PORT', line: 7, column: 6, required: false }] },
    { title: 'long name', text: '${A} $MY_VAR_2 ', expected: [
      { name: 'A', line: 7, column: 1, required: false },
      { name: 'MY_VAR_2', line: 7, column: 6, required: false },
    ] },
    { title: 'escaped dollar', text: '$${A}', expected: [] },
    { title: 'escaped dollar twice', text: 'cost $$5 and $A', expected: [{ name: 'A', line: 7, column: 14, required: false }] },
    { title: 'command substitution', text: '$(cat file)', expected: [] },
    { title: 'arithmetic', text: '$((1 + 2))', expected: [] },
    { title: 'github expression', text: '${{ secrets.TOKEN }}', expected: [] },
    { title: 'digits cannot start a name', text: '$1 $2A', expected: [] },
    { title: 'bounded on the left', text: 'a$B c$D $E', expected: [{ name: 'E', line: 7, column: 9, required: false }] },
    { title: 'no name at all', text: '$', expected: [] },
    { title: 'dollar then space', text: '$ A', expected: [] },
    { title: 'empty input', text: '', expected: [] },
  ];
  for (const testCase of cases) {
    assert.deepEqual(shapeRefs(findInterpolations(testCase.text, 7, 0, ['compose-interpolation'])), testCase.expected, testCase.title);
  }
});

test('findInterpolations ignores a bare or unterminated ${', () => {
  const cases: readonly (readonly [string, readonly RefShape[]])[] = [
    ['${', []],
    ['${}', []],
    ['${A', []],
    ['a ${ b', []],
    ['${-A}', []],
    ['${1A}', []],
    ['x${A', []],
    ['${A:-', []],
    ['}', []],
    ['{', []],
    ['${{', []],
    ['${A}${', [{ name: 'A', line: 3, column: 1, required: false }]],
    ['${A} ${B', [{ name: 'A', line: 3, column: 1, required: false }]],
    ['${A}${B', [{ name: 'A', line: 3, column: 1, required: false }]],
    ['${A:-${B', []],
  ];
  for (const [text, expected] of cases) {
    assert.deepEqual(shapeRefs(findInterpolations(text, 3, 0, ['compose-interpolation'])), expected, text);
  }
});

test('findInterpolations uses the first requested kind and no kinds means no refs', () => {
  assert.deepEqual(shapeRefs(findInterpolations('${A}', 1, 0, [])), []);
  const refs = findInterpolations('${A} $B', 1, 0, ['ci-var', 'ci-env']);
  assert.deepEqual(refs.map((ref) => ref.kind), ['ci-var', 'ci-var']);
});

test('findInterpolations points at the dollar sign in the source line', () => {
  const source = ['services:', '  web:', '    image: ghcr.io/acme/api:${IMAGE_TAG} # pinned', '    environment:', '      - ADDR=localhost:${PORT}'].join('\n');
  const document = parseYaml(source);
  for (const line of document.lines) {
    if (line.blank) {
      continue;
    }
    for (const ref of findInterpolations(line.content, line.number, line.indent, ['compose-interpolation'])) {
      const raw = lineText(source, ref.line);
      assert.equal(raw.charAt(ref.column - 1), '$', `line ${ref.line} column ${ref.column}`);
      assert.equal(raw.slice(ref.column - 1).startsWith(`\${${ref.name}`), true, `line ${ref.line} column ${ref.column}`);
    }
  }
});

test('refLocation projects the file, line and column of a reference', () => {
  const refs = findInterpolations('x ${A}', 12, 4, ['compose-interpolation']);
  assert.deepEqual(refs.map((ref) => refLocation(ref)), [{ file: '', line: 12, column: 7 }]);
});

test('findInterpolations stays linear on pathological input', () => {
  const started = performance.now();
  for (const text of [
    '${'.repeat(200_000),
    '$'.repeat(200_000),
    `${'$A'.repeat(100_000)}`,
    `${'$'.repeat(100_000)}{${'A'.repeat(100_000)}`,
    `${'${A:-'.repeat(20_000)}`,
  ]) {
    assert.doesNotThrow(() => findInterpolations(text, 1, 0, ['compose-interpolation']), `threw on ${text.length} characters`);
  }
  const elapsed = performance.now() - started;
  assert.ok(elapsed < 2000, `pathological input took ${Math.round(elapsed)} ms`);
});

test('the reader is deterministic and keeps source order instead of sorting it', () => {
  const source = ['services:', '  web:', '    environment:', '      - B: 2', '      - A=1', '      - a_b-c=1'].join('\n');
  const first = shapeAll(parseYaml(source).lines);
  const second = shapeAll(parseYaml(source).lines);
  assert.deepEqual(first, second);
  assert.deepEqual(
    blockOf(parseYaml(source), 'environment').map((line) => line.content),
    ['- B: 2', '- A=1', '- a_b-c=1'],
  );
});
