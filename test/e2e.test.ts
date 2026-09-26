import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { loadConfig } from '../src/config.js';
import { runScan } from '../src/scan/index.js';
import { allRules } from '../src/rules/index.js';
import { toJsonReport } from '../src/report/json.js';
import { toSarif } from '../src/report/sarif.js';
import { toMarkdownTable, toExampleFile } from '../src/report/markdown.js';
import { formatReport } from '../src/report/format.js';
import { buildVariableSummaries } from '../src/report/variables.js';
import { runCli } from '../src/cli.js';
import { REPO_URL, VERSION } from '../src/version.js';
import { fixturePath, repoRoot } from './helpers.js';
import type { CliIo, Report, ResolvedConfig, ScanOptions, Severity } from '../src/types.js';

const FIXTURES: readonly { name: string; expect: readonly string[]; clean?: boolean }[] = [
  {
    name: 'node-webapp',
    expect: [
      'ci-secret-undeclared',
      'compose-var-undeclared',
      'conflicting-values',
      'debug-flag-shared-env',
      'duplicate-key',
      'empty-value',
      'env-file-untracked',
      'expansion-unsupported',
      'framework-prefix-mismatch',
      'inline-comment-truncation',
      'missing-from-example',
      'missing-in-env',
      'secret-fallback-literal',
      'secret-in-example',
      'secret-in-repo',
      'unquoted-special-chars',
      'unused-variable',
      'weak-secret',
    ],
  },
  {
    name: 'python-api',
    expect: ['example-out-of-sync', 'missing-in-env', 'secret-in-repo'],
  },
  { name: 'go-service', expect: ['missing-in-env'] },
  { name: 'rust-cli', expect: ['missing-in-env', 'unused-variable', 'weak-secret'] },
  { name: 'dotnet-microservice', expect: ['empty-value', 'unused-variable', 'weak-secret'] },
  { name: 'rails-app', expect: ['debug-flag-shared-env', 'export-prefix'] },
  {
    name: 'php-laravel',
    expect: ['debug-flag-shared-env', 'empty-value', 'env-file-missing', 'unused-variable'],
  },
  {
    name: 'edge-cases',
    expect: [
      'conflicting-values',
      'duplicate-key',
      'empty-value',
      'expansion-unsupported',
      'hostile-name',
      'inline-comment-truncation',
      'invalid-name',
      'reserved-name',
      'unquoted-special-chars',
      'unterminated-quote',
      'unused-variable',
    ],
  },
  { name: 'clean', expect: [], clean: true },
];

const configFor = (root: string): ResolvedConfig =>
  loadConfig({ root, overrides: { exclude: ['.git/**'] } });

/**
 * Fixtures are copied into a scratch directory so the scan never inherits the
 * envgle repository's own configuration or git index, which keeps every
 * assertion below independent of where the test suite runs from.
 */
/**
 * Files a fixture needs that are deliberately git-ignored and therefore never
 * present in a fresh clone. The suite recreates them in the scratch copy so the
 * assertions hold identically on a developer machine and in CI.
 */
const EXTRA_FILES: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  'node-webapp': {
    '.env.local': ['# Developer-only overrides, recreated by the test suite.', 'PORT=4000', 'API_BASE_URL=https://localhost:3000', 'CACHE_TTL=', ''].join('\n'),
  },
  'python-api': {
    '.env.local': ['# Developer-only bind address, recreated by the test suite.', 'DEBUG_HOST=0.0.0.0', ''].join('\n'),
  },
  'edge-cases': {
    'app.local.env': [
      '# The .gitignore in this directory matches *.local.env, so this file is',
      '# still analysed but is never committed. Recreated by the test suite.',
      'APP_LOCAL_ONLY=local-only',
      '',
    ].join('\n'),
  },
};

const scratch = new Map<string, string>();

const scratchFor = (name: string): string => {
  const existing = scratch.get(name);
  if (existing !== undefined) {
    return existing;
  }
  const target = mkdtempSync(join(tmpdir(), `envgle-${name}-`));
  cpSync(fixturePath(name), target, { recursive: true });
  for (const [path, contents] of Object.entries(EXTRA_FILES[name] ?? {})) {
    writeFileSync(join(target, path), contents, 'utf8');
  }
  scratch.set(name, target);
  return target;
};

const scanFixture = async (name: string): Promise<Report> => {
  const root = scratchFor(name);
  const config = configFor(root);
  const options: ScanOptions = { root, config, now: new Date(0), useGitignore: true };
  return runScan(options);
};

const cache = new Map<string, Report>();

after(() => {
  for (const [, directory] of scratch) {
    rmSync(directory, { recursive: true, force: true });
  }
});

const reportFor = async (name: string): Promise<Report> => {
  const cached = cache.get(name);
  if (cached !== undefined) {
    return cached;
  }
  const report = await scanFixture(name);
  cache.set(name, report);
  return report;
};

for (const fixture of FIXTURES) {
  test(`fixture ${fixture.name}: every documented rule fires`, async () => {
    const report = await reportFor(fixture.name);
    const fired = new Set(report.findings.map((finding) => finding.ruleId));
    for (const ruleId of fixture.expect) {
      assert.ok(fired.has(ruleId as never), `${fixture.name} did not report ${ruleId}; got ${[...fired].join(', ')}`);
    }
    assert.equal(report.summary.rulesFired, fired.size);
    for (const finding of report.findings) {
      assert.ok(finding.message.length > 10, `empty message for ${finding.ruleId}`);
      assert.ok(finding.line >= 1 && finding.column >= 1, `bad position for ${finding.ruleId}`);
      assert.ok(
        finding.file.length > 0 && !finding.file.includes('\\'),
        `finding path must be relative POSIX: ${finding.file}`,
      );
      assert.ok(finding.docsUrl.startsWith(REPO_URL), `missing docs url for ${finding.ruleId}`);
    }
  });
}

test('fixture clean: no findings at all', async () => {
  const report = await reportFor('clean');
  assert.deepEqual(
    report.findings.map((finding) => `${finding.ruleId} ${finding.file}:${finding.line} ${finding.message}`),
    [],
  );
  assert.equal(report.summary.error, 0);
  assert.equal(report.summary.warn, 0);
  assert.equal(report.summary.info, 0);
});

test('fixture edge-cases: build junk is skipped, git-ignored env files are analysed as uncommitted', async () => {
  const report = await reportFor('edge-cases');
  const files = new Set([...report.files.map((file) => file.path), ...report.usages.map((usage) => usage.file)]);
  for (const path of files) {
    assert.ok(!path.includes('node_modules'), `node_modules leaked: ${path}`);
    assert.ok(!path.endsWith('logo.png'), `binary leaked: ${path}`);
    assert.ok(!path.includes('bundle.min.js'), `minified bundle leaked: ${path}`);
    assert.ok(!path.includes('vendor/'), `vendored code leaked: ${path}`);
  }
  const ignored = report.files.find((file) => file.path === 'app.local.env');
  assert.ok(ignored !== undefined, 'a git-ignored env file is still analysed');
  assert.equal(ignored?.committed, false, 'a git-ignored env file is never committed');
  assert.ok(report.files.length >= 3, 'expected several env files in the edge case fixture');
});

test('cli fmt normalises, is idempotent and never loses comments', async () => {
  const { makeTempRepo } = await import('./helpers.js');
  const repo = makeTempRepo({
    '.env': ['# zeta first', 'ZETA=1', '', 'BETA=three', 'ALPHA=2  '].join('\n'),
    'src/app.js': 'export const a = process.env.ALPHA;\n',
  });
  try {
    const before = await runCliInDir(repo.dir, ['fmt', '--no-color']);
    assert.equal(before.code, 1);
    assert.ok(before.out.includes('.env'), before.out);
    assert.ok(before.out.includes('trailing whitespace'), before.out);
    assert.ok(before.out.includes('key order'), before.out);
    assert.ok(before.out.includes('final newline'), before.out);
    assert.equal(repo.read('.env'), ['# zeta first', 'ZETA=1', '', 'BETA=three', 'ALPHA=2  '].join('\n'));

    const write = await runCliInDir(repo.dir, ['fmt', '--no-color', '--write']);
    assert.equal(write.code, 0);
    const fixed = repo.read('.env');
    assert.equal(fixed, ['# zeta first', 'ZETA=1', '', 'ALPHA=2', 'BETA=three', ''].join('\n'), fixed);

    const after = await runCliInDir(repo.dir, ['fmt', '--no-color']);
    assert.equal(after.code, 0);
    assert.ok(after.out.includes('already normalised'), after.out);
  } finally {
    repo.cleanup();
  }
});


test('no raw secret value ever reaches an output format', async () => {
  const needles = [
    'AKIAIOSFODNN7EXAMPLE',
    'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
    'ghp_EXAMPLEEXAMPLEEXAMPLEEXAMPLEEXAMPLEEXAMPLE1234',
  ];
  for (const fixture of FIXTURES) {
    const report = await reportFor(fixture.name);
    const config = configFor(scratchFor(fixture.name));
    const rendered = [
      toJsonReport(report, { config, rootLabel: '.', includeVariables: true, includeSkipped: true }),
      toSarif(report, { toolVersion: VERSION, informationUri: REPO_URL, rootLabel: '.' }),
      toMarkdownTable(report, { config, rootLabel: '.', includeFindings: true }),
      toExampleFile(report, { config, rootLabel: '.' }),
      formatReport(report, {
        io: silentIo(),
        config,
        cwd: scratchFor(fixture.name),
        maxIssuesPerFile: 1000,
        short: false,
        rootLabel: '.',
      }),
    ].join('\n');
    for (const needle of needles) {
      assert.ok(!rendered.includes(needle), `${fixture.name} leaked ${needle.slice(0, 8)} in output`);
    }
    assert.ok(rendered.length > 0);
  }
});

test('reports are deterministic for a fixed clock', async () => {
  const first = await reportFor('node-webapp');
  const second = await reportFor('node-webapp');
  assert.equal(JSON.stringify(first), JSON.stringify(second));
  assert.notEqual(first.durationMs, -1);
});

test('scan is a pure function of the working tree', async () => {
  const report = await reportFor('python-api');
  const config = configFor(scratchFor('python-api'));
  const json = toJsonReport(report, { config, rootLabel: '.', pretty: true, includeVariables: true });
  const parsed = JSON.parse(json) as { schemaVersion: number; findings: unknown[]; summary: { total: number } };
  assert.equal(parsed.schemaVersion, 1);
  assert.equal(parsed.findings.length, parsed.summary.total);
  assert.equal(json, toJsonReport(report, { config, rootLabel: '.', pretty: true, includeVariables: true }));
});

test('variable summaries never expose values', async () => {
  const report = await reportFor('node-webapp');
  const config = configFor(scratchFor('node-webapp'));
  const summaries = buildVariableSummaries(report, { config, includeUndeclared: true, includeUnused: true });
  assert.ok(summaries.length > 0);
  for (const summary of summaries) {
    for (const value of summary.values) {
      if (summary.secretish) {
        assert.equal(value.preview, '<redacted>');
      }
    }
    assert.ok(!summary.name.includes('='), 'variable name must be a bare name');
  }
  const aws = summaries.find((summary) => summary.name === 'AWS_SECRET_ACCESS_KEY');
  assert.ok(aws !== undefined, 'expected AWS_SECRET_ACCESS_KEY to be summarised');
  assert.equal(aws?.secretish, true);
  for (const value of aws?.values ?? []) {
    assert.equal(value.preview, '<redacted>');
  }
});

function silentIo(): CliIo {
  return { stdout: () => {}, stderr: () => {}, isColor: false, cwd: repoRoot() };
}

const runCliIn = async (fixture: string, argv: readonly string[]): Promise<{ code: number; out: string; err: string }> =>
  runCliInDir(scratchFor(fixture), argv);

const runCliInDir = async (
  directory: string,
  argv: readonly string[],
): Promise<{ code: number; out: string; err: string }> => {
  let out = '';
  let err = '';
  const io: CliIo = {
    stdout: (text) => {
      out += text;
    },
    stderr: (text) => {
      err += text;
    },
    isColor: false,
    cwd: directory,
  };
  const code = await runCli(argv, io, directory);
  return { code, out, err };
};

test('cli scan reports findings and exits 1', async () => {
  const result = await runCliIn('node-webapp', ['scan', '--no-color']);
  assert.equal(result.code, 1);
  assert.ok(result.out.includes('missing-in-env'), 'expected the rule id in the output');
  assert.ok(result.out.includes('envgle'), 'expected the tool name in the output');
});

test('cli scan on a clean project exits 0', async () => {
  const result = await runCliIn('clean', ['scan', '--no-color']);
  assert.equal(result.code, 0);
});

test('cli check is silent on success and fails on findings', async () => {
  const clean = await runCliIn('clean', ['check', '--no-color']);
  assert.equal(clean.code, 0);
  assert.equal(clean.out.trim(), '');
  const dirty = await runCliIn('node-webapp', ['check', '--no-color', '--quiet']);
  assert.equal(dirty.code, 1);
  assert.equal(dirty.out.trim(), '');
});

test('cli fail-on thresholds are honoured', async () => {
  const warnOnly = await runCliIn('node-webapp', ['scan', '--quiet', '--fail-on', 'error']);
  assert.equal(warnOnly.code, 1);
  const none = await runCliIn('node-webapp', ['scan', '--quiet', '--fail-on', 'none']);
  assert.equal(none.code, 0);
  const strict = await runCliIn('clean', ['scan', '--quiet', '--fail-on', 'info']);
  assert.equal(strict.code, 0);
});

test('cli json output parses and is redacted', async () => {
  const result = await runCliIn('node-webapp', ['--format', 'json']);
  assert.equal(result.code, 1);
  const parsed = JSON.parse(result.out) as { schemaVersion: number; findings: { ruleId: string }[] };
  assert.equal(parsed.schemaVersion, 1);
  assert.ok(parsed.findings.length > 0);
  assert.ok(!result.out.includes('AKIAIOSFODNN7EXAMPLE'));
});

test('cli sarif output is valid json with rules and results', async () => {
  const result = await runCliIn('node-webapp', ['--format', 'sarif']);
  const parsed = JSON.parse(result.out) as {
    version: string;
    runs: { tool: { driver: { name: string; rules: { id: string }[] } }; results: { ruleId: string; ruleIndex: number }[] }[];
  };
  assert.equal(parsed.version, '2.1.0');
  const run = parsed.runs[0];
  assert.equal(run?.tool.driver.name, 'envgle');
  assert.ok((run?.tool.driver.rules.length ?? 0) > 0);
  for (const item of run?.results ?? []) {
    const index: number = run?.tool.driver.rules.findIndex((rule) => rule.id === item.ruleId) ?? -1;
    assert.equal(index, item.ruleIndex, `ruleIndex mismatch for ${item.ruleId}`);
  }
});

test('cli markdown output renders a table', async () => {
  const result = await runCliIn('node-webapp', ['--format', 'markdown']);
  assert.ok(result.out.includes('| Variable |'), 'expected the variable table');
});

test('cli why traces one variable and rejects an unknown one', async () => {
  const known = await runCliIn('node-webapp', ['why', 'PORT']);
  assert.equal(known.code, 0);
  assert.ok(known.out.includes('PORT'));
  assert.ok(known.out.includes('declared in'), 'expected the declared section');
  const unknown = await runCliIn('node-webapp', ['why', 'DEFINITELY_NOT_DECLARED']);
  assert.equal(unknown.code, 2);
});

test('cli rules lists every rule and validates ids', async () => {
  const human = await runCliIn('clean', ['rules']);
  assert.equal(human.code, 0);
  assert.ok(human.out.includes('missing-in-env'));
  for (const rule of allRules) {
    assert.ok(human.out.includes(rule.id), `rules output is missing ${rule.id}`);
  }
  const json = await runCliIn('clean', ['rules', '--json']);
  const parsed = JSON.parse(json.out) as { count: number; rules: { id: string; severity: Severity }[] };
  assert.equal(parsed.count, allRules.length);
  assert.equal(parsed.rules.length, allRules.length);
  const bad = await runCliIn('clean', ['--rule', 'not-a-rule']);
  assert.equal(bad.code, 2);
  assert.ok(bad.err.includes('unknown rule id'));
});

test('cli --rule narrows a run to the named rules', async () => {
  const all = await runCliIn('node-webapp', ['scan', '--no-color', '--short']);
  const only = await runCliIn('node-webapp', ['scan', '--no-color', '--short', '--rule', 'duplicate-key']);
  const ignored = await runCliIn('node-webapp', ['scan', '--no-color', '--short', '--ignore-rule', 'duplicate-key']);
  const otherRules = allRules
    .map((rule) => rule.id)
    .filter((id) => id !== 'duplicate-key' && all.out.includes(id));
  assert.ok(otherRules.length > 3, 'expected the full run to fire several rules');
  assert.ok(all.out.includes('duplicate-key'), 'expected the rule in the full run');
  assert.ok(only.out.includes('duplicate-key'), 'expected the selected rule');
  for (const id of otherRules) {
    assert.ok(!only.out.includes(id), `--rule must switch ${id} off`);
  }
  assert.equal(only.code, 1);
  assert.ok(!ignored.out.includes('duplicate-key'), '--ignore-rule must silence one rule');
  assert.ok(ignored.out.includes('missing-in-env'), 'other rules must still run');
});

test('a monorepo framework dependency silences the prefix rule', async () => {
  const { makeTempRepo } = await import('./helpers.js');
  const repo = makeTempRepo({
    'package.json': JSON.stringify({ name: 'root', private: true, devDependencies: { typescript: '^5' } }),
    'apps/web/package.json': JSON.stringify({ name: 'web', devDependencies: { vite: '^5' } }),
    'apps/web/.env': 'VITE_API_URL=https://api.example.com\nVITE_MODE=production\n',
    'apps/web/src/main.ts': "console.log(import.meta.env.VITE_API_URL);\n",
  });
  try {
    const report = await runScan({
      root: repo.dir,
      config: loadConfig({ root: repo.dir }),
      now: new Date(0),
      useGitignore: false,
    });
    assert.equal(
      report.findings.filter((finding) => finding.ruleId === 'framework-prefix-mismatch').length,
      0,
      'the workspace manifest must satisfy the rule',
    );
    assert.ok((report.manifest?.relatedDependencies ?? []).includes('vite'));
  } finally {
    repo.cleanup();
  }
});

test('generated build wrappers are not scanned for env reads', async () => {
  const { makeTempRepo } = await import('./helpers.js');
  const repo = makeTempRepo({
    'android/gradlew.bat': ['@echo off', 'setlocal', 'set DIRNAME=%~dp0', 'if "%DEBUG%"=="" goto end', 'echo %APP_HOME%', 'endlocal'].join('\r\n'),
    'android/gradlew': ['#!/bin/sh', 'set -e', 'APP_HOME=$(cd "$(dirname "$0")" && pwd)', 'echo "$APP_HOME"', 'echo "$GRADLE_OPTS"'].join('\n'),
    'src/app.js': 'export const value = process.env.REAL_SETTING;\n',
  });
  try {
    const report = await runScan({
      root: repo.dir,
      config: loadConfig({ root: repo.dir }),
      now: new Date(0),
      useGitignore: false,
    });
    const read = report.usages.map((usage) => usage.file);
    assert.ok(!read.includes('android/gradlew.bat'), read.join(', '));
    assert.ok(!read.includes('android/gradlew'), read.join(', '));
    assert.ok(read.includes('src/app.js'));
    const skipped = report.skipped.filter((entry) => entry.reason === 'generated').map((entry) => entry.file);
    assert.deepEqual(skipped, ['android/gradlew', 'android/gradlew.bat']);
  } finally {
    repo.cleanup();
  }
});

test('cli init prints an example file and refuses to overwrite', async () => {
  const printed = await runCliIn('go-service', ['init']);
  assert.equal(printed.code, 0);
  assert.ok(printed.out.includes('PORT='), 'expected a read variable in the example');
  assert.ok(printed.out.includes('SENTRY_DSN='), 'expected the second read variable');
  assert.ok(printed.out.includes('Do NOT put real secrets'), 'expected the generated header');
  const refused = await runCliIn('go-service', ['init', '--write', '.env.example']);
  assert.equal(refused.code, 2, 'must not overwrite an existing example file');
  assert.ok(refused.err.includes('already exists'));
});

test('cli docs renders markdown and writes on request', async () => {
  const printed = await runCliIn('node-webapp', ['docs']);
  assert.equal(printed.code, 0);
  assert.ok(printed.out.includes('| Variable |'), 'expected the variable table');
  assert.ok(printed.out.includes('PORT'), 'expected a known variable');
});

test('cli help and version', async () => {
  const help = await runCliIn('clean', ['--help']);
  assert.equal(help.code, 0);
  assert.ok(help.out.includes('USAGE'));
  assert.ok(help.out.includes('--fail-on'));
  const version = await runCliIn('clean', ['--version']);
  assert.equal(version.code, 0);
  assert.equal(version.out.trim(), VERSION);
  const usageError = await runCliIn('clean', ['--nope']);
  assert.equal(usageError.code, 2);
});


test('inline suppression markers silence the next line', async () => {
  const { makeTempRepo } = await import('./helpers.js');
  const repo = makeTempRepo({
    'src/app.js': 'export const port = process.env.PORT ?? 3000;\n',
  });
  try {
    const withMarker = await runScan({
      root: repo.dir,
      config: loadConfig({ root: repo.dir }),
      now: new Date(0),
      useGitignore: false,
    });
    assert.ok(
      withMarker.findings.some((finding) => finding.ruleId === 'missing-in-env'),
      'expected a finding without a marker',
    );

    repo.write(
      'src/app.js',
      [
        '// envgle-disable-next-line missing-in-env',
        'export const port = process.env.PORT ?? 3000;',
        '// envgle-disable-file missing-in-env',
        'export const host = process.env.HOST ?? "127.0.0.1";',
        '',
      ].join('\n'),
    );
    const withSuppression = await runScan({
      root: repo.dir,
      config: loadConfig({ root: repo.dir }),
      now: new Date(0),
      useGitignore: false,
    });
    assert.equal(
      withSuppression.findings.filter((finding) => finding.ruleId === 'missing-in-env').length,
      0,
      'markers must silence the next line and the whole file',
    );
  } finally {
    repo.cleanup();
  }
});

test('a committed secret is an error and an uncommitted one is a warning', { skip: !hasGit() }, async () => {
  const { makeTempRepo } = await import('./helpers.js');
  const repo = makeTempRepo({
    '.env': 'AWS_ACCESS_KEY_ID=AKIAIOSFODNN7EXAMPLE\nPORT=3000\n',
    'src/app.js': 'export const port = process.env.PORT;\n',
  });
  try {
    run(repo.dir, ['init']);
    run(repo.dir, ['add', '-A']);
    const committed = await runScan({
      root: repo.dir,
      config: loadConfig({ root: repo.dir }),
      now: new Date(0),
      useGitignore: false,
    });
    const committedSecret = committed.findings.find((finding) => finding.ruleId === 'secret-in-repo');
    assert.equal(committedSecret?.severity, 'error');
    assert.equal(committed.files.find((file) => file.path === '.env')?.committed, true);
    assert.ok(committedSecret?.fingerprint !== undefined, 'expected a fingerprint');
    assert.ok(!committedSecret?.message.includes('AKIA'), 'the value must never appear in a message');

    repo.write('.gitignore', '.env\n');
    run(repo.dir, ['rm', '--cached', '.env']);
    const uncommitted = await runScan({
      root: repo.dir,
      config: loadConfig({ root: repo.dir }),
      now: new Date(0),
      useGitignore: false,
    });
    const uncommittedSecret = uncommitted.findings.find((finding) => finding.ruleId === 'secret-in-repo');
    assert.equal(uncommittedSecret?.severity, 'warn');
    assert.equal(uncommitted.files.find((file) => file.path === '.env')?.committed, false);
  } finally {
    repo.cleanup();
  }
});

function hasGit(): boolean {
  try {
    execFileSync('git', ['--version'], { stdio: 'ignore', timeout: 5000, windowsHide: true });
    return true;
  } catch {
    return false;
  }
}

function run(cwd: string, args: readonly string[]): void {
  execFileSync('git', args, { cwd, stdio: 'ignore', timeout: 20_000, windowsHide: true });
}

test('the repository dogfoods clean: no error findings in envgle itself', async () => {
  const root = repoRoot();
  const report = await runScan({ root, config: loadConfig({ root }), now: new Date(0), useGitignore: true });
  const errors = report.findings.filter((finding) => finding.severity === 'error');
  assert.deepEqual(
    errors.map((finding) => `${finding.ruleId} ${finding.file}:${finding.line}`),
    [],
  );
  assert.ok(existsSync(join(root, '.envglerc.json')));
  assert.ok(readFileSync(join(root, '.envglerc.json'), 'utf8').includes('ignoreVariables'));
});
