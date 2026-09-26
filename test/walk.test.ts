import assert from 'node:assert/strict';
import { symlinkSync } from 'node:fs';
import { test } from 'node:test';
import { createIgnoreMatcher } from '../src/utils/ignore.js';
import { toPosix } from '../src/utils/text.js';
import { detectLanguage, isEnvFileName, walkFiles } from '../src/utils/walk.js';
import { makeTempRepo } from './helpers.js';
import type { TestContext } from 'node:test';
import type { TempRepo } from './helpers.js';

const HUGE = 1024 * 1024;

interface WalkOverrides {
  readonly include?: readonly string[];
  readonly exclude?: readonly string[];
  readonly ignorePatterns?: readonly string[];
  readonly maxFileSizeBytes?: number;
  readonly followSymlinks?: boolean;
}

const walk = async (repo: TempRepo, overrides: WalkOverrides = {}) =>
  walkFiles({
    root: repo.dir,
    include: overrides.include,
    exclude: overrides.exclude,
    ignoreMatcher:
      overrides.ignorePatterns === undefined ? undefined : createIgnoreMatcher(overrides.ignorePatterns),
    maxFileSizeBytes: overrides.maxFileSizeBytes ?? HUGE,
    followSymlinks: overrides.followSymlinks ?? false,
  });

const pathsOf = (files: readonly { relativePath: string }[]): string[] =>
  files.map((file) => file.relativePath);

const paths = async (repo: TempRepo, overrides: WalkOverrides = {}) => {
  const result = await walk(repo, overrides);
  return pathsOf(result.files);
};

const withRepo = async (run: (repo: TempRepo) => Promise<void>): Promise<void> => {
  const repo = makeTempRepo();
  try {
    await run(repo);
  } finally {
    repo.cleanup();
  }
};

const errorCode = (error: unknown): string | null => {
  if (typeof error !== 'object' || error === null || !('code' in error)) {
    return null;
  }
  const code = error.code;
  return typeof code === 'string' ? code : null;
};

const makeLink = (
  linkPath: string,
  target: string,
  types: readonly ('dir' | 'file' | 'junction')[],
): string | null => {
  for (const type of types) {
    try {
      symlinkSync(target, linkPath, type);
      return null;
    } catch (error) {
      const code = errorCode(error);
      if (code === 'EPERM' || code === 'EACCES' || code === 'ENOSYS' || code === 'ENOENT') {
        continue;
      }
      return code ?? 'EUNKNOWN';
    }
  }
  return 'EPERM';
};

test('prunes build and tooling directories but never a directory named env', async () => {
  await withRepo(async (repo) => {
    repo.write('src/index.ts', 'export const a = 1;\n');
    repo.write('README.md', '# hi\n');
    repo.write('node_modules/dep/index.js', 'module.exports = 1;\n');
    repo.write('src/lib/node_modules/dep/index.js', 'module.exports = 1;\n');
    repo.write('dist/bundle.js', 'console.log(1);\n');
    repo.write('.git/config', '[core]\n');
    repo.write('coverage/lcov.info', 'TN:\n');
    repo.write('__pycache__/mod.pyc', 'x\n');
    repo.write('env/.env', 'API_KEY=x\n');
    repo.write('env/nested/settings.json', '{}\n');
    const result = await walk(repo);
    assert.deepEqual(pathsOf(result.files), [
      'README.md',
      'env/.env',
      'env/nested/settings.json',
      'src/index.ts',
    ]);
    assert.deepEqual(result.skipped, []);
  });
});

test('a matcher-pruned directory is reported with reason gitignore', async () => {
  await withRepo(async (repo) => {
    repo.write('.gitignore', 'generated/\nsecrets\n');
    repo.write('generated/out.txt', 'x\n');
    repo.write('secrets/key.txt', 'x\n');
    repo.write('src/a.ts', 'export const a = 1;\n');
    const result = await walk(repo, { ignorePatterns: ['generated/', 'secrets'] });
    assert.deepEqual(pathsOf(result.files), ['.gitignore', 'src/a.ts']);
    assert.deepEqual(result.skipped, [
      { file: 'generated', reason: 'gitignore' },
      { file: 'secrets', reason: 'gitignore' },
    ]);
  });
});

test('a built-in directory is pruned before the matcher and stays out of skipped', async () => {
  await withRepo(async (repo) => {
    repo.write('build/out.txt', 'x\n');
    repo.write('src/a.ts', 'a\n');
    const result = await walk(repo, { ignorePatterns: ['build/'] });
    assert.deepEqual(pathsOf(result.files), ['src/a.ts']);
    assert.deepEqual(result.skipped, []);
  });
});

test('a matcher-ignored file is dropped without noise', async () => {
  await withRepo(async (repo) => {
    repo.write('.env', 'A=1\n');
    repo.write('.env.local', 'A=2\n');
    repo.write('keep.txt', 'x\n');
    const result = await walk(repo, { ignorePatterns: ['.env', '!nothing'] });
    assert.deepEqual(pathsOf(result.files), ['.env.local', 'keep.txt']);
    assert.deepEqual(result.skipped, []);
  });
});

test('include globs select files without pruning their ancestors', async () => {
  await withRepo(async (repo) => {
    repo.write('src/a.ts', 'a\n');
    repo.write('src/b.js', 'b\n');
    repo.write('src/deep/deeper/c.ts', 'c\n');
    repo.write('docs/readme.md', 'd\n');
    assert.deepEqual(await paths(repo, { include: ['**/*.ts'] }), ['src/a.ts', 'src/deep/deeper/c.ts']);
    assert.deepEqual(await paths(repo, { include: ['src/**'] }), ['src/a.ts', 'src/b.js', 'src/deep/deeper/c.ts']);
    assert.deepEqual(await paths(repo, { include: ['src/*.ts'] }), ['src/a.ts']);
    assert.deepEqual(await paths(repo, { include: ['*.ts'] }), ['src/a.ts', 'src/deep/deeper/c.ts']);
    assert.deepEqual(await paths(repo, { include: ['**/*.ts', '**/*.js'] }), [
      'src/a.ts',
      'src/b.js',
      'src/deep/deeper/c.ts',
    ]);
    const empty = await walk(repo, { include: ['**/nothing-here'] });
    assert.deepEqual(pathsOf(empty.files), []);
    assert.deepEqual(empty.skipped, []);
  });
});

test('exclude globs prune directories and skip files', async () => {
  await withRepo(async (repo) => {
    repo.write('src/a.ts', 'a\n');
    repo.write('src/a.min.js', 'a\n');
    repo.write('fixtures/snap/a.ts', 'a\n');
    repo.write('docs/readme.md', 'd\n');
    assert.deepEqual(await paths(repo, { exclude: ['**/*.min.js'] }), [
      'docs/readme.md',
      'fixtures/snap/a.ts',
      'src/a.ts',
    ]);
    assert.deepEqual(await paths(repo, { exclude: ['**/deep/**'] }), [
      'docs/readme.md',
      'fixtures/snap/a.ts',
      'src/a.min.js',
      'src/a.ts',
    ]);
    assert.deepEqual(await paths(repo, { exclude: ['fixtures'] }), ['docs/readme.md', 'src/a.min.js', 'src/a.ts']);
    const result = await walk(repo, { exclude: ['fixtures'] });
    assert.deepEqual(result.skipped, [{ file: 'fixtures', reason: 'exclude' }]);
  });
});

test('a file above maxFileSizeBytes is reported as too-large', async () => {
  await withRepo(async (repo) => {
    repo.write('small.txt', 'x\n');
    repo.write('big.txt', `${'x'.repeat(4096)}\n`);
    const result = await walk(repo, { maxFileSizeBytes: 1024 });
    assert.deepEqual(pathsOf(result.files), ['small.txt']);
    assert.deepEqual(result.skipped, [{ file: 'big.txt', reason: 'too-large' }]);
    assert.equal(result.bytes, 2);
    const exact = await walk(repo, { maxFileSizeBytes: 4097 });
    assert.deepEqual(pathsOf(exact.files), ['big.txt', 'small.txt']);
  });
});

test('binary files and noisy extensions are skipped with a reason', async () => {
  await withRepo(async (repo) => {
    repo.write('data/blob.dat', 'abc\u0000def');
    repo.write('assets/logo.png', 'not really a png\n');
    repo.write('text.txt', 'plain\n');
    repo.write('app.lock', 'lockfileVersion: 9\n');
    repo.write('binary.lock', 'lockfileVersion: 9\u0000\n');
    const result = await walk(repo);
    assert.deepEqual(pathsOf(result.files), ['app.lock', 'text.txt']);
    assert.deepEqual(result.skipped, [
      { file: 'assets/logo.png', reason: 'extension' },
      { file: 'binary.lock', reason: 'binary' },
      { file: 'data/blob.dat', reason: 'binary' },
    ]);
  });
});

test('a symlink loop never causes infinite recursion', async (t: TestContext) => {
  await withRepo(async (repo) => {
    repo.write('nested/a.txt', 'a\n');
    repo.write('nested/deep/b.txt', 'b\n');
    const failure = makeLink(repo.path('nested/loop'), repo.path('nested'), ['dir', 'junction']);
    if (failure !== null) {
      t.skip(`symlinks unavailable on this host: ${failure}`);
      return;
    }
    const shallow = await walk(repo, { followSymlinks: false });
    assert.deepEqual(pathsOf(shallow.files), ['nested/a.txt', 'nested/deep/b.txt']);
    assert.deepEqual(shallow.skipped, [{ file: 'nested/loop', reason: 'symlink' }]);
    const followed = await walk(repo, { followSymlinks: true });
    assert.deepEqual(pathsOf(followed.files), ['nested/a.txt', 'nested/deep/b.txt']);
    assert.deepEqual(followed.skipped, [{ file: 'nested/loop', reason: 'symlink' }]);
  });
});

test('a dangling symlink is reported instead of thrown', async (t: TestContext) => {
  await withRepo(async (repo) => {
    repo.write('a.txt', 'a\n');
    const failure = makeLink(repo.path('broken'), repo.path('does-not-exist'), ['file', 'dir']);
    if (failure !== null) {
      t.skip(`symlinks unavailable on this host: ${failure}`);
      return;
    }
    const shallow = await walk(repo);
    assert.deepEqual(pathsOf(shallow.files), ['a.txt']);
    assert.deepEqual(shallow.skipped, [{ file: 'broken', reason: 'symlink' }]);
    const followed = await walk(repo, { followSymlinks: true });
    assert.deepEqual(pathsOf(followed.files), ['a.txt']);
    assert.deepEqual(followed.skipped, [{ file: 'broken', reason: 'symlink' }]);
  });
});

test('output is deterministic, sorted and root-relative', async () => {
  await withRepo(async (repo) => {
    for (const name of ['zeta.txt', 'alpha.txt', 'Beta.txt', 'm/n/o.txt', 'm/a.txt']) {
      repo.write(name, `${name}\n`);
    }
    const first = await walk(repo);
    const second = await walk(repo);
    assert.deepEqual(pathsOf(first.files), pathsOf(second.files));
    assert.deepEqual(pathsOf(first.files), [
      'Beta.txt',
      'alpha.txt',
      'm/a.txt',
      'm/n/o.txt',
      'zeta.txt',
    ]);
    for (const file of first.files) {
      assert.ok(!file.relativePath.startsWith('/'));
      assert.ok(!file.relativePath.includes('\\'));
      assert.ok(!file.relativePath.includes(':'));
      assert.equal(toPosix(file.absolutePath).endsWith(file.relativePath), true);
      assert.equal(file.bytes, `${file.relativePath}\n`.length);
    }
    assert.equal(first.bytes, first.files.reduce((total, file) => total + file.bytes, 0));
  });
});

test('a zero-byte file is returned', async () => {
  await withRepo(async (repo) => {
    repo.write('empty.txt', '');
    repo.write('full.txt', 'x\n');
    const result = await walk(repo);
    const empty = result.files.find((file) => file.relativePath === 'empty.txt');
    assert.equal(empty?.bytes, 0);
    assert.equal(empty?.language, 'unknown');
    assert.equal(result.bytes, 2);
  });
});

test('a ten-level deep tree is walked completely', async () => {
  await withRepo(async (repo) => {
    const deep = Array.from({ length: 10 }, (_unused, index) => `l${index + 1}`).join('/');
    repo.write(`${deep}/leaf.ts`, 'export const leaf = 1;\n');
    repo.write('shallow.ts', 'export const shallow = 1;\n');
    const result = await walk(repo);
    assert.deepEqual(pathsOf(result.files), [`${deep}/leaf.ts`, 'shallow.ts']);
    assert.equal(result.files[0]?.language, 'typescript');
    assert.deepEqual(result.skipped, []);
  });
});

test('an unreadable or missing root resolves to an empty result', async () => {
  await withRepo(async (repo) => {
    repo.write('a.txt', 'a\n');
    const missing = await walkFiles({
      root: repo.path('nope'),
      maxFileSizeBytes: HUGE,
      followSymlinks: false,
    });
    assert.deepEqual(missing.files, []);
    assert.deepEqual(missing.skipped, [{ file: '.', reason: 'unreadable' }]);
    assert.equal(missing.bytes, 0);
    const asFile = await walkFiles({
      root: repo.path('a.txt'),
      maxFileSizeBytes: HUGE,
      followSymlinks: false,
    });
    assert.deepEqual(asFile.files, []);
    assert.deepEqual(asFile.skipped, [{ file: '.', reason: 'unreadable' }]);
  });
});

test('an empty tree returns an empty result', async () => {
  await withRepo(async (repo) => {
    const result = await walk(repo);
    assert.deepEqual(result.files, []);
    assert.deepEqual(result.skipped, []);
    assert.equal(result.bytes, 0);
  });
});

test('detectLanguage maps extensions case-insensitively', () => {
  const table: readonly [string, string][] = [
    ['src/index.ts', 'typescript'],
    ['src/App.TSX', 'typescript'],
    ['build/mod.mts', 'typescript'],
    ['build/mod.cts', 'typescript'],
    ['src/index.js', 'javascript'],
    ['src/App.JSX', 'javascript'],
    ['src/mod.mjs', 'javascript'],
    ['src/mod.cjs', 'javascript'],
    ['app.py', 'python'],
    ['app.pyi', 'python'],
    ['main.go', 'go'],
    ['main.rs', 'rust'],
    ['Main.java', 'java'],
    ['Main.kt', 'kotlin'],
    ['build.gradle.kts', 'kotlin'],
    ['Program.cs', 'csharp'],
    ['app.rb', 'ruby'],
    ['app.erb', 'ruby'],
    ['Rakefile.rake', 'ruby'],
    ['index.php', 'php'],
    ['script.pl', 'perl'],
    ['lib.pm', 'perl'],
    ['t/01-basic.t', 'perl'],
    ['run.sh', 'shell'],
    ['run.bash', 'shell'],
    ['run.zsh', 'shell'],
    ['run.ksh', 'shell'],
    ['build.bat', 'batch'],
    ['build.CMD', 'batch'],
    ['App.swift', 'swift'],
    ['main.dart', 'dart'],
    ['mix.exs', 'elixir'],
    ['main.ex', 'elixir'],
    ['README.md', 'unknown'],
    ['Dockerfile', 'unknown'],
    ['docker-compose.yml', 'unknown'],
    ['.env', 'unknown'],
    ['.env.local', 'unknown'],
    ['Makefile', 'unknown'],
    ['no-extension', 'unknown'],
  ];
  for (const [path, expected] of table) {
    assert.equal(detectLanguage(path), expected, path);
  }
  assert.equal(detectLanguage('dir\\windows\\style.TS'), 'typescript');
});

test('isEnvFileName recognises dotenv names and rejects source files', () => {
  const table: readonly [string, boolean][] = [
    ['.env', true],
    ['apps/api/.env', true],
    ['.env.local', true],
    ['.env.production', true],
    ['.env.test', true],
    ['.env.staging', true],
    ['env', true],
    ['config/env', true],
    ['env.local', true],
    ['.env.example', true],
    ['env.example', true],
    ['.env.sample', true],
    ['.env.template', true],
    ['.env.dist', true],
    ['app.env', true],
    ['vars.env', true],
    ['docker.env', true],
    ['.ENV.LOCAL', true],
    ['dir\\windows\\.env', true],
    ['env.js', false],
    ['.env.ts', false],
    ['env.py', false],
    ['env.rb', false],
    ['.env.example.js', false],
    ['environment', false],
    ['environment.js', false],
    ['.envrc', false],
    ['.envexample', false],
    ['README.md', false],
    ['envfile', false],
    ['config.yml', false],
  ];
  for (const [path, expected] of table) {
    assert.equal(isEnvFileName(path, []), expected, path);
  }
  assert.equal(isEnvFileName('config/settings.dev', ['settings.*']), true);
  assert.equal(isEnvFileName('config/settings.dev', []), false);
  assert.equal(isEnvFileName('config/settings.dev', ['settings.*.prod']), false);
  assert.equal(isEnvFileName('config/Secrets.TXT', ['*.TXT']), true);
  assert.equal(isEnvFileName('env.js', ['env.js']), false);
});
