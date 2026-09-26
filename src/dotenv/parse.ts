import { Buffer } from 'node:buffer';

import type { EnvFileKind, EnvParseIssue, EnvParseIssueKind, EnvVarDecl } from '../types.js';
import { hasControlCharacters, isEnvVarName } from '../utils/text.js';

/** Structural problem the parser could not recover from. */
export interface ParseDiagnostic {
  readonly line: number;
  readonly column: number;
  readonly message: string;
  readonly severity: 'error' | 'warn';
  readonly code: string;
}

export interface EnvFile {
  readonly path: string;
  readonly kind: EnvFileKind;
  readonly decls: readonly EnvVarDecl[];
  readonly issues: readonly EnvParseIssue[];
  readonly diagnostics: readonly ParseDiagnostic[];
  readonly bytes: number;
}

type DiagnosticCode =
  | 'unterminated-quote'
  | 'invalid-key'
  | 'no-separator'
  | 'trailing-garbage'
  | 'control-characters'
  | 'line-too-long'
  | 'unknown';

interface DiagnosticDraft {
  line: number;
  column: number;
  message: string;
  severity: 'error' | 'warn';
  code: DiagnosticCode;
}

interface QuotedScan {
  /** Escapes resolved (double quotes) or verbatim (single quotes), line breaks kept. */
  readonly value: string;
  /** The same text before escape resolution, used for reference extraction. */
  readonly raw: string;
  readonly terminated: boolean;
  /** Text after the closing quote on its own physical line. */
  readonly rest: string;
  /** 1-based column of the first character of `rest`, or 0 when there is none. */
  readonly restColumn: number;
  /** 1-based line on which the closing quote was found, or the last line of the file. */
  readonly lastLine: number;
}

interface UnquotedScan {
  readonly value: string;
  readonly raw: string;
  readonly unquotedInlineComment: string | null;
}

interface AssignmentHead {
  readonly name: string;
  readonly nameColumn: number;
  readonly exported: boolean;
  readonly hasSeparator: boolean;
  /** 0-based offset of the first character after `=` inside the physical line. */
  readonly valueOffset: number;
}

interface SegmentScan {
  readonly text: string;
  /** 0-based index of the closing quote inside the segment, or -1. */
  readonly quote: number;
}

interface ValueScan {
  readonly value: string;
  readonly raw: string;
  readonly hasValue: boolean;
  readonly quoted: '"' | "'" | null;
  readonly inlineComment: string | null;
  readonly unquotedInlineComment: string | null;
  readonly unterminated: boolean;
  readonly unterminatedColumn: number;
  readonly garbage: string | null;
  readonly garbageColumn: number;
  readonly lastLine: number;
}

const MAX_LINE_LENGTH = 2048;
const BOM = '\ufeff';
const LF = 10;
const CR = 13;
const HASH = 35;
const DOLLAR = 36;
const BACKSLASH = 92;
const CURLY_OPEN = 123;
const UNDERSCORE = 95;
const DIGIT_ZERO = 48;
const DIGIT_NINE = 57;
const NAME_START_MAX = 90;
const NAME_START_MIN = 65;
const LOWER_MIN = 97;
const LOWER_MAX = 122;
const MAX_ECHOED_NAME = 64;
const EXPORT_LENGTH = 6;

const isSpace = (char: string | undefined): boolean => char === ' ' || char === '\t';

/** Leading filler of an assignment: spaces, tabs and a stray byte order mark. */
const isLeading = (char: string | undefined): boolean => isSpace(char) || char === BOM;

const isNameStart = (code: number): boolean =>
  code === UNDERSCORE || (code >= NAME_START_MIN && code <= NAME_START_MAX);

const isNamePart = (code: number): boolean =>
  isNameStart(code) ||
  (code >= DIGIT_ZERO && code <= DIGIT_NINE) ||
  (code >= LOWER_MIN && code <= LOWER_MAX);

const isHexDigit = (code: number): boolean =>
  (code >= DIGIT_ZERO && code <= DIGIT_NINE) ||
  (code >= LOWER_MIN && code <= LOWER_MIN + 5) ||
  (code >= NAME_START_MIN && code <= NAME_START_MIN + 5);

const DOUBLE_QUOTE_ESCAPES: Readonly<Record<string, string>> = {
  n: '\n',
  r: '\r',
  t: '\t',
  f: '\f',
  b: '\b',
  v: '\v',
  '\\': '\\',
  '"': '"',
  "'": "'",
  $: '$',
  '0': '\u0000',
};

/** Splits on \n, \r\n and a lone \r, keeping the terminator off the returned line. */
const splitLines = (text: string): string[] => {
  const body = text.startsWith(BOM) ? text.slice(1) : text;
  const lines: string[] = [];
  let start = 0;
  let index = 0;
  while (index < body.length) {
    const code = body.charCodeAt(index);
    if (code === LF) {
      lines.push(body.slice(start, index));
      index += 1;
      start = index;
      continue;
    }
    if (code === CR) {
      lines.push(body.slice(start, index));
      index += body.charCodeAt(index + 1) === LF ? 2 : 1;
      start = index;
      continue;
    }
    index += 1;
  }
  if (start < body.length) {
    lines.push(body.slice(start));
  }
  return lines;
};

const normalizeComment = (comment: string): string => {
  const body = comment.startsWith('#') ? comment.slice(1) : comment;
  return (body.startsWith(' ') ? body.slice(1) : body).trim();
};

const scanAssignmentHead = (text: string): AssignmentHead => {
  let index = 0;
  while (isLeading(text[index])) {
    index += 1;
  }
  let exported = false;
  if (text.startsWith('export', index) && isSpace(text[index + EXPORT_LENGTH])) {
    exported = true;
    index += EXPORT_LENGTH;
    while (isSpace(text[index])) {
      index += 1;
    }
  }
  const nameColumn = index + 1;
  const separator = text.indexOf('=', index);
  if (separator === -1) {
    return { name: text.slice(index).trim(), nameColumn, exported, hasSeparator: false, valueOffset: text.length };
  }
  return { name: text.slice(index, separator).trim(), nameColumn, exported, hasSeparator: true, valueOffset: separator + 1 };
};

const INVALID_KEY_CHARACTERS = /[\s"'=:]/;

const isValidKey = (name: string): boolean => name.length > 0 && !INVALID_KEY_CHARACTERS.test(name);

const readNameLength = (text: string, start: number): number => {
  let length = 0;
  while (isNamePart(text.charCodeAt(start + length))) {
    length += 1;
  }
  return length;
};

const extractReferences = (raw: string): string[] => {
  const names: string[] = [];
  const seen = new Set<string>();
  let index = raw.indexOf('$');
  while (index !== -1) {
    const previous = index > 0 ? raw.charCodeAt(index - 1) : -1;
    const current = raw.charCodeAt(index + 1);
    const braced = current === CURLY_OPEN;
    const start = braced ? index + 2 : index + 1;
    const length = isNameStart(raw.charCodeAt(start)) ? readNameLength(raw, start) : 0;
    let next = index + 1;
    if (previous !== BACKSLASH && previous !== DOLLAR && length > 0) {
      const name = raw.slice(start, start + length);
      if (!seen.has(name)) {
        seen.add(name);
        names.push(name);
      }
      next = start + length;
    }
    index = raw.indexOf('$', next);
  }
  return names;
};

const scanQuotedSegment = (segment: string, closing: string): SegmentScan => {
  if (closing === "'") {
    const quote = segment.indexOf("'");
    return quote === -1 ? { text: segment, quote } : { text: segment.slice(0, quote), quote };
  }
  if (!segment.includes('\\')) {
    const quote = segment.indexOf('"');
    return quote === -1 ? { text: segment, quote } : { text: segment.slice(0, quote), quote };
  }
  let text = '';
  let index = 0;
  while (index < segment.length) {
    const char = segment.charAt(index);
    if (char === '"') {
      return { text, quote: index };
    }
    if (char !== '\\') {
      text += char;
      index += 1;
      continue;
    }
    const escape = segment.charAt(index + 1);
    if (escape === '') {
      text += char;
      index += 1;
      continue;
    }
    if (escape === 'x') {
      const first = segment.charCodeAt(index + 2);
      const second = segment.charCodeAt(index + 3);
      if (isHexDigit(first) && isHexDigit(second)) {
        text += String.fromCharCode(Number.parseInt(segment.slice(index + 2, index + 4), 16));
        index += 4;
        continue;
      }
      text += char;
      index += 1;
      continue;
    }
    const decoded = DOUBLE_QUOTE_ESCAPES[escape];
    if (decoded === undefined) {
      text += char;
      index += 1;
      continue;
    }
    text += decoded;
    index += 2;
  }
  return { text, quote: -1 };
};

const scanQuotedValue = (
  lines: readonly string[],
  lineIndex: number,
  offset: number,
  closing: string,
): QuotedScan => {
  const chunks: string[] = [];
  const raws: string[] = [];
  let index = lineIndex;
  let start = offset;
  let terminated = false;
  let rest = '';
  let restColumn = 0;
  while (index < lines.length) {
    const line = lines[index];
    if (line === undefined) {
      break;
    }
    const segment = line.slice(start);
    const scanned = scanQuotedSegment(segment, closing);
    chunks.push(scanned.text);
    if (scanned.quote === -1) {
      raws.push(segment);
      index += 1;
      start = 0;
      continue;
    }
    raws.push(segment.slice(0, scanned.quote));
    rest = segment.slice(scanned.quote + 1);
    restColumn = start + scanned.quote + 2;
    terminated = true;
    break;
  }
  return {
    value: chunks.join('\n'),
    raw: raws.join('\n'),
    terminated,
    rest,
    restColumn,
    lastLine: terminated ? index + 1 : lines.length,
  };
};

const scanUnquotedValue = (text: string, offset: number): UnquotedScan => {
  let start = offset;
  while (isSpace(text[start])) {
    start += 1;
  }
  const region = text.slice(start);
  let cut = -1;
  for (let index = 0; index < region.length; index += 1) {
    if (region.charCodeAt(index) !== HASH) {
      continue;
    }
    const before = index > 0 ? region.charAt(index - 1) : start > offset ? ' ' : '';
    if (isSpace(before)) {
      cut = index;
      break;
    }
  }
  if (cut === -1) {
    const value = region.trimEnd();
    return { value, raw: value, unquotedInlineComment: null };
  }
  const value = region.slice(0, cut).trimEnd();
  return { value, raw: value, unquotedInlineComment: region.slice(cut).trimEnd() };
};

const scanValue = (lines: readonly string[], lineIndex: number, text: string, head: AssignmentHead): ValueScan => {
  if (!head.hasSeparator) {
    return {
      value: '',
      raw: '',
      hasValue: false,
      quoted: null,
      inlineComment: null,
      unquotedInlineComment: null,
      unterminated: false,
      unterminatedColumn: 0,
      garbage: null,
      garbageColumn: 0,
      lastLine: lineIndex + 1,
    };
  }
  let start = head.valueOffset;
  while (isSpace(text[start])) {
    start += 1;
  }
  const quote = text.charAt(start);
  if (quote === '"' || quote === "'") {
    const scan = scanQuotedValue(lines, lineIndex, start + 1, quote);
    const rest = scan.rest;
    const trimmed = rest.trim();
    const garbageStart = rest.length - rest.trimStart().length;
    return {
      value: scan.value,
      raw: scan.raw,
      hasValue: true,
      quoted: quote,
      inlineComment: trimmed.startsWith('#') ? trimmed.slice(1).trim() : null,
      unquotedInlineComment: null,
      unterminated: !scan.terminated,
      unterminatedColumn: start + 1,
      garbage: trimmed.length > 0 && !trimmed.startsWith('#') ? trimmed : null,
      garbageColumn: scan.restColumn + garbageStart,
      lastLine: scan.lastLine,
    };
  }
  const scan = scanUnquotedValue(text, head.valueOffset);
  return {
    value: scan.value,
    raw: scan.raw,
    hasValue: scan.value.length > 0,
    quoted: null,
    inlineComment: null,
    unquotedInlineComment: scan.unquotedInlineComment,
    unterminated: false,
    unterminatedColumn: 0,
    garbage: null,
    garbageColumn: 0,
    lastLine: lineIndex + 1,
  };
};

const commentText = (line: string): string | null => {
  const trimmed = line.trim();
  return trimmed.length > 0 && trimmed.charCodeAt(0) === HASH ? normalizeComment(trimmed) : null;
};

const continuesValue = (next: string): boolean => next.trim().length > 0 && commentText(next) === null;

const echoableName = (name: string): string =>
  name.length <= MAX_ECHOED_NAME && isEnvVarName(name) ? name : 'the variable';

const invalidKeyMessage = (path: string, line: number, column: number): string =>
  `Invalid key at line ${line}, column ${column} in ${path}: expected NAME=value`;

const noSeparatorMessage = (path: string, line: number, column: number, name: string): string =>
  `${echoableName(name)} at line ${line}, column ${column} in ${path} has no "=" separator; the value appears to start on the next line`;

const unterminatedMessage = (path: string, line: number, column: number, quote: string): string =>
  `Unterminated ${quote === '"' ? 'double' : 'single'}-quoted value starting at line ${line}, column ${column} in ${path}: the closing quote is missing at end of file`;

const trailingGarbageMessage = (path: string, line: number, column: number): string =>
  `Unexpected text after the closing quote at line ${line}, column ${column} in ${path}: the rest of the line is ignored`;

const controlCharacterMessage = (path: string, line: number, column: number, name: string): string =>
  `The value of ${echoableName(name)} at line ${line}, column ${column} in ${path} contains a NUL or control character`;

const lineTooLongMessage = (path: string, line: number, length: number): string =>
  `Line ${line} in ${path} is ${length} characters long (limit ${MAX_LINE_LENGTH})`;

const pushIssue = (
  issues: EnvParseIssue[],
  kind: EnvParseIssueKind,
  message: string,
  file: string,
  line: number,
  column: number,
): void => {
  issues.push({ kind, message, file, line, column });
};

/** Parses one dotenv file into declarations, parse issues and non-fatal diagnostics. */
export function parseEnvFile(
  path: string,
  text: string,
  options: { kind: EnvVarDecl['kind']; shared: boolean; devOnly: boolean },
): EnvFile {
  const lines = splitLines(text);
  const decls: EnvVarDecl[] = [];
  const issues: EnvParseIssue[] = [];
  const diagnostics: DiagnosticDraft[] = [];
  const pendingComments: string[] = [];
  const firstDeclaration = new Map<string, number>();
  let position = 0;
  let skipThrough = 0;

  for (const line of lines) {
    position += 1;
    if (line.length > MAX_LINE_LENGTH) {
      diagnostics.push({
        line: position,
        column: 1,
        message: lineTooLongMessage(path, position, line.length),
        severity: 'warn',
        code: 'line-too-long',
      });
    }
    if (position <= skipThrough) {
      continue;
    }
    if (line.trim().length === 0) {
      pendingComments.length = 0;
      continue;
    }
    const comment = commentText(line);
    if (comment !== null) {
      pendingComments.push(comment);
      continue;
    }
    const head = scanAssignmentHead(line);
    const leadingComments = pendingComments.slice();
    pendingComments.length = 0;
    if (!isValidKey(head.name)) {
      pushIssue(issues, 'unknown', invalidKeyMessage(path, position, head.nameColumn), path, position, head.nameColumn);
      diagnostics.push({
        line: position,
        column: head.nameColumn,
        message: invalidKeyMessage(path, position, head.nameColumn),
        severity: 'error',
        code: 'invalid-key',
      });
      continue;
    }
    if (!head.hasSeparator && continuesValue(lines[position] ?? '')) {
      pushIssue(
        issues,
        'no-separator',
        noSeparatorMessage(path, position, head.nameColumn, head.name),
        path,
        position,
        head.nameColumn,
      );
      diagnostics.push({
        line: position,
        column: head.nameColumn,
        message: noSeparatorMessage(path, position, head.nameColumn, head.name),
        severity: 'error',
        code: 'no-separator',
      });
      continue;
    }
    const scan = scanValue(lines, position - 1, line, head);
    skipThrough = scan.lastLine;
    if (scan.unterminated && scan.quoted !== null) {
      const message = unterminatedMessage(path, position, scan.unterminatedColumn, scan.quoted);
      pushIssue(issues, 'unterminated-quote', message, path, position, scan.unterminatedColumn);
      diagnostics.push({
        line: position,
        column: scan.unterminatedColumn,
        message,
        severity: 'error',
        code: 'unterminated-quote',
      });
    }
    if (scan.garbage !== null) {
      diagnostics.push({
        line: scan.lastLine,
        column: scan.garbageColumn,
        message: trailingGarbageMessage(path, scan.lastLine, scan.garbageColumn),
        severity: 'warn',
        code: 'trailing-garbage',
      });
    }
    if (hasControlCharacters(scan.value)) {
      diagnostics.push({
        line: position,
        column: head.nameColumn,
        message: controlCharacterMessage(path, position, head.nameColumn, head.name),
        severity: 'warn',
        code: 'control-characters',
      });
    }
    const duplicateOfLine = firstDeclaration.get(head.name) ?? null;
    if (duplicateOfLine === null) {
      firstDeclaration.set(head.name, position);
    }
    decls.push({
      name: head.name,
      file: path,
      line: position,
      column: head.nameColumn,
      value: scan.value,
      hasValue: scan.hasValue,
      quoted: scan.quoted,
      exported: head.exported,
      references: extractReferences(scan.raw),
      duplicateOfLine,
      leadingComments,
      inlineComment: scan.inlineComment,
      unquotedInlineComment: scan.unquotedInlineComment,
      hasTrailingWhitespace: line.endsWith(' ') || line.endsWith('\t'),
      kind: options.kind,
      shared: options.shared,
      devOnly: options.devOnly,
    });
  }

  return { path, kind: options.kind, decls, issues, diagnostics, bytes: Buffer.byteLength(text, 'utf8') };
}
