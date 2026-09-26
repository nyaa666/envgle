import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseEnvFile } from '../dotenv/parse.js';
import { buildContext, runRules } from '../rules/context.js';
import { allRules } from '../rules/index.js';
import { createIgnoreMatcher } from '../utils/ignore.js';
import { appendAll, isSecretishName, relativePosix, resolveRelativePath, toPosix } from '../utils/text.js';
import { isEnvFileName, walkFiles } from '../utils/walk.js';
import { VERSION } from '../version.js';
import { classifyEnvFile } from './classify.js';
import { isCiFile, scanCi } from './ci.js';
import { scanCode } from './code.js';
import { isComposeFile, scanCompose } from './compose.js';
import { isDockerfile, scanDockerfile } from './dockerfile.js';
import { trackedFiles } from './git.js';
import { buildSuppressionIndex } from './suppress.js';
import { parseYaml } from './yaml.js';
import type { EnvFileInfo, EnvUsage, EnvVarDecl, InfraRef, PackageManifest, Report, ReportDiagnostic, ReportSummary, ResolvedConfig, ScanOptions, Severity, SkippedFile } from '../types.js';
import type { EnvFile as ParsedEnvFile } from '../dotenv/parse.js';
import type { IgnoreMatcher } from '../utils/ignore.js';
import type { SuppressionIndex, SuppressionSource } from './suppress.js';
import type { WalkedFile } from '../utils/walk.js';

export { resolveRelativePath };

export interface ScanResult {
  readonly report: Report;
  readonly suppressions: SuppressionIndex;
  /** Rules that threw; the scan continues without them. */
  readonly ruleErrors: readonly { ruleId: string; message: string }[];
}

const IGNORE_FILE_NAME = '.gitignore';
const IGNORE_SEARCH_DEPTH = 5;
const MARKER_SCAN_MAX_BYTES = 2 * 1024 * 1024;
const ENV_FILE_PATTERNS: readonly string[] = ['.env', '.env.*', 'env', 'env.*', '*.env', '*.env.*'];
const PRUNED_DIRECTORIES: ReadonlySet<string> = new Set([
  '.git',
  'node_modules',
  'dist',
  'build',
  'out',
  'coverage',
  'target',
  'vendor',
  '.venv',
  'venv',
]);
const JS_LANGUAGES: ReadonlySet<string> = new Set(['javascript', 'typescript']);
const DOTENV_PATTERNS: readonly RegExp[] = [
  /dotenv\s*\.\s*config\s*\(\s*\{[^}]*?\bpath\s*:\s*['"`]([^'"`\n]+)['"`]/gi,
  /new\s+Dotenv\s*\(\s*\{[^}]*?\bpath\s*:\s*['"`]([^'"`\n]+)['"`]/gi,
];

const byCodeUnit = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

const readText = (absolutePath: string): string | null => {
  try {
    return readFileSync(absolutePath, 'utf8');
  } catch {
    return null;
  }
};

const readDirectory = (absolutePath: string): string[] => {
  try {
    return readdirSync(absolutePath, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort(byCodeUnit);
  } catch {
    return [];
  }
};

const readEntryNames = (absolutePath: string): string[] => {
  try {
    return readdirSync(absolutePath).sort(byCodeUnit);
  } catch {
    return [];
  }
};

function readIgnoreFile(path: string): string[] {
  const text = readText(path);
  if (text === null) {
    return [];
  }
  const patterns: string[] = [];
  for (const raw of text.split('\n')) {
    const trimmed = raw.replace(/\r$/, '').trim();
    if (trimmed.length > 0 && !trimmed.startsWith('#')) {
      patterns.push(trimmed);
    }
  }
  return patterns;
}

function prefixPattern(pattern: string, directory: string): string {
  const negated = pattern.startsWith('!');
  const body = negated ? pattern.slice(1) : pattern;
  const anchored = body.startsWith('/') || body.slice(0, body.endsWith('/') ? -1 : undefined).includes('/');
  const bare = body.replace(/^\//, '').replace(/\/$/, '');
  const scoped = anchored ? `${directory}/${bare}` : `${directory}/**/${bare}`;
  return negated ? `!${scoped}` : scoped;
}

/** Collects `.gitignore` rules from the root and, with a depth bound, from nested directories. */
export function readIgnorePatterns(root: string, exclude: readonly string[] = []): string[] {
  const patterns: string[] = readIgnoreFile(join(root, IGNORE_FILE_NAME));
  const visited = new Set<string>();
  let frontier: string[] = [root];
  for (let depth = 0; depth < IGNORE_SEARCH_DEPTH && frontier.length > 0; depth += 1) {
    const next: string[] = [];
    for (const directory of frontier) {
      for (const child of readDirectory(directory)) {
        if (PRUNED_DIRECTORIES.has(child)) {
          continue;
        }
        if (exclude.some((pattern) => pattern === child || pattern === `**/${child}`)) {
          continue;
        }
        next.push(join(directory, child));
      }
    }
    for (const directory of next) {
      const key = toPosix(directory);
      if (visited.has(key)) {
        continue;
      }
      visited.add(key);
      const nested = readIgnoreFile(join(directory, IGNORE_FILE_NAME));
      if (nested.length === 0) {
        continue;
      }
      const relative = relativePosix(root, directory);
      for (const pattern of nested) {
        patterns.push(relative === '' ? pattern : prefixPattern(pattern, relative));
      }
    }
    frontier = next;
  }
  return patterns;
}

function stringRecord(value: unknown): Record<string, string> {
  const result: Record<string, string> = {};
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return result;
  }
  for (const [key, entry] of Object.entries(value as Record<string, unknown>).sort(([a], [b]) => byCodeUnit(a, b))) {
    if (typeof entry === 'string') {
      result[key] = entry;
    }
  }
  return result;
}

function nameList(value: unknown): string[] {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return [];
  }
  return Object.keys(value as Record<string, unknown>).sort(byCodeUnit);
}

function readManifest(root: string): PackageManifest | null {
  const text = readText(join(root, 'package.json'));
  if (text === null) {
    return null;
  }
  try {
    const value = JSON.parse(text.replace(/^\uFEFF/, '')) as Record<string, unknown>;
    return {
      path: 'package.json',
      name: typeof value['name'] === 'string' ? value['name'] : null,
      dependencies: nameList(value['dependencies']),
      devDependencies: nameList(value['devDependencies']),
      scripts: stringRecord(value['scripts']),
      engines: stringRecord(value['engines']),
      relatedDependencies: workspaceDependencies(root),
    };
  } catch {
    return null;
  }
}

const MAX_WORKSPACE_MANIFESTS = 200;

/** Union of the dependencies declared by every other package.json in the workspace. */
function workspaceDependencies(root: string): string[] {
  const names: string[] = [];
  const queue: { directory: string; depth: number }[] = [{ directory: root, depth: 0 }];
  let found = 0;
  while (queue.length > 0 && found < MAX_WORKSPACE_MANIFESTS) {
    const current = queue.shift();
    if (current === undefined) {
      break;
    }
    for (const child of readEntryNames(current.directory)) {
      if (PRUNED_DIRECTORIES.has(child)) {
        continue;
      }
      const childPath = join(current.directory, child);
      if (child === 'package.json') {
        const text = readText(childPath);
        if (text === null) {
          continue;
        }
        try {
          const value = JSON.parse(text.replace(/^\uFEFF/, '')) as Record<string, unknown>;
          appendAll(names, nameList(value['dependencies']));
          appendAll(names, nameList(value['devDependencies']));
        } catch {
          continue;
        }
        found += 1;
        continue;
      }
      if (current.depth < 4) {
        queue.push({ directory: childPath, depth: current.depth + 1 });
      }
    }
  }
  return names.sort(byCodeUnit);
}

function isEnvLikeFile(relativePath: string, config: ResolvedConfig): boolean {
  return isEnvFileName(relativePath, [...config.envFiles, ...ENV_FILE_PATTERNS]);
}

/** CI environment kinds narrowed to the dialects the CI scanner understands. */
function ciEnvironmentKinds(config: ResolvedConfig): Record<string, 'dev' | 'test' | 'production' | 'local' | 'example' | 'unknown'> {
  const result: Record<string, 'dev' | 'test' | 'production' | 'local' | 'example' | 'unknown'> = {};
  for (const [name, kind] of Object.entries(config.ciEnvironmentKinds)) {
    if (kind === 'dev' || kind === 'test' || kind === 'production' || kind === 'local' || kind === 'example' || kind === 'unknown') {
      result[name] = kind;
    }
  }
  return result;
}

function buildSummary(
  findings: readonly { ruleId: string; severity: Severity; file: string }[],
  decls: readonly EnvVarDecl[],
  usages: readonly EnvUsage[],
  config: ResolvedConfig,
  filesScanned: number,
  diagnostics: number,
): ReportSummary {
  const counts: Record<Severity, number> = { error: 0, warn: 0, info: 0 };
  const byRule: Record<string, number> = {};
  const filesWithFindings = new Set<string>();
  for (const finding of findings) {
    counts[finding.severity] += 1;
    byRule[finding.ruleId] = (byRule[finding.ruleId] ?? 0) + 1;
    filesWithFindings.add(finding.file);
  }
  const names = new Set<string>([...decls.map((decl) => decl.name), ...usages.map((usage) => usage.name)]);
  let secretish = 0;
  for (const name of names) {
    if (isSecretishName(name, config.secretNamePattern)) {
      secretish += 1;
    }
  }
  return {
    error: counts.error,
    warn: counts.warn,
    info: counts.info,
    total: findings.length,
    byRule,
    variables: names.size,
    declared: new Set(decls.map((decl) => decl.name)).size,
    read: new Set(usages.map((usage) => usage.name)).size,
    secretish,
    filesScanned,
    filesWithFindings: filesWithFindings.size,
    rulesFired: Object.keys(byRule).length,
    diagnostics,
  };
}

function dotenvPathRefs(relativePath: string, text: string): InfraRef[] {
  const refs: InfraRef[] = [];
  for (const pattern of DOTENV_PATTERNS) {
    pattern.lastIndex = 0;
    let match = pattern.exec(text);
    while (match !== null) {
      const target = match[1] ?? '';
      if (target.length > 0) {
        const before = text.slice(0, match.index);
        const line = before.split('\n').length;
        const column = match.index - before.lastIndexOf('\n');
        refs.push({
          name: target,
          file: relativePath,
          line,
          column,
          kind: 'dotenv-path',
          required: true,
          refersToFile: true,
          interpolation: false,
        });
      }
      match = pattern.exec(text);
    }
  }
  return refs;
}

/** Walks the project, parses every source of truth and returns the full report. */
export async function runScan(options: ScanOptions): Promise<Report> {
  return (await runScanDetailed(options)).report;
}

/** Same as runScan but also returns the inline suppression index for command output. */
export async function runScanDetailed(options: ScanOptions): Promise<ScanResult> {
  const startedAt = Date.now();
  const root = resolve(options.root);
  const config = options.config;
  const useGitignore = options.useGitignore !== false;

  const patterns = useGitignore ? readIgnorePatterns(root, config.exclude) : [];
  const fullMatcher = createIgnoreMatcher(patterns);
  const dirMatcher: IgnoreMatcher = {
    test: (relativePath, isDirectory) => (isDirectory ? fullMatcher.test(relativePath, true) : 'not-ignored'),
  };

  const walked = await walkFiles({
    root,
    include: config.include,
    exclude: config.exclude,
    ignoreMatcher: dirMatcher,
    maxFileSizeBytes: config.maxFileSizeBytes,
    followSymlinks: config.followSymlinks,
  });

  const tracked = trackedFiles(root);
  const files: WalkedFile[] = [...walked.files];
  const skipped: SkippedFile[] = [...walked.skipped];

  const isTracked = (relativePath: string, local: boolean): boolean => {
    if (tracked !== null) {
      return tracked.has(relativePath);
    }
    return !local && fullMatcher.test(relativePath, false) === 'not-ignored';
  };

  if (tracked !== null) {
    for (const file of files) {
      if (!tracked.has(file.relativePath) && fullMatcher.test(file.relativePath, false) === 'ignored') {
        skipped.push({ file: file.relativePath, reason: 'gitignore' });
      }
    }
  }

  const decls: EnvVarDecl[] = [];
  const envFiles: EnvFileInfo[] = [];
  const diagnostics: ReportDiagnostic[] = [];
  const suppressionSources: SuppressionSource[] = [];

  for (const file of files) {
    if (!isEnvLikeFile(file.relativePath, config)) {
      continue;
    }
    const text = readText(file.absolutePath);
    if (text === null) {
      skipped.push({ file: file.relativePath, reason: 'unreadable' });
      continue;
    }
    const classification = classifyEnvFile(file.relativePath, config.exampleFiles);
    const parsed: ParsedEnvFile = parseEnvFile(file.relativePath, text, {
      kind: classification.kind,
      shared: classification.shared,
      devOnly: classification.devOnly,
    });
    const fileTracked = isTracked(file.relativePath, classification.kind === 'local');
    appendAll(decls, parsed.decls);
    envFiles.push({
      path: file.relativePath,
      kind: classification.kind,
      exists: true,
      shared: classification.shared,
      devOnly: classification.devOnly,
      tracked: fileTracked,
      committed: fileTracked,
      declCount: parsed.decls.length,
      issues: parsed.issues,
      byteSize: file.bytes,
    });
    suppressionSources.push({ path: file.relativePath, text });
    for (const diagnostic of parsed.diagnostics) {
      if (diagnostic.severity === 'error') {
        continue;
      }
      diagnostics.push({
        file: file.relativePath,
        line: diagnostic.line,
        column: diagnostic.column,
        code: diagnostic.code,
        severity: diagnostic.severity,
        message: diagnostic.message,
      });
    }
  }

  const codeFiles: WalkedFile[] = [];
  const infraRefs: InfraRef[] = [];

  for (const file of files) {
    if (isEnvLikeFile(file.relativePath, config)) {
      continue;
    }
    const text = readText(file.absolutePath);
    if (text !== null && file.bytes <= MARKER_SCAN_MAX_BYTES) {
      suppressionSources.push({ path: file.relativePath, text });
    }
    if (isDockerfile(file.relativePath)) {
      if (text !== null) {
        appendAll(infraRefs, scanDockerfile(file.relativePath, text).refs);
      }
      continue;
    }
    if (isComposeFile(file.relativePath)) {
      if (text !== null) {
        appendAll(
          infraRefs,
          scanCompose(file.relativePath, parseYaml(text), {
            envFileNames: config.envFiles,
            isOverride: false,
          }).refs,
        );
      }
      continue;
    }
    if (isCiFile(file.relativePath)) {
      if (text !== null) {
        appendAll(
          infraRefs,
          scanCi(file.relativePath, parseYaml(text), {
            defaultEnvironmentKind: 'dev',
            environmentKinds: ciEnvironmentKinds(config),
          }).refs,
        );
      }
      continue;
    }
    if (file.language !== 'unknown') {
      codeFiles.push(file);
      if (text !== null && JS_LANGUAGES.has(file.language)) {
        appendAll(infraRefs, dotenvPathRefs(file.relativePath, text));
      }
    }
  }

  const knownPaths = new Set(envFiles.map((file) => file.path));
  const knownBaseNames = new Set<string>();
  for (const path of knownPaths) {
    knownBaseNames.add(path.slice(path.lastIndexOf('/') + 1));
  }
  for (const ref of infraRefs) {
    if (!ref.refersToFile || ref.name.length === 0) {
      continue;
    }
    const directory = ref.file.slice(0, ref.file.lastIndexOf('/'));
    const resolved = resolveRelativePath(directory, ref.name);
    if (knownPaths.has(resolved) || knownBaseNames.has(ref.name)) {
      continue;
    }
    envFiles.push({
      path: resolved,
      kind: 'unknown',
      exists: false,
      shared: false,
      devOnly: true,
      tracked: false,
      committed: false,
      declCount: 0,
      issues: [],
      byteSize: 0,
    });
    knownPaths.add(resolved);
  }

  const usages = await scanCode(codeFiles);
  const manifest = readManifest(root);
  const suppressions = buildSuppressionIndex(suppressionSources);

  const base: Report = {
    tool: { name: 'envgle', version: VERSION },
    root,
    startedAt: (options.now ?? new Date(startedAt)).toISOString(),
    durationMs: 0,
    filesScanned: files.length,
    bytesScanned: walked.bytes,
    filesSkipped: skipped.length,
    skipped: skipped.sort((a, b) => byCodeUnit(a.file, b.file) || byCodeUnit(a.reason, b.reason)),
    files: envFiles.sort((a, b) => byCodeUnit(a.path, b.path)),
    decls,
    usages,
    infra: infraRefs,
    manifest,
    findings: [],
    summary: buildSummary([], decls, usages, config, files.length, diagnostics.length),
    diagnostics,
  };

  const context = buildContext({
    report: base,
    config,
    suppress: (location, ruleId) =>
      config.ignoreRules.has(ruleId) || suppressions.isSuppressed(location, ruleId),
  });
  const run = runRules(context, allRules);
  const durationMs = Math.max(0, Date.now() - startedAt);

  return {
    suppressions,
    ruleErrors: run.errors,
    report: {
      ...base,
      durationMs,
      findings: run.findings,
      summary: buildSummary(run.findings, decls, usages, config, files.length, diagnostics.length),
    },
  };
}
