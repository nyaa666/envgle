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
import { toExampleFile, toMarkdownTable } from '../src/report/markdown.js';
import { REPO_URL, VERSION } from '../src/version.js';

const byCodeUnit = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

const EM = '\u2014';
const ELLIPSIS = '\u2026';

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

const rows = (text: string): string[] => text.split('\n');

const maybeRow = (text: string, name: string): string | undefined =>
  rows(text).find((line) => line.startsWith(`| ${name} |`));

const rowFor = (text: string, name: string): string => {
  const row = maybeRow(text, name);
  assert.ok(row !== undefined, `no table row for ${name}`);
  return row;
};

const section = (text: string, heading: string): string[] => {
  const all = rows(text);
  const start = all.indexOf(heading);
  assert.notEqual(start, -1, `missing heading ${heading}`);
  const rest = all.slice(start + 1);
  const end = rest.findIndex((line) => line.startsWith('## '));
  return end === -1 ? rest : rest.slice(0, end);
};

test('an empty report renders an exact document', () => {
  const expected = [
    '# Environment variables',
    '',
    `envgle ${VERSION} \u00b7 empty-repo \u00b7 0 files \u00b7 0 variables \u00b7 0 errors, 0 warnings, 0 info`,
    '',
    '| Severity | Count |',
    '| --- | --- |',
    '| error | 0 |',
    '| warn | 0 |',
    '| info | 0 |',
    '',
    'No environment variables found.',
    '',
  ].join('\n');
  assert.equal(toMarkdownTable(empty, { rootLabel: 'empty-repo', config }), expected);
  assert.equal(toMarkdownTable(empty, { rootLabel: 'empty-repo', config }), toMarkdownTable(empty, { rootLabel: 'empty-repo', config }));
});

test('the header, severity table and rule table describe the run', () => {
  const text = toMarkdownTable(report, { rootLabel: 'demo-repo', config, includeFindings: true });
  const all = rows(text);
  assert.equal(all[0], '# Environment variables');
  assert.equal(all[2], `envgle ${VERSION} \u00b7 demo-repo \u00b7 24 files \u00b7 ${report.summary.variables} variables \u00b7 ${report.summary.error} errors, ${report.summary.warn} warnings, ${report.summary.info} info`);
  assert.equal(all.includes('| Severity | Count |'), true);
  assert.equal(all.includes(`| error | ${report.summary.error} |`), true);
  const table = all.slice(
    all.indexOf('| Rule | Severity | Count |') + 2,
    all.indexOf('| Variable | Required | Declared in | Read in | Default | Description |'),
  );
  const ruleRows = table.filter((line) => line.length > 0);
  const ruleKeys = Object.keys(report.summary.byRule).sort(byCodeUnit);
  assert.deepEqual(ruleRows.map((line) => (line.split(' | ')[0] ?? '').slice(2)), ruleKeys);
  assert.deepEqual(ruleRows.map((line) => (line.split(' | ')[1] ?? '')), ruleKeys.map((rule) => {
    const fired = FINDINGS.filter((finding) => finding.ruleId === rule);
    return fired.some((finding) => finding.severity === 'error') ? 'error' : fired.some((finding) => finding.severity === 'warn') ? 'warn' : 'info';
  }));
  assert.deepEqual(ruleRows.map((line) => (line.split(' | ')[2] ?? '').slice(0, -2)), ruleKeys.map((rule) => String(report.summary.byRule[rule])));
  assert.equal(text.endsWith('\n'), true);
  assert.equal(toMarkdownTable(report, { title: 'Env', config }).startsWith('# Env\n'), true);
  assert.equal(toMarkdownTable(report, { config }).includes('## Findings'), false);
});

test('the variable table is sorted, escaped and truncated', () => {
  const text = toMarkdownTable(report, { config });
  const all = rows(text);
  const start = all.indexOf('| Variable | Required | Declared in | Read in | Default | Description |');
  assert.notEqual(start, -1);
  const body = all.slice(start + 2).filter((line) => line.length > 0);
  const names = body.map((line) => (line.split(' | ')[0] ?? '').slice(2));
  assert.deepEqual(names, [...names].sort(byCodeUnit));
  assert.equal(names.includes('UNLISTED_FLAG'), true);
  assert.equal(rowFor(text, 'QUEUE_URL'), `| QUEUE_URL | yes | .env.example, apps/worker/.env.template | apps/worker/src/consumer.cs | <redacted> | AMQP broker \\| used by the worker. |`);
  assert.equal(
    rowFor(text, 'MAX_CONNECTIONS'),
    `| MAX_CONNECTIONS | yes | apps/web/.env | apps/api/src/pool.java | <redacted> | Maximum number of pooled database connections per process i${ELLIPSIS} |`,
  );
  assert.equal(rowFor(text, 'OTEL_EXPORTER'), `| OTEL_EXPORTER | no | apps/worker/.env.template | apps/worker/src/otel.ts | <redacted> | Sets the \\\`OTEL_EXPORTER\\\` endpoint. |`);
  assert.equal(rowFor(text, 'DEFAULT_TENANT'), `| DEFAULT_TENANT | no | .env | src/tenant.swift | <redacted> | ${EM} |`);
  assert.equal(rowFor(text, 'UNLISTED_FLAG'), `| UNLISTED_FLAG | no | ${EM} | src/flags.ts | ${EM} | ${EM} |`);
  assert.equal(rowFor(text, 'PORT'), `| PORT | yes | .env, .env.example, .env.production | apps/api/src/server.ts, apps/web/next.config.js | ${EM} | Port the HTTP server listens on. Set to 0 to let the OS cho${ELLIPSIS} |`);
  for (const line of body) {
    const cells = line.slice(1, -2).split(' | ');
    for (const value of cells) {
      assert.equal(value.length <= 60, true, `cell too long: ${value}`);
    }
  }
});

test('list cells cap at three paths and report the remainder', () => {
  const text = toMarkdownTable(report, { config });
  assert.equal(rowFor(text, 'LOG_LEVEL').includes('.env, .env.example, .env.production, +1 more'), true);
  assert.equal(rowFor(text, 'APP_ENV').includes('.env, .env.example, .env.production, +1 more'), true);
  assert.equal(rowFor(text, 'SESSION_SECRET').includes('.env, .env.example, .env.production, +1 more'), true);
  assert.equal(rowFor(text, 'APP_NAME').includes('.env, .env.example, .env.production |'), true);
  assert.equal(rowFor(text, 'UNLISTED_FLAG').includes(`| src/flags.ts |`), true);
});

test('redact controls the Default column without exposing secrets', () => {
  const visible = toMarkdownTable(report, { config, redact: false });
  assert.equal(rowFor(visible, 'APP_ENV').includes('| development |'), true);
  assert.equal(rowFor(visible, 'MAX_CONNECTIONS').includes('| 20 |'), true);
  assert.equal(rowFor(visible, 'AWS_ACCESS_KEY_ID').includes('| <redacted> |'), true);
  for (const text of [visible, toMarkdownTable(report, { config })]) {
    for (const secret of ['AKIAIOSFODNN7EXAMPLE', 'sk_test_EXAMPLE', 'whsec_EXAMPLE', 's3cr3t-EXAMPLE-value']) {
      assert.equal(text.includes(secret), false, `${secret} leaked into markdown`);
    }
  }
});

test('includeFindings appends one section per rule', () => {
  const text = toMarkdownTable(report, { config, includeFindings: true });
  const headings = rows(text).filter((line) => line.startsWith('### '));
  assert.deepEqual(headings, [...new Set(FINDINGS.map((finding) => finding.ruleId))].sort(byCodeUnit).map((rule) => `### ${rule}`));
  const missing = section(text, '### missing-in-env');
  assert.equal(missing.includes('error \u00b7 2 findings'), true);
  assert.equal(missing.includes('| File | Line | Message |'), true);
  assert.equal(missing.includes('Variable read but never declared'), true);
  assert.equal(
    missing.includes('| apps/api/src/db.ts | 12 | DATABASE_URL is read by the code but no .env file declares it. |'),
    false,
    'long messages are truncated to 60 characters',
  );
  assert.equal(
    missing.includes(`| apps/api/src/db.ts | 12 | DATABASE_URL is read by the code but no .env file declares ${ELLIPSIS} |`),
    true,
  );
  const ciSection = section(text, '### ci-secret-undeclared');
  assert.equal(ciSection.includes('error \u00b7 1 finding'), true);
  assert.equal(ciSection.includes('| .github/workflows/ci.yml | 22 | CI injects STRIPE_SECRET_KEY but no .env file declares it. |'), true);
  const exportSection = section(text, '### export-prefix');
  assert.equal(exportSection.includes('info \u00b7 1 finding'), true);
  const longRow = exportSection.find((line) => line.startsWith('| apps/worker/.env.template | 4 | QUEUE_URL uses'));
  assert.equal(longRow?.includes(`${ELLIPSIS} |`), true, 'a 69 character message is truncated');
  assert.equal((longRow ?? '').slice(1, -2).split(' | ')[2]?.length, 60);
  assert.equal(section(text, '### weak-secret').includes('| .env | 7 | DEFAULT_TENANT matches a well-known weak placeholder. |'), true);
});

test('includeEmpty keeps variables that only appear in infrastructure', () => {
  const trimmed = toMarkdownTable(report, { config });
  const full = toMarkdownTable(report, { config, includeEmpty: true });
  assert.equal(maybeRow(trimmed, 'NEXT_TELEMETRY'), undefined);
  assert.equal(maybeRow(trimmed, 'NODE_ENV'), undefined);
  assert.equal(rowFor(full, 'NEXT_TELEMETRY'), `| NEXT_TELEMETRY | no | ${EM} | ${EM} | ${EM} | ${EM} |`);
  assert.equal(rowFor(full, 'UNLISTED_FLAG'), `| UNLISTED_FLAG | no | ${EM} | src/flags.ts | ${EM} | ${EM} |`);
  assert.equal(full.split('\n').length > trimmed.split('\n').length, true);
});

test('the markdown document is stable and free of ansi codes and absolute paths', () => {
  const options = { config, includeFindings: true, includeEmpty: true } as const;
  assert.equal(toMarkdownTable(report, options), toMarkdownTable(makeRichReport(), options));
  const text = toMarkdownTable(report, options);
  assert.equal(text.includes('\u001b['), false);
  assert.equal(text.includes('C:\\'), false);
  assert.equal(text.includes(report.startedAt), false);
  assert.equal(toMarkdownTable(report), toMarkdownTable(report));
});

test('the example file never contains a value', () => {
  const text = toExampleFile(report, { config });
  const all = rows(text).slice(0, -1);
  assert.equal(all[0], `# Generated by envgle v${VERSION}. Do not edit by hand: regenerate with "envgle init --write".`);
  assert.equal(all[1], '# Do NOT put real secrets in this file. Leave secret values empty.');
  assert.equal(all[3], '# --- required (no default) ---');
  for (const line of all) {
    assert.equal(/^(?:#.*|[A-Za-z_][A-Za-z0-9_]*=)?$/.test(line), true, `invalid .env.example line: ${line}`);
  }
  const assignments = all.filter((line) => line.includes('='));
  assert.equal(assignments.length > 20, true);
  for (const line of assignments) {
    assert.equal(line.endsWith('='), true);
  }
  assert.equal(text.includes('.env.production='), false);
  assert.equal(text.includes('DB-PORT='), false);
  for (const secret of ['AKIAIOSFODNN7EXAMPLE', 'sk_test_EXAMPLE', 'whsec_EXAMPLE', 'amqp://localhost', 'postgres://localhost/app', 'changeme', 'development']) {
    assert.equal(text.includes(secret), false, `${secret} leaked into the example file`);
  }
  const required = all.slice(all.indexOf('# --- required (no default) ---') + 1, all.indexOf('# --- optional ---'));
  const optional = all.slice(all.indexOf('# --- optional ---') + 1);
  assert.equal(required.includes('PORT='), true);
  assert.equal(required.includes('# read in apps/api/src/server.ts:44'), true);
  assert.equal(required.includes('DATABASE_URL='), true);
  assert.equal(required.includes('# Connection string for the primary database.'), true);
  assert.equal(optional.includes('PORT='), false);
  assert.equal(optional.includes('APP_NAME='), true);
  assert.equal(optional.includes('LEGACY_CACHE_TTL='), true);
  assert.equal(optional.includes('UNLISTED_FLAG='), true);
  assert.equal(optional.includes('NEXT_TELEMETRY='), true);
  const names = (lines: string[]): string[] => lines.filter((line) => line.includes('=')).map((line) => line.slice(0, -1));
  assert.deepEqual(names(required), [...names(required)].sort(byCodeUnit));
  assert.deepEqual(names(optional), [...names(optional)].sort(byCodeUnit));
  const secretNote = all.indexOf('# secret - do not commit a real value');
  assert.notEqual(secretNote, -1);
  assert.equal(all[secretNote - 1]?.startsWith('# '), true);
  assert.equal(all[secretNote + 1]?.startsWith('# '), true);
  assert.equal(all[secretNote + 1], '# read in apps/api/src/s3.ts:7');
  assert.equal(all[secretNote + 2], 'AWS_ACCESS_KEY_ID=');
});

test('the example file is idempotent for an already redacted report', () => {
  const redacted: Report = {
    ...report,
    decls: report.decls.map((decl) => ({ ...decl, value: decl.value.length === 0 ? '' : '<redacted>' })),
  };
  assert.equal(toExampleFile(redacted, { config }), toExampleFile(report, { config }));
  assert.equal(toExampleFile(report, { config }), toExampleFile(report, { config }));
  assert.equal(toExampleFile(report, { config, title: 'Ignored', includeFindings: true, includeEmpty: true, redact: false }), toExampleFile(report, { config }));
});

test('an empty report still produces a valid example file', () => {
  const expected = [
    `# Generated by envgle v${VERSION}. Do not edit by hand: regenerate with "envgle init --write".`,
    '# Do NOT put real secrets in this file. Leave secret values empty.',
    '',
    '# --- required (no default) ---',
    '',
    '# --- optional ---',
    '',
  ].join('\n');
  assert.equal(toExampleFile(empty, { config }), expected);
  assert.equal(toExampleFile(empty), expected);
});

test('pathological reports render without throwing', () => {
  const odd: Report = {
    ...empty,
    files: [makeFile('', { issues: [makeIssue('unknown', '', 0, '')] })],
    decls: [
      makeDecl('WEIRD|NAME', '.env', -1, 'a'.repeat(300), { leadingComments: ['multi\nline   comment', '  ', 'second'] }),
      makeDecl('', '', 0, ''),
    ],
    usages: [makeUsage('', '', 0, '')],
  };
  const text = toMarkdownTable(odd, { config, includeFindings: true, includeEmpty: true });
  const row = rowFor(text, 'WEIRD\\|NAME');
  assert.equal(row.includes('WEIRD\\|NAME'), true);
  assert.equal(row.includes('multi line comment second'), true);
  assert.equal(row.includes(`${EM} |`), true);
  assert.equal(row.endsWith(' |'), true);
  const example = toExampleFile(odd, { config });
  assert.equal(example.includes('WEIRD'), false, 'names that are not identifiers never reach the example file');
  assert.equal(typeof toExampleFile(report, { config }), 'string');
});
