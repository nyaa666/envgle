import type { InfraKind, InfraRef, SourceLocation } from '../types.js';

export interface YamlLine {
  readonly number: number;
  readonly indent: number;
  readonly text: string;
  readonly content: string;
  readonly blank: boolean;
  readonly comment: boolean;
}

export interface YamlDocument {
  readonly lines: readonly YamlLine[];
  readonly byNumber: ReadonlyMap<number, YamlLine>;
}

interface KeyLine {
  readonly index: number;
  readonly indent: number;
  readonly start: number;
  readonly end: number;
}

interface BraceScan {
  /** Index of the `}` that closes the group, or -1 when the group is never closed. */
  readonly close: number;
  /** Where a linear scan may continue after an unterminated group. */
  readonly resume: number;
}

const LINE_BREAK = /\r\n|\n|\r/;
const TRAILING_WHITESPACE = /[ \t]+$/;
const DOCUMENT_MARKER = '---';
const TOKEN_BOUNDARY = '=:,[{(';
const DOLLAR = 0x24;
const OPEN_PAREN = 0x28;
const HASH = 0x23;
const ZERO = 0x30;
const NINE = 0x39;
const COLON = 0x3a;
const QUESTION = 0x3f;
const UPPER_A = 0x41;
const UPPER_Z = 0x5a;
const UNDERSCORE = 0x5f;
const LOWER_A = 0x61;
const LOWER_Z = 0x7a;
const OPEN_BRACE = 0x7b;
const CLOSE_BRACE = 0x7d;

const isNameStart = (code: number): boolean =>
  (code >= UPPER_A && code <= UPPER_Z) || (code >= LOWER_A && code <= LOWER_Z) || code === UNDERSCORE;

const isNamePart = (code: number): boolean => isNameStart(code) || (code >= ZERO && code <= NINE);

const isSpace = (code: number): boolean => code === 0x20 || code === 0x09;

const isTokenStart = (text: string, index: number): boolean => {
  if (index === 0) {
    return true;
  }
  const previous = text.charAt(index - 1);
  return isSpace(previous.charCodeAt(0)) || TOKEN_BOUNDARY.includes(previous);
};

const indentOf = (text: string): number => {
  let indent = 0;
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    if (code === 0x20) {
      indent += 1;
      continue;
    }
    if (code === 0x09) {
      return -1;
    }
    break;
  }
  return indent;
};

const stripComment = (text: string): string => {
  let quote = '';
  for (let index = 0; index < text.length; index += 1) {
    const char = text.charAt(index);
    if (quote !== '') {
      if (char === '\\' && quote === '"') {
        index += 1;
        continue;
      }
      if (char === "'" && quote === "'" && text.charAt(index + 1) === "'") {
        index += 1;
        continue;
      }
      if (char === quote) {
        quote = '';
      }
      continue;
    }
    if (char === '"' || char === "'") {
      if (isTokenStart(text, index)) {
        quote = char;
      }
      continue;
    }
    if (char.charCodeAt(0) === HASH && (index === 0 || isSpace(text.charCodeAt(index - 1)))) {
      return text.slice(0, index);
    }
  }
  return text;
};

const contentOf = (text: string): string => {
  const trimmed = text.trimStart();
  if (trimmed.startsWith('#')) {
    return trimmed;
  }
  return stripComment(text).trim();
};

const unquote = (value: string): string => {
  if (value.length < 2) {
    return value;
  }
  const first = value.charAt(0);
  if ((first === '"' || first === "'") && value.endsWith(first)) {
    return value.slice(1, -1);
  }
  return value;
};

const keyColonAt = (content: string): number => {
  let quote = '';
  for (let index = 0; index < content.length; index += 1) {
    const char = content.charAt(index);
    if (quote !== '') {
      if (char === '\\' && quote === '"') {
        index += 1;
        continue;
      }
      if (char === "'" && quote === "'" && content.charAt(index + 1) === "'") {
        index += 1;
        continue;
      }
      if (char === quote) {
        quote = '';
      }
      continue;
    }
    if (char === '"' || char === "'") {
      if (isTokenStart(content, index)) {
        quote = char;
      }
      continue;
    }
    if (char !== ':') {
      continue;
    }
    if (index + 1 === content.length || isSpace(content.charCodeAt(index + 1))) {
      return index;
    }
  }
  return -1;
};

const keyLineAt = (lines: readonly YamlLine[], index: number): KeyLine | null => {
  const line = lines[index];
  if (line === undefined || line.blank || line.comment) {
    return null;
  }
  const content = line.content;
  if (content.startsWith('-')) {
    return null;
  }
  const colon = keyColonAt(content);
  if (colon === -1) {
    return null;
  }
  const raw = content.slice(0, colon);
  return {
    index,
    indent: line.indent,
    start: raw.length - raw.trimStart().length,
    end: colon,
  };
};

const keyTextOf = (line: YamlLine, match: KeyLine): string => unquote(line.content.slice(match.start, match.end).trim());

const findKeyLine = (lines: readonly YamlLine[], key: string, indent?: number): KeyLine | null => {
  let chosen: KeyLine | null = null;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (line === undefined) {
      continue;
    }
    if (indent !== undefined && line.indent !== indent) {
      continue;
    }
    const match = keyLineAt(lines, index);
    if (match === null || keyTextOf(line, match) !== key) {
      continue;
    }
    if (indent !== undefined) {
      return match;
    }
    if (chosen === null || match.indent < chosen.indent) {
      chosen = match;
    }
  }
  return chosen;
};

const blockAt = (lines: readonly YamlLine[], match: KeyLine): readonly YamlLine[] => {
  const collected: YamlLine[] = [];
  for (let index = match.index + 1; index < lines.length; index += 1) {
    const line = lines[index];
    if (line === undefined || line.blank) {
      continue;
    }
    if (line.indent <= match.indent) {
      break;
    }
    collected.push(line);
  }
  return collected;
};

/** Indentation based reader for the plain block-style subset of YAML used by CI and compose files. */
export function parseYaml(text: string): YamlDocument {
  const normalized = text.startsWith('\ufeff') ? text.slice(1) : text;
  const rawLines = normalized.split(LINE_BREAK);
  const lines: YamlLine[] = [];
  const byNumber = new Map<number, YamlLine>();
  for (let index = 0; index < rawLines.length; index += 1) {
    const rawLine = rawLines[index] ?? '';
    const cleaned = rawLine.replace(TRAILING_WHITESPACE, '');
    const indent = indentOf(cleaned);
    const parsed = contentOf(cleaned);
    const content = indent === 0 && parsed === DOCUMENT_MARKER ? '' : parsed;
    const line: YamlLine = {
      number: index + 1,
      indent,
      text: cleaned,
      content,
      blank: content === '',
      comment: content.startsWith('#'),
    };
    lines.push(line);
    byNumber.set(line.number, line);
  }
  return { lines, byNumber };
}

/** Yields the lines of the block whose entries sit at the given indent under `key`. */
export function blockOf(document: YamlDocument, key: string, indent?: number): readonly YamlLine[] {
  const match = findKeyLine(document.lines, key, indent);
  return match === null ? [] : blockAt(document.lines, match);
}

const scanBraces = (text: string, open: number): BraceScan => {
  let depth = 0;
  let lastOpen = open;
  for (let index = open + 1; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    if (code === OPEN_BRACE) {
      depth += 1;
      lastOpen = index;
      continue;
    }
    if (code === CLOSE_BRACE) {
      depth -= 1;
      if (depth === 0) {
        return { close: index, resume: index + 1 };
      }
    }
  }
  return { close: -1, resume: lastOpen > open ? lastOpen - 1 : open + 1 };
};

const nameEndAt = (text: string, start: number): number => {
  let index = start;
  while (index < text.length && isNamePart(text.charCodeAt(index))) {
    index += 1;
  }
  return index;
};

const operatorIsRequired = (text: string, nameEnd: number): boolean => {
  const code = text.charCodeAt(nameEnd);
  if (code === QUESTION) {
    return true;
  }
  if (code !== COLON) {
    return false;
  }
  return text.charCodeAt(nameEnd + 1) === QUESTION;
};

const interpolationRef = (name: string, line: number, column: number, kind: InfraKind, required: boolean): InfraRef => ({
  name,
  file: '',
  line,
  column,
  kind,
  required,
  refersToFile: false,
  interpolation: true,
});

/** ${VAR}, ${VAR:-default}, ${VAR:?error}, ${VAR-default} and $VAR references with positions. */
export function findInterpolations(
  text: string,
  line: number,
  columnOffset: number,
  kinds: readonly InfraKind[],
): readonly InfraRef[] {
  const kind = kinds[0];
  const refs: InfraRef[] = [];
  if (kind === undefined) {
    return refs;
  }
  let index = 0;
  while (index < text.length) {
    if (text.charCodeAt(index) !== DOLLAR) {
      index += 1;
      continue;
    }
    const first = text.charCodeAt(index + 1);
    if (first === DOLLAR || first === OPEN_PAREN) {
      index += 2;
      continue;
    }
    if (first === OPEN_BRACE) {
      if (text.charCodeAt(index + 2) === OPEN_BRACE) {
        index += 3;
        continue;
      }
      if (!isNameStart(text.charCodeAt(index + 2))) {
        index += 2;
        continue;
      }
      const braces = scanBraces(text, index);
      if (braces.close === -1) {
        index = Math.max(index + 2, braces.resume);
        continue;
      }
      const nameEnd = nameEndAt(text, index + 2);
      refs.push(interpolationRef(text.slice(index + 2, nameEnd), line, columnOffset + index + 1, kind, operatorIsRequired(text, nameEnd)));
      index = braces.close + 1;
      continue;
    }
    if (!isNameStart(first) || (index > 0 && isNamePart(text.charCodeAt(index - 1)))) {
      index += 1;
      continue;
    }
    const nameEnd = nameEndAt(text, index + 1);
    refs.push(interpolationRef(text.slice(index + 1, nameEnd), line, columnOffset + index + 1, kind, false));
    index = nameEnd;
  }
  return refs;
}

/** Projects an infra reference onto the report location shape. */
export function refLocation(ref: InfraRef): SourceLocation {
  return { file: ref.file, line: ref.line, column: ref.column };
}
