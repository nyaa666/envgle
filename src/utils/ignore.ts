import { escapeRegExp, toPosix } from './text.js';

export type IgnoreResult = 'ignored' | 'not-ignored';

export interface IgnoreMatcher {
  /** Last matching pattern decides, so `!` negation and later rules win. */
  test(relativePath: string, isDirectory: boolean): IgnoreResult;
}

interface IgnoreRule {
  readonly negated: boolean;
  readonly dirOnly: boolean;
  readonly matcher: RegExp;
}

interface CompiledSegment {
  readonly source: string;
  readonly next: number;
}

const GLOBSTAR = '**';

const splitSegments = (glob: string): string[] => {
  const parts: string[] = [];
  let current = '';
  let index = 0;
  while (index < glob.length) {
    const char = glob[index] ?? '';
    if (char === '\\') {
      current += char;
      const next = glob[index + 1];
      if (next === undefined) {
        index += 1;
        continue;
      }
      current += next;
      index += 2;
      continue;
    }
    if (char === '/') {
      parts.push(current);
      current = '';
      index += 1;
      continue;
    }
    current += char;
    index += 1;
  }
  parts.push(current);
  return parts;
};

const compileCharClass = (segment: string, start: number): CompiledSegment | null => {
  let index = start + 1;
  let body = '';
  if (segment[index] === '!' || segment[index] === '^') {
    body += '^';
    index += 1;
  }
  if (segment[index] === ']') {
    body += '\\]';
    index += 1;
  }
  let closed = false;
  while (index < segment.length) {
    const char = segment[index] ?? '';
    if (char === ']') {
      closed = true;
      index += 1;
      break;
    }
    if (char === '\\') {
      const next = segment[index + 1];
      if (next === undefined) {
        index += 1;
        continue;
      }
      body += next === '-' ? '\\-' : escapeRegExp(next);
      index += 2;
      continue;
    }
    body += char;
    index += 1;
  }
  if (!closed) {
    return null;
  }
  return { source: `[${body}]`, next: index };
};

const compileSegment = (segment: string): string => {
  let source = '';
  let index = 0;
  while (index < segment.length) {
    const char = segment[index] ?? '';
    if (char === '\\') {
      const next = segment[index + 1];
      source += next === undefined ? '\\\\' : escapeRegExp(next);
      index += next === undefined ? 1 : 2;
      continue;
    }
    if (char === '*') {
      source += '[^/]*';
      index += 1;
      continue;
    }
    if (char === '?') {
      source += '[^/]';
      index += 1;
      continue;
    }
    if (char === '[') {
      const compiled = compileCharClass(segment, index);
      if (compiled !== null) {
        source += compiled.source;
        index = compiled.next;
        continue;
      }
      source += '\\[';
      index += 1;
      continue;
    }
    source += escapeRegExp(char);
    index += 1;
  }
  return source;
};

const compileGlob = (parts: readonly string[]): string => {
  if (parts.length === 1 && parts[0] === GLOBSTAR) {
    return '.*';
  }
  let source = '';
  let needsSeparator = false;
  for (let index = 0; index < parts.length; index += 1) {
    const part = parts[index] ?? '';
    const isLast = index === parts.length - 1;
    if (part === GLOBSTAR) {
      if (needsSeparator) {
        source += '/';
        needsSeparator = false;
      }
      source += isLast ? '.*' : '(?:[^/]+/)*';
      continue;
    }
    if (needsSeparator) {
      source += '/';
      needsSeparator = false;
    }
    source += compileSegment(part);
    needsSeparator = !isLast;
  }
  return source;
};

const compileRule = (pattern: string): IgnoreRule | null => {
  const line = pattern
    .replace(/^\uFEFF/, '')
    .replace(/[\r\n]+$/, '')
    .replace(/(?<!\\)[ \t]+$/, '');
  if (line === '') {
    return null;
  }
  let negated = false;
  let body = line;
  if (body.startsWith('!')) {
    negated = true;
    body = body.slice(1);
  } else if (body.startsWith('#')) {
    return null;
  }
  let dirOnly = false;
  if (body.endsWith('/')) {
    dirOnly = true;
    body = body.replace(/\/+$/, '');
  }
  const anchored = body.includes('/');
  if (body.startsWith('/')) {
    body = body.replace(/^\/+/, '');
  }
  if (body === '') {
    return null;
  }
  const parts = splitSegments(body).filter((part) => part !== '');
  if (parts.length === 0) {
    return null;
  }
  const prefix = anchored ? '' : '(?:.*/)?';
  try {
    return { negated, dirOnly, matcher: new RegExp(`^${prefix}${compileGlob(parts)}$`) };
  } catch {
    return null;
  }
};

const normalisePath = (input: string): string => {
  if (input === '') {
    return '';
  }
  const cleaned: string[] = [];
  for (const segment of toPosix(input).split('/')) {
    if (segment === '' || segment === '.') {
      continue;
    }
    cleaned.push(segment);
  }
  return cleaned.join('/');
};

const ancestorPrefixes = (normalisedPath: string): string[] => {
  const segments = normalisedPath.split('/');
  const prefixes: string[] = [];
  for (let index = 1; index < segments.length; index += 1) {
    prefixes.push(segments.slice(0, index).join('/'));
  }
  return prefixes;
};

/**
 * Faithful .gitignore matcher: comments, `!` negation, trailing-`/` directory rules, root
 * anchoring, `**` spans and `*`/`?`/character classes, with the last matching pattern winning.
 * Like git, a negation cannot re-include a file whose ancestor directory is ignored.
 */
export const createIgnoreMatcher = (patterns: readonly string[]): IgnoreMatcher => {
  const rules: IgnoreRule[] = [];
  for (const pattern of patterns) {
    const rule = compileRule(pattern);
    if (rule !== null) {
      rules.push(rule);
    }
  }
  const decide = (normalisedPath: string, isDirectory: boolean): IgnoreResult => {
    let result: IgnoreResult = 'not-ignored';
    for (const rule of rules) {
      if (rule.dirOnly && !isDirectory) {
        continue;
      }
      if (!rule.matcher.test(normalisedPath)) {
        continue;
      }
      result = rule.negated ? 'not-ignored' : 'ignored';
    }
    return result;
  };
  return {
    test: (relativePath: string, isDirectory: boolean): IgnoreResult => {
      const normalisedPath = normalisePath(relativePath);
      if (normalisedPath === '') {
        return 'not-ignored';
      }
      for (const prefix of ancestorPrefixes(normalisedPath)) {
        if (decide(prefix, true) === 'ignored') {
          return 'ignored';
        }
      }
      return decide(normalisedPath, isDirectory);
    },
  };
};
