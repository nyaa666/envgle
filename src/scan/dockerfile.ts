import type { InfraRef } from '../types.js';
import { findBracedVariables, unique } from '../utils/text.js';

export interface DockerScanResult {
  readonly refs: readonly InfraRef[];
  readonly envNames: readonly string[];
  readonly argNames: readonly string[];
  readonly referencedPaths: readonly InfraRef[];
}

interface Stage {
  args: string[];
  envs: string[];
}

interface LogicalLine {
  readonly line: number;
  readonly text: string;
  readonly columns: Int32Array;
}

interface Span {
  readonly start: number;
  readonly end: number;
}

interface Hit {
  readonly name: string;
  readonly offset: number;
}

interface Pair {
  readonly name: string;
  readonly nameStart: number;
  readonly hasValue: boolean;
  readonly valueStart: number;
  readonly valueEnd: number;
}

const DOCKERFILE_BASENAME = /^(?:Dockerfile|Containerfile)(?:\.[\w.-]+)?$/i;
const DOCKERFILE_SUFFIXED = /^[\w.-]+\.(?:Dockerfile|Containerfile)$/i;
const INSTRUCTION_HEAD = /^([A-Za-z][A-Za-z0-9_]*)(?:[ \t]|$)/;
const STICKY_NAME = /[A-Za-z_][A-Za-z0-9_]*/y;
const BARE_VARIABLE = /(?<![$\\])\$([A-Za-z_][A-Za-z0-9_]*)/g;
const FROM_FLAG = /--from=[^\s=]*/g;
const LINE_CONTINUATION = /\\[ \t]*$/;

/** True for Dockerfile and Containerfile names, optionally with a variant suffix. */
export const isDockerfile = (relativePath: string): boolean => {
  const normalized = relativePath.replace(/\\/g, '/');
  const at = normalized.lastIndexOf('/');
  const basename = at === -1 ? normalized : normalized.slice(at + 1);
  return DOCKERFILE_BASENAME.test(basename) || DOCKERFILE_SUFFIXED.test(basename);
};

/** Parses FROM/ARG/ENV/COPY --from and $VAR / ${VAR} / ${VAR:-default} usage per build stage. */
export const scanDockerfile = (relativePath: string, text: string): DockerScanResult => {
  const refs: InfraRef[] = [];
  const stages: Stage[] = [{ args: [], envs: [] }];
  for (const line of readLogicalLines(text)) {
    const head = INSTRUCTION_HEAD.exec(line.text);
    if (head === null) {
      continue;
    }
    const instruction = (head[1] ?? '').toUpperCase();
    const restOffset = head[0].length;
    const stage = stages[stages.length - 1] ?? { args: [], envs: [] };
    const at = (offset: number): number => line.columns[offset] ?? 1;
    const ref = (
      name: string,
      offset: number,
      kind: InfraRef['kind'],
      required: boolean,
      interpolation: boolean,
    ): void => {
      refs.push({
        name,
        file: relativePath,
        line: line.line,
        column: at(offset),
        kind,
        required,
        refersToFile: false,
        interpolation,
      });
    };
    const usages = (from: number, to: number): void => {
      for (const hit of findHits(line.text, from, to)) {
        ref(hit.name, hit.offset, 'dockerfile-usage', false, true);
      }
    };
    if (instruction === 'FROM') {
      stages.push({ args: [], envs: [] });
      usages(restOffset, line.text.length);
      continue;
    }
    if (instruction === 'ARG') {
      const parsed = readArg(line.text, restOffset);
      if (parsed === null) {
        continue;
      }
      ref(parsed.name, parsed.nameStart, 'dockerfile-arg', parsed.valueStart === -1, false);
      stage.args.push(parsed.name);
      if (parsed.valueStart !== -1) {
        usages(parsed.valueStart, line.text.length);
      }
      continue;
    }
    if (instruction === 'ENV') {
      for (const pair of readEnvPairs(line.text, restOffset)) {
        ref(pair.name, pair.nameStart, 'dockerfile-env', false, false);
        stage.envs.push(pair.name);
        usages(pair.valueStart, pair.valueEnd);
      }
      continue;
    }
    usages(restOffset, line.text.length);
  }
  return {
    refs,
    envNames: unique(stages.flatMap((stage) => stage.envs)),
    argNames: unique(stages.flatMap((stage) => stage.args)),
    referencedPaths: [],
  };
};

/** Joins backslash continuations, keeping the first physical line and every piece's own column. */
const readLogicalLines = (text: string): LogicalLine[] => {
  const physical = text.split('\n');
  const result: LogicalLine[] = [];
  let index = 0;
  while (index < physical.length) {
    const first = index;
    let joined = '';
    const columns: number[] = [];
    let continued = true;
    while (index < physical.length) {
      const raw = (physical[index] ?? '').replace(/\r$/, '');
      const lead = raw.length - raw.trimStart().length;
      let piece = raw.slice(lead);
      continued = LINE_CONTINUATION.test(piece);
      if (continued) {
        piece = piece.replace(LINE_CONTINUATION, '');
      }
      for (let at = 0; at < piece.length; at += 1) {
        columns.push(lead + at + 1);
      }
      joined += piece;
      index += 1;
      if (!continued) {
        break;
      }
    }
    if (joined.trim() === '') {
      continue;
    }
    result.push({ line: first + 1, text: joined, columns: Int32Array.from(columns) });
  }
  return result;
};

/** Every $NAME / ${NAME} / ${NAME:-default} in the region, minus $(, $((, $$ and --from= values. */
const findHits = (text: string, from: number, to: number): readonly Hit[] => {
  if (to <= from) {
    return [];
  }
  const region = text.slice(from, to);
  const hits: Hit[] = [];
  const blocked: Span[] = [];
  for (const braced of findBracedVariables(region)) {
    hits.push({ name: braced.name, offset: from + braced.start + 2 });
    blocked.push({ start: braced.start, end: braced.end });
  }
  FROM_FLAG.lastIndex = 0;
  let flag = FROM_FLAG.exec(region);
  while (flag !== null) {
    blocked.push({ start: flag.index, end: flag.index + flag[0].length });
    flag = FROM_FLAG.exec(region);
  }
  blocked.sort((left, right) => left.start - right.start);
  let cursor = 0;
  BARE_VARIABLE.lastIndex = 0;
  let bare = BARE_VARIABLE.exec(region);
  while (bare !== null) {
    const name = bare[1];
    if (name !== undefined) {
      while (cursor < blocked.length && (blocked[cursor]?.end ?? 0) <= bare.index) {
        cursor += 1;
      }
      const span = blocked[cursor];
      if (span === undefined || bare.index < span.start || bare.index >= span.end) {
        hits.push({ name, offset: from + bare.index + 1 });
      }
    }
    bare = BARE_VARIABLE.exec(region);
  }
  return hits.sort((left, right) => left.offset - right.offset);
};

/** Reads the name and optional default of one ARG, skipping any leading --flag token. */
const readArg = (text: string, from: number): Pair | null => {
  let cursor = skipSpaces(text, from);
  if (text.startsWith('--', cursor)) {
    cursor = skipSpaces(text, skipToken(text, cursor));
  }
  const name = matchNameAt(text, cursor);
  if (name === null) {
    return null;
  }
  const after = cursor + name.length;
  const hasDefault = text.charAt(after) === '=';
  return {
    name,
    nameStart: cursor,
    hasValue: hasDefault,
    valueStart: hasDefault ? after + 1 : -1,
    valueEnd: hasDefault ? trimBack(text, text.length) : -1,
  };
};

/** One pair per ENV assignment: the multi-pair `ENV A=1 B=2` form and legacy `ENV A 1 2`. */
const readEnvPairs = (text: string, from: number): readonly Pair[] => {
  const first = readNameValue(text, from);
  if (first === null) {
    return [];
  }
  if (!first.hasValue) {
    const valueEnd = trimBack(text, text.length);
    if (valueEnd <= first.valueStart) {
      return [];
    }
    return [
      { name: first.name, nameStart: first.nameStart, hasValue: false, valueStart: first.valueStart, valueEnd },
    ];
  }
  const pairs: Pair[] = [];
  let cursor = from;
  while (cursor < text.length) {
    const char = text.charAt(cursor);
    if (char === ' ' || char === '\t') {
      cursor += 1;
      continue;
    }
    const pair = readNameValue(text, cursor);
    if (pair === null || !pair.hasValue) {
      break;
    }
    pairs.push(pair);
    cursor = pair.valueEnd;
  }
  return pairs;
};

/** Reads NAME or NAME=value at an offset, honouring quotes inside the value. */
const readNameValue = (text: string, from: number): Pair | null => {
  const name = matchNameAt(text, from);
  if (name === null) {
    return null;
  }
  const after = from + name.length;
  if (text.charAt(after) !== '=') {
    return { name, nameStart: from, hasValue: false, valueStart: after, valueEnd: after };
  }
  const valueStart = after + 1;
  let at = valueStart;
  let quote = '';
  while (at < text.length) {
    const char = text.charAt(at);
    if (quote !== '') {
      if (char === '\\' && quote === '"') {
        at += 2;
        continue;
      }
      if (char === quote) {
        quote = '';
      }
      at += 1;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      at += 1;
      continue;
    }
    if (char === ' ' || char === '\t') {
      break;
    }
    at += 1;
  }
  return { name, nameStart: from, hasValue: true, valueStart, valueEnd: at };
};

const matchNameAt = (text: string, from: number): string | null => {
  if (from < 0 || from > text.length) {
    return null;
  }
  STICKY_NAME.lastIndex = from;
  return STICKY_NAME.exec(text)?.[0] ?? null;
};

const isBlank = (char: string): boolean => char === ' ' || char === '\t';

const skipSpaces = (text: string, from: number): number => {
  let at = from;
  while (at < text.length && isBlank(text.charAt(at))) {
    at += 1;
  }
  return at;
};

const skipToken = (text: string, from: number): number => {
  let at = from;
  while (at < text.length && !isBlank(text.charAt(at))) {
    at += 1;
  }
  return at;
};

const trimBack = (text: string, end: number): number => {
  let at = Math.min(end, text.length);
  while (at > 0 && (text.charAt(at - 1) === ' ' || text.charAt(at - 1) === '\t')) {
    at -= 1;
  }
  return at;
};
