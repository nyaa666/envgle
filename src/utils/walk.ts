import { open, readdir, realpath, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { Dirent, Stats } from 'node:fs';
import type { Language, SkippedFile } from '../types.js';
import type { IgnoreMatcher } from './ignore.js';
import { isProbablyBinary, matchAnyGlob, matchGlob, toPosix } from './text.js';

export interface WalkOptions {
  readonly root: string;
  readonly include?: readonly string[];
  readonly exclude?: readonly string[];
  readonly ignoreMatcher?: IgnoreMatcher;
  readonly maxFileSizeBytes: number;
  readonly followSymlinks: boolean;
}

export interface WalkedFile {
  readonly absolutePath: string;
  /** Project-root-relative POSIX path. */
  readonly relativePath: string;
  readonly bytes: number;
  readonly language: Language;
}

export interface WalkResult {
  readonly files: readonly WalkedFile[];
  readonly skipped: readonly { file: string; reason: string }[];
  readonly bytes: number;
}

interface PendingDirectory {
  readonly absolutePath: string;
  readonly relativePath: string;
}

type EntryKind = 'file' | 'directory' | 'other';

const LANGUAGE_BY_EXTENSION: Readonly<Record<string, Language>> = {
  '.ts': 'typescript',
  '.tsx': 'typescript',
  '.mts': 'typescript',
  '.cts': 'typescript',
  '.js': 'javascript',
  '.jsx': 'javascript',
  '.mjs': 'javascript',
  '.cjs': 'javascript',
  '.py': 'python',
  '.pyi': 'python',
  '.go': 'go',
  '.rs': 'rust',
  '.java': 'java',
  '.kt': 'kotlin',
  '.kts': 'kotlin',
  '.cs': 'csharp',
  '.rb': 'ruby',
  '.erb': 'ruby',
  '.rake': 'ruby',
  '.php': 'php',
  '.pl': 'perl',
  '.pm': 'perl',
  '.t': 'perl',
  '.sh': 'shell',
  '.bash': 'shell',
  '.zsh': 'shell',
  '.ksh': 'shell',
  '.bat': 'batch',
  '.cmd': 'batch',
  '.swift': 'swift',
  '.dart': 'dart',
  '.ex': 'elixir',
  '.exs': 'elixir',
};

const ALWAYS_SKIPPED_DIRECTORIES: ReadonlySet<string> = new Set([
  '.git',
  '.hg',
  '.svn',
  'node_modules',
  'dist',
  'build',
  'out',
  'coverage',
  '.next',
  '.nuxt',
  '.svelte-kit',
  '.turbo',
  '.cache',
  '.venv',
  'venv',
  'vendor',
  'target',
  'bin',
  'obj',
  '.gradle',
  '.idea',
  '.vscode',
  '.pytest_cache',
  '__pycache__',
  '.terraform',
  '.tox',
]);

/**
 * Generated build wrappers and autotools helpers. They are thousands of lines of
 * shell and batch that read and write their own local variables, so scanning them
 * produces only false positives.
 */
const ALWAYS_SKIPPED_FILES: ReadonlySet<string> = new Set([
  'gradlew',
  'gradlew.bat',
  'mvnw',
  'mvnw.cmd',
  'configure',
  'config.guess',
  'config.sub',
  'config.sub',
  'ltmain.sh',
  'libtool',
  'install-sh',
  'missing',
  'depcomp',
  'test-driver',
  'compile',
  'ar-lib',
  'ylwrap',
  'cygwin',
]);

const NOISY_EXTENSIONS: ReadonlySet<string> = new Set([
  '.png',
  '.jpg',
  '.jpeg',
  '.gif',
  '.ico',
  '.pdf',
  '.zip',
  '.gz',
  '.tar',
  '.woff',
  '.woff2',
  '.ttf',
  '.eot',
  '.mp4',
  '.mp3',
  '.wasm',
  '.so',
  '.dll',
  '.exe',
  '.class',
  '.jar',
  '.pyc',
]);

const ENV_FILE_NAME_PATTERNS: readonly RegExp[] = [/^\.env(\..+)?$/, /^env(\..+)?$/, /\.env$/];

const BINARY_SNIFF_BYTES = 8192;

const compareText = (left: string, right: string): number =>
  left < right ? -1 : left > right ? 1 : 0;

const baseName = (relativePath: string): string => {
  const slash = relativePath.lastIndexOf('/');
  return slash === -1 ? relativePath : relativePath.slice(slash + 1);
};

const lowerExtension = (name: string): string => {
  const dot = name.lastIndexOf('.');
  return dot <= 0 ? '' : name.slice(dot).toLowerCase();
};

const displayPath = (relativePath: string): string => (relativePath === '' ? '.' : relativePath);

const matchesAnyPattern = (
  relativePath: string,
  name: string,
  patterns: readonly string[],
): boolean => {
  if (patterns.length === 0) {
    return false;
  }
  return matchAnyGlob(relativePath, patterns, true) || matchAnyGlob(name, patterns, true);
};

const statOrNull = async (absolutePath: string): Promise<Stats | null> => {
  try {
    return await stat(absolutePath);
  } catch {
    return null;
  }
};

const realpathOrNull = async (absolutePath: string): Promise<string | null> => {
  try {
    return await realpath(absolutePath);
  } catch {
    return null;
  }
};

const readFileHead = async (absolutePath: string, byteCount: number): Promise<Uint8Array | null> => {
  try {
    const handle = await open(absolutePath, 'r');
    try {
      const buffer = new Uint8Array(byteCount);
      const result = await handle.read(buffer, 0, byteCount, 0);
      return buffer.subarray(0, result.bytesRead);
    } finally {
      await handle.close().catch(() => undefined);
    }
  } catch {
    return null;
  }
};

const classifyEntry = async (
  entry: Dirent,
  absolutePath: string,
  followSymlinks: boolean,
): Promise<EntryKind> => {
  if (entry.isDirectory()) {
    return 'directory';
  }
  if (entry.isFile()) {
    return 'file';
  }
  if (entry.isSymbolicLink() && followSymlinks) {
    const stats = await statOrNull(absolutePath);
    if (stats === null) {
      return 'other';
    }
    return stats.isFile() ? 'file' : 'directory';
  }
  return 'other';
};

/** Maps a project-relative path to one of the 15 scanned languages, or `unknown`. */
export const detectLanguage = (relativePath: string): Language => {
  const name = baseName(toPosix(relativePath)).toLowerCase();
  const dot = name.lastIndexOf('.');
  if (dot <= 0) {
    return 'unknown';
  }
  return LANGUAGE_BY_EXTENSION[name.slice(dot)] ?? 'unknown';
};

/** True for dotenv-style file names, including config-supplied globs, never for source files. */
export const isEnvFileName = (relativePath: string, extra: readonly string[]): boolean => {
  const rawName = baseName(toPosix(relativePath));
  if (detectLanguage(rawName) !== 'unknown') {
    return false;
  }
  const name = rawName.toLowerCase();
  if (ENV_FILE_NAME_PATTERNS.some((pattern) => pattern.test(name))) {
    return true;
  }
  if (extra.length === 0) {
    return false;
  }
  return (
    matchAnyGlob(rawName, extra, true) || matchAnyGlob(toPosix(relativePath), extra, true)
  );
};

/** Walks the tree iteratively, never throws, and reports every file it refused to read. */
export const walkFiles = async (options: WalkOptions): Promise<WalkResult> => {
  const root = resolve(options.root);
  const include = options.include ?? [];
  const exclude = options.exclude ?? [];
  const matcher = options.ignoreMatcher ?? null;
  const maxFileSizeBytes = options.maxFileSizeBytes;
  const files: WalkedFile[] = [];
  const skipped: SkippedFile[] = [];
  const visited = new Set<string>();
  const stack: PendingDirectory[] = [{ absolutePath: root, relativePath: '' }];
  const rootRealPath = await realpathOrNull(root);
  if (rootRealPath !== null) {
    visited.add(rootRealPath);
  }

  while (stack.length > 0) {
    const current = stack.pop();
    if (current === undefined) {
      break;
    }
    let entries: Dirent[];
    try {
      entries = await readdir(current.absolutePath, { withFileTypes: true });
    } catch {
      skipped.push({ file: displayPath(current.relativePath), reason: 'unreadable' });
      continue;
    }
    for (const entry of entries) {
      const name = entry.name;
      const relativePath = current.relativePath === '' ? name : `${current.relativePath}/${name}`;
      const absolutePath = join(current.absolutePath, name);
      const kind = await classifyEntry(entry, absolutePath, options.followSymlinks);
      if (kind === 'other') {
        skipped.push({
          file: relativePath,
          reason: entry.isSymbolicLink() ? 'symlink' : 'special',
        });
        continue;
      }
      if (kind === 'directory') {
        if (ALWAYS_SKIPPED_DIRECTORIES.has(name)) {
          continue;
        }
        if (matchesAnyPattern(relativePath, name, exclude)) {
          skipped.push({ file: relativePath, reason: 'exclude' });
          continue;
        }
        if (matcher !== null && matcher.test(relativePath, true) === 'ignored') {
          skipped.push({ file: relativePath, reason: 'gitignore' });
          continue;
        }
        if (options.followSymlinks) {
          const realPath = await realpathOrNull(absolutePath);
          if (realPath === null || visited.has(realPath)) {
            skipped.push({ file: relativePath, reason: 'symlink' });
            continue;
          }
          visited.add(realPath);
        }
        stack.push({ absolutePath, relativePath });
        continue;
      }
      if (matcher !== null && matcher.test(relativePath, false) === 'ignored') {
        continue;
      }
      if (matchesAnyPattern(relativePath, name, exclude)) {
        continue;
      }
      if (NOISY_EXTENSIONS.has(lowerExtension(name))) {
        skipped.push({ file: relativePath, reason: 'extension' });
        continue;
      }
      if (ALWAYS_SKIPPED_FILES.has(name.toLowerCase())) {
        skipped.push({ file: relativePath, reason: 'generated' });
        continue;
      }
      if (include.length > 0 && !matchesAnyPattern(relativePath, name, include)) {
        continue;
      }
      const stats = await statOrNull(absolutePath);
      if (stats === null) {
        skipped.push({ file: relativePath, reason: 'unreadable' });
        continue;
      }
      if (stats.size > maxFileSizeBytes) {
        skipped.push({ file: relativePath, reason: 'too-large' });
        continue;
      }
      const head = await readFileHead(absolutePath, BINARY_SNIFF_BYTES);
      if (head === null) {
        skipped.push({ file: relativePath, reason: 'unreadable' });
        continue;
      }
      if (isProbablyBinary(head)) {
        skipped.push({ file: relativePath, reason: 'binary' });
        continue;
      }
      files.push({
        absolutePath,
        relativePath,
        bytes: stats.size,
        language: detectLanguage(relativePath),
      });
    }
  }

  files.sort((left, right) => compareText(left.relativePath, right.relativePath));
  skipped.sort(
    (left, right) =>
      compareText(left.file, right.file) || compareText(left.reason, right.reason),
  );
  return { files, skipped, bytes: files.reduce((total, file) => total + file.bytes, 0) };
};
