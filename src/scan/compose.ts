import { isEnvVarName, toPosix } from '../utils/text.js';
import { blockOf, findInterpolations } from './yaml.js';
import type { InfraRef } from '../types.js';
import type { YamlDocument, YamlLine } from './yaml.js';

export interface ComposeScanOptions {
  readonly envFileNames: readonly string[];
  readonly isOverride: boolean;
}

export interface ComposeScanResult {
  readonly refs: readonly InfraRef[];
  readonly serviceNames: readonly string[];
  readonly referencedEnvFiles: readonly InfraRef[];
  readonly composeFileName: string;
  readonly isOverride: boolean;
}

interface Entry {
  readonly key: string;
  readonly keyStart: number;
  readonly value: string;
  readonly valueStart: number;
  readonly dash: number;
  readonly mapped: boolean;
}

interface Block {
  readonly lines: readonly YamlLine[];
  readonly end: number;
}

interface Assignment {
  readonly name: string;
  readonly required: boolean;
}

interface ServiceBlock {
  readonly name: string;
  readonly lines: readonly YamlLine[];
}

const COMPOSE_FILE_NAME = /^(?:docker-)?compose(?:\.[A-Za-z0-9_-]+)?\.ya?ml$/i;
const OVERRIDE_MARKER = /[.]override/i;
const ENV_FILE_NAME = /^\.env/;

const isSpace = (code: number): boolean => code === 0x20 || code === 0x09;

const TOKEN_BOUNDARY = '=:,[{(';

const isTokenStart = (text: string, index: number): boolean => {
  if (index === 0) {
    return true;
  }
  const previous = text.charAt(index - 1);
  return isSpace(previous.charCodeAt(0)) || TOKEN_BOUNDARY.includes(previous);
};

const compareStrings = (left: string, right: string): number => (left < right ? -1 : left > right ? 1 : 0);

const baseName = (path: string): string => {
  const posix = toPosix(path);
  const cut = posix.lastIndexOf('/');
  return cut === -1 ? posix : posix.slice(cut + 1);
};

const leadingWidth = (text: string): number => {
  let width = 0;
  while (width < text.length && isSpace(text.charCodeAt(width))) {
    width += 1;
  }
  return width;
};

const leadingOffset = (value: string): number => value.length - value.trimStart().length;

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

const entryOf = (content: string): Entry | null => {
  if (content === '' || content.startsWith('#')) {
    return null;
  }
  let dash = 0;
  if (content === '-') {
    dash = 1;
  } else if (content.startsWith('- ') || content.startsWith('-\t')) {
    dash = 2;
  }
  const rest = content.slice(dash);
  const colon = keyColonAt(rest);
  if (colon === -1) {
    return {
      key: unquote(rest.trim()),
      keyStart: dash + leadingOffset(rest),
      value: '',
      valueStart: dash + rest.trimEnd().length,
      dash,
      mapped: false,
    };
  }
  const rawKey = rest.slice(0, colon);
  const rawValue = rest.slice(colon + 1);
  return {
    key: unquote(rawKey.trim()),
    keyStart: dash + leadingOffset(rawKey),
    value: unquote(rawValue.trim()),
    valueStart: dash + colon + 1 + leadingOffset(rawValue),
    dash,
    mapped: true,
  };
};

const blockAt = (lines: readonly YamlLine[], index: number): Block => {
  const parent = lines[index];
  const collected: YamlLine[] = [];
  if (parent === undefined) {
    return { lines: collected, end: index + 1 };
  }
  let cursor = index + 1;
  for (; cursor < lines.length; cursor += 1) {
    const line = lines[cursor];
    if (line === undefined || line.blank) {
      continue;
    }
    if (line.indent <= parent.indent) {
      break;
    }
    collected.push(line);
  }
  return { lines: collected, end: cursor };
};

const keyIndexAt = (lines: readonly YamlLine[], key: string, indent: number): number => {
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (line === undefined || line.indent !== indent) {
      continue;
    }
    const entry = entryOf(line.content);
    if (entry !== null && entry.dash === 0 && entry.key === key) {
      return index;
    }
  }
  return -1;
};

const payloadOf = (line: YamlLine, entry: Entry): { readonly text: string; readonly start: number } => {
  const raw = line.content.slice(entry.dash);
  return { text: unquote(raw.trim()), start: entry.dash + leadingOffset(raw) };
};

const parseAssignment = (text: string): Assignment | null => {
  const equals = text.indexOf('=');
  const name = unquote((equals === -1 ? text : text.slice(0, equals)).trim());
  return isEnvVarName(name) ? { name, required: equals === -1 } : null;
};

const isEnvFileReference = (name: string, envFileNames: readonly string[]): boolean => {
  const base = baseName(name);
  if (base === '' || base === '.' || base === '..' || base.endsWith('/')) {
    return false;
  }
  return ENV_FILE_NAME.test(base) || envFileNames.includes(base);
};

const compareRefs = (left: InfraRef, right: InfraRef): number =>
  left.line - right.line
  || left.column - right.column
  || compareStrings(left.name, right.name)
  || compareStrings(left.kind, right.kind);

const serviceBlocksOf = (document: YamlDocument): ServiceBlock[] => {
  const services = blockOf(document, 'services', 0);
  const found: ServiceBlock[] = [];
  let index = 0;
  while (index < services.length) {
    const line = services[index];
    if (line === undefined || line.blank || line.comment) {
      index += 1;
      continue;
    }
    const entry = entryOf(line.content);
    const block = blockAt(services, index);
    index = block.end;
    if (entry === null || entry.dash > 0 || entry.value !== '') {
      continue;
    }
    if (entry.key === '' || entry.key.startsWith('x-')) {
      continue;
    }
    found.push({ name: entry.key, lines: block.lines });
  }
  return found;
};

/** True when the path's basename is `compose`, `docker-compose` or a variant such as `compose.override.yml`. */
export function isComposeFile(relativePath: string): boolean {
  return COMPOSE_FILE_NAME.test(baseName(relativePath));
}

/** Parses docker-compose.yml/.yaml: services.*.environment, env_file, build.args, ${VAR}. */
export function scanCompose(
  relativePath: string,
  document: YamlDocument,
  options: ComposeScanOptions,
): ComposeScanResult {
  const composeFileName = baseName(relativePath);
  const envFileNames = options.envFileNames;
  const refs: InfraRef[] = [];
  const referencedEnvFiles: InfraRef[] = [];
  const serviceNames: string[] = [];
  const seen = new Set<string>();

  const columnOf = (line: YamlLine, offsetInContent: number): number => leadingWidth(line.text) + offsetInContent + 1;

  const addRef = (name: string, line: YamlLine, offsetInContent: number, kind: InfraRef['kind'], required: boolean): void => {
    refs.push({
      name,
      file: relativePath,
      line: line.number,
      column: columnOf(line, offsetInContent),
      kind,
      required,
      refersToFile: false,
      interpolation: false,
    });
  };

  const addEnvFile = (name: string, line: YamlLine, offsetInContent: number): void => {
    const ref: InfraRef = {
      name,
      file: relativePath,
      line: line.number,
      column: columnOf(line, offsetInContent),
      kind: 'compose-env-file',
      required: true,
      refersToFile: true,
      interpolation: false,
    };
    refs.push(ref);
    if (isEnvFileReference(name, envFileNames)) {
      referencedEnvFiles.push(ref);
    }
  };

  const addEnvFileList = (line: YamlLine, text: string, start: number): void => {
    let offset = start;
    for (const part of text.split(',')) {
      const lead = leadingOffset(part);
      const value = unquote(part.trim());
      if (value !== '') {
        addEnvFile(value, line, offset + lead);
      }
      offset += part.length + 1;
    }
  };

  const scanEnvironmentLines = (lines: readonly YamlLine[], index: number): void => {
    const line = lines[index];
    if (line === undefined) {
      return;
    }
    const entry = entryOf(line.content);
    if (entry === null || entry.value !== '') {
      return;
    }
    const block = blockAt(lines, index);
    for (let position = 0; position < block.lines.length; position += 1) {
      const child = block.lines[position];
      if (child === undefined) {
        continue;
      }
      position = blockAt(block.lines, position).end - 1;
      if (child.blank || child.comment) {
        continue;
      }
      const item = entryOf(child.content);
      if (item === null) {
        continue;
      }
      if (item.dash > 0) {
        const payload = payloadOf(child, item);
        const assignment = parseAssignment(payload.text);
        if (assignment !== null) {
          addRef(assignment.name, child, payload.start, 'compose-environment', assignment.required);
        }
        continue;
      }
      if (isEnvVarName(item.key)) {
        addRef(item.key, child, item.keyStart, 'compose-environment', item.value === '');
      }
    }
  };

  const scanEnvFileLines = (lines: readonly YamlLine[], index: number): void => {
    const line = lines[index];
    if (line === undefined) {
      return;
    }
    const entry = entryOf(line.content);
    if (entry === null) {
      return;
    }
    if (entry.value !== '') {
      addEnvFileList(line, entry.value, entry.valueStart);
      return;
    }
    const block = blockAt(lines, index);
    for (let position = 0; position < block.lines.length; position += 1) {
      const child = block.lines[position];
      if (child === undefined) {
        continue;
      }
      position = blockAt(block.lines, position).end - 1;
      if (child.blank || child.comment) {
        continue;
      }
      const item = entryOf(child.content);
      if (item === null || item.dash === 0) {
        continue;
      }
      if (item.mapped) {
        if (item.key === 'path' && item.value !== '') {
          addEnvFileList(child, item.value, item.valueStart);
        }
        continue;
      }
      const payload = payloadOf(child, item);
      addEnvFileList(child, payload.text, payload.start);
    }
  };

  const scanBuildLines = (lines: readonly YamlLine[], index: number): void => {
    const line = lines[index];
    if (line === undefined) {
      return;
    }
    const entry = entryOf(line.content);
    if (entry === null || entry.value !== '') {
      return;
    }
    const build = blockAt(lines, index);
    for (let position = 0; position < build.lines.length; position += 1) {
      const child = build.lines[position];
      if (child === undefined) {
        continue;
      }
      const start = position;
      position = blockAt(build.lines, start).end - 1;
      if (child.blank || child.comment) {
        continue;
      }
      const item = entryOf(child.content);
      if (item === null || item.key !== 'args' || item.value !== '') {
        continue;
      }
      for (const argLine of blockAt(build.lines, start).lines) {
        if (argLine.blank || argLine.comment) {
          continue;
        }
        const arg = entryOf(argLine.content);
        if (arg === null) {
          continue;
        }
        if (arg.dash > 0) {
          const payload = payloadOf(argLine, arg);
          const assignment = parseAssignment(payload.text);
          if (assignment !== null) {
            addRef(assignment.name, argLine, payload.start, 'compose-build-arg', assignment.required);
          }
          continue;
        }
        if (isEnvVarName(arg.key)) {
          addRef(arg.key, argLine, arg.keyStart, 'compose-build-arg', arg.value === '');
        }
      }
    }
  };

  for (const service of serviceBlocksOf(document)) {
    if (seen.has(service.name)) {
      continue;
    }
    seen.add(service.name);
    serviceNames.push(service.name);
    for (let index = 0; index < service.lines.length; index += 1) {
      const child = service.lines[index];
      if (child === undefined) {
        continue;
      }
      const start = index;
      index = blockAt(service.lines, start).end - 1;
      if (child.blank || child.comment) {
        continue;
      }
      const entry = entryOf(child.content);
      if (entry === null || entry.dash > 0 || entry.key.startsWith('x-')) {
        continue;
      }
      if (entry.key === 'environment') {
        scanEnvironmentLines(service.lines, start);
      } else if (entry.key === 'env_file') {
        scanEnvFileLines(service.lines, start);
      } else if (entry.key === 'build') {
        scanBuildLines(service.lines, start);
      }
    }
  }

  const topLevelEnvFile = keyIndexAt(document.lines, 'env_file', 0);
  if (topLevelEnvFile !== -1) {
    scanEnvFileLines(document.lines, topLevelEnvFile);
  }
  const topLevelEnv = keyIndexAt(document.lines, 'env', 0);
  if (topLevelEnv !== -1) {
    scanEnvironmentLines(document.lines, topLevelEnv);
  }

  for (const line of document.lines) {
    if (line.blank || line.comment) {
      continue;
    }
    for (const ref of findInterpolations(line.content, line.number, leadingWidth(line.text), ['compose-interpolation'])) {
      refs.push({ ...ref, file: relativePath });
    }
  }

  return {
    refs: refs.sort(compareRefs),
    serviceNames,
    referencedEnvFiles,
    composeFileName,
    isOverride: options.isOverride || OVERRIDE_MARKER.test(composeFileName),
  };
}
