import { createHash } from 'node:crypto';

/** Default pattern for "this variable name smells like a secret". */
export const DEFAULT_SECRET_NAME_PATTERN =
  '(SECRET|TOKEN|PASSWORD|PASSWD|PWD|API_?KEY|PRIVATE_?KEY|ACCESS_?KEY|CREDENTIAL|AUTH_?KEY|SESSION_?KEY|CLIENT_?SECRET|ENCRYPTION|SALT|CERT_?KEY|SIGNING_?KEY|INTERNAL_?(SIGNING_)?KEY|DATABASE_?URL|DSN)';

export interface LineColumn {
  readonly line: number;
  readonly column: number;
}

export function toPosix(input: string): string {
  return input.replace(/\\/g, '/');
}

export function relativePosix(root: string, absolute: string): string {
  const normalizedRoot = toPosix(root).replace(/\/+$/, '');
  const normalized = toPosix(absolute);
  if (normalized.startsWith(normalizedRoot)) {
    const rest = normalized.slice(normalizedRoot.length);
    return rest.replace(/^\/+/, '');
  }
  return normalized;
}

/** Resolves a referenced path against a directory, collapsing `.` and `..` without touching the disk. */
export function resolveRelativePath(fromDirectory: string, reference: string): string {
  const parts = (fromDirectory === '' ? [] : fromDirectory.split('/')).concat(reference.split(/[\\/]/));
  const output: string[] = [];
  for (const part of parts) {
    if (part === '' || part === '.') {
      continue;
    }
    if (part === '..') {
      output.pop();
      continue;
    }
    output.push(part);
  }
  return output.join('/');
}

export function offsetToLineColumn(text: string, offset: number): LineColumn {
  const clamped = Math.max(0, Math.min(offset, text.length));
  let line = 1;
  let lastBreak = -1;
  for (let index = 0; index < clamped; index += 1) {
    if (text.charCodeAt(index) === 10) {
      line += 1;
      lastBreak = index;
    }
  }
  return { line, column: clamped - lastBreak };
}

export function lineOfOffset(text: string, offset: number): number {
  return offsetToLineColumn(text, offset).line;
}

export function lineText(text: string, line: number): string {
  const lines = text.split('\n');
  const index = line - 1;
  if (index < 0 || index >= lines.length) {
    return '';
  }
  return (lines[index] ?? '').replace(/\r$/, '');
}

export function countLines(text: string): number {
  if (text.length === 0) {
    return 0;
  }
  return text.split('\n').length;
}

export function fingerprint(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex').slice(0, 12);
}

export function shannonEntropy(value: string): number {
  if (value.length === 0) {
    return 0;
  }
  const counts = new Map<string, number>();
  for (const char of value) {
    counts.set(char, (counts.get(char) ?? 0) + 1);
  }
  let entropy = 0;
  for (const count of counts.values()) {
    const probability = count / value.length;
    entropy -= probability * Math.log2(probability);
  }
  return entropy;
}

export function isSecretishName(name: string, pattern: string = DEFAULT_SECRET_NAME_PATTERN): boolean {
  return new RegExp(pattern, 'i').test(name);
}

/** Single-line, length-capped, safe-to-print representation of a value. */
export function previewValue(value: string, options: { secretish: boolean; maxLength?: number }): string {
  const maxLength = options.maxLength ?? 48;
  if (options.secretish && value.length > 0) {
    return '<redacted>';
  }
  const flattened = value.replace(/\r?\n/g, '\\n');
  if (flattened.length <= maxLength) {
    return flattened;
  }
  return `${flattened.slice(0, maxLength - 1)}\u2026`;
}

export function maskSecret(value: string): string {
  if (value.length === 0) {
    return '<empty>';
  }
  if (value.length <= 8) {
    return '*'.repeat(value.length);
  }
  return `${'*'.repeat(3)}${value.slice(-2)}`;
}

export function escapeRegExp(input: string): string {
  return input.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

const GLOB_CACHE_LIMIT = 512;

const GLOB_CACHE: Map<string, RegExp> = new Map();

/** Only stateless patterns are shared: a sticky or global one carries `lastIndex` between calls. */
const cacheable = (flags: string): boolean => !flags.includes('g') && !flags.includes('y');

const cacheKey = (glob: string, flags: string): string => `${flags}\u0000${glob}`;

/** Glob supporting `*` (no slash), `**` (any depth), `?` and `{a,b}` alternation. */
export function globToRegExp(glob: string, flags = ''): RegExp {
  const key = cacheable(flags) ? cacheKey(glob, flags) : '';
  if (key !== '') {
    const cached = GLOB_CACHE.get(key);
    if (cached !== undefined) {
      return cached;
    }
  }
  let source = '';
  let index = 0;
  while (index < glob.length) {
    const char = glob[index] ?? '';
    if (char === '*') {
      if (glob[index + 1] === '*') {
        const isSlashThenStar = glob[index + 2] === '/';
        source += isSlashThenStar ? '(?:.*/)?' : '.*';
        index += isSlashThenStar ? 3 : 2;
        continue;
      }
      source += '[^/]*';
      index += 1;
      continue;
    }
    if (char === '?') {
      source += '[^/]';
      index += 1;
      continue;
    }
    if (char === '{') {
      const close = glob.indexOf('}', index);
      if (close > index) {
        const body = glob
          .slice(index + 1, close)
          .split(',')
          .map((part) => escapeRegExp(part))
          .join('|');
        source += `(?:${body})`;
        index = close + 1;
        continue;
      }
    }
    source += escapeRegExp(char);
    index += 1;
  }
  const compiled = new RegExp(`^${source}$`, flags);
  if (key === '') {
    return compiled;
  }
  if (GLOB_CACHE.size >= GLOB_CACHE_LIMIT) {
    GLOB_CACHE.clear();
  }
  GLOB_CACHE.set(key, compiled);
  return compiled;
}

export function matchGlob(value: string, glob: string, caseInsensitive = false): boolean {
  return globToRegExp(glob, caseInsensitive ? 'i' : '').test(value);
}

export function matchAnyGlob(value: string, globs: readonly string[], caseInsensitive = false): boolean {
  return globs.some((glob) => matchGlob(value, glob, caseInsensitive));
}

export function unique<T>(values: readonly T[]): T[] {
  return [...new Set(values)];
}

/**
 * `target.push(...items)` without the engine's argument-count limit: spreading a
 * hundred thousand elements into a call overflows the stack, and a repository
 * with a large generated compose file or env file really does produce that many.
 */
export function appendAll<T>(target: T[], items: Iterable<T>): T[] {
  for (const item of items) {
    target.push(item);
  }
  return target;
}

export function groupBy<T, K>(values: readonly T[], key: (value: T) => K): Map<K, T[]> {
  const groups = new Map<K, T[]>();
  for (const value of values) {
    const bucket = key(value);
    const existing = groups.get(bucket);
    if (existing) {
      existing.push(value);
    } else {
      groups.set(bucket, [value]);
    }
  }
  return groups;
}

export function sortedUnique(values: readonly string[]): string[] {
  return unique(values).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

export function stableStringify(value: unknown, indent = 2): string {
  return JSON.stringify(sortValue(value), null, indent);
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortValue);
  }
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return Object.fromEntries(entries.map(([key, item]) => [key, sortValue(item)]));
  }
  return value;
}

export function truncate(value: string, maxLength: number): string {
  if (value.length <= maxLength) {
    return value;
  }
  return `${value.slice(0, Math.max(0, maxLength - 1))}\u2026`;
}

/** One `${NAME}`, `${NAME:-default}` reference found by findBracedVariables. */
export interface BracedVariable {
  /** 0-based offset of the `$` that opens the reference. */
  readonly start: number;
  /** 0-based offset just past the closing `}`. */
  readonly end: number;
  readonly name: string;
}

const BRACED_BODY_LIMIT = 4096;
const DOLLAR_CODE = 0x24;
const DASH_CODE = 0x2d;
const PLUS_CODE = 0x2b;
const COLON_CODE = 0x3a;
const QUESTION_CODE = 0x3f;
const ZERO_CODE = 0x30;
const NINE_CODE = 0x39;
const OPEN_BRACE_CODE = 0x7b;
const CLOSE_BRACE_CODE = 0x7d;
const UNDERSCORE_CODE = 0x5f;
const UPPER_A_CODE = 0x41;
const UPPER_Z_CODE = 0x5a;
const LOWER_A_CODE = 0x61;
const LOWER_Z_CODE = 0x7a;

const isBracedNameStart = (code: number): boolean =>
  (code >= UPPER_A_CODE && code <= UPPER_Z_CODE) || (code >= LOWER_A_CODE && code <= LOWER_Z_CODE) || code === UNDERSCORE_CODE;

const isBracedNamePart = (code: number): boolean => isBracedNameStart(code) || (code >= ZERO_CODE && code <= NINE_CODE);

const isBracedOperatorStart = (code: number): boolean =>
  code === DASH_CODE || code === QUESTION_CODE || code === PLUS_CODE || code === COLON_CODE;

const nextBraceFrom = (text: string, from: number, to: number): number => {
  const found = text.indexOf('}', from);
  return found === -1 || found >= to ? -1 : found;
};

/**
 * Every `${NAME}`, `${NAME:-default}`, `${NAME:?msg}` reference in `text[from, to)`, in order.
 *
 * A single regular expression cannot do this in linear time: the default body
 * `[^}]{0,4096}` backtracks 4096 times for every `${` that has no closing brace
 * within reach, which turns a malformed 60 KB Dockerfile into half a second of
 * CPU. This scan looks the closing brace up directly instead, so the whole pass
 * stays linear no matter how the input is shaped.
 */
export function findBracedVariables(text: string, from = 0, to = text.length): readonly BracedVariable[] {
  const end = Math.min(Math.max(0, to), text.length);
  const hits: BracedVariable[] = [];
  let index = Math.max(0, from);
  let brace = nextBraceFrom(text, index, end);
  while (index < end) {
    if (text.charCodeAt(index) !== DOLLAR_CODE || text.charCodeAt(index + 1) !== OPEN_BRACE_CODE) {
      index += 1;
      continue;
    }
    const nameStart = index + 2;
    let nameEnd = nameStart;
    while (nameEnd < end && isBracedNamePart(text.charCodeAt(nameEnd))) {
      nameEnd += 1;
    }
    const named = nameEnd > nameStart && isBracedNameStart(text.charCodeAt(nameStart));
    const close = named ? bracedCloseAt(text, nameEnd, end, brace) : -1;
    if (close === -1) {
      index += 1;
      if (brace !== -1 && brace < index) {
        brace = nextBraceFrom(text, index, end);
      }
      continue;
    }
    hits.push({ start: index, end: close + 1, name: text.slice(nameStart, nameEnd) });
    index = close + 1;
    if (brace !== -1 && brace <= close) {
      brace = nextBraceFrom(text, index, end);
    }
  }
  return hits;
}

/** Index of the `}` that closes the reference whose name ends at `nameEnd`, or -1. */
const bracedCloseAt = (text: string, nameEnd: number, end: number, brace: number): number => {
  if (nameEnd >= end) {
    return -1;
  }
  const code = text.charCodeAt(nameEnd);
  if (code === CLOSE_BRACE_CODE) {
    return nameEnd;
  }
  if (!isBracedOperatorStart(code)) {
    return -1;
  }
  if (brace === -1) {
    return -1;
  }
  const first = nameEnd + 1;
  const widened = code === COLON_CODE && first < end && isBracedOperatorStart(text.charCodeAt(first)) ? first + 1 : -1;
  if (widened !== -1 && brace >= widened && brace - widened <= BRACED_BODY_LIMIT) {
    return brace;
  }
  return brace >= first && brace - first <= BRACED_BODY_LIMIT ? brace : -1;
};

export function isProbablyBinary(buffer: Uint8Array): boolean {
  const sample = buffer.subarray(0, Math.min(buffer.length, 8000));
  let suspicious = 0;
  for (const byte of sample) {
    if (byte === 0) {
      return true;
    }
    if (byte < 7 || (byte > 14 && byte < 32)) {
      suspicious += 1;
    }
  }
  return sample.length > 0 && suspicious / sample.length > 0.3;
}

export function hasControlCharacters(value: string): boolean {
  return /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(value);
}

export function isEnvVarName(value: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(value);
}

export function isUpperSnakeCase(value: string): boolean {
  return /^[A-Z][A-Z0-9_]*$/.test(value);
}

export function pluralRules(count: number): string {
  return count === 1 ? '1 rule' : `${count} rules`;
}
