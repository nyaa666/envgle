import assert from 'node:assert/strict';
import test from 'node:test';
import type {
  EnvFileInfo,
  EnvUsage,
  EnvVarDecl,
  Finding,
  FindingInput,
  InfraRef,
  Report,
  ResolvedConfig,
  Rule,
  RuleContext,
  RuleId,
  Severity,
} from '../src/types.js';
import { buildContext, isIgnoredVariable, runRules } from '../src/rules/context.js';
import { ruleDocsUrl } from '../src/version.js';
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

const makeDecl = (name: string, file: string, line: number, column = 1): EnvVarDecl => ({
  name,
  file,
  line,
  column,
  value: 'v',
  hasValue: true,
  quoted: null,
  exported: false,
  references: [],
  duplicateOfLine: null,
  leadingComments: [],
  inlineComment: null,
  unquotedInlineComment: null,
  hasTrailingWhitespace: false,
  kind: 'dev',
  shared: true,
  devOnly: false,
});

const makeUsage = (name: string, file: string, line: number, column = 1): EnvUsage => ({
  name,
  file,
  line,
  column,
  language: 'typescript',
  accessor: 'process.env',
  hasFallback: false,
  required: false,
  viaImport: false,
  fallbackLiteral: null,
});

const makeRef = (name: string, file: string, line: number, column = 1): InfraRef => ({
  name,
  file,
  line,
  column,
  kind: 'ci-env',
  required: false,
  refersToFile: false,
  interpolation: false,
});

const makeFile = (path: string, overrides: Partial<EnvFileInfo> = {}): EnvFileInfo => ({
  path,
  kind: 'dev',
  exists: true,
  shared: true,
  devOnly: false,
  tracked: true,
  declCount: 0,
  issues: [],
  committed: true,
  byteSize: 10,
  ...overrides,
});

const makeReport = (parts: {
  readonly files?: readonly EnvFileInfo[];
  readonly decls?: readonly EnvVarDecl[];
  readonly usages?: readonly EnvUsage[];
  readonly infra?: readonly InfraRef[];
}): Report => ({
  tool: { name: 'envgle', version: '0.1.0' },
  root: '/repo',
  startedAt: '2024-01-01T00:00:00.000Z',
  durationMs: 1,
  filesScanned: 1,
  bytesScanned: 10,
  filesSkipped: 0,
  skipped: [],
  files: parts.files ?? [],
  decls: parts.decls ?? [],
  usages: parts.usages ?? [],
  infra: parts.infra ?? [],
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
    filesScanned: 0,
    filesWithFindings: 0,
    rulesFired: 0,
  },
});

const input = (
  ruleId: RuleId,
  file: string,
  line: number,
  column: number,
  extra: Partial<FindingInput> = {},
): FindingInput => ({
  ruleId,
  message: 'message',
  location: { file, line, column },
  ...extra,
});

const fakeRule = (
  id: RuleId,
  severity: Severity,
  inputs: readonly FindingInput[],
  check?: (context: RuleContext) => void,
): Rule => ({
  id,
  title: `title ${id}`,
  severity,
  description: 'fake rule for the context tests',
  docs: `docs/rules.md#${id}`,
  remediation: 'fix it',
  tags: ['correctness'],
  check:
    check ??
    ((context) => {
      for (const finding of inputs) {
        context.report(finding);
      }
    }),
});

const tuple = (finding: Finding): readonly (string | number | null)[] => [
  finding.ruleId,
  finding.file,
  finding.line,
  finding.column,
  finding.severity,
  finding.variable ?? null,
];

test('buildContext groups declarations, usages and infra refs by name', () => {
  const report = makeReport({
    files: [makeFile('.env'), makeFile('.env.local', { devOnly: true, committed: false, kind: 'local' })],
    decls: [makeDecl('PORT', '.env', 1), makeDecl('PORT', '.env.local', 4), makeDecl('HOST', '.env', 2)],
    usages: [makeUsage('PORT', 'src/app.ts', 10), makeUsage('DEBUG', 'src/app.ts', 12)],
    infra: [makeRef('HOST', 'docker-compose.yml', 3)],
  });
  const context = buildContext({ report, config: makeConfig() });

  assert.equal(context.root, '/repo');
  assert.equal(context.decls, report.decls);
  assert.equal(context.usages, report.usages);
  assert.equal(context.infra, report.infra);
  assert.equal(context.manifest, null);
  assert.equal(context.files.size, 2);
  assert.equal(context.files.get('.env.local')?.devOnly, true);
  assert.equal(context.files.get('nope.env'), undefined);
  assert.deepEqual(
    (context.byName.get('PORT') ?? []).map((decl) => `${decl.file}:${decl.line}`),
    ['.env:1', '.env.local:4'],
  );
  assert.equal(context.byName.get('DEBUG'), undefined);
  assert.deepEqual((context.usagesByName.get('PORT') ?? []).map((usage) => usage.file), ['src/app.ts']);
  assert.deepEqual((context.infraByName.get('HOST') ?? []).map((ref) => ref.file), ['docker-compose.yml']);
});

test('buildContext exposes the sorted union of all three name sets', () => {
  const report = makeReport({
    decls: [makeDecl('PORT', '.env', 1), makeDecl('API_URL', '.env', 2)],
    usages: [makeUsage('zebra', 'src/a.ts', 1), makeUsage('API_URL', 'src/a.ts', 2)],
    infra: [makeRef('Mid', 'docker-compose.yml', 1)],
  });
  const context = buildContext({ report, config: makeConfig() });

  assert.deepEqual([...context.names], ['API_URL', 'Mid', 'PORT', 'zebra']);
});

test('isSuppressed falls back to config.ignoreRules when no callback is supplied', () => {
  const report = makeReport({ decls: [makeDecl('PORT', '.env', 1)] });
  const location = { file: '.env', line: 1, column: 1 };

  const open = buildContext({ report, config: makeConfig() });
  assert.equal(open.isSuppressed(location, 'missing-in-env'), false);

  const closed = buildContext({
    report,
    config: makeConfig({ ignoreRules: new Set<RuleId>(['missing-in-env']) }),
  });
  assert.equal(closed.isSuppressed(location, 'missing-in-env'), true);
  assert.equal(closed.isSuppressed(location, 'duplicate-key'), false);
});

test('isSuppressed prefers the supplied callback over config.ignoreRules', () => {
  const report = makeReport({});
  const seen: RuleId[] = [];
  const context = buildContext({
    report,
    config: makeConfig({ ignoreRules: new Set<RuleId>(['missing-in-env']) }),
    suppress: (location, ruleId) => {
      seen.push(ruleId);
      return location.line === 7;
    },
  });

  assert.equal(context.isSuppressed({ file: 'a', line: 1, column: 1 }, 'missing-in-env'), false);
  assert.equal(context.isSuppressed({ file: 'a', line: 7, column: 1 }, 'missing-in-env'), true);
  assert.deepEqual(seen, ['missing-in-env', 'missing-in-env']);
});

test('isIgnoredVariable matches config globs case-insensitively', () => {
  const config = makeConfig({ ignoreVariables: ['PORT', 'react_app_*'] });

  assert.equal(isIgnoredVariable(config, 'PORT'), true);
  assert.equal(isIgnoredVariable(config, 'react_app_api'), true);
  assert.equal(isIgnoredVariable(makeConfig(), 'PORT'), false);
});

test('report resolves the rule title, docs url and severity', () => {
  const rule = fakeRule('duplicate-key', 'warn', [input('duplicate-key', '.env', 3, 1, { variable: 'PORT' })]);
  const context = buildContext({ report: makeReport({}), config: makeConfig() });
  const result = runRules(context, [rule]);

  assert.deepEqual(result.errors, []);
  assert.equal(result.findings.length, 1);
  const finding = result.findings[0];
  assert.equal(finding?.ruleTitle, 'title duplicate-key');
  assert.equal(finding?.docsUrl, ruleDocsUrl('duplicate-key'));
  assert.equal(finding?.severity, 'warn');
  assert.deepEqual(tuple(finding as Finding), ['duplicate-key', '.env', 3, 1, 'warn', 'PORT']);
});

test('severity precedence is input, then config.severities, then the rule default', () => {
  const fromInput = fakeRule('empty-value', 'info', [input('empty-value', '.env', 1, 1, { severity: 'error' })]);
  const fromConfig = fakeRule('export-prefix', 'info', [input('export-prefix', '.env', 2, 1)]);
  const fromRule = fakeRule('conflicting-values', 'warn', [input('conflicting-values', '.env', 3, 1)]);
  const config = makeConfig({ severities: { 'export-prefix': 'warn' } });
  const context = buildContext({ report: makeReport({}), config });
  const result = runRules(context, [fromInput, fromConfig, fromRule]);

  assert.deepEqual(
    result.findings.map((finding) => finding.severity),
    ['error', 'warn', 'warn'],
  );
});

test('config severity does not override a per-instance severity', () => {
  const rule = fakeRule('compose-var-undeclared', 'warn', [
    input('compose-var-undeclared', 'docker-compose.yml', 1, 1, { severity: 'info' }),
  ]);
  const context = buildContext({
    report: makeReport({}),
    config: makeConfig({ severities: { 'compose-var-undeclared': 'error' } }),
  });

  assert.deepEqual(
    runRules(context, [rule]).findings.map((finding) => finding.severity),
    ['info'],
  );
});

test('a rule that throws is recorded in errors and the other rules still run', () => {
  const boom = fakeRule('prod-crash', 'error', [], () => {
    throw new Error('kaboom');
  });
  const after = fakeRule('unused-variable', 'warn', [input('unused-variable', '.env', 4, 1, { variable: 'OLD' })]);
  const before = fakeRule('missing-in-env', 'error', [input('missing-in-env', 'src/a.ts', 1, 1, { variable: 'NEW' })]);
  const context = buildContext({ report: makeReport({}), config: makeConfig() });
  const result = runRules(context, [before, boom, after]);

  assert.deepEqual(result.errors, [{ ruleId: 'prod-crash', message: 'kaboom' }]);
  assert.deepEqual(
    result.findings.map((finding) => finding.ruleId),
    ['missing-in-env', 'unused-variable'],
  );
});

test('a rule throwing a non-error is recorded without crashing the run', () => {
  const boom = fakeRule('duplicate-key', 'error', [], () => {
    throw 'plain string failure';
  });
  const context = buildContext({ report: makeReport({}), config: makeConfig() });

  assert.deepEqual(runRules(context, [boom]).errors, [{ ruleId: 'duplicate-key', message: 'plain string failure' }]);
});

test('findings are sorted by severity, file, line, column then rule id', () => {
  const report = fakeRule('missing-in-env', 'error', [
    input('missing-in-env', 'z.ts', 1, 1, { variable: 'B', severity: 'info' }),
    input('missing-in-env', 'b.ts', 2, 1, { variable: 'C' }),
    input('missing-in-env', 'a.ts', 2, 5, { variable: 'D' }),
    input('missing-in-env', 'a.ts', 2, 1, { variable: 'A' }),
    input('missing-in-env', 'a.ts', 1, 1, { variable: 'E' }),
  ]);
  const other = fakeRule('duplicate-key', 'error', [
    input('duplicate-key', 'a.ts', 2, 1, { variable: 'A', severity: 'warn' }),
  ]);
  const context = buildContext({ report: makeReport({}), config: makeConfig() });
  const result = runRules(context, [report, other]);

  assert.deepEqual(
    result.findings.map((finding) => `${finding.severity} ${finding.file}:${finding.line}:${finding.column} ${finding.ruleId}`),
    [
      'error a.ts:1:1 missing-in-env',
      'error a.ts:2:1 missing-in-env',
      'error a.ts:2:5 missing-in-env',
      'error b.ts:2:1 missing-in-env',
      'warn a.ts:2:1 duplicate-key',
      'info z.ts:1:1 missing-in-env',
    ],
  );
});

test('identical rule, location and variable findings are de-duplicated', () => {
  const first = fakeRule('missing-in-env', 'error', [
    input('missing-in-env', 'src/a.ts', 3, 1, { variable: 'PORT', message: 'first' }),
    input('missing-in-env', 'src/a.ts', 3, 1, { variable: 'PORT', message: 'second' }),
  ]);
  const second = fakeRule('missing-in-env', 'error', [
    input('missing-in-env', 'src/a.ts', 3, 1, { variable: 'PORT', message: 'third' }),
    input('missing-in-env', 'src/a.ts', 3, 2, { variable: 'PORT', message: 'fourth' }),
    input('missing-in-env', 'src/a.ts', 3, 1, { variable: 'OTHER', message: 'fifth' }),
  ]);
  const context = buildContext({ report: makeReport({}), config: makeConfig() });
  const result = runRules(context, [first, second]);

  assert.deepEqual(
    result.findings.map((finding) => finding.message),
    ['fifth', 'first', 'fourth'],
  );
});

test('report is synchronous, does not re-enter and findings stay usable after the run', () => {
  const seen: string[] = [];
  const rule = fakeRule('empty-value', 'info', [], (context) => {
    context.report(input('empty-value', '.env', 1, 1, { variable: 'A' }));
    seen.push('after-first-report');
    context.report(input('empty-value', '.env', 2, 1, { variable: 'B' }));
    seen.push(context.isSuppressed({ file: '.env', line: 1, column: 1 }, 'empty-value') ? 'suppressed' : 'open');
  });
  const context = buildContext({ report: makeReport({}), config: makeConfig() });
  const result = runRules(context, [rule]);

  assert.deepEqual(seen, ['after-first-report', 'open']);
  assert.deepEqual(
    result.findings.map((finding) => finding.variable),
    ['A', 'B'],
  );
});

test('a context built for one run keeps collecting across repeated runs', () => {
  const rule = fakeRule('empty-value', 'info', [input('empty-value', '.env', 1, 1, { variable: 'A' })]);
  const context = buildContext({ report: makeReport({}), config: makeConfig() });
  const first = runRules(context, [rule]);
  const second = runRules(context, [rule]);

  assert.equal(first.findings.length, 1);
  assert.equal(second.findings.length, 1);
  assert.equal(first.findings[0], second.findings[0]);
});

test('a fingerprint from a rule reaches the finding', () => {
  const rule = fakeRule('conflicting-values', 'warn', [
    input('conflicting-values', '.env', 2, 1, { variable: 'API_TOKEN', fingerprint: fingerprint('secret-value') }),
  ]);
  const context = buildContext({ report: makeReport({}), config: makeConfig() });

  assert.equal(runRules(context, [rule]).findings[0]?.fingerprint, fingerprint('secret-value'));
});

test('optional fields stay absent when the rule omits them', () => {
  const rule = fakeRule('empty-value', 'info', [input('empty-value', '.env', 1, 1)]);
  const context = buildContext({ report: makeReport({}), config: makeConfig() });
  const finding = runRules(context, [rule]).findings[0] as Finding;

  assert.equal('variable' in finding, false);
  assert.equal('hint' in finding, false);
  assert.equal('fingerprint' in finding, false);
});

test('runRules on a context that did not come from buildContext finds nothing and never throws', () => {
  const rule = fakeRule('empty-value', 'info', [input('empty-value', '.env', 1, 1)]);
  const foreign: RuleContext = {
    root: '/repo',
    config: makeConfig(),
    decls: [],
    usages: [],
    infra: [],
    files: new Map(),
    manifest: null,
    byName: new Map(),
    usagesByName: new Map(),
    infraByName: new Map(),
    names: [],
    isSuppressed: () => false,
    report: () => undefined,
  };

  assert.deepEqual(runRules(foreign, [rule]), { findings: [], errors: [] });
});
