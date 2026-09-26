import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

/**
 * Absolute path of the repository root, found by walking up from the compiled test
 * location until a directory with its own `package.json` shows up. The build output
 * may sit at any depth below the root (`dist/test`, `.verify/qa/test`), so a fixed
 * number of `..` steps would resolve to the wrong directory.
 */
export function repoRoot(): string {
  let directory = resolve(here, '..');
  for (let depth = 0; depth < 8; depth += 1) {
    if (existsSync(join(directory, 'package.json'))) {
      return directory;
    }
    const parent = dirname(directory);
    if (parent === directory) {
      break;
    }
    directory = parent;
  }
  return resolve(here, '..', '..');
}

export function fixturePath(...segments: string[]): string {
  return join(repoRoot(), 'test', 'fixtures', ...segments);
}

export function readFixture(...segments: string[]): string {
  return readFileSync(fixturePath(...segments), 'utf8');
}

export interface TempRepo {
  readonly dir: string;
  write(relativePath: string, contents: string): string;
  append(relativePath: string, contents: string): string;
  read(relativePath: string): string;
  exists(relativePath: string): boolean;
  path(relativePath: string): string;
  cleanup(): void;
}

export function makeTempRepo(files: Record<string, string> = {}): TempRepo {
  const dir = mkdtempSync(join(tmpdir(), 'envgle-test-'));
  const repo: TempRepo = {
    dir,
    write(relativePath, contents) {
      const target = join(dir, relativePath);
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, contents, 'utf8');
      return target;
    },
    append(relativePath, contents) {
      const target = join(dir, relativePath);
      mkdirSync(dirname(target), { recursive: true });
      const existing = existsSync(target) ? readFileSync(target, 'utf8') : '';
      writeFileSync(target, existing + contents, 'utf8');
      return target;
    },
    read(relativePath) {
      return readFileSync(join(dir, relativePath), 'utf8');
    },
    exists(relativePath) {
      return existsSync(join(dir, relativePath));
    },
    path(relativePath) {
      return join(dir, relativePath);
    },
    cleanup() {
      rmSync(dir, { recursive: true, force: true });
    },
  };
  for (const [relativePath, contents] of Object.entries(files)) {
    repo.write(relativePath, contents);
  }
  return repo;
}
