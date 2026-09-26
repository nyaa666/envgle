#!/usr/bin/env node
/**
 * Portable test entry point. The Node test runner only learned to expand glob
 * patterns in v21, and a directory argument behaves differently across
 * versions, so the file list is collected here and passed explicitly. Works
 * identically on Node 20, 22 and 24 and on every platform.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const testDirectory = join(root, 'dist', 'test');

if (!existsSync(testDirectory)) {
  process.stderr.write('no compiled tests: run "npm run build" first\n');
  process.exit(1);
}

const files = readdirSync(testDirectory)
  .filter((name) => name.endsWith('.test.js'))
  .sort()
  .map((name) => join('dist', 'test', name));

if (files.length === 0) {
  process.stderr.write(`no *.test.js files in ${testDirectory}\n`);
  process.exit(1);
}

const forwarded = process.argv.slice(2);
const result = spawnSync(
  process.execPath,
  ['--test', '--test-reporter=spec', ...(forwarded.length > 0 ? forwarded : files)],
  { cwd: root, stdio: 'inherit' },
);

if (result.error !== undefined) {
  process.stderr.write(`cannot start the test runner: ${result.error.message}\n`);
  process.exit(1);
}
process.exit(result.status ?? 1);
