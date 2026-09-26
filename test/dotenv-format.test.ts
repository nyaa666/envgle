import assert from 'node:assert/strict';
import { test } from 'node:test';
import { needsQuoting, normalizeValue, serializeEnvFile } from '../src/dotenv/format.js';
import { parseEnvFile } from '../src/dotenv/parse.js';
import type { EnvFile } from '../src/dotenv/parse.js';
import type { EnvFileKind } from '../src/types.js';

const parse = (text: string): EnvFile =>
  parseEnvFile('.env', text, { kind: 'dev' as EnvFileKind, shared: true, devOnly: false });

test('needsQuoting marks exactly the values a loader would disagree about', () => {
  for (const safe of ['abc', '3000', 'a-b_c.d', 'https://x.example/y?z=1', 'a,b', '50%', '~x', 'a:b@c']) {
    assert.equal(needsQuoting(safe), false, `${safe} should not need quotes`);
  }
  for (const unsafe of [
    '',
    'a b',
    ' a',
    'a ',
    '#a',
    'a#b',
    "$A",
    "it's",
    'say "hi"',
    'back\\slash',
    'line\nbreak',
    'tab\there',
    '"quoted"',
  ]) {
    assert.equal(needsQuoting(unsafe), true, `${JSON.stringify(unsafe)} should need quotes`);
  }
});

test('normalizeValue quotes and escapes only when needed', () => {
  assert.equal(normalizeValue('plain-value'), 'plain-value');
  assert.equal(normalizeValue(''), '""');
  assert.equal(normalizeValue('has space'), '"has space"');
  assert.equal(normalizeValue('a"b'), '"a\\"b"');
  assert.equal(normalizeValue('a$b'), '"a$b"');
  assert.equal(normalizeValue('a\\b'), '"a\\\\b"');
  assert.equal(normalizeValue('one\ntwo'), '"one\\ntwo"');
  assert.equal(normalizeValue('cr\r\nlf'), '"cr\\nlf"');
});

test('a round trip preserves every parsed fact', () => {
  const sources = [
    'A=1\nB=two words\n',
    '# leading comment\nA=1\n\n# another\nB=2\n',
    'export A=1\nexport B=2\n',
    "A='single quoted'\nB=\"double \\\"quoted\\\"\"\n",
    'A=1 # trailing comment\nB="2" # quoted comment\n',
    'A=multi\n  line\nB=2\n',
    'A=$B/${C}\nB=1\nC=2\n',
    'A=\nB=\n',
  ];
  for (const source of sources) {
    const first = parse(source);
    const written = serializeEnvFile(first);
    const second = parse(written);
    const shape = (file: EnvFile): unknown =>
      file.decls.map((decl) => ({
        name: decl.name,
        value: decl.value,
        hasValue: decl.hasValue,
        exported: decl.exported,
        references: decl.references,
        leadingComments: decl.leadingComments,
      }));
    assert.deepEqual(shape(second), shape(first), `round trip changed ${JSON.stringify(source)} -> ${JSON.stringify(written)}`);
  }
});

test('an unsafe unquoted value is quoted while its value is untouched', () => {
  const file = parse('A=two words\nB=plain\n');
  const written = serializeEnvFile(file);
  assert.equal(written, 'A="two words"\nB=plain\n');
  const reparsed = parse(written);
  assert.equal(reparsed.decls[0]?.value, 'two words');
  assert.equal(reparsed.decls[0]?.quoted, '"');
  assert.equal(reparsed.decls[1]?.quoted, null);
});

test('serialization is idempotent', () => {
  const source = '# doc\nZED=1\nALPHA=two words\n';
  const once = serializeEnvFile(parse(source));
  const twice = serializeEnvFile(parse(once));
  assert.equal(twice, once);
});

test('quote styles are honoured and stay parseable', () => {
  const file = parse('A=plain\nB="already quoted"\n');
  assert.equal(serializeEnvFile(file, { quoteStyle: 'auto' }), 'A=plain\nB="already quoted"\n');
  assert.equal(serializeEnvFile(file, { quoteStyle: 'double' }), 'A="plain"\nB="already quoted"\n');
  assert.equal(serializeEnvFile(parse("A=it's\n"), { quoteStyle: 'single' }), "A=\"it's\"\n");
  const auto = parse(serializeEnvFile(file, { quoteStyle: 'auto' }));
  assert.deepEqual(auto.decls.map((decl) => decl.value), ['plain', 'already quoted']);
});

test('duplicate handling is explicit', () => {
  const file = parse('A=1\nA=2\nB=3\n');
  assert.equal(serializeEnvFile(file, { dedupe: 'keep-all' }), 'A=1\nA=2\nB=3\n');
  assert.equal(serializeEnvFile(file, { dedupe: 'keep-first' }), 'A=1\nB=3\n');
  assert.equal(serializeEnvFile(file, { dedupe: 'keep-last' }), 'A=2\nB=3\n');
});

test('headers, end of line and the final newline are configurable', () => {
  const file = parse('A=1\n');
  assert.equal(serializeEnvFile(file, { header: ['Generated', '# already prefixed'] }), '# Generated\n# already prefixed\n\nA=1\n');
  assert.equal(serializeEnvFile(file, { eol: '\r\n' }), 'A=1\r\n');
  assert.equal(serializeEnvFile(file, { finalNewline: false }), 'A=1');
  assert.equal(serializeEnvFile(parse('')), '');
});

test('blank lines collapse and comments travel with their assignment', () => {
  const file = parse('A=1\n\n\nB=2\n');
  assert.equal(serializeEnvFile(file), 'A=1\nB=2\n');
  const grouped = parse('# section one\nA=1\n\n# section two\nB=2\n');
  assert.equal(serializeEnvFile(grouped), '# section one\nA=1\n# section two\nB=2\n');
});

test('an unquoted value with a dollar reference stays unquoted', () => {
  const file = parse('A=$B/${C}\nB=1\nC=2\n');
  assert.equal(serializeEnvFile(file), 'A=$B/${C}\nB=1\nC=2\n');
  const reparsed = parse(serializeEnvFile(file));
  assert.deepEqual(reparsed.decls[0]?.references, ['B', 'C']);
});
