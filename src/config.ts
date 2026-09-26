import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { ruleIds } from './rules/index.js';
import { appendAll, DEFAULT_SECRET_NAME_PATTERN } from './utils/text.js';
import { SEVERITIES } from './types.js';
import type {
  EnvAuditConfig,
  EnvFileKind,
  ResolvedConfig,
  RuleId,
  SecretPatternConfig,
  Severity,
} from './types.js';

export const DEFAULT_WEAK_VALUES: readonly string[] = [
  'changeme',
  'change-me',
  'change_me',
  'password',
  'passwd',
  'pwd',
  'secret',
  'admin',
  'root',
  'test',
  'testing',
  'example',
  'placeholder',
  'todo',
  'tbd',
  'fixme',
  'your-password',
  'your_password',
  'your-secret',
  'your_secret',
  'your-api-key',
  'your_api_key',
  'my-secret',
  'abc123',
  '123456',
  '12345678',
  'qwerty',
  'letmein',
  'hunter2',
  'default',
  'undefined',
  'null',
  'none',
  'empty',
  'insert-key-here',
];

export const DEFAULT_HOSTILE_NAMES: readonly string[] = [
  'LD_PRELOAD',
  'LD_LIBRARY_PATH',
  'LD_AUDIT',
  'LD_DEBUG',
  'DYLD_INSERT_LIBRARIES',
  'DYLD_LIBRARY_PATH',
  'DYLD_FRAMEWORK_PATH',
  'DYLD_ROOT_PATH',
  'NODE_OPTIONS',
  'NODE_REPL_EXTERNAL_MODULE',
  'NODE_PATH',
  'BASH_ENV',
  'ENV',
  'SHELLOPTS',
  'BASHOPTS',
  'IFS',
  'PS4',
  'PROMPT_COMMAND',
  'PERL5OPT',
  'PERL5LIB',
  'RUBYOPT',
  'RUBYLIB',
  'PYTHONSTARTUP',
  'PYTHONPATH',
  'PYTHONHOME',
  'PYTHONWARNINGS',
  'GLIBC_TUNABLES',
  'JAVA_TOOL_OPTIONS',
  '_JAVA_OPTIONS',
  'JDK_JAVA_OPTIONS',
  'CLASSPATH',
  'PATH',
];

export const DEFAULT_RESERVED_NAMES: readonly string[] = [
  'HOME',
  'USER',
  'USERNAME',
  'LOGNAME',
  'SHELL',
  'PWD',
  'OLDPWD',
  'HOSTNAME',
  'TERM',
  'LANG',
  'LC_ALL',
  'LC_CTYPE',
  'EDITOR',
  'VISUAL',
  'PAGER',
  'DISPLAY',
  'TMPDIR',
  'TEMP',
  'TMP',
  'XDG_CONFIG_HOME',
  'XDG_DATA_HOME',
  'XDG_CACHE_HOME',
  'XDG_RUNTIME_DIR',
  'SYSTEMROOT',
  'WINDIR',
  'COMSPEC',
  'PATHEXT',
  'PROGRAMFILES',
  'USERPROFILE',
  'HOMEDRIVE',
  'HOMEPATH',
  'APPDATA',
  'LOCALAPPDATA',
  'ALLUSERSPROFILE',
  'PUBLIC',
  'NUMBER_OF_PROCESSORS',
  'PROCESSOR_ARCHITECTURE',
  'PROCESSOR_IDENTIFIER',
  'OS',
  'JAVA_HOME',
  'GOPATH',
  'GOROOT',
  'VIRTUAL_ENV',
  'CONDA_PREFIX',
  'GEM_HOME',
  'CARGO_HOME',
];

export const DEFAULT_EXAMPLE_FILES: readonly string[] = [
  '.env.example',
  '.env.sample',
  '.env.template',
  '.env.dist',
  'env.example',
  'env.sample',
  'env.template',
  'env.dist',
  '*.env.example',
  '*.env.sample',
  '*.env.template',
  '*.env.dist',
  '**/.env.example',
  '**/.env.sample',
  '**/.env.template',
  '**/.env.dist',
];

export const DEFAULT_CI_ENVIRONMENT_KINDS: Readonly<Record<string, EnvFileKind>> = {
  production: 'production',
  prod: 'production',
  staging: 'production',
  preview: 'production',
  development: 'dev',
  dev: 'dev',
  test: 'test',
  testing: 'test',
  qa: 'test',
  ci: 'test',
};

const CONFIG_FILE_NAMES: readonly string[] = ['.envglerc.json', 'envgle.config.json'];

const KNOWN_KEYS: ReadonlySet<string> = new Set([
  '$schema',
  'include',
  'exclude',
  'envFiles',
  'exampleFiles',
  'ignoreRules',
  'ignoreVariables',
  'ignoreFingerprints',
  'severities',
  'weakValues',
  'hostileNames',
  'reservedNames',
  'secretPatterns',
  'secretNamePattern',
  'maxFileSizeKb',
  'maxLineLength',
  'ciEnvironmentKinds',
  'failOn',
  'codeFrameLines',
  'followSymlinks',
  'requireExampleFile',
]);

export interface LoadConfigOptions {
  readonly root: string;
  /** Explicit path from `--config`; when present no discovery happens. */
  readonly configPath?: string | undefined;
  /** CLI overrides applied on top of the file configuration. */
  readonly overrides?: Partial<EnvAuditConfig> | undefined;
}

export interface ConfigDiscovery {
  readonly path: string | null;
  readonly warnings: readonly string[];
}

/** Removes `//` and block comments outside strings so a config file may be annotated. */
export function stripJsonComments(text: string): string {
  let output = '';
  let index = 0;
  let inString = false;
  let escaped = false;
  while (index < text.length) {
    const char = text.charAt(index);
    const next = text.charAt(index + 1);
    if (inString) {
      output += char;
      if (escaped) {
        escaped = false;
      } else if (char === '\\') {
        escaped = true;
      } else if (char === '"') {
        inString = false;
      }
      index += 1;
      continue;
    }
    if (char === '"') {
      inString = true;
      output += char;
      index += 1;
      continue;
    }
    if (char === '/' && next === '/') {
      while (index < text.length && text.charAt(index) !== '\n') {
        index += 1;
      }
      continue;
    }
    if (char === '/' && next === '*') {
      index += 2;
      while (index < text.length && !(text.charAt(index) === '*' && text.charAt(index + 1) === '/')) {
        index += 1;
      }
      index += 2;
      continue;
    }
    output += char;
    index += 1;
  }
  return output;
}

/** Finds the nearest configuration file, searching upward from `root`. */
export function discoverConfig(root: string): ConfigDiscovery {
  const warnings: string[] = [];
  let directory = resolve(root);
  for (;;) {
    const manifestPath = join(directory, 'package.json');
    if (existsSync(manifestPath)) {
      const value = readJson(manifestPath, warnings);
      if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
        const section = (value as Record<string, unknown>)['envgle'];
        if (section !== undefined) {
          return { path: manifestPath, warnings };
        }
      }
    }
    for (const name of CONFIG_FILE_NAMES) {
      const candidate = join(directory, name);
      if (existsSync(candidate)) {
        return { path: candidate, warnings };
      }
    }
    const parent = dirname(directory);
    if (parent === directory) {
      return { path: null, warnings };
    }
    directory = parent;
  }
}

function readJson(path: string, warnings: string[]): unknown {
  try {
    const raw = readFileSync(path, 'utf8').replace(/^\uFEFF/, '');
    return JSON.parse(stripJsonComments(raw)) as unknown;
  } catch (error) {
    warnings.push(`${path}: ${error instanceof Error ? error.message : String(error)}`);
    return null;
  }
}

function asStringArray(value: unknown, field: string, warnings: string[]): string[] {
  if (value === undefined) {
    return [];
  }
  if (!Array.isArray(value)) {
    warnings.push(`"${field}" must be an array of strings`);
    return [];
  }
  const result: string[] = [];
  for (const entry of value) {
    if (typeof entry === 'string') {
      result.push(entry);
    } else {
      warnings.push(`"${field}" contains a non-string entry`);
    }
  }
  return result;
}

function asPositiveNumber(value: unknown, field: string, fallback: number, warnings: string[]): number {
  if (value === undefined) {
    return fallback;
  }
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    warnings.push(`"${field}" must be a positive number`);
    return fallback;
  }
  return value;
}

function asSeverity(value: unknown, field: string, warnings: string[]): Severity {
  if (value === 'error' || value === 'warn' || value === 'info') {
    return value;
  }
  warnings.push(`"${field}" must be one of error, warn, info`);
  return 'error';
}

function asSeverityMap(value: unknown, warnings: string[]): Partial<Record<RuleId, Severity>> {
  const result: Partial<Record<RuleId, Severity>> = {};
  if (value === undefined) {
    return result;
  }  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    warnings.push('"severities" must be an object mapping rule ids to severities');
    return result;
  }
  const known = new Set<string>(ruleIds());
  for (const [id, severity] of Object.entries(value as Record<string, unknown>)) {
    if (!known.has(id)) {
      warnings.push(`"severities" references unknown rule id "${id}"`);
      continue;
    }
    if (severity !== 'error' && severity !== 'warn' && severity !== 'info') {
      warnings.push(`"severities.${id}" must be one of error, warn, info`);
      continue;
    }
    result[id as RuleId] = severity;
  }
  return result;
}

function asSecretPatterns(value: unknown, warnings: string[]): SecretPatternConfig[] {
  if (value === undefined) {
    return [];
  }
  if (!Array.isArray(value)) {
    warnings.push('"secretPatterns" must be an array of objects');
    return [];
  }
  const result: SecretPatternConfig[] = [];
  for (const entry of value) {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      warnings.push('"secretPatterns" contains a non-object entry');
      continue;
    }
    const record = entry as Record<string, unknown>;
    const id = typeof record['id'] === 'string' ? record['id'] : undefined;
    const name = typeof record['name'] === 'string' ? record['name'] : undefined;
    const pattern = typeof record['pattern'] === 'string' ? record['pattern'] : undefined;
    if (id === undefined || name === undefined || pattern === undefined) {
      warnings.push('each "secretPatterns" entry needs string id, name and pattern fields');
      continue;
    }
    try {
      // eslint-disable-next-line no-new
      new RegExp(pattern);
    } catch {
      warnings.push(`secret pattern "${id}" is not a valid regular expression and was dropped`);
      continue;
    }
    const test = typeof record['test'] === 'string' ? record['test'] : undefined;
    if (test !== undefined && !new RegExp(pattern).test(test)) {
      warnings.push(`secret pattern "${id}" does not match its own "test" sample and was dropped`);
      continue;
    }
    result.push({
      id,
      name,
      pattern,
      ...(test === undefined ? {} : { test }),
      ...(typeof record['secretish'] === 'boolean' ? { secretish: record['secretish'] } : {}),
    });
  }
  return result;
}

function asEnvironmentKinds(value: unknown, warnings: string[]): Record<string, EnvFileKind> {
  const result: Record<string, EnvFileKind> = {};
  if (value === undefined) {
    return result;
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    warnings.push('"ciEnvironmentKinds" must be an object');
    return result;
  }
  const kinds: readonly EnvFileKind[] = ['dev', 'test', 'production', 'local', 'example', 'template', 'unknown'];
  for (const [name, kind] of Object.entries(value as Record<string, unknown>)) {
    if (typeof kind === 'string' && (kinds as readonly string[]).includes(kind)) {
      result[name] = kind as EnvFileKind;
    } else {
      warnings.push(`"ciEnvironmentKinds.${name}" is not a valid env file kind`);
    }
  }
  return result;
}

function mergeConfig(base: EnvAuditConfig, extra: Partial<EnvAuditConfig>): EnvAuditConfig {
  const merged: EnvAuditConfig = { ...base };
  for (const [key, value] of Object.entries(extra)) {
    if (value === undefined) {
      continue;
    }
    switch (key) {
      case 'ignoreRules':
      case 'ignoreVariables':
      case 'ignoreFingerprints':
      case 'weakValues':
      case 'hostileNames':
      case 'reservedNames':
      case 'include':
      case 'exclude':
      case 'envFiles':
      case 'exampleFiles':
        if (Array.isArray(value)) {
          const current = (merged as Record<string, unknown>)[key];
          (merged as Record<string, unknown>)[key] = Array.isArray(current)
            ? [...current, ...(value as string[])]
            : (value as string[]);
        }
        break;
      case 'severities':
        merged.severities = { ...merged.severities, ...(value as Partial<Record<RuleId, Severity>>) };
        break;
      default:
        (merged as Record<string, unknown>)[key] = value;
        break;
    }
  }
  return merged;
}

/** Loads, validates and resolves the effective configuration; never throws. */
export function loadConfig(options: LoadConfigOptions): ResolvedConfig {
  const warnings: string[] = [];
  let fileConfig: EnvAuditConfig = {};
  let source: string | null = null;

  if (options.configPath !== undefined) {
    const explicit = resolve(options.configPath);
    if (!existsSync(explicit)) {
      warnings.push(`config file not found: ${explicit}`);
    } else {
      const value = readJson(explicit, warnings);
      if (value !== null) {
        source = explicit;
        if (typeof value === 'object' && !Array.isArray(value)) {
          fileConfig = value as EnvAuditConfig;
        } else {
          warnings.push(`${explicit}: expected a JSON object`);
        }
      }
    }
  } else {
    const discovery = discoverConfig(options.root);
    appendAll(warnings, discovery.warnings);
    if (discovery.path !== null) {
      source = discovery.path;
      const value = readJson(discovery.path, warnings);
      if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
        const record = value as Record<string, unknown>;
        fileConfig =
          discovery.path.endsWith('package.json')
            ? ((record['envgle'] ?? {}) as EnvAuditConfig)
            : (record as EnvAuditConfig);
      } else if (discovery.path.endsWith('package.json')) {
        fileConfig = {};
      } else {
        warnings.push(`${discovery.path}: expected a JSON object`);
      }
    }
  }

  const merged = mergeConfig({ ...fileConfig }, options.overrides ?? {});

  for (const key of Object.keys(merged)) {
    if (!KNOWN_KEYS.has(key)) {
      warnings.push(`unknown configuration key "${key}"`);
    }
  }

  const knownRules = new Set<string>(ruleIds());
  const ignoreRules: RuleId[] = [];
  for (const entry of asStringArray(merged.ignoreRules, 'ignoreRules', warnings)) {
    if (knownRules.has(entry)) {
      ignoreRules.push(entry as RuleId);
    } else {
      warnings.push(`"ignoreRules" references unknown rule id "${entry}"`);
    }
  }

  let secretNamePattern = DEFAULT_SECRET_NAME_PATTERN;
  if (merged.secretNamePattern !== undefined) {
    if (typeof merged.secretNamePattern !== 'string') {
      warnings.push('"secretNamePattern" must be a string');
    } else {
      try {
        // eslint-disable-next-line no-new
        new RegExp(merged.secretNamePattern, 'i');
        secretNamePattern = merged.secretNamePattern;
      } catch {
        warnings.push('"secretNamePattern" is not a valid regular expression, using the default');
      }
    }
  }

  let failOn: Severity = 'error';
  if (merged.failOn !== undefined) {
    failOn = asSeverity(merged.failOn, 'failOn', warnings);
  }

  const exampleFiles = [...DEFAULT_EXAMPLE_FILES, ...asStringArray(merged.exampleFiles, 'exampleFiles', warnings)];

  return {
    include: asStringArray(merged.include, 'include', warnings),
    exclude: asStringArray(merged.exclude, 'exclude', warnings),
    envFiles: asStringArray(merged.envFiles, 'envFiles', warnings),
    exampleFiles,
    ignoreRules: new Set(ignoreRules),
    ignoreVariables: asStringArray(merged.ignoreVariables, 'ignoreVariables', warnings),
    ignoreFingerprints: new Set(
      asStringArray(merged.ignoreFingerprints, 'ignoreFingerprints', warnings).map((value) =>
        value.toLowerCase(),
      ),
    ),
    severities: asSeverityMap(merged.severities, warnings),
    weakValues: new Set(
      [...DEFAULT_WEAK_VALUES, ...asStringArray(merged.weakValues, 'weakValues', warnings)].map((value) =>
        value.toLowerCase(),
      ),
    ),
    hostileNames: new Set([
      ...DEFAULT_HOSTILE_NAMES,
      ...asStringArray(merged.hostileNames, 'hostileNames', warnings),
    ]),
    reservedNames: new Set([
      ...DEFAULT_RESERVED_NAMES,
      ...asStringArray(merged.reservedNames, 'reservedNames', warnings),
    ]),
    secretPatterns: asSecretPatterns(merged.secretPatterns, warnings),
    secretNamePattern,
    maxFileSizeBytes: Math.round(
      asPositiveNumber(merged.maxFileSizeKb, 'maxFileSizeKb', 64, warnings) * 1024,
    ),
    maxLineLength: asPositiveNumber(merged.maxLineLength, 'maxLineLength', 2000, warnings),
    ciEnvironmentKinds: { ...DEFAULT_CI_ENVIRONMENT_KINDS, ...asEnvironmentKinds(merged.ciEnvironmentKinds, warnings) },
    failOn,
    codeFrameLines: asPositiveNumber(merged.codeFrameLines, 'codeFrameLines', 2, warnings),
    followSymlinks: merged.followSymlinks === undefined ? false : Boolean(merged.followSymlinks),
    requireExampleFile: merged.requireExampleFile === undefined ? true : Boolean(merged.requireExampleFile),
    source,
    warnings,
  };
}

export const SEVERITY_VALUES = SEVERITIES;
