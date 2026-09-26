import assert from 'node:assert/strict';
import test from 'node:test';

import type {
  EnvFileInfo,
  EnvParseIssue,
  EnvUsage,
  EnvVarDecl,
  InfraRef,
  Language,
  Report,
  ReportSummary,
  ResolvedConfig,
  RuleId,
  SkippedFile,
  VariableSummary,
} from '../src/types.js';
import { buildVariableSummaries } from '../src/report/variables.js';
import { VERSION } from '../src/version.js';

const SECRET_PATTERN =
  '(SECRET|TOKEN|PASSWORD|API_?KEY|PRIVATE_?KEY|ACCESS_?KEY|CREDENTIAL|DSN|DATABASE_?URL|REDIS_?URL|STRIPE_?KEY)';

const makeConfig = (): ResolvedConfig => ({
  include: ['**/*'],
  exclude: ['**/node_modules/**'],
  envFiles: ['.env*'],
  exampleFiles: ['.env.example', '**/.env.template'],
  ignoreRules: new Set<RuleId>(),
  ignoreVariables: [],
  ignoreFingerprints: new Set<string>(),
  severities: {},
  weakValues: new Set(['changeme', 'password', 'secret', 'placeholder', 'todo']),
  hostileNames: new Set(['LD_PRELOAD']),
  reservedNames: new Set(['NODE_OPTIONS']),
  secretPatterns: [],
  secretNamePattern: SECRET_PATTERN,
  maxFileSizeBytes: 65_536,
  maxLineLength: 2_000,
  ciEnvironmentKinds: {},
  failOn: 'error',
  codeFrameLines: 2,
  followSymlinks: false,
  requireExampleFile: true,
  source: null,
  warnings: [],
});

const makeFile = (path: string, patch: Partial<EnvFileInfo> = {}): EnvFileInfo => ({
  path,
  kind: 'dev',
  exists: true,
  shared: false,
  devOnly: true,
  tracked: false,
  declCount: 0,
  issues: [],
  committed: false,
  byteSize: 128,
  ...patch,
});

const makeIssue = (kind: EnvParseIssue['kind'], file: string, line: number, message: string): EnvParseIssue => ({
  kind,
  message,
  file,
  line,
  column: 1,
});

const FILES: readonly EnvFileInfo[] = [
  makeFile('.env', {
    declCount: 13,
    committed: false,
    issues: [makeIssue('unterminated-quote', '.env', 9, 'Unterminated quote for APP_NAME')],
    byteSize: 512,
  }),
  makeFile('.env.example', {
    kind: 'example',
    shared: true,
    devOnly: false,
    tracked: true,
    committed: true,
    declCount: 15,
    byteSize: 640,
  }),
  makeFile('.env.production', { kind: 'production', shared: true, devOnly: false, tracked: true, committed: true, declCount: 9, byteSize: 480 }),
  makeFile('apps/api/.env', { declCount: 4, byteSize: 210 }),
  makeFile('apps/web/.env', { declCount: 5, byteSize: 190, issues: [makeIssue('no-separator', 'apps/web/.env', 12, 'No separator found')] }),
  makeFile('apps/web/.env.local', { kind: 'local', declCount: 2, byteSize: 90 }),
  makeFile('config/.env.test', { kind: 'test', shared: true, tracked: true, committed: true, declCount: 3, byteSize: 120 }),
  makeFile('apps/worker/.env.template', { kind: 'template', shared: true, devOnly: false, tracked: true, committed: true, declCount: 4, byteSize: 150 }),
];

const FILE_BY_PATH = new Map(FILES.map((file) => [file.path, file]));

const makeDecl = (name: string, file: string, line: number, value: string, patch: Partial<EnvVarDecl> = {}): EnvVarDecl => {
  const info = FILE_BY_PATH.get(file);
  return {
    name,
    file,
    line,
    column: 1,
    value,
    hasValue: value.length > 0,
    quoted: value.length > 0 ? '"' : null,
    exported: false,
    references: [],
    duplicateOfLine: null,
    leadingComments: [],
    inlineComment: null,
    unquotedInlineComment: null,
    hasTrailingWhitespace: false,
    kind: info?.kind ?? 'unknown',
    shared: info?.shared ?? false,
    devOnly: info?.devOnly ?? true,
    ...patch,
  };
};

const DECLS: readonly EnvVarDecl[] = [
  makeDecl('APP_NAME', '.env', 2, 'app', { leadingComments: ['Application name shown in the banner.'] }),
  makeDecl('APP_ENV', '.env', 3, 'development'),
  makeDecl('APP_ENV', '.env', 4, 'production', { duplicateOfLine: 3 }),
  makeDecl('LOG_LEVEL', '.env', 5, 'debug'),
  makeDecl('PORT', '.env', 6, ''),
  makeDecl('DEFAULT_TENANT', '.env', 7, 'changeme'),
  makeDecl('AWS_ACCESS_KEY_ID', '.env', 8, 'AKIAIOSFODNN7EXAMPLE'),
  makeDecl('SESSION_SECRET', '.env', 10, 's3cr3t-EXAMPLE-value', { quoted: "'" }),
  makeDecl('FEATURE_X', '.env', 11, '1'),
  makeDecl('FEATURE_Y', '.env', 12, '1'),
  makeDecl('NODE_OPTIONS', '.env', 13, '--max-old-space-size=2048'),
  makeDecl('LD_PRELOAD', '.env', 14, '/tmp/evil.so'),
  makeDecl('DB-PORT', '.env', 15, '5432'),
  makeDecl('APP_NAME', '.env.example', 3, 'app', { leadingComments: ['Application name shown in the banner.'] }),
  makeDecl('APP_ENV', '.env.example', 4, ''),
  makeDecl('LOG_LEVEL', '.env.example', 5, 'info'),
  makeDecl('PORT', '.env.example', 6, '3000', {
    leadingComments: ['Port the HTTP server listens on.', 'Set to 0 to let the OS choose a free port.'],
  }),
  makeDecl('STRIPE_SECRET_KEY', '.env.example', 7, 'sk_test_EXAMPLE'),
  makeDecl('SENTRY_DSN', '.env.example', 8, ''),
  makeDecl('DATABASE_URL', '.env.example', 9, 'postgres://localhost/app', {
    inlineComment: ' local database',
    leadingComments: ['Connection string for the primary database.'],
  }),
  makeDecl('REDIS_URL', '.env.example', 10, 'redis://localhost:6379'),
  makeDecl('JWT_SIGNING_KEY', '.env.example', 11, ''),
  makeDecl('SMTP_HOST', '.env.example', 12, 'smtp.example.com'),
  makeDecl('SMTP_PASSWORD', '.env.example', 13, ''),
  makeDecl('QUEUE_URL', '.env.example', 14, 'amqp://localhost', { leadingComments: ['AMQP broker | used by the worker.'] }),
  makeDecl('TELEMETRY_ENABLED', '.env.example', 15, 'false'),
  makeDecl('LEGACY_CACHE_TTL', '.env.example', 16, '60'),
  makeDecl('SESSION_SECRET', '.env.example', 17, '', { leadingComments: ['Signing key for session cookies.'] }),
  makeDecl('APP_NAME', '.env.production', 2, 'app'),
  makeDecl('APP_ENV', '.env.production', 3, 'production'),
  makeDecl('LOG_LEVEL', '.env.production', 5, 'info'),
  makeDecl('PORT', '.env.production', 6, '8080'),
  makeDecl('DATABASE_URL', '.env.production', 7, 'postgres://db.internal/app'),
  makeDecl('STRIPE_SECRET_KEY', '.env.production', 8, ''),
  makeDecl('NODE_OPTIONS', '.env.production', 9, ''),
  makeDecl('SESSION_SECRET', '.env.production', 10, ''),
  makeDecl('TELEMETRY_ENABLED', '.env.production', 11, 'false'),
  makeDecl('DATABASE_URL', 'apps/api/.env', 2, 'postgres://localhost:5432/app'),
  makeDecl('STRIPE_SECRET_KEY', 'apps/api/.env', 3, 'sk_live_EXAMPLE'),
  makeDecl('AWS_ACCESS_KEY_ID', 'apps/api/.env', 4, ''),
  makeDecl('RETRY_COUNT', 'apps/api/.env', 5, '3'),
  makeDecl('PUBLIC_API_URL', 'apps/web/.env', 2, 'http://localhost:3000'),
  makeDecl('CORS_ORIGIN', 'apps/web/.env', 3, 'http://localhost:3000', { unquotedInlineComment: ' trailing' }),
  makeDecl('HOST', 'apps/web/.env', 4, ''),
  makeDecl('FEATURE_FLAGS', 'apps/web/.env', 5, 'beta'),
  makeDecl('MAX_CONNECTIONS', 'apps/web/.env', 6, '20', {
    leadingComments: ['Maximum number of pooled database connections per process in production deployments.'],
  }),
  makeDecl('LOG_LEVEL', 'apps/web/.env.local', 2, 'trace'),
  makeDecl('SESSION_SECRET', 'apps/web/.env.local', 3, ''),
  makeDecl('APP_ENV', 'config/.env.test', 2, 'test'),
  makeDecl('TELEMETRY_ENABLED', 'config/.env.test', 3, 'true'),
  makeDecl('REDIS_URL', 'config/.env.test', 4, 'redis://127.0.0.1:6379/0'),
  makeDecl('QUEUE_URL', 'apps/worker/.env.template', 4, '', { exported: true }),
  makeDecl('WORKER_CONCURRENCY', 'apps/worker/.env.template', 5, '4'),
  makeDecl('OTEL_EXPORTER', 'apps/worker/.env.template', 6, 'otlp', {
    leadingComments: ['Sets the `OTEL_EXPORTER` endpoint.'],
  }),
  makeDecl('WEBHOOK_SECRET', 'apps/worker/.env.template', 7, 'whsec_EXAMPLE', { leadingComments: ['Signing secret for inbound webhooks.'] }),
];

const makeUsage = (
  name: string,
  file: string,
  line: number,
  accessor: string,
  patch: Partial<EnvUsage> = {},
): EnvUsage => ({
  name,
  file,
  line,
  column: 20,
  language: 'typescript' satisfies Language,
  accessor,
  hasFallback: false,
  required: true,
  viaImport: false,
  fallbackLiteral: null,
  ...patch,
});

const USAGES: readonly EnvUsage[] = [
  makeUsage('PORT', 'apps/api/src/server.ts', 44, 'os.environ', { language: 'python', required: true }),
  makeUsage('PORT', 'apps/web/next.config.js', 8, 'process.env', { required: false, hasFallback: true }),
  makeUsage('DATABASE_URL', 'apps/api/src/db.ts', 12, 'Deno.env.get'),
  makeUsage('DATABASE_URL', 'apps/worker/src/queue.py', 22, 'os.getenv', { language: 'python', required: false, hasFallback: true }),
  makeUsage('STRIPE_SECRET_KEY', 'apps/web/src/api.ts', 31, 'process.env'),
  makeUsage('JWT_SIGNING_KEY', 'apps/api/src/auth.ts', 9, 'process.env'),
  makeUsage('SESSION_SECRET', 'apps/api/src/redis.ts', 15, 'process.env', { required: false, hasFallback: true, fallbackLiteral: 'dev' }),
  makeUsage('AWS_ACCESS_KEY_ID', 'apps/api/src/s3.ts', 7, 'process.env'),
  makeUsage('APP_ENV', 'src/config.ts', 3, 'process.env', { required: false, hasFallback: true }),
  makeUsage('LOG_LEVEL', 'src/logger.ts', 4, 'process.env', { required: false, hasFallback: true }),
  makeUsage('LOG_LEVEL', 'apps/worker/src/main.go', 31, 'os.Getenv', { language: 'go' }),
  makeUsage('PUBLIC_API_URL', 'apps/web/src/runtime.ts', 8, '$env/static/public', { language: 'javascript', viaImport: true }),
  makeUsage('TELEMETRY_ENABLED', 'apps/api/src/telemetry.ts', 6, 'process.env', { required: false, hasFallback: true }),
  makeUsage('SENTRY_DSN', 'apps/web/src/sentry.ts', 5, 'process.env', { required: false, hasFallback: true }),
  makeUsage('SMTP_HOST', 'src/mailer.rb', 12, 'ENV', { language: 'ruby', required: false, hasFallback: true }),
  makeUsage('SMTP_PASSWORD', 'src/mailer.rb', 13, 'ENV', { language: 'ruby', required: false, hasFallback: true }),
  makeUsage('RETRY_COUNT', 'src/http.ts', 19, 'process.env', { required: false, hasFallback: true }),
  makeUsage('MAX_CONNECTIONS', 'apps/api/src/pool.java', 31, 'System.getenv', { language: 'java' }),
  makeUsage('HOST', 'apps/web/src/serve.ts', 10, 'process.env', { required: false, hasFallback: true }),
  makeUsage('CORS_ORIGIN', 'src/cors.ts', 7, 'process.env', { required: false, hasFallback: true }),
  makeUsage('FEATURE_FLAGS', 'src/flags.ts', 11, 'process.env'),
  makeUsage('UNLISTED_FLAG', 'src/flags.ts', 15, 'process.env', { required: false, hasFallback: true }),
  makeUsage('QUEUE_URL', 'apps/worker/src/consumer.cs', 18, 'Environment.Get', { language: 'csharp' }),
  makeUsage('WORKER_CONCURRENCY', 'apps/worker/src/pool.kt', 22, 'System.getenv', { language: 'kotlin' }),
  makeUsage('OTEL_EXPORTER', 'apps/worker/src/otel.ts', 9, 'process.env', { required: false, hasFallback: true }),
  makeUsage('WEBHOOK_SECRET', 'src/webhooks.php', 18, 'getenv', { language: 'php' }),
  makeUsage('DEFAULT_TENANT', 'src/tenant.swift', 14, 'ProcessInfo', { language: 'swift', required: false, hasFallback: true }),
  makeUsage('APP_NAME', 'src/banner.ts', 3, 'process.env', { required: false, hasFallback: true }),
];

const makeRef = (name: string, file: string, line: number, kind: InfraRef['kind'], patch: Partial<InfraRef> = {}): InfraRef => ({
  name,
  file,
  line,
  column: 3,
  kind,
  required: false,
  refersToFile: false,
  interpolation: false,
  ...patch,
});

const INFRA: readonly InfraRef[] = [
  makeRef('QUEUE_URL', 'docker-compose.yml', 18, 'compose-environment'),
  makeRef('DATABASE_URL', 'docker-compose.yml', 19, 'compose-environment', { required: true }),
  makeRef('STRIPE_SECRET_KEY', 'docker-compose.yml', 22, 'compose-interpolation', { interpolation: true }),
  makeRef('NEXT_TELEMETRY', 'docker-compose.yml', 25, 'compose-build-arg'),
  makeRef('.env.production', 'docker-compose.yml', 30, 'dotenv-path', { refersToFile: true }),
  makeRef('NODE_ENV', 'Dockerfile', 6, 'dockerfile-env'),
  makeRef('APP_VERSION', 'Dockerfile', 14, 'dockerfile-arg'),
  makeRef('STRIPE_SECRET_KEY', '.github/workflows/ci.yml', 22, 'ci-secret', { required: true }),
  makeRef('RETRY_COUNT', '.github/workflows/ci.yml', 23, 'ci-var'),
  makeRef('TELEMETRY_ENABLED', '.github/workflows/ci.yml', 24, 'ci-env'),
  makeRef('WEBHOOK_SECRET', '.github/workflows/ci.yml', 31, 'ci-secret'),
  makeRef('AWS_ACCESS_KEY_ID', '.github/workflows/release.yml', 18, 'ci-secret'),
];

const SKIPPED: readonly SkippedFile[] = [
  { file: 'apps/legacy/.env', reason: 'git-ignored' },
  { file: 'vendor/bundle.env', reason: 'binary file' },
];

const emptySummary = (): ReportSummary => ({
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
});

const makeEmptyReport = (): Report => ({
  tool: { name: 'envgle', version: VERSION },
  root: 'empty-repo',
  startedAt: '2026-01-01T00:00:00.000Z',
  durationMs: 0,
  filesScanned: 0,
  bytesScanned: 0,
  filesSkipped: 0,
  skipped: [],
  files: [],
  decls: [],
  usages: [],
  infra: [],
  manifest: null,
  findings: [],
  summary: emptySummary(),
});

const makeRichReport = (): Report => ({
  tool: { name: 'envgle', version: VERSION },
  root: 'demo-repo',
  startedAt: '2026-01-01T00:00:00.000Z',
  durationMs: 42.4,
  filesScanned: 24,
  bytesScanned: 51_234,
  filesSkipped: SKIPPED.length,
  skipped: SKIPPED,
  files: FILES,
  decls: DECLS,
  usages: USAGES,
  infra: INFRA,
  manifest: { path: 'package.json', name: 'demo', dependencies: ['pg'], devDependencies: [], scripts: {}, engines: {} },
  findings: [],
  summary: emptySummary(),
});

const config = makeConfig();
const report = makeRichReport();

const names = (summaries: readonly VariableSummary[]): string[] => summaries.map((summary) => summary.name);

const pick = (summaries: readonly VariableSummary[], name: string): VariableSummary => {
  const found = summaries.find((summary) => summary.name === name);
  assert.ok(found !== undefined, `expected a summary for ${name}`);
  return found;
};

test('one summary per distinct name, sorted by name with code-unit order', () => {
  const summaries = buildVariableSummaries(report, { config });
  const all = names(summaries);
  assert.deepEqual(all, [...all].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)));
  assert.equal(new Set(all).size, all.length);
  assert.ok(all.length >= 25, `expected at least 25 variables, got ${all.length}`);
  assert.ok(all.includes('AWS_ACCESS_KEY_ID'));
  assert.ok(all.includes('UNLISTED_FLAG') === false, 'undeclared names are dropped by default');
});

test('every field of a secretish variable is derived from the report', () => {
  const summaries = buildVariableSummaries(report, { config });
  assert.deepEqual(pick(summaries, 'AWS_ACCESS_KEY_ID'), {
    name: 'AWS_ACCESS_KEY_ID',
    declaredIn: ['.env', 'apps/api/.env'],
    readIn: [{ file: 'apps/api/src/s3.ts', line: 7, accessor: 'process.env', hasFallback: false, required: true }],
    referencedIn: ['.github/workflows/release.yml'],
    hasValue: true,
    required: true,
    secretish: true,
    description: null,
    kind: 'dev',
    hasWeakValue: false,
    values: [
      { file: '.env', line: 8, preview: '<redacted>', conflicting: true, shared: false },
      { file: 'apps/api/.env', line: 4, preview: '', conflicting: true, shared: false },
    ],
    infraKinds: ['ci-secret'],
    ciNames: ['AWS_ACCESS_KEY_ID'],
  });
});

test('reads are sorted by file then line and files are deduplicated', () => {
  const summaries = buildVariableSummaries(report, { config });
  assert.deepEqual(pick(summaries, 'PORT').readIn, [
    { file: 'apps/api/src/server.ts', line: 44, accessor: 'os.environ', hasFallback: false, required: true },
    { file: 'apps/web/next.config.js', line: 8, accessor: 'process.env', hasFallback: true, required: false },
  ]);
  assert.deepEqual(pick(summaries, 'LOG_LEVEL').declaredIn, ['.env', '.env.example', '.env.production', 'apps/web/.env.local']);
  assert.deepEqual(pick(summaries, 'DATABASE_URL').readIn.map((usage) => usage.file), [
    'apps/api/src/db.ts',
    'apps/worker/src/queue.py',
  ]);
  assert.deepEqual(pick(summaries, 'DATABASE_URL').referencedIn, ['docker-compose.yml']);
});

test('kind prefers an example file, then a shared file, then the first sorted file', () => {
  const summaries = buildVariableSummaries(report, { config });
  assert.equal(pick(summaries, 'STRIPE_SECRET_KEY').kind, 'example');
  assert.equal(pick(summaries, 'REDIS_URL').kind, 'example');
  assert.equal(pick(summaries, 'SENTRY_DSN').kind, 'example');
  assert.equal(pick(summaries, 'AWS_ACCESS_KEY_ID').kind, 'dev');
  assert.equal(pick(summaries, 'TELEMETRY_ENABLED').kind, 'example');
});

test('description is the first non-empty comment set, collapsed to one line', () => {
  const summaries = buildVariableSummaries(report, { config });
  assert.equal(pick(summaries, 'PORT').description, 'Port the HTTP server listens on. Set to 0 to let the OS choose a free port.');
  assert.equal(pick(summaries, 'QUEUE_URL').description, 'AMQP broker | used by the worker.');
  assert.equal(pick(summaries, 'SESSION_SECRET').description, 'Signing key for session cookies.');
  assert.equal(pick(summaries, 'DEFAULT_TENANT').description, null);
  assert.equal(pick(summaries, 'OTEL_EXPORTER').description, 'Sets the `OTEL_EXPORTER` endpoint.');
});

test('hasWeakValue only fires for non-example declarations', () => {
  const summaries = buildVariableSummaries(report, { config });
  assert.equal(pick(summaries, 'DEFAULT_TENANT').hasWeakValue, true);
  assert.equal(pick(summaries, 'APP_NAME').hasWeakValue, false);
  assert.equal(pick(summaries, 'AWS_ACCESS_KEY_ID').hasWeakValue, false);
});

test('conflicting is true only when another declaration holds a different value', () => {
  const summaries = buildVariableSummaries(report, { config });
  assert.deepEqual(pick(summaries, 'APP_NAME').values.map((value) => value.conflicting), [false, false, false]);
  assert.deepEqual(pick(summaries, 'FEATURE_X').values.map((value) => value.conflicting), [false]);
  assert.deepEqual(pick(summaries, 'APP_ENV').values.map((value) => value.conflicting), [true, true, true, true, true]);
  assert.deepEqual(pick(summaries, 'SESSION_SECRET').values.map((value) => value.conflicting), [true, true, true, true]);
  assert.deepEqual(pick(summaries, 'TELEMETRY_ENABLED').values.map((value) => value.conflicting), [true, true, true]);
  assert.deepEqual(pick(summaries, 'LOG_LEVEL').values.map((value) => value.conflicting), [true, true, true, true]);
});

test('required follows reads without a fallback, hasValue follows non-empty declarations', () => {
  const summaries = buildVariableSummaries(report, { config });
  assert.equal(pick(summaries, 'PORT').required, true);
  assert.equal(pick(summaries, 'APP_NAME').required, false);
  assert.equal(pick(summaries, 'APP_NAME').hasValue, true);
  assert.equal(pick(summaries, 'HOST').hasValue, false);
  assert.equal(pick(summaries, 'HOST').required, false);
});

test('redact controls previews without ever exposing a secretish value', () => {
  const redacted = buildVariableSummaries(report, { config, redact: true });
  for (const summary of redacted) {
    for (const value of summary.values) {
      assert.equal(value.preview === '<redacted>' || value.preview.length === 0, true, `${summary.name} leaked a preview while redacting`);
    }
  }
  const visible = buildVariableSummaries(report, { config, redact: false });
  assert.equal(pick(visible, 'APP_ENV').values[0]?.preview, 'development');
  assert.equal(pick(visible, 'MAX_CONNECTIONS').values[0]?.preview, '20');
  assert.equal(pick(visible, 'QUEUE_URL').values[0]?.preview, 'amqp://localhost');
  for (const name of ['AWS_ACCESS_KEY_ID', 'STRIPE_SECRET_KEY', 'DATABASE_URL', 'SESSION_SECRET', 'WEBHOOK_SECRET']) {
    for (const value of pick(visible, name).values) {
      assert.equal(value.preview === '<redacted>' || value.preview.length === 0, true, `${name} leaked a secretish value`);
    }
  }
  const serialized = JSON.stringify(visible);
  for (const secret of ['AKIAIOSFODNN7EXAMPLE', 'sk_test_EXAMPLE', 'sk_live_EXAMPLE', 'whsec_EXAMPLE', 's3cr3t-EXAMPLE-value']) {
    assert.equal(serialized.includes(secret), false, `${secret} must never be serialised`);
  }
});

test('includeUndeclared and includeUnused switch which names survive', () => {
  const declaredOnly = names(buildVariableSummaries(report, { config }));
  assert.equal(declaredOnly.includes('UNLISTED_FLAG'), false);
  const withUndeclared = names(buildVariableSummaries(report, { config, includeUndeclared: true }));
  assert.equal(withUndeclared.includes('UNLISTED_FLAG'), true);
  assert.deepEqual(pick(buildVariableSummaries(report, { config, includeUndeclared: true }), 'UNLISTED_FLAG'), {
    name: 'UNLISTED_FLAG',
    declaredIn: [],
    readIn: [{ file: 'src/flags.ts', line: 15, accessor: 'process.env', hasFallback: true, required: false }],
    referencedIn: [],
    hasValue: false,
    required: false,
    secretish: false,
    description: null,
    kind: null,
    hasWeakValue: false,
    values: [],
    infraKinds: [],
    ciNames: [],
  });
  const used = names(buildVariableSummaries(report, { config, includeUnused: false }));
  assert.equal(used.includes('FEATURE_X'), false);
  assert.equal(used.includes('LEGACY_CACHE_TTL'), false);
  assert.equal(used.includes('LD_PRELOAD'), false);
  assert.equal(used.includes('APP_NAME'), true);
  const bothOff = names(buildVariableSummaries(report, { config, includeUnused: false, includeUndeclared: false }));
  assert.equal(bothOff.includes('FEATURE_X'), false);
  assert.ok(bothOff.length < declaredOnly.length);
});

test('an empty report produces an empty array and never throws', () => {
  assert.deepEqual(buildVariableSummaries(makeEmptyReport(), { config }), []);
  assert.deepEqual(buildVariableSummaries(makeEmptyReport()), []);
});

test('options may be omitted entirely and defaults stay redacted', () => {
  const summaries = buildVariableSummaries(report);
  assert.ok(summaries.length > 0);
  for (const summary of summaries) {
    for (const value of summary.values) {
      assert.equal(value.preview === '<redacted>' || value.preview.length === 0, true);
    }
  }
});

test('the report is never mutated and the output is stable', () => {
  const before = JSON.stringify(report);
  const first = buildVariableSummaries(report, { config });
  const second = buildVariableSummaries(report, { config });
  assert.equal(JSON.stringify(report), before);
  assert.equal(JSON.stringify(first), JSON.stringify(second));
});

test('pathological values are tolerated', () => {
  const odd = makeRichReport();
  const hostile: Report = {
    ...odd,
    decls: [
      makeDecl('', '.env', 0, ''),
      makeDecl('A'.repeat(300), '.env', -5, 'x'.repeat(200)),
      ...odd.decls,
    ],
    usages: [makeUsage('', '', 0, ''), ...odd.usages],
    infra: [makeRef('', '', 0, 'ci-env'), ...odd.infra],
  };
  const summaries = buildVariableSummaries(hostile, { config, redact: false });
  assert.ok(summaries.length > 0);
  const long = pick(summaries, 'A'.repeat(300));
  assert.equal(long.values[0]?.preview.endsWith('\u2026'), true);
  const blank = pick(summaries, '');
  assert.equal(blank.name, '');
  const broken = buildVariableSummaries(hostile, { config: { ...config, secretNamePattern: '([' } });
  assert.deepEqual(broken.map((summary) => summary.name), summaries.map((summary) => summary.name));
});
