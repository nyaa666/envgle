import assert from 'node:assert/strict';
import test from 'node:test';
import type {
  EnvFileInfo,
  EnvFileKind,
  EnvParseIssue,
  EnvUsage,
  EnvVarDecl,
  Finding,
  InfraKind,
  InfraRef,
  PackageManifest,
  Report,
  ResolvedConfig,
  RuleContext,
  RuleId,
} from '../src/types.js';
import { buildContext, runRules } from '../src/rules/context.js';
import { contractRules } from '../src/rules/contract.js';
import { DEFAULT_SECRET_NAME_PATTERN } from '../src/utils/text.js';

const BASE_CONFIG: ResolvedConfig = {
  include: ['**/*'],
  exclude: ['node_modules'],
  envFiles: ['**/.env*'],
  exampleFiles: ['**/.env.example', '**/.env.sample', '**/.env.template'],
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
  hasValue: true,
  quoted: null,
  exported: false,
  references: [],
  duplicateOfLine: null,
  leadingComments: [],
  inlineComment: null,
  unquotedInlineComment: null,
  hasTrailingWhitespace: false,
  kind: options.kind ?? 'dev',
  shared: options.shared ?? true,
  devOnly: options.devOnly ?? false,
});

interface UsageOptions {
  readonly column?: number;
  readonly required?: boolean;
  readonly hasFallback?: boolean;
}

const usage = (name: string, file: string, line: number, options: UsageOptions = {}): EnvUsage => ({
  name,
  file,
  line,
  column: options.column ?? 1,
  language: 'typescript',
  accessor: 'process.env',
  hasFallback: options.hasFallback ?? false,
  required: options.required ?? false,
  viaImport: false,
  fallbackLiteral: null,
});

interface RefOptions {
  readonly column?: number;
  readonly required?: boolean;
  readonly refersToFile?: boolean;
  readonly interpolation?: boolean;
}

const ref = (name: string, file: string, line: number, kind: InfraKind, options: RefOptions = {}): InfraRef => ({
  name,
  file,
  line,
  column: options.column ?? 1,
  kind,
  required: options.required ?? false,
  refersToFile: options.refersToFile ?? false,
  interpolation: options.interpolation ?? false,
});

interface FileOptions {
  readonly kind?: EnvFileKind;
  readonly exists?: boolean;
  readonly shared?: boolean;
  readonly devOnly?: boolean;
  readonly tracked?: boolean;
  readonly committed?: boolean;
  readonly issues?: readonly EnvParseIssue[];
}

const fileInfo = (path: string, options: FileOptions = {}): EnvFileInfo => ({
  path,
  kind: options.kind ?? 'dev',
  exists: options.exists ?? true,
  shared: options.shared ?? true,
  devOnly: options.devOnly ?? false,
  tracked: options.tracked ?? true,
  declCount: 0,
  issues: options.issues ?? [],
  committed: options.committed ?? true,
  byteSize: 12,
});

const makeManifest = (dependencies: readonly string[] = [], devDependencies: readonly string[] = []): PackageManifest => ({
  path: 'package.json',
  name: 'app',
  dependencies,
  devDependencies,
  scripts: {},
  engines: {},
});

interface Parts {
  readonly files?: readonly EnvFileInfo[];
  readonly decls?: readonly EnvVarDecl[];
  readonly usages?: readonly EnvUsage[];
  readonly infra?: readonly InfraRef[];
  readonly manifest?: PackageManifest | null;
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
          tracked: !item.devOnly,
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
    usages: parts.usages ?? [],
    infra: parts.infra ?? [],
    manifest: parts.manifest ?? null,
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
  const rule = contractRules.find((item) => item.id === ruleId);
  assert.ok(rule !== undefined, `contract rule ${ruleId} is missing`);
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

test('missing-in-env reports the first read per file', () => {
  const findings = run('missing-in-env', {
    usages: [
      usage('PORT', 'src/app.ts', 30, { column: 13 }),
      usage('PORT', 'src/app.ts', 10, { column: 13 }),
      usage('PORT', 'src/other.ts', 4),
    ],
  });

  assert.deepEqual(tuples(findings), [
    ['missing-in-env', 'src/app.ts', 10, 13, 'error', 'PORT'],
    ['missing-in-env', 'src/other.ts', 4, 1, 'error', 'PORT'],
  ]);
  assert.equal(
    findings[0]?.message,
    'PORT is read in src/app.ts but never declared in any env file',
  );
  assert.match(findings[0]?.hint ?? '', /envgle init/);
});

test('missing-in-env ignores names an env file or an infra declaration provides', () => {
  const findings = run('missing-in-env', {
    decls: [decl('PORT', '.env', 1)],
    usages: [
      usage('PORT', 'src/app.ts', 2),
      usage('HOST', 'src/app.ts', 3),
      usage('CI_FLAG', 'src/app.ts', 4),
      usage('BUILT', 'src/app.ts', 5),
    ],
    infra: [
      ref('HOST', 'docker-compose.yml', 1, 'compose-environment'),
      ref('CI_FLAG', '.github/workflows/ci.yml', 3, 'ci-env'),
      ref('BUILT', 'Dockerfile', 2, 'dockerfile-env'),
    ],
  });

  assert.deepEqual(findings, []);
});

test('missing-in-env honours ignoreRules and ignoreVariables', () => {
  const parts: Parts = { usages: [usage('PORT', 'src/app.ts', 2)] };

  assert.deepEqual(run('missing-in-env', parts, makeConfig({ ignoreRules: new Set<RuleId>(['missing-in-env']) })), []);
  assert.deepEqual(run('missing-in-env', parts, makeConfig({ ignoreVariables: ['p*'] })), []);
  assert.deepEqual(run('missing-in-env', parts, makeConfig({ ignoreVariables: ['HOST'] })).length, 1);
});

test('missing-in-env uses the configured severity', () => {
  const findings = run(
    'missing-in-env',
    { usages: [usage('PORT', 'src/app.ts', 2)] },
    makeConfig({ severities: { 'missing-in-env': 'info' } }),
  );

  assert.equal(findings[0]?.severity, 'info');
});

test('missing-in-env asks the context before reporting', () => {
  const rule = contractRules.find((item) => item.id === 'missing-in-env');
  assert.ok(rule !== undefined);
  const asked: RuleId[] = [];
  const suppress = (location: { file: string; line: number; column: number }, ruleId: RuleId): boolean => {
    asked.push(ruleId);
    return location.line === 2;
  };
  const context: RuleContext = buildContext({
    report: makeReport({ usages: [usage('PORT', 'src/app.ts', 2), usage('PORT', 'src/other.ts', 9)] }),
    config: makeConfig(),
    suppress,
  });

  assert.deepEqual(tuples(runRules(context, [rule]).findings), [
    ['missing-in-env', 'src/other.ts', 9, 1, 'error', 'PORT'],
  ]);
  assert.deepEqual(asked, ['missing-in-env', 'missing-in-env']);
});

test('missing-from-example reports real declarations the example file omits', () => {
  const findings = run('missing-from-example', {
    decls: [
      decl('DATABASE_URL', '.env.example', 1, { kind: 'example' }),
      decl('API_URL', '.env', 3, { column: 5 }),
      decl('API_URL', '.env.prod', 2),
    ],
  });

  assert.deepEqual(tuples(findings), [
    ['missing-from-example', '.env', 3, 5, 'error', 'API_URL'],
    ['missing-from-example', '.env.prod', 2, 1, 'error', 'API_URL'],
  ]);
  assert.equal(findings[0]?.message, 'API_URL is declared in .env but is not documented in .env.example');
  assert.match(findings[0]?.hint ?? '', /\.env\.example/);
});

test('missing-from-example stays quiet for documented names and for repos without an example', () => {
  const documented = run('missing-from-example', {
    decls: [decl('API_URL', '.env.example', 1, { kind: 'example' }), decl('API_URL', '.env', 2)],
  });
  const noExample = run('missing-from-example', { decls: [decl('API_URL', '.env', 2)] });

  assert.deepEqual(documented, []);
  assert.deepEqual(noExample, []);
});

test('missing-from-example honours ignoreRules, ignoreVariables and severities', () => {
  const parts: Parts = { decls: [decl('DATABASE_URL', '.env.example', 1, { kind: 'example' }), decl('API_URL', '.env', 2)] };

  assert.deepEqual(
    run('missing-from-example', parts, makeConfig({ ignoreRules: new Set<RuleId>(['missing-from-example']) })),
    [],
  );
  assert.deepEqual(run('missing-from-example', parts, makeConfig({ ignoreVariables: ['API_*'] })), []);
  assert.equal(
    run('missing-from-example', parts, makeConfig({ severities: { 'missing-from-example': 'warn' } }))[0]?.severity,
    'warn',
  );
});

test('unused-variable reports a declaration nothing reads', () => {
  const findings = run('unused-variable', { decls: [decl('API_LEGACY', '.env', 2, { column: 3 })] });

  assert.deepEqual(tuples(findings), [['unused-variable', '.env', 2, 3, 'warn', 'API_LEGACY']]);
  assert.equal(
    findings[0]?.message,
    'API_LEGACY is declared but never read by code, compose, Docker or CI',
  );
});

test('unused-variable ignores names read by code or referenced by infra', () => {
  const findings = run('unused-variable', {
    decls: [decl('USED', '.env', 1), decl('COMPOSED', '.env', 2), decl('CI_ONLY', '.env', 3)],
    usages: [usage('USED', 'src/app.ts', 4)],
    infra: [ref('COMPOSED', 'docker-compose.yml', 1, 'compose-environment'), ref('CI_ONLY', 'ci.yml', 2, 'ci-env')],
  });

  assert.deepEqual(findings, []);
});

test('unused-variable honours ignoreRules, ignoreVariables and severities', () => {
  const parts: Parts = { decls: [decl('API_LEGACY', '.env', 2)] };

  assert.deepEqual(run('unused-variable', parts, makeConfig({ ignoreRules: new Set<RuleId>(['unused-variable']) })), []);
  assert.deepEqual(run('unused-variable', parts, makeConfig({ ignoreVariables: ['API_*'] })), []);
  assert.equal(
    run('unused-variable', parts, makeConfig({ severities: { 'unused-variable': 'error' } }))[0]?.severity,
    'error',
  );
});

test('prod-crash reports a required read only a dev-only file provides', () => {
  const findings = run('prod-crash', {
    decls: [decl('DATABASE_URL', '.env.local', 4, { kind: 'local', shared: false, devOnly: true })],
    usages: [usage('DATABASE_URL', 'src/db.ts', 20, { column: 15, required: true })],
  });

  assert.deepEqual(tuples(findings), [['prod-crash', 'src/db.ts', 20, 15, 'error', 'DATABASE_URL']]);
  assert.match(findings[0]?.message ?? '', /only \.env\.local declares it/);
  assert.match(findings[0]?.message ?? '', /undefined in production/);
  assert.match(findings[0]?.hint ?? '', /default/);
});

test('prod-crash ignores fallback reads, shared declarations and CI secrets', () => {
  const devOnly = { kind: 'local', shared: false, devOnly: true } as const;
  const withFallback = run('prod-crash', {
    decls: [decl('DATABASE_URL', '.env.local', 4, devOnly)],
    usages: [usage('DATABASE_URL', 'src/db.ts', 20, { hasFallback: true })],
  });
  const sharedDeclaration = run('prod-crash', {
    decls: [decl('DATABASE_URL', '.env', 1), decl('DATABASE_URL', '.env.local', 4, devOnly)],
    usages: [usage('DATABASE_URL', 'src/db.ts', 20, { required: true })],
  });
  const ciSecret = run('prod-crash', {
    decls: [decl('DEPLOY_TOKEN', '.env.local', 4, devOnly)],
    usages: [usage('DEPLOY_TOKEN', 'src/app.ts', 7, { required: true })],
    infra: [ref('DEPLOY_TOKEN', 'ci.yml', 3, 'ci-secret')],
  });

  assert.deepEqual(withFallback, []);
  assert.deepEqual(sharedDeclaration, []);
  assert.deepEqual(ciSecret, []);
});

test('prod-crash honours ignoreRules, ignoreVariables and severities', () => {
  const parts: Parts = {
    decls: [decl('DATABASE_URL', '.env.local', 4, { kind: 'local', shared: false, devOnly: true })],
    usages: [usage('DATABASE_URL', 'src/db.ts', 20, { required: true })],
  };

  assert.deepEqual(run('prod-crash', parts, makeConfig({ ignoreRules: new Set<RuleId>(['prod-crash']) })), []);
  assert.deepEqual(run('prod-crash', parts, makeConfig({ ignoreVariables: ['DATABASE_*'] })), []);
  assert.equal(
    run('prod-crash', parts, makeConfig({ severities: { 'prod-crash': 'warn' } }))[0]?.severity,
    'warn',
  );
});

test('example-out-of-sync reports documented entries nothing uses', () => {
  const findings = run('example-out-of-sync', { decls: [decl('UNUSED_DOC', '.env.example', 5, { kind: 'example' })] });

  assert.deepEqual(tuples(findings), [['example-out-of-sync', '.env.example', 5, 1, 'error', 'UNUSED_DOC']]);
  assert.match(findings[0]?.message ?? '', /documented in \.env\.example/);
});

test('example-out-of-sync ignores documented entries that are declared or read', () => {
  const declared = run('example-out-of-sync', {
    decls: [decl('REAL', '.env.example', 1, { kind: 'example' }), decl('REAL', '.env', 2)],
  });
  const read = run('example-out-of-sync', {
    decls: [decl('READ', '.env.example', 1, { kind: 'example' })],
    usages: [usage('READ', 'src/app.ts', 3)],
  });

  assert.deepEqual(declared, []);
  assert.deepEqual(read, []);
});

test('example-out-of-sync reports a missing example file once when requireExampleFile is set', () => {
  const findings = run('example-out-of-sync', {
    decls: [decl('PORT', '.env', 1, { column: 4 }), decl('HOST', '.env', 2)],
  });

  assert.deepEqual(tuples(findings), [['example-out-of-sync', '.env', 1, 4, 'error', 'PORT']]);
  assert.match(findings[0]?.message ?? '', /no example env file is committed/);
  assert.equal(findings[0]?.hint, 'run envgle init to create .env.example');
  assert.deepEqual(
    run('example-out-of-sync', { decls: [decl('PORT', '.env', 1)] }, makeConfig({ requireExampleFile: false })),
    [],
  );
  assert.deepEqual(run('example-out-of-sync', { decls: [] }), []);
});

test('example-out-of-sync honours ignoreRules, ignoreVariables and severities', () => {
  const parts: Parts = { decls: [decl('UNUSED_DOC', '.env.example', 5, { kind: 'example' })] };

  assert.deepEqual(
    run('example-out-of-sync', parts, makeConfig({ ignoreRules: new Set<RuleId>(['example-out-of-sync']) })),
    [],
  );
  assert.deepEqual(run('example-out-of-sync', parts, makeConfig({ ignoreVariables: ['UNUSED_*'] })), []);
  assert.equal(
    run('example-out-of-sync', parts, makeConfig({ severities: { 'example-out-of-sync': 'info' } }))[0]?.severity,
    'info',
  );
});

test('ci-secret-undeclared reports an undocumented secretish CI secret', () => {
  const findings = run('ci-secret-undeclared', {
    infra: [ref('DEPLOY_TOKEN', '.github/workflows/ci.yml', 22, 'ci-secret', { column: 9, required: true })],
  });

  assert.deepEqual(tuples(findings), [
    ['ci-secret-undeclared', '.github/workflows/ci.yml', 22, 9, 'warn', 'DEPLOY_TOKEN'],
  ]);
  assert.equal(
    findings[0]?.message,
    'DEPLOY_TOKEN is a secret in .github/workflows/ci.yml but is not documented in any example env file',
  );
  assert.equal(findings[0]?.fingerprint, undefined);
  assert.match(findings[0]?.hint ?? '', /example env file/);
});

test('ci-secret-undeclared ignores documented secrets and non-secretish names', () => {
  const documented = run('ci-secret-undeclared', {
    decls: [decl('DEPLOY_TOKEN', '.env.example', 1, { kind: 'example' })],
    infra: [ref('DEPLOY_TOKEN', '.github/workflows/ci.yml', 22, 'ci-secret', { required: true })],
  });
  const notSecretish = run('ci-secret-undeclared', {
    infra: [ref('AWS_REGION', '.github/workflows/ci.yml', 4, 'ci-secret', { required: true })],
  });

  assert.deepEqual(documented, []);
  assert.deepEqual(notSecretish, []);
});

test('ci-secret-undeclared honours ignoreRules, ignoreVariables and severities', () => {
  const parts: Parts = { infra: [ref('DEPLOY_TOKEN', 'ci.yml', 22, 'ci-secret', { required: true })] };

  assert.deepEqual(
    run('ci-secret-undeclared', parts, makeConfig({ ignoreRules: new Set<RuleId>(['ci-secret-undeclared']) })),
    [],
  );
  assert.deepEqual(run('ci-secret-undeclared', parts, makeConfig({ ignoreVariables: ['*_TOKEN'] })), []);
  assert.equal(
    run('ci-secret-undeclared', parts, makeConfig({ severities: { 'ci-secret-undeclared': 'error' } }))[0]?.severity,
    'error',
  );
});

test('compose-var-undeclared scales severity with the interpolation form', () => {
  const findings = run('compose-var-undeclared', {
    infra: [
      ref('PGPASSWORD', 'docker-compose.yml', 12, 'compose-interpolation', {
        column: 20,
        required: true,
        interpolation: true,
      }),
      ref('LOG_LEVEL', 'docker-compose.yml', 13, 'compose-interpolation', { interpolation: true }),
    ],
  });

  assert.deepEqual(tuples(findings), [
    ['compose-var-undeclared', 'docker-compose.yml', 12, 20, 'error', 'PGPASSWORD'],
    ['compose-var-undeclared', 'docker-compose.yml', 13, 1, 'info', 'LOG_LEVEL'],
  ]);
  assert.match(findings[0]?.message ?? '', /PGPASSWORD is interpolated in docker-compose\.yml/);
  assert.match(findings[0]?.hint ?? '', /environment:/);
  assert.match(findings[1]?.hint ?? '', /default/);
});

test('compose-var-undeclared ignores declared and environment-provided names', () => {
  const findings = run('compose-var-undeclared', {
    decls: [decl('API_URL', '.env', 1)],
    infra: [
      ref('API_URL', 'docker-compose.yml', 4, 'compose-interpolation', { interpolation: true }),
      ref('HOST', 'docker-compose.yml', 5, 'compose-interpolation', { interpolation: true }),
      ref('HOST', 'docker-compose.yml', 6, 'compose-environment'),
    ],
  });

  assert.deepEqual(findings, []);
});

test('compose-var-undeclared honours ignoreRules, ignoreVariables and severity precedence', () => {
  const parts: Parts = {
    infra: [ref('LOG_LEVEL', 'docker-compose.yml', 13, 'compose-interpolation', { interpolation: true })],
  };

  assert.deepEqual(
    run('compose-var-undeclared', parts, makeConfig({ ignoreRules: new Set<RuleId>(['compose-var-undeclared']) })),
    [],
  );
  assert.deepEqual(run('compose-var-undeclared', parts, makeConfig({ ignoreVariables: ['LOG_*'] })), []);
  assert.equal(
    run('compose-var-undeclared', parts, makeConfig({ severities: { 'compose-var-undeclared': 'error' } }))[0]
      ?.severity,
    'info',
  );
});

test('env-file-missing reports a referenced file that is not on disk', () => {
  const findings = run('env-file-missing', {
    infra: [ref('.env.local', 'docker-compose.yml', 8, 'compose-env-file', { column: 15, refersToFile: true })],
  });

  assert.deepEqual(tuples(findings), [['env-file-missing', 'docker-compose.yml', 8, 15, 'error', null]]);
  assert.equal(findings[0]?.message, 'docker-compose.yml references .env.local which does not exist');
  assert.match(findings[0]?.hint ?? '', /create the file/);
});

test('env-file-missing still reports when the scanner pre-registered the file as missing', () => {
  const findings = run('env-file-missing', {
    files: [fileInfo('.env.local', { kind: 'local', exists: false, devOnly: true, committed: false })],
    infra: [ref('.env.local', 'docker-compose.yml', 8, 'compose-env-file', { refersToFile: true })],
  });

  assert.deepEqual(tuples(findings), [['env-file-missing', 'docker-compose.yml', 8, 1, 'error', null]]);
});

test('env-file-missing resolves dotenv paths relative to the referring file', () => {
  const relative = run('env-file-missing', {
    infra: [ref('../../.env', 'apps/api/docker-compose.yml', 3, 'dotenv-path', { refersToFile: true })],
  });
  const withFile = run('env-file-missing', {
    decls: [decl('API_URL', '.env', 1)],
    infra: [ref('../../.env', 'apps/api/docker-compose.yml', 3, 'dotenv-path', { refersToFile: true })],
  });

  assert.equal(
    relative[0]?.message,
    'apps/api/docker-compose.yml references ../../.env which does not exist',
  );
  assert.deepEqual(withFile, []);
});

test('env-file-missing honours ignoreRules, ignoreVariables and severities', () => {
  const parts: Parts = {
    infra: [ref('.env.local', 'docker-compose.yml', 8, 'compose-env-file', { refersToFile: true })],
  };

  assert.deepEqual(run('env-file-missing', parts, makeConfig({ ignoreRules: new Set<RuleId>(['env-file-missing']) })), []);
  assert.deepEqual(run('env-file-missing', parts, makeConfig({ ignoreVariables: ['.env.*'] })), []);
  assert.equal(
    run('env-file-missing', parts, makeConfig({ severities: { 'env-file-missing': 'warn' } }))[0]?.severity,
    'warn',
  );
});

test('env-file-untracked reports a dev-only referenced file', () => {
  const findings = run('env-file-untracked', {
    files: [fileInfo('.env.local', { kind: 'local', devOnly: true, committed: false, tracked: false })],
    infra: [ref('.env.local', 'docker-compose.yml', 8, 'compose-env-file', { column: 15, refersToFile: true })],
  });

  assert.deepEqual(tuples(findings), [['env-file-untracked', 'docker-compose.yml', 8, 15, 'error', null]]);
  assert.equal(
    findings[0]?.message,
    'docker-compose.yml references .env.local which is a dev-only file, so the deploy will not have it',
  );
  assert.match(findings[0]?.hint ?? '', /deploy pipeline/);
});

test('env-file-untracked reports a git-ignored referenced file and ignores missing ones', () => {
  const ignored = run('env-file-untracked', {
    files: [fileInfo('.env.staging', { committed: false, tracked: false })],
    infra: [ref('.env.staging', 'docker-compose.yml', 8, 'compose-env-file', { refersToFile: true })],
  });
  const missing = run('env-file-untracked', {
    infra: [ref('.env.staging', 'docker-compose.yml', 8, 'compose-env-file', { refersToFile: true })],
  });

  assert.match(ignored[0]?.message ?? '', /is not tracked by git/);
  assert.deepEqual(missing, []);
});

test('env-file-untracked stays quiet for committed referenced files', () => {
  const findings = run('env-file-untracked', {
    files: [fileInfo('.env.production')],
    infra: [ref('.env.production', 'docker-compose.yml', 8, 'compose-env-file', { refersToFile: true })],
  });

  assert.deepEqual(findings, []);
});

test('env-file-untracked honours ignoreRules, ignoreVariables and severities', () => {
  const parts: Parts = {
    files: [fileInfo('.env.local', { kind: 'local', devOnly: true, committed: false, tracked: false })],
    infra: [ref('.env.local', 'docker-compose.yml', 8, 'compose-env-file', { refersToFile: true })],
  };

  assert.deepEqual(
    run('env-file-untracked', parts, makeConfig({ ignoreRules: new Set<RuleId>(['env-file-untracked']) })),
    [],
  );
  assert.deepEqual(run('env-file-untracked', parts, makeConfig({ ignoreVariables: ['.env.local'] })), []);
  assert.equal(
    run('env-file-untracked', parts, makeConfig({ severities: { 'env-file-untracked': 'warn' } }))[0]?.severity,
    'warn',
  );
});

test('framework-prefix-mismatch reports a prefix the manifest does not use', () => {
  const findings = run('framework-prefix-mismatch', {
    decls: [decl('REACT_APP_API_URL', '.env', 3, { column: 2 })],
    manifest: makeManifest(['express']),
  });

  assert.deepEqual(tuples(findings), [['framework-prefix-mismatch', '.env', 3, 2, 'warn', 'REACT_APP_API_URL']]);
  assert.equal(
    findings[0]?.message,
    'REACT_APP_API_URL uses the REACT_APP_ prefix, but this project depends on none of react-scripts, react, next, expo',
  );
});

test('framework-prefix-mismatch reports names that are read in code as well', () => {
  const findings = run('framework-prefix-mismatch', {
    decls: [decl('VITE_MODE', '.env', 1), decl('VITE_MODE', '.env.production', 4)],
    usages: [usage('VITE_MODE', 'src/main.ts', 2)],
    manifest: makeManifest(['vue']),
  });

  assert.deepEqual(tuples(findings), [
    ['framework-prefix-mismatch', '.env', 1, 1, 'warn', 'VITE_MODE'],
    ['framework-prefix-mismatch', '.env.production', 4, 1, 'warn', 'VITE_MODE'],
  ]);
});

test('framework-prefix-mismatch stays quiet for a matching dependency, no prefix or no manifest', () => {
  const matching = run('framework-prefix-mismatch', {
    decls: [decl('REACT_APP_API_URL', '.env', 3)],
    manifest: makeManifest([], ['react-scripts']),
  });
  const plainName = run('framework-prefix-mismatch', {
    decls: [decl('API_URL', '.env', 3)],
    manifest: makeManifest(['express']),
  });
  const noManifest = run('framework-prefix-mismatch', { decls: [decl('REACT_APP_API_URL', '.env', 3)] });

  assert.deepEqual(matching, []);
  assert.deepEqual(plainName, []);
  assert.deepEqual(noManifest, []);
});

test('framework-prefix-mismatch honours ignoreRules, ignoreVariables and severities', () => {
  const parts: Parts = {
    decls: [decl('REACT_APP_API_URL', '.env', 3)],
    manifest: makeManifest(['express']),
  };

  assert.deepEqual(
    run('framework-prefix-mismatch', parts, makeConfig({ ignoreRules: new Set<RuleId>(['framework-prefix-mismatch']) })),
    [],
  );
  assert.deepEqual(run('framework-prefix-mismatch', parts, makeConfig({ ignoreVariables: ['REACT_APP_*'] })), []);
  assert.equal(
    run('framework-prefix-mismatch', parts, makeConfig({ severities: { 'framework-prefix-mismatch': 'error' } }))[0]
      ?.severity,
    'error',
  );
});
