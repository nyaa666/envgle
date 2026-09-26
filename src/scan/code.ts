import { readFile } from 'node:fs/promises';
import type { EnvUsage, Language, SourceLocation } from '../types.js';
import type { WalkedFile } from '../utils/walk.js';
import { appendAll, escapeRegExp, isProbablyBinary } from '../utils/text.js';

export interface ScannedFile {
  readonly path: string;
  readonly language: Language;
  readonly text: string;
  readonly lines: readonly string[];
}

export interface ExtractionContext {
  readonly file: string;
  readonly language: Language;
  readonly text: string;
  readonly lines: readonly string[];
  readonly push: (usage: EnvUsage, location?: SourceLocation) => void;
}

export interface Extractor {
  readonly id: string;
  readonly accessor: string;
  readonly languages: readonly Language[];
  readonly comment: string;
  extract(context: ExtractionContext): void;
}

/**
 * envgle — language analysis: source text in, `EnvUsage` records out.
 *
 * Every extractor sees the same comment/string-aware view of a file, so an
 * accessor is never reported from inside a comment or a string literal.
 * Positions are 1-based and point at the first character of the variable name
 * token as written, at the opening quote for quoted keys.
 *
 * Known limitation: a computed key such as `process.env[name]` or
 * `os.environ[prefix + suffix]` has no static name and yields no usage.
 */

interface MaskSpec {
  readonly lineComments: readonly string[];
  readonly lineCommentAtLineStart: boolean;
  readonly lineCommentEscapes: boolean;
  readonly lineCommentKeywords: readonly string[];
  readonly blockComment: readonly [string, string] | null;
  readonly nestedBlockComments: boolean;
  readonly quotes: string;
  readonly tripleQuotes: boolean;
  readonly escapes: boolean;
  readonly backtick: 'off' | 'plain' | 'template';
  readonly verbatim: boolean;
}

interface MaskedCode {
  readonly code: string;
  readonly inString: Uint8Array;
  readonly lineStarts: Int32Array;
  readonly length: number;
}

interface Position {
  readonly line: number;
  readonly column: number;
}

type MaskFrame = { kind: 'template' } | { kind: 'interp'; depth: number };

type ReportOffset = (match: RegExpExecArray, name: string, end: number, nameGroup: number) => number;

type FollowRule = (code: string, end: number) => Adjustment | null;

interface Adjustment {
  readonly required?: boolean;
  readonly hasFallback?: boolean;
  readonly fallbackLiteral?: string | null;
}

interface AccessorRow {
  readonly id: string;
  readonly accessor: string;
  readonly languages: readonly Language[];
  readonly comment: string;
  readonly source: string;
  readonly nameGroup: number;
  readonly report?: string;
  readonly required: boolean;
  readonly hasFallback: boolean;
  readonly requireCode?: boolean;
  readonly follow?: string;
  readonly skipWrite?: boolean;
  readonly skip?: (name: string, code: string, end: number) => boolean;
  readonly gate?: (code: string) => boolean;
  readonly multiline?: boolean;
}

interface UsageDraft {
  readonly name: string;
  readonly accessor: string;
  readonly hasFallback: boolean;
  readonly required: boolean;
  readonly viaImport?: boolean;
  readonly fallbackLiteral?: string | null;
}

interface EnvBinding {
  readonly name: string;
  readonly offset: number;
  readonly hasDefault: boolean;
  readonly literal: string | null;
}

interface ClassField {
  readonly name: string;
  readonly offset: number;
  readonly hasDefault: boolean;
  readonly literal: string | null;
}

interface BindingPart {
  readonly text: string;
  readonly offset: number;
}

const MAX_CODE_FILE_BYTES = 8 * 1024 * 1024;
const MAX_TAIL_SLICE = 64;
const MAX_LITERAL_SLICE = 4096;
const IDENTIFIER = '[A-Za-z_][A-Za-z0-9_]*';
const SHELL_NAME = '[A-Za-z_][A-Za-z0-9_]{1,}';
const BATCH_NAME = '[A-Z][A-Z0-9_]{1,}';

const SLASH_BLOCK: MaskSpec = {
  lineComments: ['//'],
  lineCommentAtLineStart: false,
  lineCommentEscapes: false,
  lineCommentKeywords: [],
  blockComment: ['/*', '*/'],
  nestedBlockComments: false,
  quotes: '\'"',
  tripleQuotes: false,
  escapes: true,
  backtick: 'off',
  verbatim: false,
};

const HASH_LINE: MaskSpec = {
  lineComments: ['#'],
  lineCommentAtLineStart: false,
  lineCommentEscapes: false,
  lineCommentKeywords: [],
  blockComment: null,
  nestedBlockComments: false,
  quotes: '\'"',
  tripleQuotes: true,
  escapes: true,
  backtick: 'off',
  verbatim: false,
};

const NO_COMMENT: MaskSpec = {
  lineComments: [],
  lineCommentAtLineStart: false,
  lineCommentEscapes: false,
  lineCommentKeywords: [],
  blockComment: null,
  nestedBlockComments: false,
  quotes: '',
  tripleQuotes: false,
  escapes: false,
  backtick: 'off',
  verbatim: false,
};

const MASK_BY_LANGUAGE: Readonly<Record<Language, MaskSpec | null>> = {
  javascript: { ...SLASH_BLOCK, backtick: 'template' },
  typescript: { ...SLASH_BLOCK, backtick: 'template' },
  python: { ...HASH_LINE },
  go: { ...SLASH_BLOCK, backtick: 'plain' },
  rust: { ...SLASH_BLOCK, nestedBlockComments: true, quotes: '"' },
  java: SLASH_BLOCK,
  kotlin: { ...SLASH_BLOCK, nestedBlockComments: true },
  csharp: { ...SLASH_BLOCK, verbatim: true },
  ruby: { ...HASH_LINE, backtick: 'plain' },
  php: { ...SLASH_BLOCK, lineComments: ['//', '#'] },
  perl: { ...HASH_LINE, backtick: 'plain', quotes: '\'"`' },
  shell: {
    ...HASH_LINE,
    lineCommentAtLineStart: true,
    lineCommentEscapes: true,
    tripleQuotes: false,
    quotes: "'",
    backtick: 'plain',
  },
  batch: { ...NO_COMMENT, lineComments: ['::'], lineCommentAtLineStart: true, lineCommentKeywords: ['rem'] },
  swift: { ...SLASH_BLOCK, nestedBlockComments: true, quotes: '"' },
  dart: { ...SLASH_BLOCK, nestedBlockComments: true },
  elixir: { ...HASH_LINE },
  unknown: null,
};

const VITE_BUILT_INS: ReadonlySet<string> = new Set([
  'MODE',
  'DEV',
  'PROD',
  'SSR',
  'BASE_URL',
  'ASSETS_PREFIX',
  'KEYS',
]);

const SETTINGS_FIELDS_TO_SKIP: readonly RegExp[] = [/^model_/, /^Config$/, /^_/];

const BARE_BINDING = new RegExp(`^(${IDENTIFIER})`);
const BARE_BRACKET_BINDING = new RegExp(`^\\[\\s*(['"])(${IDENTIFIER})\\1\\s*\\]`);
const QUOTED_BINDING = new RegExp(`^(['"])(${IDENTIFIER})\\1`);
const STATIC_ENV_IMPORT = /import\s*\{([^}]{0,500})\}\s*from\s*['"](\$env\/static\/(?:private|public))['"]/g;
const DYNAMIC_ENV_IMPORT = /import\s*\{([^}]{0,500})\}\s*from\s*['"](\$env\/dynamic\/(?:private|public))['"]/g;
const DYNAMIC_DOT_SUFFIX = String.raw`\s*\.\s*(${IDENTIFIER})`;
const DYNAMIC_BRACKET_SUFFIX = String.raw`\s*\[\s*(['"])(${IDENTIFIER})\1(?=\s*\])`;
const JS_GLOBALS = String.raw`(?<![.\w$])(?:(?:globalThis|global|window|self)\s*\.\s*)?`;
const GO_IMPORT_OS = /^[ \t]*(?:import\s+)?(?:[A-Za-z_][A-Za-z0-9_]*\s+)?"os"[ \t]*(?:\/\/.*)?$/m;
const RUST_USE_VAR = /^[ \t]*use\s+(?:std\s*::\s*env\s*::\s*(?:var|\{[^}]*\bvar\b[^}]*\})|env\s*::\s*var)\s*;/m;
const PY_ENVIRON_IMPORT = new RegExp(
  `(?<![\\w.])from\\s+os\\s+import\\s+([A-Za-z_][A-Za-z0-9_]*)(?:\\s+as\\s+([A-Za-z_][A-Za-z0-9_]*))?`,
  'g',
);
const PY_CLASS_HEADER = /^([ \t]*)class\s+[A-Za-z_][A-Za-z0-9_]*\s*\(\s*([A-Za-z_][A-Za-z0-9_]*)/gm;
const PY_FIELD = new RegExp(`^([ \\t]*)(${IDENTIFIER})\\s*:\\s*(.*)$`);
const RUST_CHAIN = /^\s*\)\s*\.\s*([A-Za-z_][A-Za-z0-9_]*)/;
const RUST_FALLBACK_METHODS: ReadonlySet<string> = new Set([
  'unwrap_or',
  'unwrap_or_else',
  'unwrap_or_default',
  'ok',
]);
const RUST_ASSERT_METHODS: ReadonlySet<string> = new Set(['unwrap', 'expect']);
const ASSIGNMENT_TAIL = /^[=><!+\-*/%&|^~:]$/;
const TRIPLE_SINGLE = "'''";
const TRIPLE_DOUBLE = '"""';
const CODE_TAB = 9;
const CODE_NEWLINE = 10;
const CODE_VERTICAL_TAB = 11;
const CODE_FORM_FEED = 12;
const CODE_RETURN = 13;
const CODE_SPACE = 32;
const CODE_QUOTE_SINGLE = 39;
const CODE_QUOTE_DOUBLE = 34;
const CODE_AT = 64;
const CODE_BRACE_OPEN = 123;
const CODE_BRACE_CLOSE = 125;
const CODE_BACKTICK = 96;
const COMMA_AFTER = /^\s*,\s*/;
const COALESCE_AFTER = /^\s*\]?\s*(?:\?\?|\|\|)\s*/;
const DEFINED_OR_AFTER = /^\s*\/\/\s*/;
const WRITE_AFTER = /^\s*\]?\s*(?:\+|-|\*|\/|\/\/|\*\*|<<)?=(?![=])/;

const compareText = (left: string, right: string): number => (left < right ? -1 : left > right ? 1 : 0);

function buildLineStarts(text: string): Int32Array {
  const starts: number[] = [0];
  for (let index = 0; index < text.length; index += 1) {
    if (text.charCodeAt(index) === 10) {
      starts.push(index + 1);
    }
  }
  return Int32Array.from(starts);
}

function positionAt(masked: MaskedCode, offset: number): Position {
  const starts = masked.lineStarts;
  const clamped = Math.max(0, Math.min(offset, masked.length));
  let low = 0;
  let high = starts.length - 1;
  while (low < high) {
    const middle = (low + high + 1) >>> 1;
    if ((starts[middle] ?? 0) <= clamped) {
      low = middle;
    } else {
      high = middle - 1;
    }
  }
  return { line: low + 1, column: clamped - (starts[low] ?? 0) + 1 };
}

interface MaskTriggers {
  readonly jumper: RegExp;
  readonly commentStarts: ReadonlySet<number>;
}

const triggers = new WeakMap<MaskSpec, MaskTriggers>();

function triggersFor(spec: MaskSpec): MaskTriggers {
  const cached = triggers.get(spec);
  if (cached !== undefined) {
    return cached;
  }
  const chars = new Set<string>(['\n', '\r']);
  for (const token of spec.lineComments) {
    const head = token.charAt(0);
    if (head !== '') {
      chars.add(head);
    }
  }
  for (const keyword of spec.lineCommentKeywords) {
    const head = keyword.charAt(0);
    if (head !== '') {
      chars.add(head);
    }
  }
  const blockOpen = spec.blockComment?.[0] ?? '';
  if (blockOpen !== '') {
    chars.add(blockOpen.charAt(0));
  }
  if (spec.verbatim) {
    chars.add('@');
  }
  if (spec.backtick !== 'off') {
    chars.add('`');
  }
  for (const char of spec.quotes) {
    chars.add(char);
  }
  if (spec.tripleQuotes) {
    chars.add("'");
    chars.add('"');
  }
  const commentStarts = new Set<number>();
  for (const token of spec.lineComments) {
    const head = token.charAt(0);
    if (head !== '') {
      commentStarts.add(head.charCodeAt(0));
    }
  }
  if (blockOpen !== '') {
    commentStarts.add(blockOpen.charCodeAt(0));
  }
  const body = [...chars].map((char) => (char === '\\' ? '\\\\' : char)).join('');
  const built: MaskTriggers = { jumper: new RegExp(`[${body}]`, 'g'), commentStarts };
  triggers.set(spec, built);
  return built;
}

function buildMask(text: string, spec: MaskSpec): MaskedCode {
  const length = text.length;
  const inString = new Uint8Array(length);
  const pieces: string[] = [];
  const frames: MaskFrame[] = [];
  const blockOpen = spec.blockComment?.[0] ?? '';
  const blockClose = spec.blockComment?.[1] ?? '';
  const backtick = spec.backtick;
  const hasKeyword = spec.lineCommentKeywords.length > 0;
  const quoteSingle = spec.quotes.includes("'");
  const quoteDouble = spec.quotes.includes('"');
  const jumper = triggersFor(spec).jumper;
  const commentStarts = triggersFor(spec).commentStarts;
  let chunkStart = 0;
  let index = 0;
  let atLineStart = true;

  const blankComment = (from: number, to: number): void => {
    const start = Math.max(from, chunkStart);
    if (to <= start) {
      return;
    }
    pieces.push(text.slice(chunkStart, start), text.slice(start, to).replace(/[^\n]/g, ' '));
    chunkStart = to;
  };

  const markString = (from: number, to: number): void => {
    const end = Math.min(to, length);
    for (let at = Math.max(0, from); at < end; at += 1) {
      inString[at] = 1;
    }
  };

  const scanQuoted = (from: number, close: string, multiline: boolean): number => {
    const head = close.charAt(0);
    let at = from;
    while (at < length) {
      const char = text.charAt(at);
      if (spec.escapes && char === '\\') {
        at += 2;
        continue;
      }
      if (char === head && text.startsWith(close, at)) {
        return at + close.length;
      }
      if (!multiline && (char === '\n' || char === '\r')) {
        return at;
      }
      at += 1;
    }
    return length;
  };

  const scanLineComment = (from: number): number => {
    if (!spec.lineCommentEscapes) {
      const breakAt = text.indexOf('\n', from);
      return breakAt === -1 ? length : breakAt;
    }
    let at = from;
    while (at < length) {
      const char = text.charAt(at);
      if (char === '\\' && at + 1 < length) {
        at += 2;
        continue;
      }
      if (char === '\n') {
        return at;
      }
      at += 1;
    }
    return length;
  };

  const keywordStartsComment = (): boolean => {
    if (!atLineStart) {
      return false;
    }
    for (const keyword of spec.lineCommentKeywords) {
      if (text.slice(index, index + keyword.length).toLowerCase() !== keyword) {
        continue;
      }
      const after = text.charAt(index + keyword.length);
      if (after === '' || after === ' ' || after === '\t') {
        return true;
      }
    }
    return false;
  };

  scanner: while (index < length) {
    const top = frames[frames.length - 1];
    const code = text.charCodeAt(index);

    if (top !== undefined && top.kind === 'template') {
      const char = text.charAt(index);
      if (char === '\\') {
        markString(index, index + 2);
        index += 2;
        continue;
      }
      if (char === '`') {
        markString(index, index + 1);
        index += 1;
        frames.pop();
        continue;
      }
      if (char === '$' && text.charAt(index + 1) === '{') {
        markString(index, index + 2);
        index += 2;
        frames.push({ kind: 'interp', depth: 1 });
        continue;
      }
      markString(index, index + 1);
      index += 1;
      continue;
    }

    if (top !== undefined && code === CODE_BRACE_OPEN) {
      top.depth += 1;
      index += 1;
      continue;
    }

    if (top !== undefined && code === CODE_BRACE_CLOSE) {
      top.depth -= 1;
      index += 1;
      if (top.depth === 0) {
        frames.pop();
      }
      continue;
    }

    if (top === undefined) {
      const beforeSpaces = index;
      while (index < length) {
        const fast = text.charCodeAt(index);
        if (fast !== CODE_SPACE && fast !== CODE_TAB && fast !== CODE_FORM_FEED && fast !== CODE_VERTICAL_TAB) {
          break;
        }
        index += 1;
      }
      if (index >= length) {
        break;
      }
      if (index !== beforeSpaces) {
        continue;
      }
      jumper.lastIndex = index;
      const found = jumper.exec(text);
      if (found === null) {
        atLineStart = false;
        index = length;
        break;
      }
      if (found.index !== index) {
        atLineStart = false;
        index = found.index;
        continue;
      }
    }

    if (code === CODE_NEWLINE || code === CODE_RETURN) {
      index += 1;
      atLineStart = true;
      continue;
    }

    if (
      code === CODE_SPACE ||
      code === CODE_TAB ||
      code === CODE_FORM_FEED ||
      code === CODE_VERTICAL_TAB
    ) {
      index += 1;
      continue;
    }

    if (hasKeyword && atLineStart && keywordStartsComment()) {
      const end = scanLineComment(index);
      blankComment(index, end);
      index = end;
      continue;
    }

    if (commentStarts.size > 0 && commentStarts.has(code)) {
      for (const token of spec.lineComments) {
        if (text.startsWith(token, index) && (!spec.lineCommentAtLineStart || atLineStart)) {
          const end = scanLineComment(index);
          blankComment(index, end);
          index = end;
          continue scanner;
        }
      }
      if (blockOpen !== '' && text.startsWith(blockOpen, index)) {
        const start = index;
        index += blockOpen.length;
        let cursor = index;
        let depth = 1;
        while (cursor < length && depth > 0) {
          if (spec.nestedBlockComments && text.startsWith(blockOpen, cursor)) {
            depth += 1;
            cursor += blockOpen.length;
            continue;
          }
          if (text.startsWith(blockClose, cursor)) {
            depth -= 1;
            cursor += blockClose.length;
            continue;
          }
          cursor += 1;
        }
        blankComment(start, cursor);
        index = cursor;
        continue;
      }
    }

    if (spec.verbatim && code === CODE_AT && text.charCodeAt(index + 1) === CODE_QUOTE_DOUBLE) {
      markString(index, index + 1);
      const end = scanQuoted(index + 1, '"', true);
      markString(index + 1, end);
      index = end;
      atLineStart = false;
      continue;
    }

    if (code === CODE_BACKTICK && backtick !== 'off') {
      if (backtick === 'template') {
        markString(index, index + 1);
        index += 1;
        frames.push({ kind: 'template' });
        continue;
      }
      const end = scanQuoted(index + 1, '`', true);
      markString(index, end);
      index = end;
      atLineStart = false;
      continue;
    }

    if (code !== CODE_QUOTE_SINGLE && code !== CODE_QUOTE_DOUBLE) {
      atLineStart = false;
      index += 1;
      continue;
    }

    if (spec.tripleQuotes) {
      const triple = code === CODE_QUOTE_SINGLE ? TRIPLE_SINGLE : TRIPLE_DOUBLE;
      if (text.startsWith(triple, index)) {
        const end = scanQuoted(index + 3, triple, true);
        markString(index, end);
        index = end;
        continue;
      }
    }

    if ((code === CODE_QUOTE_SINGLE && quoteSingle) || (code === CODE_QUOTE_DOUBLE && quoteDouble)) {
      const char = code === CODE_QUOTE_SINGLE ? "'" : '"';
      const end = scanQuoted(index + 1, char, false);
      markString(index, end);
      index = end;
      atLineStart = false;
      continue;
    }

    atLineStart = false;
    index += 1;
  }

  pieces.push(text.slice(chunkStart));
  return { code: pieces.join(''), inString, lineStarts: buildLineStarts(text), length };
}

let cachedText = '';
let cachedLanguage: Language = 'unknown';
let cachedMask: MaskedCode | null = null;

function analyze(text: string, language: Language): MaskedCode | null {
  const spec = MASK_BY_LANGUAGE[language];
  if (spec === null) {
    return null;
  }
  if (cachedMask !== null && cachedLanguage === language && cachedText === text) {
    return cachedMask;
  }
  const built = buildMask(text, spec);
  cachedText = text;
  cachedLanguage = language;
  cachedMask = built;
  return built;
}

function lineEnd(code: string, offset: number): number {
  const breakAt = code.indexOf('\n', offset);
  return breakAt === -1 ? code.length : breakAt;
}

function shiftPast(code: string, end: number, pattern: RegExp): number {
  const match = pattern.exec(code.slice(end, end + MAX_TAIL_SLICE));
  return match === null ? -1 : match[0].length;
}

function readLiteral(code: string, offset: number): string | null {
  let at = offset;
  while (at < code.length && (code.charAt(at) === ' ' || code.charAt(at) === '\t')) {
    at += 1;
  }
  const quote = code.charAt(at);
  if (quote !== '"' && quote !== "'") {
    return null;
  }
  const limit = Math.min(code.length, at + MAX_LITERAL_SLICE);
  let end = at + 1;
  while (end < limit) {
    const char = code.charAt(end);
    if (char === '\\') {
      end += 2;
      continue;
    }
    if (char === quote) {
      return code.slice(at + 1, end);
    }
    if (char === '\n') {
      return null;
    }
    end += 1;
  }
  return null;
}

function isWriteAfter(code: string, end: number): boolean {
  return WRITE_AFTER.test(code.slice(end, Math.min(lineEnd(code, end), end + MAX_TAIL_SLICE)));
}

const atNameEnd: ReportOffset = (_match, name, end) => end - name.length;
const atQuotedName: ReportOffset = (_match, name, end) => end - name.length - 2;

const followCallArgument: FollowRule = (code, end) => {
  const shift = shiftPast(code, end, COMMA_AFTER);
  if (shift === -1) {
    return null;
  }
  return { hasFallback: true, fallbackLiteral: readLiteral(code, end + shift) };
};

const followCoalesce: FollowRule = (code, end) => {
  const shift = shiftPast(code, end, COALESCE_AFTER);
  if (shift === -1) {
    return null;
  }
  return { hasFallback: true, fallbackLiteral: readLiteral(code, end + shift) };
};

const followDefinedOr: FollowRule = (code, end) => {
  const shift = shiftPast(code, end, DEFINED_OR_AFTER);
  if (shift === -1) {
    return null;
  }
  return { hasFallback: true, fallbackLiteral: readLiteral(code, end + shift) };
};

const followRustChain: FollowRule = (code, end) => {
  const match = RUST_CHAIN.exec(code.slice(end, end + MAX_TAIL_SLICE));
  const method = match?.[1];
  if (match === null || method === undefined) {
    return null;
  }
  if (RUST_ASSERT_METHODS.has(method)) {
    return { required: true, hasFallback: false, fallbackLiteral: null };
  }
  if (!RUST_FALLBACK_METHODS.has(method)) {
    return null;
  }
  const after = end + match[0].length;
  if (method !== 'unwrap_or' || code.charAt(after) !== '(') {
    return { hasFallback: true, fallbackLiteral: null };
  }
  return { hasFallback: true, fallbackLiteral: readLiteral(code, after + 1) };
};

const RUBY_BLOCK_AFTER = /^[ \t]*\)[ \t]*\{[ \t]*/;

const followRubyFetch: FollowRule = (code, end) => {
  const comma = shiftPast(code, end, COMMA_AFTER);
  if (comma !== -1) {
    return { hasFallback: true, fallbackLiteral: readLiteral(code, end + comma) };
  }
  const block = RUBY_BLOCK_AFTER.exec(code.slice(end, end + MAX_TAIL_SLICE));
  if (block === null) {
    return null;
  }
  return { hasFallback: true, fallbackLiteral: readLiteral(code, end + block[0].length) };
};

const followShellOperator: FollowRule = (code, end) => {
  const operator = code.charAt(end - 1);
  if (operator === '?') {
    return { required: true, hasFallback: false, fallbackLiteral: null };
  }
  if (operator !== '-') {
    return null;
  }
  const rest = code.slice(end, end + MAX_LITERAL_SLICE);
  const close = rest.indexOf('}');
  if (close === -1) {
    return null;
  }
  const value = rest.slice(0, close);
  return { hasFallback: true, fallbackLiteral: value === '' ? null : value };
};

const followNone: FollowRule = () => null;

const FOLLOW_RULES: Readonly<Record<string, FollowRule>> = {
  none: followNone,
  callArgument: followCallArgument,
  coalesce: followCoalesce,
  definedOr: followDefinedOr,
  rustChain: followRustChain,
  rubyFetch: followRubyFetch,
  shellOperator: followShellOperator,
};

const atNameTail: ReportOffset = (match, name, end) =>
  end - (match[0].length - match[0].indexOf(name) - name.length) - name.length;

/** Perl: the group before the name group holds the quote, so the offset shifts by one. */
const reportPerlEnv: ReportOffset = (match, name, end, nameGroup) => {
  const quoted = (match[nameGroup - 1] ?? '').length === 1;
  return end - (quoted ? 3 : 1) - name.length;
};

const REPORT_OFFSETS: Readonly<Record<string, ReportOffset>> = {
  name: atNameEnd,
  quotedName: atQuotedName,
  atNameTail,
  perlEnv: reportPerlEnv,
};

function patternExtractor(row: AccessorRow): Extractor {
  const regex = new RegExp(row.source, row.multiline === true ? 'gm' : 'g');
  const report = REPORT_OFFSETS[row.report ?? 'name'] ?? atNameEnd;
  const follow = FOLLOW_RULES[row.follow ?? 'none'] ?? followNone;
  return {
    id: row.id,
    accessor: row.accessor,
    languages: row.languages,
    comment: row.comment,
    extract(context: ExtractionContext): void {
      const masked = analyze(context.text, context.language);
      if (masked === null || (row.gate !== undefined && !row.gate(masked.code))) {
        return;
      }
      regex.lastIndex = 0;
      let match = regex.exec(masked.code);
      while (match !== null) {
        if (match[0].length === 0) {
          regex.lastIndex += 1;
        } else {
          emitPatternMatch(context, masked, row, report, follow, match);
        }
        match = regex.exec(masked.code);
      }
    },
  };
}

function emitPatternMatch(
  context: ExtractionContext,
  masked: MaskedCode,
  row: AccessorRow,
  report: ReportOffset,
  follow: FollowRule,
  match: RegExpExecArray,
): void {
  const name = match[row.nameGroup];
  if (name === undefined || name.length === 0) {
    return;
  }
  const end = match.index + match[0].length;
  if (row.requireCode === true && masked.inString[match.index] === 1) {
    return;
  }
  if (row.skipWrite === true && isWriteAfter(masked.code, end)) {
    return;
  }
  if (row.skip !== undefined && row.skip(name, masked.code, end)) {
    return;
  }
  const adjustment = follow(masked.code, end);
  emitAt(context, masked, report(match, name, end, row.nameGroup), {
    name,
    accessor: row.accessor,
    hasFallback: adjustment?.hasFallback ?? row.hasFallback,
    required: adjustment?.required ?? row.required,
    fallbackLiteral: adjustment?.fallbackLiteral ?? null,
  });
}

function emit(context: ExtractionContext, position: Position, draft: UsageDraft): void {
  context.push({
    name: draft.name,
    file: context.file,
    line: position.line,
    column: position.column,
    language: context.language,
    accessor: draft.accessor,
    hasFallback: draft.hasFallback,
    required: draft.required,
    viaImport: draft.viaImport ?? false,
    fallbackLiteral: draft.fallbackLiteral ?? null,
  });
}

function emitAt(context: ExtractionContext, masked: MaskedCode, offset: number, draft: UsageDraft): void {
  emit(context, positionAt(masked, offset), draft);
}

function tableExtractors(rows: readonly AccessorRow[]): Extractor[] {
  return rows.map((row) => patternExtractor(row));
}

function plainExtractor(
  id: string,
  accessor: string,
  languages: readonly Language[],
  comment: string,
  extract: (context: ExtractionContext, masked: MaskedCode) => void,
): Extractor {
  return {
    id,
    accessor,
    languages,
    comment,
    extract(context: ExtractionContext): void {
      const masked = analyze(context.text, context.language);
      if (masked === null) {
        return;
      }
      extract(context, masked);
    },
  };
}

function matchAll(regex: RegExp, code: string): RegExpExecArray[] {
  regex.lastIndex = 0;
  const matches: RegExpExecArray[] = [];
  let match = regex.exec(code);
  while (match !== null) {
    if (match[0].length > 0) {
      matches.push(match);
    } else {
      regex.lastIndex += 1;
    }
    match = regex.exec(code);
  }
  return matches;
}

function findAssignment(text: string): number {
  let quote = '';
  let depth = 0;
  for (let at = 0; at < text.length; at += 1) {
    const char = text.charAt(at);
    if (quote !== '') {
      if (char === '\\') {
        at += 1;
        continue;
      }
      if (char === quote) {
        quote = '';
      }
      continue;
    }
    if (char === '"' || char === "'" || char === '`') {
      quote = char;
      continue;
    }
    if (char === '(' || char === '[' || char === '{') {
      depth += 1;
      continue;
    }
    if (char === ')' || char === ']' || char === '}') {
      depth -= 1;
      continue;
    }
    if (char === '=' && depth <= 0) {
      const next = text.charAt(at + 1);
      if (next !== '=' && next !== '>' && !ASSIGNMENT_TAIL.test(text.charAt(at - 1))) {
        return at;
      }
    }
  }
  return -1;
}

function splitParts(body: string): readonly BindingPart[] {
  const parts: BindingPart[] = [];
  let depth = 0;
  let quote = '';
  let start = 0;
  for (let at = 0; at <= body.length; at += 1) {
    const char = body.charAt(at);
    if (quote !== '') {
      if (char === '\\') {
        at += 1;
        continue;
      }
      if (char === quote) {
        quote = '';
      }
      continue;
    }
    if (char === '"' || char === "'" || char === '`') {
      quote = char;
      continue;
    }
    if (char === '{' || char === '[' || char === '(') {
      depth += 1;
      continue;
    }
    if (char === '}' || char === ']' || char === ')') {
      depth -= 1;
      continue;
    }
    if ((char === ',' && depth <= 0) || at === body.length) {
      parts.push({ text: body.slice(start, at), offset: start });
      start = at + 1;
    }
  }
  return parts;
}

function readBindingKey(region: string, regionOffset: number): EnvBinding | null {
  const bracketed = BARE_BRACKET_BINDING.exec(region);
  if (bracketed !== null) {
    const name = bracketed[2];
    if (name === undefined) {
      return null;
    }
    const quoteAt = bracketed[0].indexOf(bracketed[1] ?? '');
    return {
      name,
      offset: regionOffset + quoteAt,
      hasDefault: false,
      literal: null,
    };
  }
  const quoted = QUOTED_BINDING.exec(region);
  if (quoted !== null) {
    const name = quoted[2];
    return name === undefined ? null : { name, offset: regionOffset, hasDefault: false, literal: null };
  }
  const bare = BARE_BINDING.exec(region);
  if (bare === null) {
    return null;
  }
  const name = bare[1];
  if (name === undefined) {
    return null;
  }
  const rest = region.slice(bare[0].length).trim();
  if (rest !== '' && !rest.startsWith(':')) {
    return null;
  }
  return { name, offset: regionOffset, hasDefault: false, literal: null };
}

function readBinding(code: string, part: BindingPart, bodyOffset: number): EnvBinding | null {
  const lead = part.text.length - part.text.trimStart().length;
  const base = bodyOffset + part.offset + lead;
  const text = part.text.trim();
  if (text === '' || text.startsWith('...')) {
    return null;
  }
  const equals = findAssignment(text);
  const keySlice = equals === -1 ? text : text.slice(0, equals);
  const keyLead = keySlice.length - keySlice.trimStart().length;
  const key = readBindingKey(keySlice.trimStart(), base + keyLead);
  if (key === null) {
    return null;
  }
  return {
    name: key.name,
    offset: key.offset,
    hasDefault: equals !== -1,
    literal: equals === -1 ? null : readLiteral(code, base + equals + 1),
  };
}

function readImportBinding(part: BindingPart, bodyOffset: number): EnvBinding | null {
  const lead = part.text.length - part.text.trimStart().length;
  const text = part.text.trim();
  if (text === '' || /^type\s/.test(text)) {
    return null;
  }
  const name = BARE_BINDING.exec(text);
  if (name === null || name[1] === undefined) {
    return null;
  }
  return {
    name: name[1],
    offset: bodyOffset + part.offset + lead,
    hasDefault: false,
    literal: null,
  };
}

function readDestructuring(
  context: ExtractionContext,
  masked: MaskedCode,
  regex: RegExp,
  accessor: string,
): void {
  for (const match of matchAll(regex, masked.code)) {
    const body = match[1];
    if (body === undefined || masked.inString[match.index] === 1) {
      continue;
    }
    const bodyOffset = match.index + 1;
    for (const part of splitParts(body)) {
      const binding = readBinding(masked.code, part, bodyOffset);
      if (binding === null) {
        continue;
      }
      emitAt(context, masked, binding.offset, {
        name: binding.name,
        accessor,
        hasFallback: binding.hasDefault,
        required: false,
        fallbackLiteral: binding.literal,
      });
    }
  }
}

const jsExtractors: readonly Extractor[] = [
  jsMemberExtractor(
    'js-process-env',
    'process.env',
    'process.env.NAME, process.env["NAME"] and the ?? / || fallback forms',
    new RegExp(`${JS_GLOBALS}process\\s*\\??\\.\\s*env\\s*\\??\\.\\s*(${IDENTIFIER})`, 'g'),
    new RegExp(`${JS_GLOBALS}process\\s*\\??\\.\\s*env\\s*(?:\\??\\.\\s*)?\\[\\s*(['"])(${IDENTIFIER})\\1(?=\\s*\\])`, 'g'),
  ),
  plainExtractor(
    'js-process-env-destructuring',
    'process.env',
    ['javascript', 'typescript'],
    'const { PORT, HOST: h, API_KEY = "x" } = process.env, one usage per binding',
    (context, masked) => {
      readDestructuring(
        context,
        masked,
        new RegExp(`\\{([^{}]{0,500})\\}\\s*(?::[^=;]*)?=\\s*${JS_GLOBALS}process\\s*\\.\\s*env\\b`, 'g'),
        'process.env',
      );
    },
  ),
  jsMemberExtractor(
    'js-import-meta-env',
    'import.meta.env',
    'Vite import.meta.env, with the built-ins MODE, DEV, PROD, SSR and BASE_URL excluded',
    new RegExp(`${JS_GLOBALS}import\\s*\\.\\s*meta\\s*\\.\\s*env\\s*\\.\\s*(${IDENTIFIER})`, 'g'),
    new RegExp(`${JS_GLOBALS}import\\s*\\.\\s*meta\\s*\\.\\s*env\\s*(?:\\??\\.\\s*)?\\[\\s*(['"])(${IDENTIFIER})\\1(?=\\s*\\])`, 'g'),
    (name) => VITE_BUILT_INS.has(name),
  ),
  jsMemberExtractor(
    'js-bun-env',
    'Bun.env',
    'Bun.env.NAME and Bun.env["NAME"]',
    new RegExp(`${JS_GLOBALS}Bun\\s*\\.\\s*env\\s*\\.\\s*(${IDENTIFIER})`, 'g'),
    new RegExp(`${JS_GLOBALS}Bun\\s*\\.\\s*env\\s*(?:\\??\\.\\s*)?\\[\\s*(['"])(${IDENTIFIER})\\1(?=\\s*\\])`, 'g'),
  ),
  ...tableExtractors([
    {
      id: 'js-deno-env-get',
      accessor: 'Deno.env.get',
      languages: ['javascript', 'typescript'],
      comment: 'Deno.env.get("NAME") and its two-argument default form',
      source: `${JS_GLOBALS}Deno\\s*\\.\\s*env\\s*\\.\\s*get\\s*\\(\\s*(['"])(${IDENTIFIER})\\1(?=\\s*[,)])`,
      nameGroup: 2,
      report: 'quotedName',
      required: false,
      hasFallback: false,
      requireCode: true,
      follow: 'callArgument',
    },
  ]),
  plainExtractor(
    'js-env-static-import',
    '$env/static/private',
    ['javascript', 'typescript'],
    "import { NAME } from '$env/static/private' or '$env/static/public'",
    (context, masked) => {
      for (const match of matchAll(STATIC_ENV_IMPORT, masked.code)) {
        const specifiers = match[1];
        const module = match[2];
        if (specifiers === undefined || module === undefined) {
          continue;
        }
        const bodyOffset = match.index + match[0].indexOf('{') + 1;
        for (const part of splitParts(specifiers)) {
          const binding = readImportBinding(part, bodyOffset);
          if (binding === null) {
            continue;
          }
          const at = positionAt(masked, binding.offset);
          context.push(
            {
              name: binding.name,
              file: context.file,
              line: at.line,
              column: at.column,
              language: context.language,
              accessor: module,
              hasFallback: false,
              required: true,
              viaImport: true,
              fallbackLiteral: null,
            },
            { file: context.file, line: at.line, column: at.column },
          );
        }
      }
    },
  ),
  plainExtractor(
    'js-env-dynamic-import',
    '$env/dynamic/private',
    ['javascript', 'typescript'],
    "import { env } from '$env/dynamic/private', then env.NAME reads in that file",
    (context, masked) => {
      for (const match of matchAll(DYNAMIC_ENV_IMPORT, masked.code)) {
        const specifiers = match[1];
        const module = match[2];
        if (specifiers === undefined || module === undefined) {
          continue;
        }
        const bodyOffset = match.index + match[0].indexOf('{') + 1;
        for (const part of splitParts(specifiers)) {
          const binding = readImportBinding(part, bodyOffset);
          if (binding === null) {
            continue;
          }
          emitDynamicEnvUsages(context, masked, binding.name, module);
        }
      }
    },
  ),
];

function jsMemberExtractor(
  id: string,
  accessor: string,
  comment: string,
  dot: RegExp,
  bracket: RegExp,
  skip?: (name: string) => boolean,
): Extractor {
  return plainExtractor(id, accessor, ['javascript', 'typescript'], comment, (context, masked) => {
    for (const match of matchAll(dot, masked.code)) {
      const name = match[1];
      if (name === undefined || masked.inString[match.index] === 1) {
        continue;
      }
      if (skip?.(name) === true) {
        continue;
      }
      const end = match.index + match[0].length;
      const adjustment = followCoalesce(masked.code, end);
      emitAt(context, masked, end - name.length, {
        name,
        accessor,
        hasFallback: adjustment?.hasFallback ?? false,
        required: false,
        fallbackLiteral: adjustment?.fallbackLiteral ?? null,
      });
    }
    for (const match of matchAll(bracket, masked.code)) {
      const name = match[2];
      if (name === undefined || masked.inString[match.index] === 1) {
        continue;
      }
      if (skip?.(name) === true) {
        continue;
      }
      const end = match.index + match[0].length;
      const adjustment = followCoalesce(masked.code, end);
      emitAt(context, masked, end - name.length - 2, {
        name,
        accessor,
        hasFallback: adjustment?.hasFallback ?? false,
        required: false,
        fallbackLiteral: adjustment?.fallbackLiteral ?? null,
      });
    }
  });
}

function emitDynamicEnvUsages(
  context: ExtractionContext,
  masked: MaskedCode,
  binding: string,
  module: string,
): void {
  const prefix = `(?<![\\w.$])${escapeRegExp(binding)}`;
  for (const match of matchAll(new RegExp(`${prefix}${DYNAMIC_DOT_SUFFIX}`, 'g'), masked.code)) {
    const name = match[1];
    if (name === undefined || masked.inString[match.index] === 1) {
      continue;
    }
    emitAt(context, masked, match.index + match[0].length - name.length, {
      name,
      accessor: module,
      hasFallback: false,
      required: false,
      viaImport: true,
    });
  }
  for (const match of matchAll(new RegExp(`${prefix}${DYNAMIC_BRACKET_SUFFIX}`, 'g'), masked.code)) {
    const name = match[2];
    if (name === undefined || masked.inString[match.index] === 1) {
      continue;
    }
    emitAt(context, masked, match.index + match[0].length - name.length - 2, {
      name,
      accessor: module,
      hasFallback: false,
      required: false,
      viaImport: true,
    });
  }
}

const pythonExtractors: readonly Extractor[] = [
  ...tableExtractors([
    {
      id: 'py-os-environ-index',
      accessor: 'os.environ',
      languages: ['python'],
      comment: "os.environ['NAME'] raises KeyError when unset; the assignment form is a write",
      source: `(?<![\\w.])os\\s*\\.\\s*environ\\s*\\[\\s*(['"])(${IDENTIFIER})\\1(?=\\s*\\])`,
      nameGroup: 2,
      report: 'quotedName',
      required: true,
      hasFallback: false,
      requireCode: true,
      skipWrite: true,
    },
    {
      id: 'py-os-environ-get',
      accessor: 'os.environ',
      languages: ['python'],
      comment: "os.environ.get('NAME') and os.environ.get('NAME', 'dev')",
      source: `(?<![\\w.])os\\s*\\.\\s*environ\\s*\\.\\s*get\\s*\\(\\s*(['"])(${IDENTIFIER})\\1(?=\\s*[,)])`,
      nameGroup: 2,
      report: 'quotedName',
      required: false,
      hasFallback: false,
      requireCode: true,
      follow: 'callArgument',
    },
    {
      id: 'py-os-environ-setdefault',
      accessor: 'os.environ',
      languages: ['python'],
      comment: "os.environ.setdefault('NAME', 'dev'), a read that also seeds a default",
      source: `(?<![\\w.])os\\s*\\.\\s*environ\\s*\\.\\s*setdefault\\s*\\(\\s*(['"])(${IDENTIFIER})\\1(?=\\s*[,)])`,
      nameGroup: 2,
      report: 'quotedName',
      required: false,
      hasFallback: false,
      requireCode: true,
      follow: 'callArgument',
    },
    {
      id: 'py-os-getenv',
      accessor: 'os.getenv',
      languages: ['python'],
      comment: "os.getenv('NAME') and os.getenv('NAME', 'dev')",
      source: `(?<![\\w.])os\\s*\\.\\s*getenv\\s*\\(\\s*(['"])(${IDENTIFIER})\\1(?=\\s*[,)])`,
      nameGroup: 2,
      report: 'quotedName',
      required: false,
      hasFallback: false,
      requireCode: true,
      follow: 'callArgument',
    },
  ]),
  plainExtractor(
    'py-environ-import',
    'os.environ',
    ['python'],
    "from os import environ, then environ['NAME'] and environ.get('NAME')",
    (context, masked) => {
      const bindings = new Set<string>();
      for (const match of matchAll(PY_ENVIRON_IMPORT, masked.code)) {
        if (match[1] === 'environ') {
          bindings.add(match[2] ?? 'environ');
        }
      }
      for (const binding of [...bindings].sort(compareText)) {
        const escaped = escapeRegExp(binding);
        const bracket = new RegExp(
          `(?<![\\w.])${escaped}\\s*\\[\\s*(['"])(${IDENTIFIER})\\1(?=\\s*\\])`,
          'g',
        );
        const method = new RegExp(
          `(?<![\\w.])${escaped}\\s*\\.\\s*(get|setdefault)\\s*\\(\\s*(['"])(${IDENTIFIER})\\2(?=\\s*[,)])`,
          'g',
        );
        for (const match of matchAll(bracket, masked.code)) {
          const name = match[2];
          if (name === undefined || masked.inString[match.index] === 1) {
            continue;
          }
          const end = match.index + match[0].length;
          if (isWriteAfter(masked.code, end)) {
            continue;
          }
          emitAt(context, masked, end - name.length - 2, {
            name,
            accessor: 'os.environ',
            hasFallback: false,
            required: true,
          });
        }
        for (const match of matchAll(method, masked.code)) {
          const name = match[3];
          if (name === undefined || masked.inString[match.index] === 1) {
            continue;
          }
          const end = match.index + match[0].length;
          const adjustment = followCallArgument(masked.code, end);
          emitAt(context, masked, end - name.length - 2, {
            name,
            accessor: 'os.environ',
            hasFallback: adjustment?.hasFallback ?? false,
            required: false,
            fallbackLiteral: adjustment?.fallbackLiteral ?? null,
          });
        }
      }
    },
  ),
  plainExtractor(
    'py-pydantic-settings',
    'BaseSettings',
    ['python'],
    'pydantic-settings: every annotated field of a class deriving from BaseSettings',
    (context, masked) => {
      for (const header of matchAll(PY_CLASS_HEADER, masked.code)) {
        const base = header[2];
        if (base === undefined || !/Settings$/.test(base)) {
          continue;
        }
        const start = masked.code.indexOf('\n', header.index + header[0].length);
        for (const field of readClassFields(masked.code, start === -1 ? masked.code.length : start + 1, (header[1] ?? '').length)) {
          if (SETTINGS_FIELDS_TO_SKIP.some((pattern) => pattern.test(field.name))) {
            continue;
          }
          emitAt(context, masked, field.offset, {
            name: field.name,
            accessor: 'BaseSettings',
            hasFallback: field.hasDefault,
            required: !field.hasDefault,
            fallbackLiteral: field.literal,
          });
        }
      }
    },
  ),
];

function readClassFields(code: string, start: number, classIndent: number): readonly ClassField[] {
  const fields: ClassField[] = [];
  let lineStart = start;
  while (lineStart <= code.length) {
    const breakAt = code.indexOf('\n', lineStart);
    const end = breakAt === -1 ? code.length : breakAt;
    const line = code.slice(lineStart, end).replace(/\r$/, '');
    if (line.trim() !== '') {
      const trimmed = line.trimStart();
      const indent = line.length - trimmed.length;
      if (indent <= classIndent || trimmed.startsWith('class ')) {
        break;
      }
      const field = PY_FIELD.exec(line);
      if (field !== null && field[2] !== undefined) {
        const value = field[3] ?? '';
        const equals = findAssignment(value);
        fields.push({
          name: field[2],
          offset: lineStart + indent,
          hasDefault: equals !== -1,
          literal: equals === -1 ? null : readLiteral(value, equals + 1),
        });
      }
    }
    if (breakAt === -1) {
      break;
    }
    lineStart = breakAt + 1;
  }
  return fields;
}

const goExtractors: readonly Extractor[] = tableExtractors([
  {
    id: 'go-os-getenv',
    accessor: 'os.Getenv',
    languages: ['go'],
    comment: 'os.Getenv("NAME"), empty string when unset',
    source: `(?<![\\w.])os\\s*\\.\\s*Getenv\\s*\\(\\s*(['"\`])(${IDENTIFIER})\\1(?=\\s*\\))`,
    nameGroup: 2,
    report: 'quotedName',
    required: false,
    hasFallback: false,
    requireCode: true,
  },
  {
    id: 'go-bare-getenv',
    accessor: 'os.Getenv',
    languages: ['go'],
    comment: 'Getenv("NAME") in the bare call form, only after import "os"',
    source: `(?<![\\w.])Getenv\\s*\\(\\s*(['"\`])(${IDENTIFIER})\\1(?=\\s*\\))`,
    nameGroup: 2,
    report: 'quotedName',
    required: false,
    hasFallback: false,
    requireCode: true,
    gate: (code) => GO_IMPORT_OS.test(code),
  },
  {
    id: 'go-os-lookupenv',
    accessor: 'os.LookupEnv',
    languages: ['go'],
    comment: 'os.LookupEnv("NAME"), a presence check that handles the absent case',
    source: `(?<![\\w.])os\\s*\\.\\s*LookupEnv\\s*\\(\\s*(['"\`])(${IDENTIFIER})\\1(?=\\s*\\))`,
    nameGroup: 2,
    report: 'quotedName',
    required: false,
    hasFallback: true,
    requireCode: true,
  },
]);

const rustExtractors: readonly Extractor[] = tableExtractors([
  {
    id: 'rust-env-var',
    accessor: 'env::var',
    languages: ['rust'],
    comment: 'env::var("NAME") with unwrap and expect required, unwrap_or a fallback',
    source: `(?<![\\w:.])(?:std\\s*::\\s*env\\s*::\\s*var|dotenvy\\s*::\\s*var|dotenv\\s*::\\s*var|env\\s*::\\s*var)\\s*\\(\\s*"(${IDENTIFIER})"`,
    nameGroup: 1,
    report: 'quotedName',
    required: false,
    hasFallback: false,
    requireCode: true,
    follow: 'rustChain',
  },
  {
    id: 'rust-bare-var',
    accessor: 'env::var',
    languages: ['rust'],
    comment: 'var("NAME") in the bare call form, only after use std::env::var',
    source: `(?<![\\w:.])var\\s*\\(\\s*"(${IDENTIFIER})"`,
    nameGroup: 1,
    report: 'quotedName',
    required: false,
    hasFallback: false,
    requireCode: true,
    follow: 'rustChain',
    gate: (code) => RUST_USE_VAR.test(code),
  },
]);

const jvmExtractors: readonly Extractor[] = tableExtractors([
  {
    id: 'jvm-system-getenv',
    accessor: 'System.getenv',
    languages: ['java', 'kotlin'],
    comment: 'System.getenv("NAME") and System.getenv().get("NAME")',
    source: `(?<![\\w.])System\\s*\\.\\s*getenv\\s*\\(\\s*(?:\\)\\s*\\.\\s*get\\s*\\(\\s*)?(['"])(${IDENTIFIER})\\1(?=\\s*[,)])`,
    nameGroup: 2,
    report: 'quotedName',
    required: false,
    hasFallback: false,
    requireCode: true,
  },
  {
    id: 'jvm-system-getproperty',
    accessor: 'System.getProperty',
    languages: ['java', 'kotlin'],
    comment: 'System.getProperty("NAME") for JVM system properties',
    source: `(?<![\\w.])System\\s*\\.\\s*getProperty\\s*\\(\\s*(['"])(${IDENTIFIER})\\1(?=\\s*[,)])`,
    nameGroup: 2,
    report: 'quotedName',
    required: false,
    hasFallback: false,
    requireCode: true,
    follow: 'callArgument',
  },
]);

const csharpExtractors: readonly Extractor[] = tableExtractors([
  {
    id: 'cs-get-environment-variable',
    accessor: 'Environment.GetEnvironmentVariable',
    languages: ['csharp'],
    comment: 'Environment.GetEnvironmentVariable("NAME") with its optional target argument',
    source: `(?<![\\w.])Environment\\s*\\.\\s*GetEnvironmentVariable\\s*\\(\\s*(['"])(${IDENTIFIER})\\1(?=\\s*[,)])`,
    nameGroup: 2,
    report: 'quotedName',
    required: false,
    hasFallback: false,
    requireCode: true,
  },
  {
    id: 'cs-iconfiguration',
    accessor: 'IConfiguration',
    languages: ['csharp'],
    comment: 'builder.Configuration["NAME"] and configuration["NAME"]',
    source: `(?<![\\w.])(?:[A-Za-z_][A-Za-z0-9_]*\\s*\\.\\s*)*(?:[Cc]onfiguration|IConfiguration)\\s*\\[\\s*(['"])(${IDENTIFIER})\\1(?=\\s*\\])`,
    nameGroup: 2,
    report: 'quotedName',
    required: false,
    hasFallback: false,
    requireCode: true,
  },
  {
    id: 'cs-get-connection-string',
    accessor: 'GetConnectionString',
    languages: ['csharp'],
    comment: 'Configuration.GetConnectionString("NAME"), which throws when it is absent',
    source: `(?<![\\w.])(?:[A-Za-z_][A-Za-z0-9_]*\\s*\\.\\s*)*GetConnectionString\\s*\\(\\s*(['"])(${IDENTIFIER})\\1(?=\\s*\\))`,
    nameGroup: 2,
    report: 'quotedName',
    required: true,
    hasFallback: false,
    requireCode: true,
  },
]);

const rubyExtractors: readonly Extractor[] = tableExtractors([
  {
    id: 'rb-env-index',
    accessor: 'ENV',
    languages: ['ruby'],
    comment: "ENV['NAME'], which is nil when unset, and its || fallback form",
    source: `(?<![\\w.])ENV\\s*\\[\\s*(['"])(${IDENTIFIER})\\1(?=\\s*\\])`,
    nameGroup: 2,
    report: 'quotedName',
    required: true,
    hasFallback: false,
    requireCode: true,
    follow: 'coalesce',
    skipWrite: true,
  },
  {
    id: 'rb-env-fetch',
    accessor: 'ENV.fetch',
    languages: ['ruby'],
    comment: "ENV.fetch('NAME'), with a second argument or a block as the fallback",
    source: `(?<![\\w.])ENV\\s*\\.\\s*fetch\\s*\\(\\s*(['"])(${IDENTIFIER})\\1(?=\\s*[,)])`,
    nameGroup: 2,
    report: 'quotedName',
    required: true,
    hasFallback: false,
    requireCode: true,
    follow: 'rubyFetch',
  },
]);

const phpExtractors: readonly Extractor[] = tableExtractors([
  {
    id: 'php-getenv',
    accessor: 'getenv',
    languages: ['php'],
    comment: "getenv('NAME') and getenv('NAME', true), whose second argument is a local-only flag",
    source: `(?<![\\w$])getenv\\s*\\(\\s*(['"])(${IDENTIFIER})\\1(?=\\s*[,)])`,
    nameGroup: 2,
    report: 'quotedName',
    required: false,
    hasFallback: false,
    requireCode: true,
  },
  {
    id: 'php-env-superglobal',
    accessor: '$_ENV',
    languages: ['php'],
    comment: "$_ENV['NAME'], a null when unset",
    source: `(?<![\\w$])\\$_ENV\\s*\\[\\s*(['"])(${IDENTIFIER})\\1(?=\\s*\\])`,
    nameGroup: 2,
    report: 'quotedName',
    required: false,
    hasFallback: false,
    requireCode: true,
    skipWrite: true,
  },
  {
    id: 'php-server-superglobal',
    accessor: '$_SERVER',
    languages: ['php'],
    comment: "$_SERVER['NAME'], a null when unset",
    source: `(?<![\\w$])\\$_SERVER\\s*\\[\\s*(['"])(${IDENTIFIER})\\1(?=\\s*\\])`,
    nameGroup: 2,
    report: 'quotedName',
    required: false,
    hasFallback: false,
    requireCode: true,
    skipWrite: true,
  },
  {
    id: 'php-laravel-env',
    accessor: 'env',
    languages: ['php'],
    comment: "Laravel env('NAME'), env('NAME', 'dev') and Env::get('NAME')",
    source: `(?<![\\w$])(?:env|Env\\s*::\\s*get)\\s*\\(\\s*(['"])(${IDENTIFIER})\\1(?=\\s*[,)])`,
    nameGroup: 2,
    report: 'quotedName',
    required: false,
    hasFallback: false,
    requireCode: true,
    follow: 'callArgument',
  },
]);

const perlExtractors: readonly Extractor[] = tableExtractors([
  {
    id: 'perl-env',
    accessor: '%ENV',
    languages: ['perl'],
    comment: '$ENV{NAME} and $ENV{\'NAME\'}, with the // fallback form',
    source: `(?<![\\w$])\\$ENV\\s*\\{\\s*(['"]?)(${IDENTIFIER})\\1\\s*\\}`,
    nameGroup: 2,
    report: 'perlEnv',
    required: false,
    hasFallback: false,
    requireCode: true,
    follow: 'definedOr',
  },
]);

const SHELL_PLAIN = new RegExp(`\\$\\{(${SHELL_NAME})\\}`, 'g');
const SHELL_OPERATOR = new RegExp(`\\$\\{(${SHELL_NAME})(:?[-?])(?=[^}])`, 'g');
const SHELL_BARE = new RegExp(`(?<![$\\\\])\\$(?!\\{)(${SHELL_NAME})`, 'g');
const PRINTENV = new RegExp(`(?<![\\w.$/\\\\-])printenv(?:[ \\t]+-{1,2}[A-Za-z][A-Za-z-]*)*[ \\t]+(${IDENTIFIER})(?![\\w-])`, 'g');

const shellExtractors: readonly Extractor[] = [
  plainExtractor(
    'sh-parameter',
    'shell-parameter',
    ['shell'],
    '$NAME, ${NAME}, ${NAME:-d}, ${NAME-d} and the required ${NAME:?msg} forms',
    (context, masked) => {
      emitShellParameters(context, masked, SHELL_OPERATOR, atNameTail, followShellOperator);
      emitShellParameters(context, masked, SHELL_PLAIN, atNameTail, followNone);
      emitShellParameters(context, masked, SHELL_BARE, atNameEnd, followNone);
    },
  ),
  plainExtractor(
    'sh-printenv',
    'printenv',
    ['shell'],
    'printenv NAME, a required bare-word argument; export NAME is a declaration',
    (context, masked) => {
      for (const match of matchAll(PRINTENV, masked.code)) {
        const name = match[1];
        if (name === undefined || masked.inString[match.index] === 1) {
          continue;
        }
        emitAt(context, masked, match.index + match[0].length - name.length, {
          name,
          accessor: 'printenv',
          hasFallback: false,
          required: true,
        });
      }
    },
  ),
];

function emitShellParameters(
  context: ExtractionContext,
  masked: MaskedCode,
  regex: RegExp,
  report: ReportOffset,
  follow: FollowRule,
): void {
  for (const match of matchAll(regex, masked.code)) {
    const name = match[1];
    if (name === undefined || masked.inString[match.index] === 1) {
      continue;
    }
    const end = match.index + match[0].length;
    const adjustment = follow(masked.code, end);
    emitAt(context, masked, report(match, name, end, 1), {
      name,
      accessor: 'shell-parameter',
      hasFallback: adjustment?.hasFallback ?? false,
      required: adjustment?.required ?? false,
      fallbackLiteral: adjustment?.fallbackLiteral ?? null,
    });
  }
}

const KNOWN_CMD_VARIABLES: ReadonlySet<string> = new Set([
  'CD',
  'ERRORLEVEL',
  'CMDEXTVERSION',
  'CMDCMDLINE',
  'DATE',
  'TIME',
  'RANDOM',
  'USERNAME',
  'USERDOMAIN',
  'COMPUTERNAME',
  'PATH',
  'PATHEXT',
  'PROMPT',
  'OS',
  'PROCESSOR_ARCHITECTURE',
  'NUMBER_OF_PROCESSORS',
  'HOMEDRIVE',
  'HOMEPATH',
  'TEMP',
  'TMP',
  'WINDIR',
  'COMSPEC',
  'APPDATA',
  'LOCALAPPDATA',
  'PROGRAMFILES',
  'SYSTEMROOT',
  'PUBLIC',
  'ALLUSERSPROFILE',
  'LOGONSERVER',
  'SESSIONNAME',
]);

const BATCH_PERCENT = new RegExp(`%(${BATCH_NAME})%`, 'g');
const BATCH_DEFINED = new RegExp(
  `(?:^|[ \\t])if[ \\t]+(?:not[ \\t]+)?defined[ \\t]+(${BATCH_NAME})(?![\\w])`,
  'gm',
);
const BATCH_SET = /(?:^|\n)[ \t]*set[ \t]+"?([A-Za-z_][A-Za-z0-9_]*)=[^\n]*$/i;

const batchExtractors: readonly Extractor[] = tableExtractors([
  {
    id: 'batch-parameter',
    accessor: 'batch-parameter',
    languages: ['batch'],
    comment: '%NAME% and if defined NAME, skipping the built-in CMD variables and set writes',
    source: `%(${BATCH_NAME})%`,
    nameGroup: 1,
    report: 'atNameTail',
    required: false,
    hasFallback: false,
    skip: isBatchWrite,
  },
  {
    id: 'batch-defined',
    accessor: 'batch-parameter',
    languages: ['batch'],
    comment: 'if defined NAME, the CMD existence test',
    source: `(?:^|[ \\t])if[ \\t]+(?:not[ \\t]+)?defined[ \\t]+(${BATCH_NAME})(?![\\w])`,
    nameGroup: 1,
    report: 'name',
    required: false,
    hasFallback: false,
    multiline: true,
    skip: isKnownCmdVariable,
  },
]);

function isKnownCmdVariable(name: string): boolean {
  return KNOWN_CMD_VARIABLES.has(name.toUpperCase());
}

function isBatchWrite(name: string, code: string, end: number): boolean {
  if (isKnownCmdVariable(name)) {
    return true;
  }
  const from = Math.max(0, end - MAX_TAIL_SLICE);
  const assigned = BATCH_SET.exec(code.slice(from, end))?.[1];
  return assigned !== undefined && assigned.toUpperCase() === name.toUpperCase();
}

const swiftExtractors: readonly Extractor[] = tableExtractors([
  {
    id: 'swift-process-environment',
    accessor: 'ProcessInfo.processInfo.environment',
    languages: ['swift'],
    comment: 'ProcessInfo.processInfo.environment["NAME"]',
    source: `(?<![\\w.])ProcessInfo\\s*\\.\\s*processInfo\\s*\\.\\s*environment\\s*\\[\\s*(['"])(${IDENTIFIER})\\1(?=\\s*\\])`,
    nameGroup: 2,
    report: 'quotedName',
    required: false,
    hasFallback: false,
    requireCode: true,
  },
  {
    id: 'swift-environment-foundation',
    accessor: 'ProcessInfo.processInfo.environment',
    languages: ['swift'],
    comment: 'environment["NAME"] in a file that imports Foundation or a framework that re-exports it',
    source: `(?<![\\w.])environment\\s*\\[\\s*(['"])(${IDENTIFIER})\\1(?=\\s*\\])`,
    nameGroup: 2,
    report: 'quotedName',
    required: false,
    hasFallback: false,
    requireCode: true,
    gate: (code) => /^[ \t]*import\s+(?:Foundation|SwiftUI|AppKit|UIKit)\b/m.test(code),
  },
]);

const dartExtractors: readonly Extractor[] = tableExtractors([
  {
    id: 'dart-platform-environment',
    accessor: 'Platform.environment',
    languages: ['dart'],
    comment: "Platform.environment['NAME'] and Platform.environment[\"NAME\"]",
    source: `(?<![\\w.])Platform\\s*\\.\\s*environment\\s*\\[\\s*(['"])(${IDENTIFIER})\\1(?=\\s*\\])`,
    nameGroup: 2,
    report: 'quotedName',
    required: false,
    hasFallback: false,
    requireCode: true,
  },
  {
    id: 'dart-string-from-environment',
    accessor: 'String.fromEnvironment',
    languages: ['dart'],
    comment: "String.fromEnvironment('NAME') for compile-time defines",
    source: `(?<![\\w.])String\\s*\\.\\s*fromEnvironment\\s*\\(\\s*(['"])(${IDENTIFIER})\\1(?=\\s*[,)])`,
    nameGroup: 2,
    report: 'quotedName',
    required: false,
    hasFallback: false,
    requireCode: true,
    follow: 'callArgument',
  },
]);

const elixirExtractors: readonly Extractor[] = tableExtractors([
  {
    id: 'ex-system-get-env',
    accessor: 'System.get_env',
    languages: ['elixir'],
    comment: 'System.get_env("NAME"), nil when unset',
    source: `(?<![\\w.])System\\s*\\.\\s*get_env\\s*\\(\\s*(['"])(${IDENTIFIER})\\1(?=\\s*\\))`,
    nameGroup: 2,
    report: 'quotedName',
    required: false,
    hasFallback: false,
    requireCode: true,
  },
  {
    id: 'ex-system-fetch-env',
    accessor: 'System.fetch_env',
    languages: ['elixir'],
    comment: 'System.fetch_env("NAME"), returning an :error tuple when unset',
    source: `(?<![\\w.])System\\s*\\.\\s*fetch_env\\s*\\(\\s*(['"])(${IDENTIFIER})\\1(?=\\s*\\))`,
    nameGroup: 2,
    report: 'quotedName',
    required: false,
    hasFallback: false,
    requireCode: true,
  },
  {
    id: 'ex-system-fetch-env-bang',
    accessor: 'System.fetch_env',
    languages: ['elixir'],
    comment: 'System.fetch_env!("NAME"), which raises when unset',
    source: `(?<![\\w.])System\\s*\\.\\s*fetch_env!\\s*\\(\\s*(['"])(${IDENTIFIER})\\1(?=\\s*\\))`,
    nameGroup: 2,
    report: 'quotedName',
    required: true,
    hasFallback: false,
    requireCode: true,
  },
]);

const EXTRACTORS: readonly Extractor[] = [
  ...jsExtractors,
  ...pythonExtractors,
  ...goExtractors,
  ...rustExtractors,
  ...jvmExtractors,
  ...csharpExtractors,
  ...rubyExtractors,
  ...phpExtractors,
  ...perlExtractors,
  ...shellExtractors,
  ...batchExtractors,
  ...swiftExtractors,
  ...dartExtractors,
  ...elixirExtractors,
];

/** Accessor list used by the rules engine and the `why` command. */
export function supportedAccessors(): readonly Extractor[] {
  return EXTRACTORS;
}

function compareUsages(left: EnvUsage, right: EnvUsage): number {
  return (
    left.line - right.line ||
    left.column - right.column ||
    compareText(left.name, right.name) ||
    compareText(left.accessor, right.accessor) ||
    compareText(left.file, right.file)
  );
}

function sameUsage(left: EnvUsage, right: EnvUsage): boolean {
  return (
    left.name === right.name &&
    left.file === right.file &&
    left.line === right.line &&
    left.column === right.column &&
    left.accessor === right.accessor &&
    left.hasFallback === right.hasFallback &&
    left.required === right.required &&
    left.viaImport === right.viaImport &&
    left.fallbackLiteral === right.fallbackLiteral
  );
}

function sortAndDedupe(usages: readonly EnvUsage[]): readonly EnvUsage[] {
  const sorted = [...usages].sort(compareUsages);
  const unique: EnvUsage[] = [];
  let previous: EnvUsage | null = null;
  for (const usage of sorted) {
    if (previous !== null && sameUsage(previous, usage)) {
      continue;
    }
    unique.push(usage);
    previous = usage;
  }
  return unique;
}

/** Extracts every env read in one in-memory file, sorted and de-duplicated. */
export function scanTextFile(file: ScannedFile): readonly EnvUsage[] {
  if (file.language === 'unknown') {
    return [];
  }
  const usages: EnvUsage[] = [];
  const context: ExtractionContext = {
    file: file.path,
    language: file.language,
    text: file.text,
    lines: file.lines,
    push(usage, location) {
      usages.push(
        location === undefined
          ? usage
          : { ...usage, file: location.file, line: location.line, column: location.column },
      );
    },
  };
  for (const extractor of EXTRACTORS) {
    if (!extractor.languages.includes(file.language)) {
      continue;
    }
    try {
      extractor.extract(context);
    } catch {
      continue;
    }
  }
  return sortAndDedupe(usages);
}

/**
 * Reads and scans every scannable file into one flat, sorted, de-duplicated list.
 *
 * Files whose language is `unknown` are never scanned, so a `process.env.X`
 * inside a Markdown fence, a YAML value or a JSON document is intentionally
 * NOT reported. Binary files, files larger than 8 MB and unreadable files are
 * skipped silently; a malformed file yields fewer usages, never an exception.
 */
export async function scanCode(files: readonly WalkedFile[]): Promise<readonly EnvUsage[]> {
  const usages: EnvUsage[] = [];
  for (const file of files) {
    if (file.language === 'unknown' || file.bytes > MAX_CODE_FILE_BYTES) {
      continue;
    }
    let text: string;
    try {
      const buffer = await readFile(file.absolutePath);
      if (isProbablyBinary(buffer)) {
        continue;
      }
      text = buffer.toString('utf8');
    } catch {
      continue;
    }
    try {
      const usagesInFile = scanTextFile({
        path: file.relativePath,
        language: file.language,
        text,
        lines: text.split('\n'),
      });
      appendAll(usages, usagesInFile);
    } catch {
      continue;
    }
  }
  return sortAndDedupe(usages);
}

/** Position of a usage, for findings and code frames. */
export function usageLocation(usage: EnvUsage): SourceLocation {
  return { file: usage.file, line: usage.line, column: usage.column };
}
