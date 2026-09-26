import assert from 'node:assert/strict';
import test from 'node:test';
import type {
  EnvFileInfo,
  EnvFileKind,
  EnvParseIssue,
  EnvVarDecl,
  Finding,
  Report,
  ResolvedConfig,
  RuleId,
} from '../src/types.js';
import { buildContext, runRules } from '../src/rules/context.js';
import { hygieneRules } from '../src/rules/hygiene.js';
import { DEFAULT_SECRET_NAME_PATTERN, fingerprint } from '../src/utils/text.js';

const BASE_CONFIG: ResolvedConfig = {
  include: ['**/*'],
  exclude: ['node_modules'],
  envFiles: ['**/.env*'],
  exampleFiles: ['**/.env.example'],
  ignoreRules: new Set<RuleId>(),
  ignoreVariables: [],
  ignoreFingerprints: new Set<string>(),
  severities: {},
  weakValues: new Set<string>(),
  hostileNames: new Set<string>(),
  reservedNames: new Set<string>(),
  secretPatterns: [],
  secretNamePattern: DEFAULT_SECRET_NAME_PATTERN,
  maxFileSizeBytes: 262144,
  maxLineLength: 4096,
  ciEnvironmentKinds: {},
  failOn: 'error',
  codeFrameLines: 2,
  followSymlinks: false,
  requireExampleFile: true,
  source: null,
  warnings: [],
};

const makeConfig = (overrides: Partial<ResolvedConfig> = {}): ResolvedConfig => ({ ...BASE_CONFIG, ...overrides });

interface DeclOptions {
  readonly column?: number;
  readonly value?: string;
  readonly hasValue?: boolean;
  readonly quoted?: '"' | "'" | null;
  readonly exported?: boolean;
  readonly references?: readonly string[];
  readonly duplicateOfLine?: number | null;
  readonly unquotedInlineComment?: string | null;
  readonly kind?: EnvFileKind;
  readonly shared?: boolean;
  readonly devOnly?: boolean;
}

const decl = (name: string, file: string, line: number, options: DeclOptions = {}): EnvVarDecl => ({
  name,
  file,
  line,
  column: options.column ?? 1,
  value: options.value ?? 'value',
  hasValue: options.hasValue ?? true,
  quoted: options.quoted ?? null,
  exported: options.exported ?? false,
  references: options.references ?? [],
  duplicateOfLine: options.duplicateOfLine ?? null,
  leadingComments: [],
  inlineComment: null,
  unquotedInlineComment: options.unquotedInlineComment ?? null,
  hasTrailingWhitespace: false,
  kind: options.kind ?? 'dev',
  shared: options.shared ?? true,
  devOnly: options.devOnly ?? false,
});

interface FileOptions {
  readonly kind?: EnvFileKind;
  readonly devOnly?: boolean;
  readonly shared?: boolean;
  readonly committed?: boolean;
  readonly issues?: readonly EnvParseIssue[];
}

const fileInfo = (path: string, options: FileOptions = {}): EnvFileInfo => ({
  path,
  kind: options.kind ?? 'dev',
  exists: true,
  shared: options.shared ?? true,
  devOnly: options.devOnly ?? false,
  tracked: true,
  declCount: 0,
  issues: options.issues ?? [],
  committed: options.committed ?? true,
  byteSize: 12,
});

const issue = (
  kind: EnvParseIssue['kind'],
  message: string,
  line: number,
  column = 1,
): EnvParseIssue => ({ kind, message, file: '.env', line, column });

interface Parts {
  readonly files?: readonly EnvFileInfo[];
  readonly decls?: readonly EnvVarDecl[];
}

const makeReport = (parts: Parts): Report => {
  const files = new Map<string, EnvFileInfo>();
  for (const item of parts.decls ?? []) {
    if (!files.has(item.file)) {
      files.set(
        item.file,
        fileInfo(item.file, {
          kind: item.kind,
          shared: item.shared,
          devOnly: item.devOnly,
          committed: !item.devOnly,
        }),
      );
    }
  }
  for (const file of parts.files ?? []) {
    files.set(file.path, file);
  }
  return {
    tool: { name: 'envgle', version: '0.1.0' },
    root: '/repo',
    startedAt: '2024-01-01T00:00:00.000Z',
    durationMs: 1,
    filesScanned: files.size,
    bytesScanned: 12,
    filesSkipped: 0,
    skipped: [],
    files: [...files.values()],
    decls: parts.decls ?? [],
    usages: [],
    infra: [],
    manifest: null,
    findings: [],
    summary: {
      error: 0,
      warn: 0,
      info: 0,
      total: 0,
      byRule: {},
      variables: 0,
      declared: 0,
      read: 0,
      secretish: 0,
      filesScanned: files.size,
      filesWithFindings: 0,
      rulesFired: 0,
    },
  };
};

const run = (ruleId: RuleId, parts: Parts, config: ResolvedConfig = makeConfig()): readonly Finding[] => {
  const rule = hygieneRules.find((item) => item.id === ruleId);
  assert.ok(rule !== undefined, `hygiene rule ${ruleId} is missing`);
  const result = runRules(buildContext({ report: makeReport(parts), config }), [rule]);
  assert.deepEqual(result.errors, []);
  return result.findings;
};

const tuple = (finding: Finding): readonly (string | number | null)[] => [
  finding.ruleId,
  finding.file,
  finding.line,
  finding.column,
  finding.severity,
  finding.variable ?? null,
];

const tuples = (findings: readonly Finding[]): readonly (readonly (string | number | null)[])[] =>
  findings.map((finding) => tuple(finding));

test('duplicate-key reports every repeated assignment with the earlier line', () => {
  const findings = run('duplicate-key', {
    decls: [decl('PORT', '.env', 7, { duplicateOfLine: 3, column: 4 }), decl('PORT', '.env', 3)],
  });

  assert.deepEqual(tuples(findings), [['duplicate-key', '.env', 7, 4, 'error', 'PORT']]);
  assert.match(findings[0]?.message ?? '', /line 3 of \.env/);
  assert.match(findings[0]?.hint ?? '', /delete the earlier assignment on line 3/);
});

test('duplicate-key stays quiet for a first assignment', () => {
  const findings = run('duplicate-key', { decls: [decl('PORT', '.env', 3), decl('HOST', '.env', 4)] });

  assert.deepEqual(findings, []);
});

test('duplicate-key honours ignoreRules, ignoreVariables and severities', () => {
  const parts: Parts = { decls: [decl('PORT', '.env', 7, { duplicateOfLine: 3 })] };

  assert.deepEqual(run('duplicate-key', parts, makeConfig({ ignoreRules: new Set<RuleId>(['duplicate-key']) })), []);
  assert.deepEqual(run('duplicate-key', parts, makeConfig({ ignoreVariables: ['PORT'] })), []);
  assert.equal(
    run('duplicate-key', parts, makeConfig({ severities: { 'duplicate-key': 'warn' } }))[0]?.severity,
    'warn',
  );
});

test('conflicting-values reports every later declaration with a truncated preview', () => {
  const findings = run('conflicting-values', {
    decls: [
      decl('API_URL', '.env', 1, { value: 'https://alpha.example.com/very-long-path/v1' }),
      decl('API_URL', '.env.prod', 2, { value: 'https://beta.example.com/v2' }),
    ],
  });

  assert.deepEqual(tuples(findings), [['conflicting-values', '.env.prod', 2, 1, 'warn', 'API_URL']]);
  const message = findings[0]?.message ?? '';
  assert.match(message, /^API_URL is /);
  assert.match(message, / in \.env\.prod but /);
  assert.equal(message.includes(' in .env, and '), true);
  assert.match(message, /loader precedence decides silently$/);
  assert.equal(message.includes('https://alpha.example.com/very-long-path/v1'), false);
  assert.equal(message.includes('https://beta.example.com/v2'), false);
  assert.match(message, /\u2026/);
});

test('conflicting-values never prints a secret value and exposes a fingerprint instead', () => {
  const findings = run('conflicting-values', {
    decls: [
      decl('API_TOKEN', '.env', 1, { value: 'alpha-secret-value-1234' }),
      decl('API_TOKEN', '.env.prod', 2, { value: 'beta-secret-value-5678' }),
    ],
  });

  const message = findings[0]?.message ?? '';
  assert.match(message, /different secret values in \.env and \.env\.prod/);
  assert.equal(message.includes('alpha-secret-value-1234'), false);
  assert.equal(message.includes('beta-secret-value-5678'), false);
  assert.equal(findings[0]?.fingerprint, fingerprint('beta-secret-value-5678'));
});

test('conflicting-values stays quiet for equal values and for example files', () => {
  const equal = run('conflicting-values', {
    decls: [decl('API_URL', '.env', 1, { value: 'same' }), decl('API_URL', '.env.prod', 2, { value: 'same' })],
  });
  const exampleOnly = run('conflicting-values', {
    decls: [
      decl('API_URL', '.env.example', 1, { value: 'a', kind: 'example' }),
      decl('API_URL', '.env.local', 2, { value: 'b', kind: 'local', devOnly: true }),
    ],
  });

  assert.deepEqual(equal, []);
  assert.deepEqual(exampleOnly, []);
});

test('conflicting-values honours ignoreRules, ignoreVariables and severities', () => {
  const parts: Parts = {
    decls: [decl('API_URL', '.env', 1, { value: 'a' }), decl('API_URL', '.env.prod', 2, { value: 'b' })],
  };

  assert.deepEqual(
    run('conflicting-values', parts, makeConfig({ ignoreRules: new Set<RuleId>(['conflicting-values']) })),
    [],
  );
  assert.deepEqual(run('conflicting-values', parts, makeConfig({ ignoreVariables: ['API_*'] })), []);
  assert.equal(
    run('conflicting-values', parts, makeConfig({ severities: { 'conflicting-values': 'error' } }))[0]?.severity,
    'error',
  );
});

test('empty-value reports a key with no value in a real env file', () => {
  const findings = run('empty-value', { decls: [decl('PORT', '.env', 4, { value: '', hasValue: false, column: 3 })] });

  assert.deepEqual(tuples(findings), [['empty-value', '.env', 4, 3, 'info', 'PORT']]);
  assert.equal(findings[0]?.message, 'PORT has no value in .env');
  assert.match(findings[0]?.hint ?? '', /example file/);
});

test('empty-value stays quiet for filled values and for the example file', () => {
  const filled = run('empty-value', { decls: [decl('PORT', '.env', 4, { value: '3000' })] });
  const example = run('empty-value', {
    decls: [decl('PORT', '.env.example', 4, { value: '', hasValue: false, kind: 'example' })],
  });

  assert.deepEqual(filled, []);
  assert.deepEqual(example, []);
});

test('empty-value honours ignoreRules, ignoreVariables and severities', () => {
  const parts: Parts = { decls: [decl('PORT', '.env', 4, { value: '', hasValue: false })] };

  assert.deepEqual(run('empty-value', parts, makeConfig({ ignoreRules: new Set<RuleId>(['empty-value']) })), []);
  assert.deepEqual(run('empty-value', parts, makeConfig({ ignoreVariables: ['P*'] })), []);
  assert.equal(run('empty-value', parts, makeConfig({ severities: { 'empty-value': 'warn' } }))[0]?.severity, 'warn');
});

test('unquoted-special-chars names the offending character classes', () => {
  const findings = run('unquoted-special-chars', {
    decls: [decl('MESSAGE', '.env', 8, { value: 'hello world #x' })],
  });

  assert.deepEqual(tuples(findings), [['unquoted-special-chars', '.env', 8, 1, 'warn', 'MESSAGE']]);
  const message = findings[0]?.message ?? '';
  assert.match(message, /^MESSAGE is unquoted but contains whitespace, # in \.env \(hello world #x\)$/);
  assert.match(findings[0]?.hint ?? '', /double quotes/);
});

test('unquoted-special-chars escapes line breaks and ignores quoted values', () => {
  const multiline = run('unquoted-special-chars', { decls: [decl('MESSAGE', '.env', 8, { value: 'a\nb' })] });
  const quoted = run('unquoted-special-chars', {
    decls: [decl('MESSAGE', '.env', 8, { value: 'hello world', quoted: '"' })],
  });

  assert.equal((multiline[0]?.message ?? '').includes('\n'), false);
  assert.match(multiline[0]?.message ?? '', /a\\nb/);
  assert.match(multiline[0]?.message ?? '', /line break/);
  assert.deepEqual(quoted, []);
});

test('unquoted-special-chars honours ignoreRules, ignoreVariables and severities', () => {
  const parts: Parts = { decls: [decl('MESSAGE', '.env', 8, { value: 'hello world' })] };

  assert.deepEqual(
    run('unquoted-special-chars', parts, makeConfig({ ignoreRules: new Set<RuleId>(['unquoted-special-chars']) })),
    [],
  );
  assert.deepEqual(run('unquoted-special-chars', parts, makeConfig({ ignoreVariables: ['MESSAGE'] })), []);
  assert.equal(
    run('unquoted-special-chars', parts, makeConfig({ severities: { 'unquoted-special-chars': 'error' } }))[0]
      ?.severity,
    'error',
  );
});

test('inline-comment-truncation explains the loader split', () => {
  const findings = run('inline-comment-truncation', {
    decls: [decl('PORT', '.env', 6, { value: '3000', unquotedInlineComment: ' the port' })],
  });

  assert.deepEqual(tuples(findings), [['inline-comment-truncation', '.env', 6, 1, 'warn', 'PORT']]);
  const message = findings[0]?.message ?? '';
  assert.match(message, /dotenv strips it/);
  assert.match(message, /docker --env-file and set -a; source keep it in the value/);
  assert.match(findings[0]?.hint ?? '', /own line/);
});

test('inline-comment-truncation stays quiet without a comment or without a value', () => {
  const noComment = run('inline-comment-truncation', { decls: [decl('PORT', '.env', 6, { value: '3000' })] });
  const noValue = run('inline-comment-truncation', {
    decls: [decl('PORT', '.env', 6, { value: '', hasValue: false, unquotedInlineComment: ' the port' })],
  });

  assert.deepEqual(noComment, []);
  assert.deepEqual(noValue, []);
});

test('inline-comment-truncation honours ignoreRules, ignoreVariables and severities', () => {
  const parts: Parts = { decls: [decl('PORT', '.env', 6, { value: '3000', unquotedInlineComment: ' the port' })] };

  assert.deepEqual(
    run('inline-comment-truncation', parts, makeConfig({ ignoreRules: new Set<RuleId>(['inline-comment-truncation']) })),
    [],
  );
  assert.deepEqual(run('inline-comment-truncation', parts, makeConfig({ ignoreVariables: ['PORT'] })), []);
  assert.equal(
    run('inline-comment-truncation', parts, makeConfig({ severities: { 'inline-comment-truncation': 'error' } }))[0]
      ?.severity,
    'error',
  );
});

test('export-prefix reports an exported key', () => {
  const findings = run('export-prefix', { decls: [decl('PATH_EXTRA', '.env', 2, { exported: true })] });

  assert.deepEqual(tuples(findings), [['export-prefix', '.env', 2, 1, 'info', 'PATH_EXTRA']]);
  assert.match(findings[0]?.message ?? '', /not valid for dotenv, docker run --env-file or systemd/);
  assert.match(findings[0]?.hint ?? '', /drop the export keyword/i);
});

test('export-prefix stays quiet for a plain key', () => {
  assert.deepEqual(run('export-prefix', { decls: [decl('PATH_EXTRA', '.env', 2)] }), []);
});

test('export-prefix honours ignoreRules, ignoreVariables and severities', () => {
  const parts: Parts = { decls: [decl('PATH_EXTRA', '.env', 2, { exported: true })] };

  assert.deepEqual(run('export-prefix', parts, makeConfig({ ignoreRules: new Set<RuleId>(['export-prefix']) })), []);
  assert.deepEqual(run('export-prefix', parts, makeConfig({ ignoreVariables: ['PATH_*'] })), []);
  assert.equal(
    run('export-prefix', parts, makeConfig({ severities: { 'export-prefix': 'error' } }))[0]?.severity,
    'error',
  );
});

test('unterminated-quote reports every parse issue once per file and line', () => {
  const findings = run('unterminated-quote', {
    files: [
      fileInfo('.env', {
        issues: [
          issue('unterminated-quote', 'unterminated double quote', 3),
          issue('unterminated-quote', 'unterminated double quote', 3, 12),
          issue('no-separator', 'missing "=" separator', 5),
          issue('unknown', 'unexpected line', 7, 4),
        ],
      }),
      fileInfo('.env.local', { issues: [issue('unterminated-quote', 'unterminated double quote', 3)] }),
    ],
  });

  assert.deepEqual(tuples(findings), [
    ['unterminated-quote', '.env', 3, 1, 'error', null],
    ['unterminated-quote', '.env', 5, 1, 'error', null],
    ['unterminated-quote', '.env', 7, 4, 'error', null],
    ['unterminated-quote', '.env.local', 3, 1, 'error', null],
  ]);
  assert.equal(findings[0]?.message, 'unterminated double quote (.env line 3)');
  assert.equal(findings[1]?.message, 'no-separator: missing "=" separator (.env line 5)');
  assert.equal(findings[2]?.message, 'unknown: unexpected line (.env line 7)');
});

test('unterminated-quote stays quiet for a clean file', () => {
  assert.deepEqual(run('unterminated-quote', { files: [fileInfo('.env')] }), []);
  assert.deepEqual(run('unterminated-quote', { decls: [decl('PORT', '.env', 1)] }), []);
});

test('unterminated-quote honours ignoreRules and severities', () => {
  const parts: Parts = { files: [fileInfo('.env', { issues: [issue('unterminated-quote', 'unterminated double quote', 3)] })] };

  assert.deepEqual(
    run('unterminated-quote', parts, makeConfig({ ignoreRules: new Set<RuleId>(['unterminated-quote']) })),
    [],
  );
  assert.equal(
    run('unterminated-quote', parts, makeConfig({ severities: { 'unterminated-quote': 'warn' } }))[0]?.severity,
    'warn',
  );
});

test('expansion-unsupported reports expansion in a shared env file', () => {
  const findings = run('expansion-unsupported', {
    decls: [decl('DATABASE_URL', '.env', 6, { column: 2, value: '${BASE_URL}/db', references: ['BASE_URL'] })],
  });

  assert.deepEqual(tuples(findings), [['expansion-unsupported', '.env', 6, 2, 'warn', 'DATABASE_URL']]);
  assert.match(findings[0]?.message ?? '', /DATABASE_URL expands \$\{BASE_URL\} in \.env/);
  assert.match(findings[0]?.message ?? '', /docker compose env_file, systemd and most CI loaders do not support it/);
  assert.match(findings[0]?.hint ?? '', /precompute the value or use dotenv-expand/);
});

test('expansion-unsupported stays quiet for plain, local and example files', () => {
  const plain = run('expansion-unsupported', { decls: [decl('DATABASE_URL', '.env', 6, { value: 'postgres://x' })] });
  const local = run('expansion-unsupported', {
    decls: [decl('DATABASE_URL', '.env.local', 1, { kind: 'local', devOnly: true, references: ['BASE_URL'] })],
  });
  const example = run('expansion-unsupported', {
    decls: [decl('DATABASE_URL', '.env.example', 1, { kind: 'example', references: ['BASE_URL'] })],
  });

  assert.deepEqual(plain, []);
  assert.deepEqual(local, []);
  assert.deepEqual(example, []);
});

test('expansion-unsupported reports one finding per name and file', () => {
  const findings = run('expansion-unsupported', {
    decls: [
      decl('DATABASE_URL', '.env', 6, { references: ['BASE_URL'] }),
      decl('DATABASE_URL', '.env.prod', 2, { references: ['BASE_URL'] }),
    ],
  });

  assert.deepEqual(tuples(findings), [
    ['expansion-unsupported', '.env', 6, 1, 'warn', 'DATABASE_URL'],
    ['expansion-unsupported', '.env.prod', 2, 1, 'warn', 'DATABASE_URL'],
  ]);
});

test('expansion-unsupported honours ignoreRules, ignoreVariables and severities', () => {
  const parts: Parts = { decls: [decl('DATABASE_URL', '.env', 6, { references: ['BASE_URL'] })] };

  assert.deepEqual(
    run('expansion-unsupported', parts, makeConfig({ ignoreRules: new Set<RuleId>(['expansion-unsupported']) })),
    [],
  );
  assert.deepEqual(run('expansion-unsupported', parts, makeConfig({ ignoreVariables: ['DATABASE_*'] })), []);
  assert.equal(
    run('expansion-unsupported', parts, makeConfig({ severities: { 'expansion-unsupported': 'error' } }))[0]
      ?.severity,
    'error',
  );
});
