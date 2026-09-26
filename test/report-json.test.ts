import assert from 'node:assert/strict';
import test from 'node:test';

import type {
  EnvFileInfo,
  EnvParseIssue,
  EnvUsage,
  EnvVarDecl,
  Finding,
  InfraRef,
  Report,
  ReportSummary,
  ResolvedConfig,
  RuleId,
  Severity,
  SkippedFile,
} from '../src/types.js';
import { toJsonReport, toJsonSummary } from '../src/report/json.js';
import { REPO_URL, VERSION } from '../src/version.js';

const byCodeUnit = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

const DOCS = `${REPO_URL}/blob/main/docs/rules.md`;

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
  makeDecl('OTEL_EXPORTER', 'apps/worker/.env.template', 6, 'otlp', { leadingComments: ['Sets the `OTEL_EXPORTER` endpoint.'] }),
  makeDecl('WEBHOOK_SECRET', 'apps/worker/.env.template', 7, 'whsec_EXAMPLE', { leadingComments: ['Signing secret for inbound webhooks.'] }),
];

const makeUsage = (name: string, file: string, line: number, accessor: string, patch: Partial<EnvUsage> = {}): EnvUsage => ({
  name,
  file,
  line,
  column: 20,
  language: 'typescript',
  accessor,
  hasFallback: false,
  required: true,
  viaImport: false,
  fallbackLiteral: null,
  ...patch,
});

const USAGES: readonly EnvUsage[] = [
  makeUsage('PORT', 'apps/api/src/server.ts', 44, 'os.environ', { language: 'python' }),
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

const TITLES: Readonly<Record<string, string>> = {
  'missing-in-env': 'Variable read but never declared',
  'prod-crash': 'Required read without a fallback',
  'secret-in-repo': 'Secret-looking value in a committed env file',
  'secret-in-example': 'Secret-looking value in an example file',
  'secret-fallback-literal': 'Secret read with a literal fallback',
  'unterminated-quote': 'Unterminated quote',
  'ci-secret-undeclared': 'CI secret that no env file declares',
  'env-file-missing': 'Referenced env file is missing',
  'weak-secret': 'Weak secret value',
  'conflicting-values': 'Conflicting values across env files',
  'duplicate-key': 'Duplicate key',
  'unquoted-special-chars': 'Unquoted value with special characters',
  'empty-value': 'Empty value',
  'missing-from-example': 'Missing from the example file',
  'env-file-untracked': 'Env file is not tracked by git',
  'compose-var-undeclared': 'Compose variable that no env file declares',
  'export-prefix': 'Redundant export prefix',
  'unused-variable': 'Declared but never read',
  'example-out-of-sync': 'Example file out of sync',
  'reserved-name': 'Reserved variable name',
  'hostile-name': 'Hostile variable name',
  'inline-comment-truncation': 'Inline comment is truncated',
  'framework-prefix-mismatch': 'Framework prefix mismatch',
};

const makeFinding = (
  ruleId: RuleId,
  severity: Severity,
  file: string,
  line: number,
  message: string,
  patch: { variable?: string; hint?: string; column?: number } = {},
): Finding => {
  const finding: {
    ruleId: RuleId;
    ruleTitle: string;
    severity: Severity;
    message: string;
    file: string;
    line: number;
    column: number;
    docsUrl: string;
    variable?: string;
    hint?: string;
  } = {
    ruleId,
    ruleTitle: TITLES[ruleId] ?? ruleId,
    severity,
    message,
    file,
    line,
    column: patch.column ?? 1,
    docsUrl: `${DOCS}#${ruleId}`,
  };
  if (patch.variable !== undefined) {
    finding.variable = patch.variable;
  }
  if (patch.hint !== undefined) {
    finding.hint = patch.hint;
  }
  return finding;
};

const FINDINGS: readonly Finding[] = [
  makeFinding('missing-in-env', 'error', 'apps/api/src/db.ts', 12, 'DATABASE_URL is read by the code but no .env file declares it.', {
    variable: 'DATABASE_URL',
    hint: 'declare it in .env and .env.example',
    column: 18,
  }),
  makeFinding('missing-in-env', 'error', 'apps/web/src/api.ts', 31, 'STRIPE_SECRET_KEY is read by the code but no .env file declares it.', {
    variable: 'STRIPE_SECRET_KEY',
    column: 22,
  }),
  makeFinding('prod-crash', 'error', 'apps/api/src/server.ts', 44, 'PORT is read without a fallback and will throw in production.', {
    variable: 'PORT',
    hint: 'add a default: os.environ.get("PORT", "3000")',
    column: 5,
  }),
  makeFinding('secret-in-repo', 'error', '.env', 8, 'AWS_ACCESS_KEY_ID looks like a real AWS access key id in a committed env file.', {
    variable: 'AWS_ACCESS_KEY_ID',
  }),
  makeFinding('secret-in-example', 'error', '.env.example', 7, 'STRIPE_SECRET_KEY looks like a real Stripe secret key in an example file.', {
    variable: 'STRIPE_SECRET_KEY',
  }),
  makeFinding('unterminated-quote', 'error', '.env', 9, 'Unterminated quote for APP_NAME; the parser swallows the rest of the file.'),
  makeFinding('ci-secret-undeclared', 'error', '.github/workflows/ci.yml', 22, 'CI injects STRIPE_SECRET_KEY but no .env file declares it.', {
    variable: 'STRIPE_SECRET_KEY',
    column: 5,
  }),
  makeFinding('env-file-missing', 'error', '.env.staging', 1, 'An env file referenced by docker-compose.yml is missing: .env.staging.'),
  makeFinding('secret-fallback-literal', 'error', 'apps/api/src/redis.ts', 15, 'SESSION_SECRET is read with a literal fallback, which leaks the secret into the code.', {
    variable: 'SESSION_SECRET',
    hint: 'remove the fallback',
    column: 20,
  }),
  makeFinding('weak-secret', 'warn', '.env', 7, 'DEFAULT_TENANT matches a well-known weak placeholder.', { variable: 'DEFAULT_TENANT' }),
  makeFinding('conflicting-values', 'warn', '.env.production', 5, 'LOG_LEVEL holds a different value in .env, .env.example and .env.production.', {
    variable: 'LOG_LEVEL',
  }),
  makeFinding('duplicate-key', 'warn', '.env', 4, 'APP_ENV is assigned twice; the last value wins.', {
    variable: 'APP_ENV',
    hint: 'delete the first assignment',
  }),
  makeFinding('unquoted-special-chars', 'warn', 'apps/web/.env', 3, 'CORS_ORIGIN has an unquoted value with special characters.', { variable: 'CORS_ORIGIN' }),
  makeFinding('empty-value', 'warn', 'apps/web/.env.local', 2, 'HOST is declared with an empty value.', { variable: 'HOST' }),
  makeFinding('missing-from-example', 'warn', '.env', 11, 'FEATURE_X is declared in .env but missing from .env.example.', { variable: 'FEATURE_X' }),
  makeFinding('env-file-untracked', 'warn', 'apps/web/.env', 1, 'apps/web/.env is not tracked by git but is meant to be shared.'),
  makeFinding('compose-var-undeclared', 'warn', 'docker-compose.yml', 25, 'NEXT_TELEMETRY is interpolated by docker-compose but never declared.', {
    variable: 'NEXT_TELEMETRY',
    column: 3,
  }),
  makeFinding('shell-incompatible-name', 'warn', '.env', 15, 'DB-PORT cannot be exported by a POSIX shell.', { variable: 'DB-PORT' }),
  makeFinding('hardcoded-connection-string', 'warn', 'apps/api/src/legacy.ts', 5, 'A postgres:// connection string is hardcoded instead of read from the environment.'),
  makeFinding('export-prefix', 'info', 'apps/worker/.env.template', 4, 'QUEUE_URL uses the export prefix, which not every loader understands.', {
    variable: 'QUEUE_URL',
  }),
  makeFinding('unused-variable', 'info', '.env.example', 16, 'LEGACY_CACHE_TTL is declared but never read.', { variable: 'LEGACY_CACHE_TTL' }),
  makeFinding('example-out-of-sync', 'info', '.env.example', 14, 'QUEUE_URL is in .env.example but not in .env.', { variable: 'QUEUE_URL' }),
  makeFinding('reserved-name', 'info', '.env.production', 9, 'NODE_OPTIONS is set in a shared env file and changes process behaviour.', {
    variable: 'NODE_OPTIONS',
  }),
  makeFinding('hostile-name', 'info', '.env', 14, 'LD_PRELOAD can execute code during process start.', { variable: 'LD_PRELOAD' }),
  makeFinding('inline-comment-truncation', 'info', '.env.example', 9, 'The inline comment after DATABASE_URL is dropped by most parsers.', {
    variable: 'DATABASE_URL',
  }),
  makeFinding('framework-prefix-mismatch', 'info', 'apps/web/src/runtime.ts', 8, 'PUBLIC_API_URL is read through $env/static/public but breaks the public prefix contract.', {
    variable: 'PUBLIC_API_URL',
  }),
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

const summarize = (findings: readonly Finding[], filesScanned: number, declared: number, read: number, secretish: number): ReportSummary => {
  const byRule: Record<string, number> = {};
  const files = new Set<string>();
  for (const finding of findings) {
    byRule[finding.ruleId] = (byRule[finding.ruleId] ?? 0) + 1;
    files.add(finding.file);
  }
  const count = (severity: Severity): number => findings.filter((finding) => finding.severity === severity).length;
  return {
    error: count('error'),
    warn: count('warn'),
    info: count('info'),
    total: findings.length,
    byRule,
    variables: declared,
    declared,
    read,
    secretish,
    filesScanned,
    filesWithFindings: files.size,
    rulesFired: Object.keys(byRule).length,
  };
};

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

const declaredNames = new Set(DECLS.map((decl) => decl.name));
const readNames = new Set(USAGES.map((usage) => usage.name));
const secretishNames = new Set(
  [...declaredNames].filter((name) => new RegExp(SECRET_PATTERN, 'i').test(name)),
);

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
  findings: FINDINGS,
  summary: summarize(FINDINGS, 24, declaredNames.size, readNames.size, secretishNames.size),
});


const config = makeConfig();
const report = makeRichReport();
const empty = makeEmptyReport();

const parse = (text: string): Record<string, unknown> => JSON.parse(text) as Record<string, unknown>;

const list = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);

const record = (value: unknown): Record<string, unknown> =>
  typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};

test('an empty report serialises to an exact, stable document', () => {
  const text = toJsonReport(empty, { rootLabel: 'empty-repo', config });
  assert.deepEqual(parse(text), {
    schemaVersion: 1,
    tool: { name: 'envgle', version: VERSION },
    root: 'empty-repo',
    durationMs: 0,
    summary: emptySummary(),
    files: [],
    variables: [],
    findings: [],
    groups: [],
  });
  assert.equal(text.endsWith('\n'), false);
  assert.equal(text, toJsonReport(empty, { rootLabel: 'empty-repo', config }));
  assert.equal(text.includes('\n  "schemaVersion"'), true);
});

test('the root label and duration are normalised', () => {
  const parsed = parse(toJsonReport(report));
  assert.equal(parsed['schemaVersion'], 1);
  assert.equal(parsed['root'], 'demo-repo');
  assert.equal(parsed['durationMs'], 42);
  assert.deepEqual(record(parsed['tool']), { name: 'envgle', version: VERSION });
  assert.deepEqual(record(parsed['summary']), JSON.parse(JSON.stringify(report.summary)));
  const overridden = parse(toJsonReport(report, { rootLabel: 'other-root' }));
  assert.equal(overridden['root'], 'other-root');
});

test('the document shape is exactly the documented key set', () => {
  const parsed = parse(toJsonReport(report, { includeSkipped: true, config }));
  assert.deepEqual(Object.keys(parsed).sort(), [
    'durationMs',
    'files',
    'findings',
    'groups',
    'root',
    'schemaVersion',
    'skipped',
    'summary',
    'tool',
    'variables',
  ]);
  assert.deepEqual(list(parsed['skipped']), [
    { file: 'apps/legacy/.env', reason: 'git-ignored' },
    { file: 'vendor/bundle.env', reason: 'binary file' },
  ]);
  const without = parse(toJsonReport(report, { config }));
  assert.equal('skipped' in without, false);
  assert.equal(JSON.parse(toJsonReport(empty, {})).skipped, undefined);
});

test('files are sorted by path and carry no raw content', () => {
  const files = list(parse(toJsonReport(report, { config }))['files']);
  const paths = files.map((file) => String(record(file)['path']));
  assert.deepEqual(paths, [...paths].sort(byCodeUnit));
  assert.deepEqual(paths, [
    '.env',
    '.env.example',
    '.env.production',
    'apps/api/.env',
    'apps/web/.env',
    'apps/web/.env.local',
    'apps/worker/.env.template',
    'config/.env.test',
  ]);
  for (const file of files) {
    assert.deepEqual(Object.keys(record(file)).sort(), [
      'committed',
      'declCount',
      'devOnly',
      'exists',
      'issues',
      'kind',
      'path',
      'shared',
      'tracked',
    ]);
  }
  assert.deepEqual(files[0], {
    path: '.env',
    kind: 'dev',
    exists: true,
    shared: false,
    devOnly: true,
    tracked: false,
    committed: false,
    declCount: 13,
    issues: [{ kind: 'unterminated-quote', message: 'Unterminated quote for APP_NAME', file: '.env', line: 9, column: 1 }],
  });
  assert.deepEqual(record(files[1])['issues'], []);
});

test('findings keep every field and drop absent optionals', () => {
  const findings = list(parse(toJsonReport(report, { config }))['findings']);
  assert.equal(findings.length, FINDINGS.length);
  const first = FINDINGS.find((finding) => finding.ruleId === 'missing-in-env' && finding.file === 'apps/api/src/db.ts');
  assert.ok(first !== undefined);
  const match = findings.find(
    (finding) => record(finding)['file'] === 'apps/api/src/db.ts' && record(finding)['ruleId'] === 'missing-in-env',
  );
  assert.deepEqual(match, {
    ruleId: 'missing-in-env',
    ruleTitle: 'Variable read but never declared',
    severity: 'error',
    message: first.message,
    file: 'apps/api/src/db.ts',
    line: 12,
    column: 18,
    docsUrl: `${DOCS}#missing-in-env`,
    variable: 'DATABASE_URL',
    hint: 'declare it in .env and .env.example',
  });
  const bare = findings.find((finding) => record(finding)['ruleId'] === 'unterminated-quote');
  assert.deepEqual(Object.keys(record(bare)).sort(), ['column', 'docsUrl', 'file', 'line', 'message', 'ruleId', 'ruleTitle', 'severity']);
});

test('findings are sorted by severity, file, line, column and rule id', () => {
  const findings = list(parse(toJsonReport(report, { config }))['findings']);
  const rank = (severity: string): number => (severity === 'error' ? 3 : severity === 'warn' ? 2 : 1);
  const keys = findings.map((finding) => {
    const entry = record(finding);
    return [String(entry['severity']), String(entry['file']), Number(entry['line']), String(entry['ruleId'])] as const;
  });
  const sorted = [...keys].sort((a, b) => rank(b[0]) - rank(a[0]) || byCodeUnit(a[1], b[1]) || a[2] - b[2] || byCodeUnit(a[3], b[3]));
  assert.deepEqual(keys, sorted);
  const unsorted = list(parse(toJsonReport(report, { config, sort: false }))['findings']);
  assert.deepEqual(unsorted.map((finding) => record(finding)['message']), FINDINGS.map((finding) => finding.message));
});

test('no raw secret value ever reaches the document', () => {
  for (const redact of [true, false]) {
    const text = toJsonReport(report, { config, redact });
    for (const secret of [
      'AKIAIOSFODNN7EXAMPLE',
      'sk_test_EXAMPLE',
      'sk_live_EXAMPLE',
      'whsec_EXAMPLE',
      's3cr3t-EXAMPLE-value',
      'postgres://db.internal/app',
      'postgres://localhost:5432/app',
    ]) {
      assert.equal(text.includes(secret), false, `${secret} leaked with redact=${redact}`);
    }
  }
  const defaultText = toJsonReport(report, { config });
  for (const variable of list(parse(defaultText)['variables'])) {
    for (const value of list(record(variable)['values'])) {
      const preview = String(record(value)['preview']);
      assert.equal(preview === '<redacted>' || preview.length === 0, true, 'a preview survived default redaction');
    }
  }
});

test('redact false still hides secretish values and reveals the rest', () => {
  const visible = list(parse(toJsonReport(report, { config, redact: false }))['variables']);
  const byName = new Map(visible.map((variable) => [String(record(variable)['name']), variable]));
  const previews = (name: string): string[] => list(record(byName.get(name))['values']).map((value) => String(record(value)['preview']));
  assert.deepEqual(previews('APP_ENV'), ['development', 'production', '', 'production', 'test']);
  assert.deepEqual(previews('AWS_ACCESS_KEY_ID'), ['<redacted>', '']);
  assert.deepEqual(previews('STRIPE_SECRET_KEY'), ['sk_test_EXAMPLE', '', 'sk_live_EXAMPLE'].map((preview) => (preview === '' ? '' : '<redacted>')));
  assert.deepEqual(previews('WEBHOOK_SECRET'), ['<redacted>']);
  const redacted = list(parse(toJsonReport(report, { config, redact: true }))['variables']);
  for (const variable of redacted) {
    for (const value of list(record(variable)['values'])) {
      const preview = String(record(value)['preview']);
      assert.equal(preview === '<redacted>' || preview.length === 0, true);
    }
  }
  assert.equal(visible.length, redacted.length);
});

test('includeSource is reserved and never emits a source field', () => {
  const withSource = toJsonReport(report, { config, includeSource: true });
  assert.equal(withSource.includes('"source"'), false);
  assert.equal(withSource, toJsonReport(report, { config, includeSource: false }));
});

test('includeVariables false drops the array but keeps the counts', () => {
  const parsed = parse(toJsonReport(report, { config, includeVariables: false }));
  assert.deepEqual(parsed['variables'], []);
  assert.equal(record(parsed['summary'])['variables'], report.summary.variables);
  assert.equal(list(parse(toJsonReport(report, { config }))['variables']).length, declaredNames.size);
});

test('groupBy emits index groups, and never duplicates text', () => {
  const none = list(parse(toJsonReport(report, { config, groupBy: 'none' }))['groups']);
  assert.deepEqual(none, []);

  const byFile = list(parse(toJsonReport(report, { config, groupBy: 'file' }))['groups']);
  const findings = list(parse(toJsonReport(report, { config, groupBy: 'file' }))['findings']);
  const fileKeys = byFile.map((group) => String(record(group)['key']));
  assert.deepEqual(fileKeys, [...new Set(FINDINGS.map((finding) => finding.file))].sort(byCodeUnit));
  assert.equal(byFile.reduce<number>((total, group) => total + Number(record(group)['count']), 0), FINDINGS.length);
  for (const group of byFile) {
    const entry = record(group);
    const indices = list(entry['findings']).map(Number);
    assert.deepEqual(Object.keys(entry).sort(), ['count', 'findings', 'key']);
    assert.equal(indices.length, entry['count']);
    assert.deepEqual(indices, [...indices].sort((a, b) => a - b));
    for (const index of indices) {
      assert.equal(String(record(findings[index])['file']), entry['key']);
    }
  }

  const byRule = list(parse(toJsonReport(report, { config, groupBy: 'rule' }))['groups']);
  const ordered = list(parse(toJsonReport(report, { config, groupBy: 'rule' }))['findings']);
  assert.deepEqual(byRule.map((group) => String(record(group)['key'])), [...new Set(FINDINGS.map((f) => f.ruleId))].sort(byCodeUnit));
  assert.equal(byRule.reduce<number>((total, group) => total + Number(record(group)['count']), 0), FINDINGS.length);
  const expectedMissing = ordered
    .map((finding, index) => (record(finding)['ruleId'] === 'missing-in-env' ? index : -1))
    .filter((index) => index >= 0);
  assert.deepEqual(record(byRule.find((group) => record(group)['key'] === 'missing-in-env')), {
    key: 'missing-in-env',
    count: 2,
    findings: expectedMissing,
  });

  const byVariable = list(parse(toJsonReport(report, { config, groupBy: 'variable' }))['groups']);
  const anonymous = byVariable.find((group) => record(group)['key'] === '');
  assert.equal(Number(record(anonymous)['count']), FINDINGS.filter((finding) => finding.variable === undefined).length);
  assert.equal(byVariable.reduce<number>((total, group) => total + Number(record(group)['count']), 0), FINDINGS.length);
  for (const group of byVariable) {
    const entry = record(group);
    for (const index of list(entry['findings']).map(Number)) {
      const variable = record(findings[index])['variable'];
      assert.equal(variable ?? '', entry['key']);
    }
  }
});

test('pretty false produces a single line and identical data', () => {
  const compact = toJsonReport(report, { config, pretty: false });
  assert.equal(compact.includes('\n'), false);
  assert.deepEqual(parse(compact), parse(toJsonReport(report, { config })));
});

test('the same report always serialises byte-identically', () => {
  const options = { config, groupBy: 'rule', includeSkipped: true } as const;
  const first = toJsonReport(report, options);
  assert.equal(first, toJsonReport(makeRichReport(), options));
  const reordered: Report = {
    ...report,
    findings: [...FINDINGS].reverse(),
    decls: [...DECLS].reverse(),
    usages: [...USAGES].reverse(),
    infra: [...INFRA].reverse(),
    files: [...FILES].reverse(),
  };
  assert.equal(toJsonReport(reordered, options), first);
  assert.equal(toJsonReport(empty), toJsonReport(empty));
});

test('toJsonSummary emits only the four documented keys', () => {
  const text = toJsonSummary(report, { rootLabel: 'demo-repo' });
  assert.deepEqual(parse(text), {
    schemaVersion: 1,
    tool: { name: 'envgle', version: VERSION },
    root: 'demo-repo',
    summary: JSON.parse(JSON.stringify(report.summary)),
  });
  assert.equal(text.includes('AKIAIOSFODNN7EXAMPLE'), false);
  assert.deepEqual(parse(toJsonSummary(empty)), {
    schemaVersion: 1,
    tool: { name: 'envgle', version: VERSION },
    root: 'empty-repo',
    summary: emptySummary(),
  });
  assert.equal(toJsonSummary(empty, { pretty: false }).includes('\n'), false);
});

test('options may be omitted entirely', () => {
  const text = toJsonReport(report);
  const parsed = parse(text);
  assert.equal(parsed['schemaVersion'], 1);
  assert.equal(parsed['root'], report.root);
  assert.equal(list(parsed['variables']).length, declaredNames.size);
  assert.equal(list(parsed['groups']).length, 0);
});

test('pathological reports serialise without throwing', () => {
  const odd: Report = {
    ...empty,
    durationMs: Number.NaN,
    files: [
      { path: '', kind: 'dev', exists: false, shared: false, devOnly: false, tracked: false, declCount: 0, issues: [], committed: false, byteSize: 0 },
    ],
    findings: [makeFinding('invalid-name', 'error', '', 0, '')],
    summary: { ...emptySummary(), error: 1, total: 1 },
  };
  const text = toJsonReport(odd, { config, groupBy: 'variable', includeSkipped: true });
  assert.equal(parse(text)['durationMs'], 0);
  assert.equal(text.includes('\u001b['), false);
  assert.equal(toJsonSummary(odd).includes('findings'), false);
});
