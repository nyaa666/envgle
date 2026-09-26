import type { InfraRef } from '../types.js';
import type { YamlDocument, YamlLine } from './yaml.js';
import { findBracedVariables, unique } from '../utils/text.js';

export interface CiScanOptions {
  readonly defaultEnvironmentKind: 'dev' | 'test' | 'production';
  readonly environmentKinds: Readonly<Record<string, 'dev' | 'test' | 'production' | 'local' | 'example' | 'unknown'>>;
}

export interface CiScanResult {
  readonly refs: readonly InfraRef[];
  readonly secrets: readonly InfraRef[];
  readonly vars: readonly InfraRef[];
  readonly environments: readonly string[];
  readonly referencedEnvFiles: readonly InfraRef[];
}

type CiDialect = 'github' | 'gitlab' | 'azure' | 'circleci' | 'unknown';

interface Entry {
  readonly line: YamlLine;
  readonly key: string | null;
  readonly keyStart: number;
  readonly value: string;
  readonly valueStart: number;
  readonly children: readonly Entry[];
}

interface ParsedEntry {
  readonly key: string | null;
  readonly keyStart: number;
  readonly value: string;
  readonly valueStart: number;
}

interface PatternEntry {
  readonly pattern: RegExp;
  /** Characters between the match start and the variable name. */
  readonly nameOffset: number;
  readonly kind: InfraRef['kind'];
  readonly required: boolean;
}

interface Found {
  readonly start: number;
  readonly end: number;
  readonly name: string;
  readonly nameOffset: number;
  readonly kind: InfraRef['kind'];
  readonly required: boolean;
}

const GITHUB_WORKFLOW = /(?:^|\/)\.github\/workflows\/[^/.][^/]*\.ya?ml$/;
const GITHUB_ACTION = /(?:^|\/)\.github\/actions\/(?:[^/]+\/)*action\.ya?ml$/;
const GITLAB_FRAGMENT = /(?:^|\/)\.gitlab\/ci\/[^/.][^/]*\.yml$/;
const AZURE_PIPELINES = /^azure-pipelines\.ya?ml$/;
const COMPOSE_LIKE = /(?:^|[-._])compose(?:[-._]|$)/i;
const GITLAB_CONFIG = '.gitlab-ci.yml';
const CIRCLECI_CONFIG = /(?:^|\/)\.circleci\/config\.yml$/;
const GITLAB_SCRIPT_KEYS: ReadonlySet<string> = new Set([
  'script',
  'before_script',
  'after_script',
  'entrypoint',
  'variables',
]);
const MAX_NESTING = 64;
const ENV_BLOCK_KEY = 'env';

const GITHUB_PATTERNS: readonly PatternEntry[] = [
  { pattern: /(?<![\w./-])secrets\.([A-Za-z_][A-Za-z0-9_]*)/g, nameOffset: 8, kind: 'ci-secret', required: true },
  { pattern: /(?<![\w./-])vars\.([A-Za-z_][A-Za-z0-9_]*)/g, nameOffset: 5, kind: 'ci-var', required: false },
  { pattern: /(?<![\w./-])env\.([A-Za-z_][A-Za-z0-9_]*)/g, nameOffset: 4, kind: 'ci-env-usage', required: false },
];

const SHELL_PATTERNS: readonly PatternEntry[] = [
  { pattern: /(?<![$\\])\$([A-Za-z_][A-Za-z0-9_]*)/g, nameOffset: 1, kind: 'ci-env-usage', required: false },
];

const AZURE_PATTERNS: readonly PatternEntry[] = [
  { pattern: /\$\(([A-Za-z_][A-Za-z0-9_]*)\)/g, nameOffset: 2, kind: 'ci-env-usage', required: false },
  { pattern: /(?<![\w./-])variables\.([A-Za-z_][A-Za-z0-9_]*)/g, nameOffset: 10, kind: 'ci-env-usage', required: false },
  { pattern: /(?<![\w./-])env\.([A-Za-z_][A-Za-z0-9_]*)/g, nameOffset: 4, kind: 'ci-env-usage', required: false },
];

const compareText = (left: string, right: string): number => (left < right ? -1 : left > right ? 1 : 0);

/** True for GitHub Actions, GitLab CI, Azure Pipelines and CircleCI config paths, and for nothing else. */
export const isCiFile = (relativePath: string): boolean => dialectOf(relativePath) !== 'unknown';

/** Scans one CI document by dialect: env declarations, secrets, vars, environment names and interpolations. */
export const scanCi = (
  relativePath: string,
  document: YamlDocument,
  _options: CiScanOptions,
): CiScanResult => {
  const refs: InfraRef[] = [];
  const environments: string[] = [];
  const lines = document.lines;
  const dialect = dialectOf(relativePath);
  if (dialect === 'github') {
    scanGithub(relativePath, lines, refs, environments);
  } else if (dialect === 'gitlab') {
    scanGitlab(relativePath, lines, refs);
  } else if (dialect === 'azure') {
    scanAzure(relativePath, lines, refs);
  } else if (dialect === 'circleci') {
    scanCircleci(relativePath, lines, refs);
  }
  refs.sort(byPosition);
  return {
    refs,
    secrets: refs.filter((ref) => ref.kind === 'ci-secret'),
    vars: refs.filter((ref) => ref.kind === 'ci-var'),
    environments: unique(environments),
    referencedEnvFiles: [],
  };
};

const dialectOf = (relativePath: string): CiDialect => {
  const path = relativePath.replace(/\\/g, '/').replace(/^\.\//, '');
  if (GITHUB_WORKFLOW.test(path)) {
    return COMPOSE_LIKE.test(basenameOf(path)) ? 'unknown' : 'github';
  }
  if (GITHUB_ACTION.test(path)) {
    return 'github';
  }
  if (path === GITLAB_CONFIG || GITLAB_FRAGMENT.test(path)) {
    return 'gitlab';
  }
  if (AZURE_PIPELINES.test(path)) {
    return 'azure';
  }
  if (CIRCLECI_CONFIG.test(path)) {
    return 'circleci';
  }
  return 'unknown';
};

const basenameOf = (path: string): string => {
  const at = path.lastIndexOf('/');
  return at === -1 ? path : path.slice(at + 1);
};

const byPosition = (left: InfraRef, right: InfraRef): number =>
  left.line - right.line ||
  left.column - right.column ||
  compareText(left.name, right.name) ||
  compareText(left.kind, right.kind);

/** GitHub Actions: every env: block, secrets/vars/env expressions and jobs.*.environment.name. */
const scanGithub = (
  file: string,
  lines: readonly YamlLine[],
  refs: InfraRef[],
  environments: string[],
): void => {
  for (const line of lines) {
    if (isDataLine(line)) {
      collectUsages(file, line, line.text, 0, GITHUB_PATTERNS, refs);
    }
  }
  const root = readEntries(lines, 0, lines.length);
  for (const entry of walk(root)) {
    if (entry.key === ENV_BLOCK_KEY && entry.value === '') {
      collectDeclarations(file, entry.children, refs);
    }
  }
  for (const entry of root) {
    if (entry.key !== 'jobs') {
      continue;
    }
    for (const job of entry.children) {
      for (const child of job.children) {
        if (child.key === 'environment') {
          const named = environmentName(child);
          if (named !== null) {
            environments.push(named);
          }
        }
      }
    }
  }
};

/** GitLab CI: the top-level variables: block and $NAME / ${NAME} inside script bodies. */
const scanGitlab = (file: string, lines: readonly YamlLine[], refs: InfraRef[]): void => {
  const root = readEntries(lines, 0, lines.length);
  for (const entry of root) {
    if (entry.key === 'variables') {
      collectDeclarations(file, entry.children, refs);
    }
  }
  for (const entry of walk(root)) {
    if (entry.key === null || !GITLAB_SCRIPT_KEYS.has(entry.key)) {
      continue;
    }
    eachValue(entry, (value, start, line) => {
      collectShellUsages(file, line, value, start, refs);
    });
  }
};

/** Azure Pipelines: variables: at any depth, a top-level env:, and the $(NAME) macro syntax. */
const scanAzure = (file: string, lines: readonly YamlLine[], refs: InfraRef[]): void => {
  for (const line of lines) {
    if (isDataLine(line)) {
      collectUsages(file, line, line.text, 0, AZURE_PATTERNS, refs);
    }
  }
  const root = readEntries(lines, 0, lines.length);
  for (const entry of walk(root)) {
    if (entry.key === 'variables') {
      collectDeclarations(file, entry.children, refs);
    }
  }
  for (const entry of root) {
    if (entry.key === ENV_BLOCK_KEY && entry.value === '') {
      collectDeclarations(file, entry.children, refs);
    }
  }
};

/** CircleCI: the job-level environment: map and $NAME / ${NAME} inside its values. */
const scanCircleci = (file: string, lines: readonly YamlLine[], refs: InfraRef[]): void => {
  for (const entry of walk(readEntries(lines, 0, lines.length))) {
    if (entry.key === 'environment') {
      collectDeclarations(file, entry.children, refs);
      eachValue(entry, (value, start, line) => {
        collectShellUsages(file, line, value, start, refs);
      });
    }
  }
};

const environmentName = (entry: Entry): string | null => {
  if (entry.value !== '') {
    return unquote(entry.value);
  }
  for (const child of entry.children) {
    if (child.key === 'name' && child.value !== '') {
      return unquote(child.value);
    }
  }
  return null;
};

/** One ci-env ref per KEY of a variables/env/environment mapping; an empty value is required. */
const collectDeclarations = (file: string, entries: readonly Entry[], refs: InfraRef[]): void => {
  for (const entry of entries) {
    if (entry.key === null) {
      continue;
    }
    refs.push({
      name: entry.key,
      file,
      line: entry.line.number,
      column: entry.keyStart + 1,
      kind: 'ci-env',
      required: isEmptyValue(entry.value),
      refersToFile: false,
      interpolation: false,
    });
  }
};

const collectUsages = (
  file: string,
  line: YamlLine,
  text: string,
  from: number,
  patterns: readonly PatternEntry[],
  refs: InfraRef[],
): void => {
  if (text === '') {
    return;
  }
  const found: Found[] = [];
  for (const row of patterns) {
    row.pattern.lastIndex = 0;
    let match = row.pattern.exec(text);
    while (match !== null) {
      const name = match[1];
      if (name !== undefined) {
        found.push({
          start: match.index,
          end: match.index + match[0].length,
          name,
          nameOffset: row.nameOffset,
          kind: row.kind,
          required: row.required,
        });
      }
      match = row.pattern.exec(text);
    }
  }
  found.sort((left, right) => left.start - right.start || left.end - right.end);
  let covered = 0;
  for (const hit of found) {
    if (hit.start < covered) {
      continue;
    }
    covered = hit.end;
    refs.push({
      name: hit.name,
      file,
      line: line.number,
      column: from + hit.start + hit.nameOffset + 1,
      kind: hit.kind,
      required: hit.required,
      refersToFile: false,
      interpolation: true,
    });
  }
};

/**
 * Shell references in a script body: `${NAME}`, `${NAME:-default}`, `${NAME:?msg}` and
 * `$NAME`. The braced forms are found by a linear scan and the bare form by a bounded
 * pattern; the two never overlap, because `$` followed by `{` is not a bare reference.
 */
const collectShellUsages = (file: string, line: YamlLine, text: string, from: number, refs: InfraRef[]): void => {
  if (text === '') {
    return;
  }
  for (const hit of findBracedVariables(text)) {
    refs.push({
      name: hit.name,
      file,
      line: line.number,
      column: from + hit.start + 3,
      kind: 'ci-env-usage',
      required: false,
      refersToFile: false,
      interpolation: true,
    });
  }
  collectUsages(file, line, text, from, SHELL_PATTERNS, refs);
};

const eachValue = (
  entry: Entry,
  visit: (value: string, start: number, line: YamlLine) => void,
  depth = 0,
): void => {
  if (depth > MAX_NESTING) {
    return;
  }
  if (entry.value !== '') {
    visit(entry.value, entry.valueStart, entry.line);
  }
  for (const child of entry.children) {
    eachValue(child, visit, depth + 1);
  }
};

const walk = (entries: readonly Entry[]): readonly Entry[] => {
  const all: Entry[] = [];
  const pending: Entry[] = [...entries];
  while (pending.length > 0) {
    const current = pending.pop();
    if (current === undefined) {
      continue;
    }
    all.push(current);
    for (const child of current.children) {
      pending.push(child);
    }
  }
  return all;
};

const isEmptyValue = (value: string): boolean => unquote(value).trim() === '';

const unquote = (value: string): string => {
  const text = value.trim();
  if (text.length >= 2) {
    const first = text.charAt(0);
    if ((first === '"' || first === "'") && text.charAt(text.length - 1) === first) {
      return text.slice(1, -1);
    }
  }
  return text;
};

const isDataLine = (line: YamlLine): boolean => {
  if (line.blank || line.comment) {
    return false;
  }
  const text = line.text.trim();
  return text !== '' && !text.startsWith('#');
};

const dashWidthOf = (line: YamlLine): number => {
  const text = line.text;
  const at = line.indent;
  if (text.charAt(at) !== '-') {
    return 0;
  }
  const next = text.charAt(at + 1);
  if (next !== '' && next !== ' ' && next !== '\t') {
    return 0;
  }
  let width = 1;
  while (text.charAt(at + width) === ' ' || text.charAt(at + width) === '\t') {
    width += 1;
  }
  return width;
};

const firstDataIndex = (lines: readonly YamlLine[], from: number, to: number): number => {
  for (let at = from; at < to; at += 1) {
    const line = lines[at];
    if (line !== undefined && isDataLine(line)) {
      return at;
    }
  }
  return -1;
};

/** Direct entries of the block that starts at `from`: a mapping, a sequence, or nothing. */
const readEntries = (lines: readonly YamlLine[], from: number, to: number, depth = 0): readonly Entry[] => {
  if (depth > MAX_NESTING) {
    return [];
  }
  const first = firstDataIndex(lines, from, to);
  const firstLine = lines[first];
  if (first === -1 || firstLine === undefined) {
    return [];
  }
  const base = firstLine.indent;
  if (dashWidthOf(firstLine) > 0) {
    return readSequence(lines, from, to, base, depth);
  }
  return readMapping(lines, from, to, base, depth);
};

const readMapping = (
  lines: readonly YamlLine[],
  from: number,
  to: number,
  base: number,
  depth: number,
): readonly Entry[] => {
  const entries: Entry[] = [];
  let index = from;
  while (index < to) {
    const line = lines[index];
    if (line === undefined) {
      break;
    }
    if (!isDataLine(line)) {
      index += 1;
      continue;
    }
    if (line.indent < base) {
      break;
    }
    if (line.indent > base || dashWidthOf(line) > 0) {
      index += 1;
      continue;
    }
    const parsed = splitEntry(line, base);
    const childEnd = blockEnd(lines, index, to, base, true);
    entries.push(makeEntry(line, parsed, readEntries(lines, index + 1, childEnd, depth + 1)));
    index = childEnd;
  }
  return entries;
};

const readSequence = (
  lines: readonly YamlLine[],
  from: number,
  to: number,
  base: number,
  depth: number,
): readonly Entry[] => {
  const entries: Entry[] = [];
  let index = from;
  while (index < to) {
    const line = lines[index];
    if (line === undefined) {
      break;
    }
    if (!isDataLine(line)) {
      index += 1;
      continue;
    }
    if (line.indent < base) {
      break;
    }
    if (line.indent > base || dashWidthOf(line) === 0) {
      index += 1;
      continue;
    }
    const itemEnd = itemEndOf(lines, index, to, base);
    for (const entry of itemEntries(lines, index, itemEnd, base + dashWidthOf(line), depth)) {
      entries.push(entry);
    }
    index = itemEnd;
  }
  return entries;
};

const itemEndOf = (lines: readonly YamlLine[], index: number, to: number, dashIndent: number): number => {
  let at = index + 1;
  while (at < to) {
    const line = lines[at];
    if (line === undefined) {
      break;
    }
    if (!isDataLine(line)) {
      at += 1;
      continue;
    }
    if (line.indent > dashIndent) {
      at += 1;
      continue;
    }
    break;
  }
  return at;
};

const itemEntries = (
  lines: readonly YamlLine[],
  start: number,
  end: number,
  itemIndent: number,
  depth: number,
): readonly Entry[] => {
  const entries: Entry[] = [];
  const head = lines[start];
  if (head !== undefined && isDataLine(head)) {
    const headStart = itemIndent;
    const headEnd = blockEnd(lines, start, end, headStart, false);
    entries.push(
      makeEntry(head, splitEntry(head, headStart), readEntries(lines, start + 1, headEnd, depth + 1)),
    );
  }
  let index = start + 1;
  while (index < end) {
    const line = lines[index];
    if (line === undefined) {
      break;
    }
    if (!isDataLine(line)) {
      index += 1;
      continue;
    }
    if (line.indent < itemIndent) {
      break;
    }
    if (line.indent > itemIndent || dashWidthOf(line) > 0) {
      index += 1;
      continue;
    }
    const childEnd = blockEnd(lines, index, end, itemIndent, true);
    entries.push(makeEntry(line, splitEntry(line, itemIndent), readEntries(lines, index + 1, childEnd, depth + 1)));
    index = childEnd;
  }
  return entries;
};

/** First index that is not part of the block opened by a key at `keyIndent`. */
const blockEnd = (
  lines: readonly YamlLine[],
  index: number,
  to: number,
  keyIndent: number,
  allowSequenceChild: boolean,
): number => {
  let at = index + 1;
  while (at < to) {
    const line = lines[at];
    if (line === undefined) {
      break;
    }
    if (!isDataLine(line)) {
      at += 1;
      continue;
    }
    if (line.indent > keyIndent) {
      at += 1;
      continue;
    }
    if (allowSequenceChild && line.indent === keyIndent && dashWidthOf(line) > 0) {
      at += 1;
      continue;
    }
    break;
  }
  return at;
};

const makeEntry = (line: YamlLine, parsed: ParsedEntry, children: readonly Entry[]): Entry => ({
  line,
  key: parsed.key,
  keyStart: parsed.keyStart,
  value: parsed.value,
  valueStart: parsed.valueStart,
  children,
});

/** Splits `KEY: value`, `"KEY": value` and a bare sequence scalar into a key and a trimmed value. */
const splitEntry = (line: YamlLine, from: number): ParsedEntry => {
  const head = stripInlineComment(line.text.slice(from));
  const colon = findKeyColon(head);
  if (colon === -1) {
    const lead = head.length - head.trimStart().length;
    const start = from + lead;
    return { key: null, keyStart: start, value: head.trimEnd(), valueStart: start };
  }
  const rawKey = head.slice(0, colon);
  const keyLead = rawKey.length - rawKey.trimStart().length;
  const raw = rawKey.trim();
  const key = unquote(raw);
  const rest = head.slice(colon + 1);
  const valueLead = rest.length - rest.trimStart().length;
  return {
    key: key === '' ? null : key,
    keyStart: from + keyLead + quoteWidth(raw),
    value: rest.slice(valueLead).trimEnd(),
    valueStart: from + colon + 1 + valueLead,
  };
};

/** First `:` that ends a key: outside quotes and followed by a space or the end of the line. */
const findKeyColon = (text: string): number => {
  let quote = '';
  for (let at = 0; at < text.length; at += 1) {
    const char = text.charAt(at);
    if (quote !== '') {
      if (char === quote) {
        quote = '';
      }
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if (char === ':' && isKeyBreak(text.charAt(at + 1))) {
      return at;
    }
  }
  return -1;
};

const quoteWidth = (text: string): number => (text.charAt(0) === '"' || text.charAt(0) === "'" ? 1 : 0);

const stripInlineComment = (text: string): string => {
  let quote = '';
  for (let at = 0; at < text.length; at += 1) {
    const char = text.charAt(at);
    if (quote !== '') {
      if (char === quote) {
        quote = '';
      }
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if (char === '#' && at > 0 && isSpace(text.charAt(at - 1))) {
      return text.slice(0, at);
    }
  }
  return text;
};

const isSpace = (char: string): boolean => char === ' ' || char === '\t';

const isKeyBreak = (char: string): boolean => char === '' || isSpace(char);
