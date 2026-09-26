import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import test from 'node:test';
import { loadConfig } from '../src/config.js';
import { runScan, runScanDetailed } from '../src/scan/index.js';
import { parseEnvFile } from '../src/dotenv/parse.js';
import { parseYaml } from '../src/scan/yaml.js';
import { scanDockerfile } from '../src/scan/dockerfile.js';
import { scanCi } from '../src/scan/ci.js';
import { toJsonReport } from '../src/report/json.js';
import { toSarif } from '../src/report/sarif.js';
import { toMarkdownTable, toExampleFile } from '../src/report/markdown.js';
import { formatReport } from '../src/report/format.js';
import { buildVariableSummaries } from '../src/report/variables.js';
import { verboseLines } from '../src/commands/scan.js';
import { runCli } from '../src/cli.js';
import { findBracedVariables, globToRegExp, matchGlob, resolveRelativePath } from '../src/utils/text.js';
import { makeTempRepo } from './helpers.js';
import type { CommandContext } from '../src/commands/context.js';
import type { CliIo, Report, ResolvedConfig, ScanOptions } from '../src/types.js';
import type { TempRepo } from './helpers.js';

const AWS_KEY = 'AKIAIOSFODNN7EXAMPLE';
const AWS_SECRET = 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY';
const GITHUB_TOKEN = 'ghp_EXAMPLEEXAMPLEEXAMPLEEXAMPLEEXAMPLE1234';
const ANTHROPIC_KEY = 'sk-ant-api03-EXAMPLEEXAMPLEEXAMPLEEXAMPLE';
const PG_URL = 'postgres://appuser:EXAMPLEpassword@db.example.com:5432/appdb';
const PEM_BLOCK = '-----BEGIN RSA PRIVATE KEY-----';
const VENDOR_CREDENTIALS: readonly string[] = [
  AWS_KEY,
  AWS_SECRET,
  GITHUB_TOKEN,
  ANTHROPIC_KEY,
  PG_URL,
  PEM_BLOCK,
];

const repeat = (unit: string, length: number): string => unit.repeat(Math.ceil(length / unit.length)).slice(0, length);

const optionsFor = (root: string, overrides: Record<string, unknown> = {}): ScanOptions => ({
  root,
  config: loadConfig({ root, overrides }),
  now: new Date(0),
  useGitignore: false,
});

const scanRepo = (repo: TempRepo, overrides: Record<string, unknown> = {}): Promise<Report> =>
  runScan(optionsFor(repo.dir, overrides));

const silentIo = (cwd: string): { io: CliIo; out: () => string; err: () => string } => {
  let stdout = '';
  let stderr = '';
  return {
    io: {
      stdout: (text) => {
        stdout += text;
      },
      stderr: (text) => {
        stderr += text;
      },
      isColor: false,
      cwd,
    },
    out: () => stdout,
    err: () => stderr,
  };
};

const commandContext = (cwd: string, verbose: boolean): CommandContext => ({
  command: 'scan',
  positional: [],
  values: new Map<string, readonly string[]>(),
  switches: new Set<string>(),
  io: silentIo(cwd).io,
  cwd,
  targetDir: cwd,
  configPath: undefined,
  useGitignore: true,
  format: 'human',
  short: false,
  verbose,
  quiet: false,
  dryRun: false,
  maxIssues: 20,
  maxFileSizeKb: undefined,
  failOn: 'error',
  onlyRules: [],
  ignoreRules: [],
  ignoreVariables: [],
  writeTarget: undefined,
});

/** Raw physical line, byte order mark included: the code and infra scanners do not strip it. */
const lineAt = (text: string, line: number): string => (text.split('\n')[line - 1] ?? '').replace(/\r$/, '');

/** Physical line as the dotenv parser sees it: a leading byte order mark belongs to the file, not to line 1. */
const lineAtForEnv = (text: string, line: number): string => lineAt(text.replace(/^\uFEFF/, ''), line);

const substringAt = (text: string, line: number, column: number, length: number): string =>
  lineAt(text, line).slice(column - 1, column - 1 + length);

const substringAtForEnv = (text: string, line: number, column: number, length: number): string =>
  lineAtForEnv(text, line).slice(column - 1, column - 1 + length);

/**
 * A JavaScript module that loads a dotenv file from `target`. The call is assembled
 * from parts so that this test file itself does not contain a literal `path:` that
 * envgle would read as a real reference when it scans its own repository.
 */
const dotenvLoader = (target: string): string =>
  [
    'import dotenv from "dotenv";',
    `dotenv.config({ path: ${JSON.stringify(target)} });`,
    'export const p = process.env.PORT;',
    '',
  ].join('\n');

function hasGit(): boolean {
  try {
    execFileSync('git', ['--version'], { stdio: 'ignore', timeout: 5000, windowsHide: true });
    return true;
  } catch {
    return false;
  }
}

const git = (cwd: string, args: readonly string[]): void => {
  execFileSync('git', args, { cwd, stdio: 'ignore', timeout: 20_000, windowsHide: true });
};

test('the published entry point of the package loads and exposes the documented API', async () => {
  const entry = (await import('../src/index.js')) as Record<string, unknown>;

  for (const name of [
    'loadConfig',
    'parseEnvFile',
    'runScan',
    'allRules',
    'formatReport',
    'toJsonReport',
    'toSarif',
    'toMarkdownTable',
    'toExampleFile',
    'buildVariableSummaries',
    'createIgnoreMatcher',
    'walkFiles',
    'runCli',
    'VERSION',
  ]) {
    assert.notEqual(entry[name], undefined, `src/index.ts must export ${name}`);
  }
});

test('no vendor credential value ever reaches an output, in any format', async () => {
  const scenarios: Record<string, Record<string, string>> = {
    'real env file': {
      '.env': `AWS_ACCESS_KEY_ID=${AWS_KEY}\nAWS_SECRET_ACCESS_KEY=${AWS_SECRET}\nPORT=3000\n`,
      '.env.example': 'AWS_ACCESS_KEY_ID=\nAWS_SECRET_ACCESS_KEY=\nPORT=\n',
      'src/app.js': 'export const p = process.env.PORT;\n',
    },
    'unquoted value with padding': {
      '.env': `AWS_SECRET_ACCESS_KEY=${AWS_SECRET}=\nPORT=3000\n`,
      '.env.example': 'AWS_SECRET_ACCESS_KEY=\nPORT=\n',
      'src/app.js': 'export const p = process.env.PORT;\n',
    },
    'conflicting values under a plain name': {
      '.env': `AWS_ID=${AWS_KEY}\nPORT=3000\n`,
      '.env.production': `AWS_ID=AKIAIOSFODNN7OTHERKEYXXXX\nPORT=3000\n`,
      '.env.example': 'AWS_ID=\nPORT=\n',
      'src/app.js': 'export const p = process.env.PORT;\n',
    },
    'example file': {
      '.env': 'PORT=3000\n',
      '.env.example': `AWS_ACCESS_KEY_ID=${AWS_KEY}\nANTHROPIC_API_KEY=${ANTHROPIC_KEY}\nGITHUB_TOKEN=${GITHUB_TOKEN}\n`,
      'src/app.js': 'export const p = process.env.PORT;\n',
    },
    'connection string under a plain name': {
      '.env': `APP_DB_URL=${PG_URL}\nPORT=3000\n`,
      '.env.example': 'APP_DB_URL=\nPORT=\n',
      'src/app.js': 'export const p = process.env.PORT;\n',
    },
    'private key block': {
      '.env': `SIGNING_KEY="${PEM_BLOCK}"\nPORT=3000\n`,
      '.env.example': 'SIGNING_KEY=\nPORT=\n',
      'src/app.js': 'export const p = process.env.PORT;\n',
    },
    'developer-only file': {
      '.env.local': `AWS_SECRET_ACCESS_KEY=${AWS_SECRET}\nPORT=3000\n`,
      '.env.example': 'AWS_SECRET_ACCESS_KEY=\nPORT=\n',
      'src/app.js': 'export const p = process.env.PORT;\n',
    },
    'hardcoded fallback in source': {
      '.env': 'PORT=3000\n',
      '.env.example': 'PORT=\nAWS_SECRET_ACCESS_KEY=\n',
      'src/app.js': `export const k = process.env.AWS_SECRET_ACCESS_KEY ?? '${AWS_SECRET}';\n`,
    },
  };

  for (const [name, files] of Object.entries(scenarios)) {
    const repo = makeTempRepo(files);
    try {
      const report = await scanRepo(repo);
      const config = loadConfig({ root: repo.dir });
      const io = silentIo(repo.dir);
      const rendered = [
        toJsonReport(report, { config, rootLabel: '.', pretty: true, includeSkipped: true, includeVariables: true }),
        toJsonReport(report, { config, rootLabel: '.', pretty: false, groupBy: 'rule' }),
        toSarif(report, { toolVersion: '0.1.0', informationUri: 'https://example.invalid', rootLabel: '.' }),
        toMarkdownTable(report, { config, rootLabel: '.', includeFindings: true, includeEmpty: true }),
        toExampleFile(report, { config }),
        formatReport(report, { io: io.io, config, cwd: repo.dir, maxIssuesPerFile: 1000, short: false, rootLabel: '.' }),
        formatReport(report, { io: io.io, config, cwd: repo.dir, maxIssuesPerFile: 1000, short: true, rootLabel: '.' }),
        verboseLines(commandContext(repo.dir, true), config, report, []).join('\n'),
        JSON.stringify(buildVariableSummaries(report, { config, includeUndeclared: true, includeUnused: true })),
        report.findings.map((finding) => `${finding.message} ${finding.hint ?? ''} ${finding.fingerprint ?? ''}`).join('\n'),
        report.files.flatMap((file) => file.issues.map((issue) => issue.message)).join('\n'),
        (report.diagnostics ?? []).map((diagnostic) => diagnostic.message).join('\n'),
      ];
      for (const format of ['human', 'json', 'sarif', 'markdown', 'quiet']) {
        const cli = silentIo(repo.dir);
        await runCli(['scan', '--format', format, '--no-color', '--verbose'], cli.io, repo.dir);
        rendered.push(`${cli.out()}\n${cli.err()}`);
      }
      for (const text of rendered) {
        for (const credential of VENDOR_CREDENTIALS) {
          assert.equal(text.includes(credential), false, `${name}: ${credential} leaked into an output`);
        }
        assert.equal(text.includes('EXAMPLEpassword'), false, `${name}: the connection-string password leaked`);
        assert.equal(text.includes('appuser:'), false, `${name}: the connection-string user leaked`);
      }
      const secretFinding = report.findings.find((finding) => finding.ruleId === 'secret-in-repo');
      if (secretFinding !== undefined) {
        assert.match(secretFinding.fingerprint ?? '', /^[0-9a-f]{12}$/);
      }
    } finally {
      repo.cleanup();
    }
  }
});

test('unquoted-special-chars never prints the value of a secret-looking variable', async () => {
  const repo = makeTempRepo({
    '.env': `AWS_SECRET_ACCESS_KEY=${AWS_SECRET}=\nMESSAGE=hello world\nPORT=3000\n`,
    '.env.example': 'AWS_SECRET_ACCESS_KEY=\nMESSAGE=\nPORT=\n',
    'src/app.js': 'export const p = process.env.PORT;\nexport const m = process.env.MESSAGE;\n',
  });
  try {
    const report = await scanRepo(repo);
    const findings = report.findings.filter((finding) => finding.ruleId === 'unquoted-special-chars');
    const secret = findings.find((finding) => finding.variable === 'AWS_SECRET_ACCESS_KEY');
    const plain = findings.find((finding) => finding.variable === 'MESSAGE');

    assert.equal(secret?.message.includes(AWS_SECRET), false);
    assert.equal(secret?.message.includes('wJalrXUtnFEMI'), false);
    assert.match(secret?.message ?? '', /<redacted>/);
    assert.match(plain?.message ?? '', /\(hello world\)/);
  } finally {
    repo.cleanup();
  }
});

test('conflicting-values never prints a credential held by a plain variable name', async () => {
  const repo = makeTempRepo({
    '.env': `AWS_ID=${AWS_KEY}\nAPP_URL=https://alpha.example.com/long/path\nPORT=3000\n`,
    '.env.production': `AWS_ID=AKIAIOSFODNN7OTHERKEYXXXX\nAPP_URL=https://beta.example.com/v2\nPORT=3000\n`,
    '.env.example': 'AWS_ID=\nAPP_URL=\nPORT=\n',
    'src/app.js': 'export const p = process.env.PORT;\nexport const u = process.env.APP_URL;\n',
  });
  try {
    const report = await scanRepo(repo);
    const findings = report.findings.filter((finding) => finding.ruleId === 'conflicting-values');
    const credential = findings.find((finding) => finding.variable === 'AWS_ID');
    const plain = findings.find((finding) => finding.variable === 'APP_URL');

    assert.equal(credential?.message.includes(AWS_KEY), false);
    assert.equal(credential?.message.includes('AKIAIOSFODNN7OTHERKEYXXXX'), false);
    assert.match(credential?.message ?? '', /different secret values/);
    assert.match(credential?.fingerprint ?? '', /^[0-9a-f]{12}$/);
    assert.match(plain?.message ?? '', /loader precedence decides silently$/);
    assert.equal(plain?.message.includes('AKIA'), false);
  } finally {
    repo.cleanup();
  }
});

test('every pathological 100 KB input costs the scan almost nothing', async () => {
  const size = 100 * 1024;
  const cases: readonly (readonly [string, string, string])[] = [
    ['src/a.js', 'const x = ', repeat('"', size)],
    ['src/a.js', 'const x = ', repeat('`${', size)],
    ['src/a.js', 'const x = ', repeat('(', size)],
    ['src/a.js', 'const x = ', repeat('[a', size)],
    ['src/a.py', 'import os\nos.environ[', repeat("'A',", size)],
    ['src/a.sh', 'echo ', repeat('${B-', size)],
    ['src/a.sh', 'echo ', repeat('$', size)],
    ['src/a.bat', '@echo ', repeat('%A%', size)],
    ['src/a.rs', 'fn main() { let _ = ', repeat('env::var("A")', size)],
    ['src/a.cs', 'class C { void M() { Configuration[', repeat('"A",', size)],
    ['src/a.php', '<?php $x = ', repeat("getenv('A',", size)],
    ['src/a.pl', 'my $x = ', repeat('$ENV{A}', size)],
    ['docker-compose.yml', 'services:\n  web:\n    image: ', repeat('${B-', size)],
    ['docker-compose.yml', 'services:\n  web:\n    image: ', repeat('$B ', size)],
    ['Dockerfile', 'ARG A=', repeat('${B-', size)],
    ['Dockerfile', 'FROM alpine\nENV A=', repeat('${B:-', size)],
    ['.gitlab-ci.yml', 'script:\n  - echo ', repeat('${A-', size)],
    ['.gitlab-ci.yml', 'script:\n  - echo ', repeat('${A', size)],
    ['.circleci/config.yml', 'environment:\n  A: ', repeat('${B-', size)],
    ['.github/workflows/ci.yml', 'env:\n  A: ', repeat('${B-', size)],
    ['.env', 'A=', repeat('a', size)],
    ['.env', 'A=', repeat('"', size)],
    ['.env', 'A=', repeat('#x ', size)],
  ];

  const scanOnly = (files: Record<string, string>, rounds: number): Promise<number> => {
    const repo = makeTempRepo(files);
    return (async () => {
      try {
        let best = Number.POSITIVE_INFINITY;
        for (let round = 0; round < rounds; round += 1) {
          const started = performance.now();
          await runScan(optionsFor(repo.dir, { maxFileSizeKb: 4096 }));
          best = Math.min(best, performance.now() - started);
        }
        return best;
      } finally {
        repo.cleanup();
      }
    })();
  };

  const baseline = { 'src/app.js': 'export const a = process.env.A;\n' };
  const floor = await scanOnly(baseline, 3);

  for (const [file, prefix, body] of cases) {
    const elapsed = await scanOnly({ [file]: `${prefix}${body}\n` }, 3);
    const overhead = Math.min(floor, await scanOnly(baseline, 1));
    assert.ok(
      elapsed - overhead < 500,
      `${file} with ${body.length} pathological bytes added ${Math.round(elapsed - overhead)}ms`,
    );
  }
});

test('findBracedVariables stays linear and finds what the default-body regex found', () => {
  const long = repeat('${A-', 25000);
  const started = performance.now();
  assert.deepEqual(findBracedVariables(long), []);
  assert.ok(performance.now() - started < 200, 'a malformed brace run must not cost more than 200ms');

  assert.deepEqual(
    findBracedVariables('RUN ${A} ${B:-x} $C ${D:?boom} ${E-f} ${} ${1} ${A B}'),
    [
      { start: 4, end: 8, name: 'A' },
      { start: 9, end: 16, name: 'B' },
      { start: 20, end: 30, name: 'D' },
      { start: 31, end: 37, name: 'E' },
    ],
  );
  assert.deepEqual(findBracedVariables('${A:-' + 'x'.repeat(4096) + '}').map((hit) => hit.name), ['A']);
  assert.deepEqual(findBracedVariables('${A:-' + 'x'.repeat(4097) + '}'), []);
  assert.deepEqual(findBracedVariables('a${A}b${', 1), [{ start: 1, end: 5, name: 'A' }]);
  assert.deepEqual(findBracedVariables(''), []);
});

test('a scan of a subdirectory of a repository only treats its own files as tracked', { skip: !hasGit() }, async () => {
  const repo = makeTempRepo({
    'package.json': '{"name":"root"}\n',
    '.env': 'PORT=3000\n',
    'packages/app/.env': 'PORT=4000\n',
    'packages/app/src/app.js': 'export const p = process.env.PORT;\n',
    'packages/other/.env': 'PORT=5000\n',
  });
  try {
    git(repo.dir, ['init', '-q']);
    git(repo.dir, ['add', '-A']);

    const sub = await runScan({ ...optionsFor(join(repo.dir, 'packages', 'app')), useGitignore: true });
    assert.equal(sub.files.find((file) => file.path === '.env')?.committed, true);

    git(repo.dir, ['rm', '-q', '--cached', 'packages/app/.env']);
    const after = await runScan({ ...optionsFor(join(repo.dir, 'packages', 'app')), useGitignore: true });
    assert.equal(after.files.find((file) => file.path === '.env')?.committed, false, 'an untracked file must not look tracked because the repository root has a file of the same name');

    const root = await runScan({ ...optionsFor(repo.dir), useGitignore: true });
    assert.equal(root.files.find((file) => file.path === '.env')?.committed, true);
    assert.equal(root.files.find((file) => file.path === 'packages/app/.env')?.committed, false);
  } finally {
    repo.cleanup();
  }
});

test('a dotenv path that is absent is reported even when a same-named env file exists elsewhere', async () => {
  const absent = makeTempRepo({
    'src/.env': 'PORT=3000\n',
    'src/.env.example': 'PORT=\n',
    'src/app.js': dotenvLoader('../.env'),
  });
  try {
    const report = await scanRepo(absent);
    const missing = report.findings.filter((finding) => finding.ruleId === 'env-file-missing');
    assert.equal(missing.length, 1);
    assert.equal(missing[0]?.file, 'src/app.js');
    assert.match(missing[0]?.message ?? '', /references \.\.\/\.env which does not exist/);
    assert.deepEqual(report.findings.filter((finding) => finding.ruleId === 'env-file-untracked'), []);
  } finally {
    absent.cleanup();
  }

  const present = makeTempRepo({
    '.env': 'PORT=3000\n',
    '.env.example': 'PORT=\n',
    'src/.env': 'PORT=4000\n',
    'src/app.js': dotenvLoader('../.env'),
  });
  try {
    const report = await scanRepo(present);
    assert.deepEqual(report.findings.filter((finding) => finding.ruleId === 'env-file-missing'), []);
  } finally {
    present.cleanup();
  }
});

test('a bare env_file name in a subdirectory still resolves to the shared file at the root', async () => {
  const repo = makeTempRepo({
    '.env': 'PORT=3000\n',
    '.env.example': 'PORT=\n',
    'deploy/docker-compose.yml': 'services:\n  web:\n    env_file:\n      - .env\n',
    'src/app.js': 'export const p = process.env.PORT;\n',
  });
  try {
    const report = await scanRepo(repo);
    assert.deepEqual(report.findings.filter((finding) => finding.ruleId === 'env-file-missing'), []);
  } finally {
    repo.cleanup();
  }
});

test('resolveRelativePath collapses . and .. without touching the disk', () => {
  assert.equal(resolveRelativePath('apps/api', '../../.env'), '.env');
  assert.equal(resolveRelativePath('apps/api', '../shared/.env'), 'apps/shared/.env');
  assert.equal(resolveRelativePath('deploy', './.env'), 'deploy/.env');
  assert.equal(resolveRelativePath('', '.env'), '.env');
  assert.equal(resolveRelativePath('a', '../../../.env'), '.env');
  assert.equal(resolveRelativePath('a', '..\\b\\.env'), 'b/.env');
});

test('the bare path argument audits that directory', async () => {
  const repo = makeTempRepo({
    'inner/.env': 'PORT=3000\n',
    'inner/.env.example': 'PORT=\n',
    'inner/src/app.js': 'export const p = process.env.PORT;\n',
  });
  try {
    const bare = silentIo(repo.dir);
    const explicit = silentIo(repo.dir);
    await runCli(['inner', '--no-color'], bare.io, repo.dir);
    await runCli(['scan', 'inner', '--no-color'], explicit.io, repo.dir);

    assert.match(bare.out(), /· inner ·/, 'a bare path must become the scan target');
    assert.equal(bare.out().replace(/\d+ms/g, '0ms'), explicit.out().replace(/\d+ms/g, '0ms'));
  } finally {
    repo.cleanup();
  }
});

test('malformed files never throw out of the public API', async () => {
  const nul = '\u0000';
  const cases: Record<string, string> = {
    'empty file': '',
    'only newlines': '\n\n\n\n',
    'only carriage returns': '\r\n\r\n',
    'only NUL': nul,
    'NUL before a key': `${nul}${nul}KEY=value\n`,
    'a 5 MB single line': `KEY=${'a'.repeat(5 * 1024 * 1024)}\n`,
    'a megabyte of quotes': `KEY="${'"'.repeat(1024 * 1024)}\n`,
    'deeply nested braces': `KEY=${'${'.repeat(5000)}\n`,
    'deeply nested parens': `KEY=${'('.repeat(20000)}\n`,
    'nested json braces': `KEY=${'{"a":'.repeat(10000)}\n`,
    '50 000 declarations': `${Array.from({ length: 50000 }, (_, index) => `KEY${index % 5}=v${index}`).join('\n')}\n`,
    'a BOM in the middle': 'A=1\n\ufeffB=2\n',
    'CR-only line endings': 'A=1\rB=2\rC=3\r',
    'no trailing newline': 'A=1\nB=2',
    'a name of only dots': '...=1\n',
    'control characters in a name': 'A\u0000B=1\nC D=2\n\u00e9=3\n',
    'a bare export': 'export\n',
    'a bare equals sign': '=\n',
    'only a hash': '#\n',
    'nothing but quotes': '"'.repeat(10000),
  };
  for (const [name, contents] of Object.entries(cases)) {
    const repo = makeTempRepo({ '.env': contents, 'src/app.js': 'export const a = process.env.A;\n' });
    try {
      const report = await runScan(optionsFor(repo.dir, { maxFileSizeKb: 4096 }));
      for (const decl of report.decls) {
        assert.ok(Number.isInteger(decl.line) && decl.line >= 1, `${name}: line ${decl.line}`);
        assert.ok(Number.isInteger(decl.column) && decl.column >= 1, `${name}: column ${decl.column}`);
      }
      for (const finding of report.findings) {
        assert.ok(Number.isInteger(finding.line) && finding.line >= 1, `${name}: finding line ${finding.line}`);
        assert.ok(Number.isInteger(finding.column) && finding.column >= 1, `${name}: finding column ${finding.column}`);
      }
    } finally {
      repo.cleanup();
    }
  }

  const infra: Record<string, string> = {
    'docker-compose.yml': '{"services": {"web": {"environment": {"A": "1"}}}}',
    '.github/workflows/ci.yml': '{"env": {"A": "1"}}',
    'azure-pipelines.yml': '${{ secrets.',
    'Dockerfile': 'FROM',
    '.gitlab-ci.yml': 'variables:\n  A: 1\n',
  };
  for (const [file, contents] of Object.entries(infra)) {
    const repo = makeTempRepo({ [file]: contents, 'src/app.js': 'export const a = process.env.A;\n' });
    try {
      const report = await runScan(optionsFor(repo.dir, { maxFileSizeKb: 4096 }));
      assert.ok(Array.isArray(report.findings), `${file}: findings must stay an array`);
    } finally {
      repo.cleanup();
    }
  }

  const code: Record<string, string> = {
    'src/a.js': '`'.repeat(20000),
    'src/a.js#2': '',
    'src/b.py': "'''".repeat(10000),
    'src/c.sh': '${'.repeat(40000),
    'src/d.bat': '%'.repeat(40000),
    'src/e.pl': '$ENV{'.repeat(10000),
  };
  for (const [file, contents] of Object.entries(code)) {
    if (contents === '') {
      continue;
    }
    const repo = makeTempRepo({ [file]: contents });
    try {
      const report = await runScan(optionsFor(repo.dir, { maxFileSizeKb: 4096 }));
      assert.ok(Array.isArray(report.usages), `${file}: usages must stay an array`);
    } finally {
      repo.cleanup();
    }
  }
});

test('every reported position points at real text in the original file', async () => {
  const files: Record<string, string> = {
    'crlf/.env': 'PORT=3000\r\nHOST=localhost\r\n',
    'bom/.env': '\ufeffPORT=3000\nHOST=localhost\n',
    'midbom/.env': 'PORT=3000\n\ufeffHOST=localhost\n',
    'notrailing/.env': 'PORT=3000\nHOST=localhost',
    'quoted/.env': 'CERT="line one\nline two"\nPORT=3000\n',
    'exported/.env': '  export PORT=3000\n\tHOST=localhost\n',
    'commented/.env': '# the port\n# second line\nPORT=3000\n',
    'crlf/src/app.js': 'const a = 1;\r\nexport const p = process.env.PORT;\r\nexport const h = process.env.HOST;\r\n',
    'bom/src/app.js': '\ufeffexport const p = process.env.PORT;\n',
    'midbom/src/app.js': 'export const p = process.env.PORT;\n\ufeffexport const h = process.env.HOST;\n',
    'notrailing/src/app.js': 'export const p = process.env.PORT;\nexport const h = process.env.HOST',
    'tabs/src/app.js': 'function f() {\n\t\t\tconst p = process.env.PORT;\n\treturn p;\n}\n',
    'docker-compose.yml': 'services:\n\tweb:\n\t\tenvironment:\n\t\t\t- PORT=3000\n\t\t\t- HOST=localhost\n',
    'Dockerfile': 'FROM node:20 AS build\nARG NODE_VERSION=20\nENV A=1\nRUN echo $A\n',
  };
  const repo = makeTempRepo(files);
  try {
    const report = await runScan(optionsFor(repo.dir));
    for (const decl of report.decls) {
      const text = readFileSync(join(repo.dir, decl.file), 'utf8');
      assert.equal(substringAtForEnv(text, decl.line, decl.column, decl.name.length), decl.name, `decl ${decl.file}:${decl.line}:${decl.column}`);
    }
    for (const usage of report.usages) {
      const text = readFileSync(join(repo.dir, usage.file), 'utf8');
      assert.equal(substringAt(text, usage.line, usage.column, usage.name.length), usage.name, `usage ${usage.file}:${usage.line}:${usage.column}`);
    }
    for (const ref of report.infra) {
      const text = readFileSync(join(repo.dir, ref.file), 'utf8');
      const line = lineAt(text, ref.line);
      assert.ok(ref.column >= 1 && ref.column <= line.length + 1, `ref ${ref.file}:${ref.line}:${ref.column} outside ${JSON.stringify(line)}`);
      const at = substringAt(text, ref.line, ref.column, ref.name.length);
      const startsToken =
        at === ref.name ||
        at === `$${ref.name}` ||
        at === `\${${ref.name}` ||
        ref.kind === 'dotenv-path' ||
        ref.kind === 'compose-env-file';
      assert.ok(startsToken, `ref ${ref.kind} ${ref.file}:${ref.line}:${ref.column} points at ${JSON.stringify(at)}, not ${JSON.stringify(ref.name)}`);
    }
    for (const finding of report.findings) {
      const text = readFileSync(join(repo.dir, finding.file), 'utf8');
      const line = lineAt(text, finding.line);
      assert.ok(finding.column >= 1 && finding.column <= line.length + 1, `finding ${finding.ruleId} ${finding.file}:${finding.line}:${finding.column} outside ${JSON.stringify(line)}`);
    }
  } finally {
    repo.cleanup();
  }
});

test('the dotenv parser reports 1-based positions for awkward lines', () => {
  const parsed = parseEnvFile('.env', '  export PORT=3000\n\tHOST="a\nb"\n# c\nBROKEN="x\n', {
    kind: 'dev',
    shared: true,
    devOnly: false,
  });
  const byName = new Map(parsed.decls.map((decl) => [decl.name, decl]));

  assert.deepEqual([byName.get('PORT')?.line, byName.get('PORT')?.column], [1, 10]);
  assert.deepEqual([byName.get('HOST')?.line, byName.get('HOST')?.column], [2, 2]);
  assert.deepEqual([byName.get('HOST')?.value, byName.get('HOST')?.hasValue], ['a\nb', true]);
  assert.deepEqual([byName.get('BROKEN')?.line, byName.get('BROKEN')?.column], [5, 1]);
  assert.equal(parsed.issues.some((issue) => issue.kind === 'unterminated-quote'), true);
  for (const issue of parsed.issues) {
    assert.ok(issue.line >= 1 && issue.column >= 1, `issue ${issue.kind} at ${issue.line}:${issue.column}`);
  }

  const crlf = parseEnvFile('.env', 'PORT=3000\r\nHOST=localhost\r\n', { kind: 'dev', shared: true, devOnly: false });
  assert.deepEqual(crlf.decls.map((decl) => [decl.name, decl.line, decl.column]), [
    ['PORT', 1, 1],
    ['HOST', 2, 1],
  ]);
  const bom = parseEnvFile('.env', '\ufeffPORT=3000\n', { kind: 'dev', shared: true, devOnly: false });
  assert.deepEqual(bom.decls.map((decl) => [decl.name, decl.line, decl.column]), [['PORT', 1, 1]]);
});

test('the infrastructure scanners point at the name they found', () => {
  const docker = scanDockerfile('Dockerfile', 'FROM alpine AS build\nARG TAG=1\nENV A=$TAG\nRUN echo ${A}\n');
  const byName = new Map(docker.refs.map((ref) => [`${ref.kind}:${ref.name}`, ref]));

  assert.equal(byName.get('dockerfile-arg:TAG')?.line, 2);
  assert.equal(substringAt('FROM alpine AS build\nARG TAG=1\nENV A=$TAG\nRUN echo ${A}\n', 2, byName.get('dockerfile-arg:TAG')?.column ?? 0, 3), 'TAG');
  assert.equal(substringAt('FROM alpine AS build\nARG TAG=1\nENV A=$TAG\nRUN echo ${A}\n', 4, byName.get('dockerfile-usage:A')?.column ?? 0, 1), 'A');

  const gitlab = scanCi('.gitlab-ci.yml', parseYaml('variables:\n  A: "1"\nscript:\n  - echo $B ${C} ${D:-x}\n'), {
    defaultEnvironmentKind: 'dev',
    environmentKinds: {},
  });
  const shell = new Map(gitlab.refs.filter((ref) => ref.kind === 'ci-env-usage').map((ref) => [ref.name, ref]));
  const lines = 'variables:\n  A: "1"\nscript:\n  - echo $B ${C} ${D:-x}\n';
  for (const [name, ref] of shell) {
    assert.equal(substringAt(lines, ref.line, ref.column, name.length), name, `ci-env-usage ${name}`);
  }
});

test('two runs over the same tree produce byte-identical output', async () => {
  const repo = makeTempRepo({
    '.env': 'PORT=3000\nA=1\nB=2\n',
    '.env.example': 'PORT=\nA=\nB=\n',
    '.env.local': 'PORT=4000\n',
    '.env.production': 'PORT=5000\nA=9\n',
    'apps/api/.env': 'PORT=6000\nDB=postgres://u:p@h/db\n',
    'docker-compose.yml': 'services:\n  web:\n    environment:\n      - PORT=${PORT}\n    env_file:\n      - .env\n',
    'Dockerfile': 'ARG A\nENV PORT=3000\nRUN echo $A $B\n',
    '.github/workflows/ci.yml': 'env:\n  PORT: 1\njobs:\n  b:\n    steps:\n      - run: echo "${{ secrets.TOKEN }} ${{ vars.V }}"\n',
    'src/app.js': 'export const p = process.env.PORT;\nexport const a = process.env.A;\n',
    'src/other.ts': 'const x = process.env.D;\nconst y = process.env.MISSING_ONE;\n',
    'package.json': '{"name":"x","dependencies":{"zod":"1"},"scripts":{"b":"b","a":"a"}}',
  });
  try {
    const render = (report: Report, config: ResolvedConfig): string[] => {
      const io = silentIo(repo.dir);
      return [
        toJsonReport(report, { config, rootLabel: '.', pretty: true, includeSkipped: true, includeVariables: true, groupBy: 'file' })
          .replace(/"durationMs": \d+/g, '"durationMs": 0'),
        toSarif(report, { toolVersion: '0.1.0', informationUri: 'https://example.invalid', rootLabel: '.' }),
        toMarkdownTable(report, { config, rootLabel: '.', includeFindings: true, includeEmpty: true }),
        toExampleFile(report, { config }),
        formatReport(report, { io: io.io, config, cwd: repo.dir, maxIssuesPerFile: 1000, short: false, rootLabel: '.' }).replace(
          /\d+ms/g,
          '0ms',
        ),
        JSON.stringify(report.findings),
        JSON.stringify(report.decls),
        JSON.stringify(report.usages),
        JSON.stringify(report.infra),
        JSON.stringify(report.files),
        JSON.stringify(report.skipped),
      ];
    };
    const config = loadConfig({ root: repo.dir });
    const first = render(await runScan({ ...optionsFor(repo.dir), config }), config);
    for (let round = 0; round < 3; round += 1) {
      const again = render(await runScan({ ...optionsFor(repo.dir), config }), config);
      assert.deepEqual(again, first, `round ${round} differs`);
    }
  } finally {
    repo.cleanup();
  }
});

test('the orchestrator handles monorepos, ignored directories, overrides and empty projects', async () => {
  const monorepo = makeTempRepo({
    'package.json': '{"name":"root","dependencies":{"vite":"1"}}',
    'packages/app/package.json': '{"name":"app","dependencies":{"next":"1"}}',
    '.env': 'VITE_X=1\nPORT=3000\n',
    '.env.example': 'VITE_X=\nPORT=\n',
    'src/app.js': 'export const p = process.env.PORT;\nexport const v = process.env.VITE_X;\n',
  });
  try {
    const report = await scanRepo(monorepo);
    assert.equal(report.findings.some((finding) => finding.ruleId === 'framework-prefix-mismatch'), false, 'the root manifest lists vite');
  } finally {
    monorepo.cleanup();
  }

  const ignored = makeTempRepo({
    '.gitignore': 'secrets/\n',
    '.env': 'PORT=3000\n',
    '.env.example': 'PORT=\nDB_PASSWORD=\n',
    'secrets/.env': 'DB_PASSWORD=abc123def456\n',
    'src/app.js': 'export const p = process.env.PORT;\nexport const d = process.env.DB_PASSWORD;\n',
  });
  try {
    const report = await runScan({ ...optionsFor(ignored.dir), useGitignore: true });
    assert.equal(report.files.some((file) => file.path === 'secrets/.env'), false);
    assert.equal(report.skipped.some((entry) => entry.file === 'secrets' && entry.reason === 'gitignore'), true);
  } finally {
    ignored.cleanup();
  }

  const twoNames = makeTempRepo({
    'a/.env': 'PORT=3000\nHOST=a\n',
    'b/.env': 'PORT=4000\nHOST=b\n',
    '.env.example': 'PORT=\nHOST=\n',
    'src/app.js': 'export const p = process.env.PORT;\nexport const h = process.env.HOST;\n',
  });
  try {
    const report = await scanRepo(twoNames);
    const conflicts = report.findings.filter((finding) => finding.ruleId === 'conflicting-values');
    assert.deepEqual(conflicts.map((finding) => `${finding.file}:${finding.variable}`), ['b/.env:PORT', 'b/.env:HOST']);
  } finally {
    twoNames.cleanup();
  }

  const ciSecret = makeTempRepo({
    '.env': 'MY_TOKEN=value\nPORT=1\n',
    '.env.example': 'MY_TOKEN=\nPORT=\n',
    '.github/workflows/ci.yml': 'jobs:\n  b:\n    steps:\n      - run: echo "${{ secrets.MY_TOKEN }}"\n',
    'src/app.js': 'export const p = process.env.PORT;\nexport const t = process.env.MY_TOKEN;\n',
  });
  try {
    const report = await scanRepo(ciSecret);
    assert.equal(report.findings.some((finding) => finding.ruleId === 'ci-secret-undeclared'), false, 'a documented secret is not undeclared');
  } finally {
    ciSecret.cleanup();
  }

  const loop = makeTempRepo({
    '.env': 'PORT=3000\n',
    '.env.example': 'PORT=\n',
    'src/app.js': 'export const p = process.env.PORT;\n',
  });
  try {
    symlinkSync(loop.dir, join(loop.dir, 'loop'), 'junction');
    const report = await runScan(optionsFor(loop.dir, { followSymlinks: true }));
    assert.equal(report.skipped.some((entry) => entry.reason === 'symlink'), true);
    assert.equal(report.findings.length, 0);
  } catch {
    assert.ok(true, 'symlink creation is not permitted here');
  } finally {
    loop.cleanup();
  }

  const empty = makeTempRepo({ 'README.md': '# nothing\n' });
  try {
    const report = await scanRepo(empty);
    assert.deepEqual(report.findings, []);
    assert.equal(report.summary.total, 0);
    assert.equal(report.files.length, 0);
    const config = loadConfig({ root: empty.dir });
    const io = silentIo(empty.dir);
    assert.match(toJsonReport(report, { config }), /"schemaVersion": 1/);
    assert.match(toSarif(report, { toolVersion: '0.1.0', informationUri: '', rootLabel: '.' }), /"version": "2.1.0"/);
    assert.match(toMarkdownTable(report, { config, includeFindings: true }), /No environment variables found\./);
    assert.match(formatReport(report, { io: io.io, config, cwd: empty.dir, maxIssuesPerFile: 5, short: false, rootLabel: '.' }), /no env problems found/);
    assert.match(toExampleFile(report, { config }), /Do NOT put real secrets/);
  } finally {
    empty.cleanup();
  }

  const subdir = makeTempRepo({
    '.env': 'ROOT_ONLY=1\nPORT=3000\n',
    '.env.example': 'ROOT_ONLY=\nPORT=\n',
    'apps/web/.env': 'PORT=4000\n',
    'apps/web/src/app.js': 'export const p = process.env.PORT;\nexport const r = process.env.ROOT_ONLY;\n',
  });
  try {
    const report = await runScan(optionsFor(join(subdir.dir, 'apps', 'web')));
    assert.deepEqual(report.files.map((file) => file.path), ['.env']);
    assert.equal(report.findings.some((finding) => finding.variable === 'ROOT_ONLY' && finding.ruleId === 'missing-in-env'), true);
  } finally {
    subdir.cleanup();
  }

  const missing = makeTempRepo({});
  const missingRoot = await runScan(optionsFor(join(missing.dir, 'does-not-exist')));
  assert.deepEqual(missingRoot.findings, []);
  missing.cleanup();
});

test('matching thousands of globs reuses one compiled pattern', () => {
  assert.equal(globToRegExp('*.env'), globToRegExp('*.env'), 'the same glob must return the same pattern object');
  assert.equal(
    globToRegExp('**/.env*', 'i'),
    globToRegExp('**/.env*', 'i'),
    'the same glob and flags must return the same pattern object',
  );
  assert.notEqual(globToRegExp('*.env'), globToRegExp('*.env', 'i'), 'flags must not be shared between patterns');
  assert.equal(globToRegExp('*.env').test('a.env'), true);
  assert.equal(globToRegExp('*.env', 'i').test('A.ENV'), true);
  assert.equal(globToRegExp('*.env').test('A.ENV'), false);
  assert.equal(globToRegExp('*', 'g').test('a'), true, 'a stateful pattern is still usable');
  assert.equal(globToRegExp('*', 'g').test('a'), true);

  const globs = ['**/*', '**/.env.example', '*.env', '{a,b}/*.env', 'apps/*/.env'];
  const started = performance.now();
  let hits = 0;
  for (let round = 0; round < 20000; round += 1) {
    for (const glob of globs) {
      for (const value of ['apps/web/.env', '.env', 'src/index.ts']) {
        if (matchGlob(value, glob, true)) {
          hits += 1;
        }
      }
    }
  }
  const elapsed = performance.now() - started;

  assert.equal(hits, 100000);
  assert.ok(elapsed < 1500, `300 000 glob matches took ${Math.round(elapsed)}ms`);
});

test('a big env file is analysed once, not once per declaration', async () => {
  const lines = Array.from({ length: 5000 }, (_, index) => `KEY${index % 5}=value${index}`);
  const repo = makeTempRepo({ '.env': `${lines.join('\n')}\n`, 'src/app.js': 'export const p = process.env.KEY0;\n' });
  try {
    const started = performance.now();
    const report = await runScan(optionsFor(repo.dir, { maxFileSizeKb: 4096 }));
    const elapsed = performance.now() - started;

    assert.equal(report.decls.length, 5000);
    assert.ok(elapsed < 2000, `5000 declarations took ${Math.round(elapsed)}ms`);
  } finally {
    repo.cleanup();
  }
});

test('a file with tens of thousands of references of one name is not quadratic', async () => {
  const timeFor = async (references: number): Promise<number> => {
    const compose = `services:\n  web:\n    image: ${repeat('$B ', references * 3)}\n`;
    const repo = makeTempRepo({ 'docker-compose.yml': compose, 'src/app.js': 'export const p = process.env.PORT;\n' });
    try {
      let best = Number.POSITIVE_INFINITY;
      for (let round = 0; round < 2; round += 1) {
        const started = performance.now();
        const report = await runScan(optionsFor(repo.dir, { maxFileSizeKb: 4096 }));
        best = Math.min(best, performance.now() - started);
        if (round === 0) {
          assert.equal(report.infra.length, references);
          assert.equal(report.findings.length, references + 1);
        }
      }
      return best;
    } finally {
      repo.cleanup();
    }
  };

  const floor = await timeFor(400);
  const small = Math.max(1, (await timeFor(8000)) - floor);
  const large = Math.max(1, (await timeFor(64000)) - floor);

  assert.ok(large < 30000, `64000 compose interpolations took ${Math.round(large)}ms above the floor`);
  // A linear implementation costs about eight times as much for eight times the
  // references, so fifteen is the ceiling. The additive slack keeps scheduler
  // noise on a busy machine from failing a run that is in fact linear.
  const budget = small * 15 + 250;
  assert.ok(
    large < budget,
    `eight times the references cost ${(large / small).toFixed(1)} times the time, which is worse than linear`,
  );
});

test('thousands of reads of one undeclared name are not quadratic', async () => {
  const reads = 20000;
  const source = `${Array.from({ length: reads }, () => 'process.env.MISSING_NAME;').join('\n')}\n`;
  const repo = makeTempRepo({ 'src/app.js': source, '.env.example': 'PORT=\n' });
  try {
    const started = performance.now();
    const report = await runScan(optionsFor(repo.dir, { maxFileSizeKb: 4096 }));
    const elapsed = performance.now() - started;

    assert.equal(report.usages.length, reads);
    assert.ok(elapsed < 3000, `${reads} reads of one name took ${Math.round(elapsed)}ms`);
  } finally {
    repo.cleanup();
  }
});

test('runScanDetailed never loses a finding to a rule that throws', async () => {
  const repo = makeTempRepo({ '.env': 'PORT=3000\n', '.env.example': 'PORT=\n', 'src/app.js': 'export const p = process.env.PORT;\n' });
  try {
    const result = await runScanDetailed(optionsFor(repo.dir));
    assert.deepEqual(result.ruleErrors, []);
    assert.ok(Array.isArray(result.report.findings));
    assert.equal(typeof result.suppressions.count, 'number');
  } finally {
    repo.cleanup();
  }
});
