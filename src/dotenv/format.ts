import type { EnvFile } from './parse.js';
import type { EnvVarDecl } from '../types.js';

export interface SerializeOptions {
  readonly kind?: EnvFile['kind'];
  readonly sort?: boolean;
  readonly header?: readonly string[];
  readonly finalNewline?: boolean;
  readonly eol?: '\n' | '\r\n';
  readonly quoteStyle?: 'preserve' | 'auto' | 'double' | 'single';
  readonly dedupe?: 'keep-all' | 'keep-first' | 'keep-last';
}

const SAFE_VALUE = /^[A-Za-z0-9_./:@+%,~?!=^-]+$/;
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/;

/** True when a bare value would be read differently by another loader without quotes. */
export function needsQuoting(value: string): boolean {
  if (value.length === 0) {
    return true;
  }
  if (!SAFE_VALUE.test(value)) {
    return true;
  }
  if (value !== value.trim()) {
    return true;
  }
  if (value.startsWith("'") || value.startsWith('"')) {
    return true;
  }
  return CONTROL.test(value);
}

/**
 * Escapes a value for a double-quoted dotenv scalar. `$` is deliberately left
 * alone: it is how dotenv-expand references another variable, and escaping it
 * would silently turn a reference into a literal dollar sign.
 */
const escapeDouble = (value: string): string =>
  value
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r')
    .replace(/\t/g, '\\t');

/** Renders a value as dotenv text, quoting and escaping only when it has to. */
export function normalizeValue(value: string): string {
  const flattened = value.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  if (flattened.includes('\n')) {
    return `"${escapeDouble(flattened)}"`;
  }
  if (needsQuoting(flattened)) {
    return `"${escapeDouble(flattened)}"`;
  }
  return flattened;
}

/** Removes `${NAME}` and `$NAME` references so the rest of a value can be judged. */
const withoutReferences = (value: string): string => value.replace(/\$\{[^}]*\}|\$[A-Za-z_][A-Za-z0-9_]*/g, '');

const renderValue = (decl: EnvVarDecl, style: NonNullable<SerializeOptions['quoteStyle']>): string => {
  if (style === 'auto') {
    return normalizeValue(decl.value);
  }
  if (style === 'double') {
    return `"${escapeDouble(decl.value)}"`;
  }
  if (style === 'single') {
    return decl.value.includes("'") ? `"${escapeDouble(decl.value)}"` : `'${decl.value}'`;
  }
  if (decl.quoted === '"') {
    return `"${escapeDouble(decl.value)}"`;
  }
  if (decl.quoted === "'" && !decl.value.includes("'")) {
    return `'${decl.value}'`;
  }
  if (decl.quoted === null) {
    const rest = withoutReferences(decl.value);
    if (rest.length === 0 || !needsQuoting(rest)) {
      return decl.value;
    }
  }
  return `"${escapeDouble(decl.value)}"`;
};

const renderComment = (text: string): string => (text.length === 0 ? '#' : `# ${text}`);

const renderLine = (decl: EnvVarDecl, style: NonNullable<SerializeOptions['quoteStyle']>): string => {
  const parts: string[] = [];
  if (decl.exported) {
    parts.push('export');
  }
  parts.push(`${decl.name}=`);
  if (decl.hasValue) {
    parts.push(renderValue(decl, style));
  }
  let line = parts.join(decl.exported ? ' ' : '');
  if (decl.unquotedInlineComment !== null && decl.unquotedInlineComment.length > 0) {
    line += ` ${decl.unquotedInlineComment}`;
  } else if (decl.quoted !== null && decl.inlineComment !== null && decl.inlineComment.length > 0) {
    line += ` # ${decl.inlineComment}`;
  }
  if (decl.hasTrailingWhitespace) {
    line += ' ';
  }
  return line;
};

const selectDecls = (
  decls: readonly EnvVarDecl[],
  dedupe: NonNullable<SerializeOptions['dedupe']>,
  sort: boolean,
): EnvVarDecl[] => {
  let selected = [...decls];
  if (dedupe === 'keep-first') {
    const seen = new Set<string>();
    selected = decls.filter((decl) => {
      if (seen.has(decl.name)) {
        return false;
      }
      seen.add(decl.name);
      return true;
    });
  } else if (dedupe === 'keep-last') {
    const last = new Map<string, EnvVarDecl>();
    for (const decl of decls) {
      last.set(decl.name, decl);
    }
    selected = decls.filter((decl) => last.get(decl.name) === decl);
  }
  if (sort) {
    selected.sort((a, b) => (a.file === b.file ? a.line - b.line : a.file < b.file ? -1 : a.file > b.file ? 1 : 0));
  }
  return selected;
};

/**
 * Canonical dotenv writer: the inverse of the reader. Comments, export prefixes,
 * quote characters, inline comments and trailing whitespace all survive a
 * parse/serialize round trip; blank lines are not preserved, because grouping in
 * a dotenv file is expressed with comments, which travel with their assignment.
 * `envgle fmt` deliberately does not use this: it rewrites files in place,
 * changing as little as possible.
 */
export function serializeEnvFile(file: EnvFile, options: SerializeOptions = {}): string {
  const eol = options.eol ?? '\n';
  const style = options.quoteStyle ?? 'preserve';
  const dedupe = options.dedupe ?? 'keep-all';
  const lines: string[] = [];

  for (const line of options.header ?? []) {
    lines.push(line.startsWith('#') ? line : renderComment(line));
  }
  if ((options.header ?? []).length > 0) {
    lines.push('');
  }

  for (const decl of selectDecls(file.decls, dedupe, options.sort === true)) {
    for (const comment of decl.leadingComments) {
      lines.push(renderComment(comment));
    }
    lines.push(renderLine(decl, style));
  }

  const body = lines.join(eol);
  const wantsFinalNewline = options.finalNewline !== false;
  if (body.length === 0) {
    return '';
  }
  return wantsFinalNewline ? `${body}${eol}` : body;
}
