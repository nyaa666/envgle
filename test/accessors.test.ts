import assert from 'node:assert/strict';
import { test } from 'node:test';
import { scanTextFile, supportedAccessors } from '../src/scan/code.js';
import { lineText, sortedUnique } from '../src/utils/text.js';
import type { Extractor, ExtractionContext } from '../src/scan/code.js';
import type { EnvUsage, Language, SourceLocation } from '../src/types.js';

const PATH = 'app/config.js';

const ALL_LANGUAGES: readonly Language[] = [
  'javascript',
  'typescript',
  'python',
  'go',
  'rust',
  'java',
  'kotlin',
  'csharp',
  'ruby',
  'php',
  'perl',
  'shell',
  'batch',
  'swift',
  'dart',
  'elixir',
  'unknown',
];

/** hasFallback, required, viaImport for the plain read of one accessor. */
type Flags = readonly [boolean, boolean, boolean];

interface Canonical {
  readonly id: string;
  readonly language: Language;
  readonly source: string;
  readonly name: string;
  readonly flags: Flags;
  readonly literal?: string;
}

const CANONICAL: readonly Canonical[] = [
  { id: 'js-process-env', language: 'typescript', source: 'const a = process.env.CANON_ONE;', name: 'CANON_ONE', flags: [false, false, false] },
  { id: 'js-process-env-destructuring', language: 'typescript', source: 'const { CANON_TWO } = process.env;', name: 'CANON_TWO', flags: [false, false, false] },
  { id: 'js-import-meta-env', language: 'typescript', source: 'const a = import.meta.env.VITE_CANON;', name: 'VITE_CANON', flags: [false, false, false] },
  { id: 'js-bun-env', language: 'typescript', source: "const a = Bun.env['BUN_CANON'];", name: 'BUN_CANON', flags: [false, false, false] },
  { id: 'js-deno-env-get', language: 'typescript', source: "const a = Deno.env.get('DENO_CANON');", name: 'DENO_CANON', flags: [false, false, false] },
  { id: 'js-env-static-import', language: 'typescript', source: "import { CANON_STATIC } from '$env/static/private';", name: 'CANON_STATIC', flags: [false, true, true] },
  { id: 'js-env-dynamic-import', language: 'typescript', source: "import { env } from '$env/dynamic/private';\nconst a = env.CANON_DYNAMIC;", name: 'CANON_DYNAMIC', flags: [false, false, true] },
  { id: 'py-os-environ-index', language: 'python', source: "a = os.environ['CANON_PY_ONE']", name: 'CANON_PY_ONE', flags: [false, true, false] },
  { id: 'py-os-environ-get', language: 'python', source: "a = os.environ.get('CANON_PY_TWO')", name: 'CANON_PY_TWO', flags: [false, false, false] },
  { id: 'py-os-environ-setdefault', language: 'python', source: "a = os.environ.setdefault('CANON_PY_THREE', 'x')", name: 'CANON_PY_THREE', flags: [true, false, false], literal: 'x' },
  { id: 'py-os-getenv', language: 'python', source: "a = os.getenv('CANON_PY_FOUR')", name: 'CANON_PY_FOUR', flags: [false, false, false] },
  { id: 'py-environ-import', language: 'python', source: "from os import environ\na = environ['CANON_PY_FIVE']", name: 'CANON_PY_FIVE', flags: [false, true, false] },
  { id: 'py-pydantic-settings', language: 'python', source: 'class S(BaseSettings):\n    canon_six: str', name: 'canon_six', flags: [false, true, false] },
  { id: 'go-os-getenv', language: 'go', source: 'package m\nfunc f() { _ = os.Getenv("CANON_GO_ONE") }', name: 'CANON_GO_ONE', flags: [false, false, false] },
  { id: 'go-bare-getenv', language: 'go', source: 'package m\nimport "os"\nfunc f() { _ = Getenv("CANON_GO_TWO") }', name: 'CANON_GO_TWO', flags: [false, false, false] },
  { id: 'go-os-lookupenv', language: 'go', source: 'package m\nfunc f() { _, _ = os.LookupEnv("CANON_GO_THREE") }', name: 'CANON_GO_THREE', flags: [true, false, false] },
  { id: 'rust-env-var', language: 'rust', source: 'fn f() { let _ = env::var("CANON_RS_ONE"); }', name: 'CANON_RS_ONE', flags: [false, false, false] },
  { id: 'rust-bare-var', language: 'rust', source: 'use std::env::var;\nfn f() { let _ = var("CANON_RS_TWO"); }', name: 'CANON_RS_TWO', flags: [false, false, false] },
  { id: 'jvm-system-getenv', language: 'java', source: 'class A { String a = System.getenv("CANON_JVM_ONE"); }', name: 'CANON_JVM_ONE', flags: [false, false, false] },
  { id: 'jvm-system-getproperty', language: 'kotlin', source: 'val a = System.getProperty("CANON_JVM_TWO")', name: 'CANON_JVM_TWO', flags: [false, false, false] },
  { id: 'cs-get-environment-variable', language: 'csharp', source: 'class A { void M() { var a = Environment.GetEnvironmentVariable("CANON_CS_ONE"); } }', name: 'CANON_CS_ONE', flags: [false, false, false] },
  { id: 'cs-iconfiguration', language: 'csharp', source: 'class A { void M() { var a = configuration["CANON_CS_TWO"]; } }', name: 'CANON_CS_TWO', flags: [false, false, false] },
  { id: 'cs-get-connection-string', language: 'csharp', source: 'class A { void M() { var a = Configuration.GetConnectionString("CANON_CS_THREE"); } }', name: 'CANON_CS_THREE', flags: [false, true, false] },
  { id: 'rb-env-index', language: 'ruby', source: "a = ENV['CANON_RB_ONE']", name: 'CANON_RB_ONE', flags: [false, true, false] },
  { id: 'rb-env-fetch', language: 'ruby', source: "a = ENV.fetch('CANON_RB_TWO')", name: 'CANON_RB_TWO', flags: [false, true, false] },
  { id: 'php-getenv', language: 'php', source: "<?php\n$a = getenv('CANON_PHP_ONE');", name: 'CANON_PHP_ONE', flags: [false, false, false] },
  { id: 'php-env-superglobal', language: 'php', source: "<?php\n$a = $_ENV['CANON_PHP_TWO'];", name: 'CANON_PHP_TWO', flags: [false, false, false] },
  { id: 'php-server-superglobal', language: 'php', source: "<?php\n$a = $_SERVER['CANON_PHP_THREE'];", name: 'CANON_PHP_THREE', flags: [false, false, false] },
  { id: 'php-laravel-env', language: 'php', source: "<?php\n$a = env('CANON_PHP_FOUR');", name: 'CANON_PHP_FOUR', flags: [false, false, false] },
  { id: 'perl-env', language: 'perl', source: 'my $a = $ENV{CANON_PERL_ONE};', name: 'CANON_PERL_ONE', flags: [false, false, false] },
  { id: 'sh-parameter', language: 'shell', source: 'echo "$CANON_SH_ONE"', name: 'CANON_SH_ONE', flags: [false, false, false] },
  { id: 'sh-printenv', language: 'shell', source: 'printenv CANON_SH_TWO', name: 'CANON_SH_TWO', flags: [false, true, false] },
  { id: 'batch-parameter', language: 'batch', source: 'echo %CANON_BATCH_ONE%', name: 'CANON_BATCH_ONE', flags: [false, false, false] },
  { id: 'batch-defined', language: 'batch', source: 'if defined CANON_BATCH_TWO echo x', name: 'CANON_BATCH_TWO', flags: [false, false, false] },
  { id: 'swift-process-environment', language: 'swift', source: 'let a = ProcessInfo.processInfo.environment["CANON_SWIFT_ONE"]', name: 'CANON_SWIFT_ONE', flags: [false, false, false] },
  { id: 'swift-environment-foundation', language: 'swift', source: 'import Foundation\nlet a = environment["CANON_SWIFT_TWO"]', name: 'CANON_SWIFT_TWO', flags: [false, false, false] },
  { id: 'dart-platform-environment', language: 'dart', source: "var a = Platform.environment['CANON_DART_ONE'];", name: 'CANON_DART_ONE', flags: [false, false, false] },
  { id: 'dart-string-from-environment', language: 'dart', source: "var a = String.fromEnvironment('CANON_DART_TWO');", name: 'CANON_DART_TWO', flags: [false, false, false] },
  { id: 'ex-system-get-env', language: 'elixir', source: 'System.get_env("CANON_EX_ONE")', name: 'CANON_EX_ONE', flags: [false, false, false] },
  { id: 'ex-system-fetch-env', language: 'elixir', source: 'System.fetch_env("CANON_EX_TWO")', name: 'CANON_EX_TWO', flags: [false, false, false] },
  { id: 'ex-system-fetch-env-bang', language: 'elixir', source: 'System.fetch_env!("CANON_EX_THREE")', name: 'CANON_EX_THREE', flags: [false, true, false] },
];

interface Collected {
  readonly usage: EnvUsage;
  readonly location: SourceLocation | undefined;
}

const runExtractorRaw = (
  extractor: Extractor,
  language: Language,
  text: string,
): readonly Collected[] => {
  const collected: Collected[] = [];
  const context: ExtractionContext = {
    file: PATH,
    language,
    text,
    lines: text.split('\n'),
    push(usage, location) {
      collected.push({ usage, location });
    },
  };
  extractor.extract(context);
  return collected;
};

const applyLocation = ({ usage, location }: Collected): EnvUsage => ({
  ...usage,
  file: location?.file ?? usage.file,
  line: location?.line ?? usage.line,
  column: location?.column ?? usage.column,
});

const runExtractor = (extractor: Extractor, language: Language, text: string): readonly EnvUsage[] =>
  runExtractorRaw(extractor, language, text).map(applyLocation);

const byId = (id: string): Extractor => {
  const extractor = supportedAccessors().find((candidate) => candidate.id === id);
  assert.ok(extractor !== undefined, `no extractor with id ${id}`);
  return extractor;
};

const canonicalUsage = (item: Canonical): EnvUsage => {
  const found = runExtractor(byId(item.id), item.language, item.source).find(
    (usage) => usage.name === item.name,
  );
  assert.ok(found !== undefined, `${item.id} found no usage for ${item.name}`);
  return found;
};

test('supportedAccessors exposes a stable, non-empty accessor list', () => {
  const extractors = supportedAccessors();
  assert.ok(extractors.length > 0);
  assert.equal(supportedAccessors(), extractors);
});

test('supportedAccessors has unique ids and complete metadata', () => {
  const ids = supportedAccessors().map((extractor) => extractor.id);
  assert.deepEqual(sortedUnique(ids).length, ids.length);
  for (const extractor of supportedAccessors()) {
    assert.notEqual(extractor.id.trim(), '');
    assert.notEqual(extractor.accessor.trim(), '');
    assert.notEqual(extractor.comment.trim(), '');
    assert.equal(extractor.comment.includes('\n'), false);
    assert.ok(extractor.languages.length > 0);
  }
});

test('supportedAccessors covers every language that has an extractor and never unknown', () => {
  const covered = new Set<Language>();
  for (const extractor of supportedAccessors()) {
    for (const language of extractor.languages) {
      covered.add(language);
    }
  }
  assert.equal(covered.has('unknown'), false);
  const expected = ALL_LANGUAGES.filter((language) => language !== 'unknown');
  assert.deepEqual([...covered].sort(), [...expected].sort());
});

test('every extractor is reachable from a canonical snippet', () => {
  for (const item of CANONICAL) {
    const extractor = byId(item.id);
    const usage = canonicalUsage(item);
    assert.equal(usage.accessor, extractor.accessor);
    assert.equal(usage.language, item.language);
    assert.equal(usage.file, PATH);
    assert.notEqual(lineText(item.source, usage.line).charAt(usage.column - 1), '');
  }
});

test('every extractor has a canonical snippet', () => {
  const covered = new Set(CANONICAL.map((item) => item.id));
  const missing = supportedAccessors()
    .map((extractor) => extractor.id)
    .filter((id) => !covered.has(id));
  assert.deepEqual(missing, []);
});

test('each accessor reports the documented flags for a plain read', () => {
  for (const item of CANONICAL) {
    const usage = canonicalUsage(item);
    assert.deepEqual(
      [usage.hasFallback, usage.required, usage.viaImport],
      item.flags,
      `${item.id} flags`,
    );
    assert.equal(usage.fallbackLiteral, item.literal ?? null, `${item.id} literal`);
  }
});

test('the canonical table covers every distinct accessor the scanner can emit', () => {
  const emitted = new Set<string>();
  for (const item of CANONICAL) {
    for (const usage of runExtractor(byId(item.id), item.language, item.source)) {
      emitted.add(usage.accessor);
    }
  }
  const declared = new Set(CANONICAL.map((item) => byId(item.id).accessor));
  assert.deepEqual(sortedUnique([...emitted]), sortedUnique([...declared]));
});

test('an import binding reports through the location override of push', () => {
  const source = "import { IMPORTED_ONE } from '$env/static/private';";
  const collected = runExtractorRaw(byId('js-env-static-import'), 'typescript', source);
  assert.equal(collected.length, 1);
  const entry = collected[0];
  assert.ok(entry !== undefined);
  assert.equal(entry.usage.name, 'IMPORTED_ONE');
  assert.deepEqual(entry.location, { file: PATH, line: 1, column: 10 });
  const applied = applyLocation(entry);
  assert.deepEqual({ line: applied.line, column: applied.column }, { line: 1, column: 10 });
  assert.ok(lineText(source, 1).slice(applied.column - 1).startsWith('IMPORTED_ONE } from'));
});

test('scanTextFile applies the location override to the reported position', () => {
  const usages = scanTextFile({
    path: PATH,
    language: 'typescript',
    text: "import { OVERRIDDEN } from '$env/static/public';",
    lines: ["import { OVERRIDDEN } from '$env/static/public';"],
  });
  assert.deepEqual(
    usages.map((usage) => `${usage.name}@${usage.line}:${usage.column}`),
    ['OVERRIDDEN@1:10'],
  );
});

test('no extractor throws on malformed, truncated or binary-looking input', () => {
  const garbage: readonly string[] = [
    '',
    ' ',
    ' ',
    '�',
    '"'.repeat(200),
    "'".repeat(200),
    '`'.repeat(200),
    '/*'.repeat(200),
    '//'.repeat(200),
    '${'.repeat(200),
    '{'.repeat(200),
    '#'.repeat(200),
    '%'.repeat(200),
    '::'.repeat(200),
    'rem '.repeat(100),
    'process.env.',
    'env::var(',
    'printenv',
    'use std::env::var;',
    'class S(BaseSettings):',
  ];
  for (const extractor of supportedAccessors()) {
    for (const language of extractor.languages) {
      for (const text of garbage) {
        assert.doesNotThrow(
          () => runExtractor(extractor, language, text),
          `${extractor.id} threw on ${JSON.stringify(text.slice(0, 12))}`,
        );
      }
    }
  }
});

test('scanTextFile merges every accessor of a polyglot file set', () => {
  const files: readonly (readonly [Language, string])[] = [
    ['typescript', 'const a = process.env.MERGED_ONE;'],
    ['python', "a = os.getenv('MERGED_TWO')"],
    ['go', 'package m\nfunc f() { _ = os.Getenv("MERGED_THREE") }'],
    ['ruby', "a = ENV['MERGED_FOUR']"],
  ];
  const collected = files.flatMap(([language, text]) =>
    scanTextFile({ path: PATH, language, text, lines: text.split('\n') }),
  );
  assert.deepEqual(
    collected.map((usage) => usage.name),
    ['MERGED_ONE', 'MERGED_TWO', 'MERGED_THREE', 'MERGED_FOUR'],
  );
  assert.deepEqual(
    collected.map((usage) => usage.accessor),
    ['process.env', 'os.getenv', 'os.Getenv', 'ENV'],
  );
});
