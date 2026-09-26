import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { toPosix } from '../utils/text.js';

const LOOKUP_DEPTH = 12;

function repositoryRoot(start: string): string | null {
  let directory = resolve(start);
  for (let depth = 0; depth < LOOKUP_DEPTH; depth += 1) {
    if (existsSync(join(directory, '.git'))) {
      return directory;
    }
    const parent = dirname(directory);
    if (parent === directory) {
      return null;
    }
    directory = parent;
  }
  return null;
}

/**
 * Tracked file list from `git ls-files`, or null when git is unavailable or the
 * directory is not in a repository. Paths are relative to `root`, not to the
 * repository root, so a scan of a subdirectory of a monorepo compares like with
 * like. Never throws and never spawns a shell.
 */
export function trackedFiles(root: string): Set<string> | null {
  const repository = repositoryRoot(root);
  if (repository === null) {
    return null;
  }
  const scanRoot = resolve(root);
  try {
    const output = execFileSync('git', ['ls-files', '-z'], {
      cwd: repository,
      encoding: 'utf8',
      timeout: 15_000,
      maxBuffer: 32 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'ignore'],
      windowsHide: true,
    });
    const result = new Set<string>();
    for (const entry of output.split('\0')) {
      if (entry.length === 0) {
        continue;
      }
      const relativeToScan = relative(scanRoot, resolve(repository, entry));
      const relativeToScanPosix = toPosix(relativeToScan);
      if (relativeToScanPosix.length === 0 || relativeToScanPosix === '..' || relativeToScanPosix.startsWith('../')) {
        continue;
      }
      if (isAbsolute(relativeToScanPosix)) {
        continue;
      }
      result.add(relativeToScanPosix);
    }
    return result;
  } catch {
    return null;
  }
}
