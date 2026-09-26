import { readFileSync } from 'node:fs';
import type { RuleId, SourceLocation } from '../types.js';

export const DISABLE_LINE = 'envgle-disable-line';
export const DISABLE_NEXT_LINE = 'envgle-disable-next-line';
export const DISABLE_FILE = 'envgle-disable-file';

export interface SuppressionSource {
  readonly path: string;
  readonly text: string;
}

export interface SuppressionIndex {
  readonly count: number;
  /** Paths carrying a file-wide marker. */
  readonly files: readonly string[];
  isSuppressed(location: SourceLocation, ruleId: RuleId): boolean;
}

const MARKER = /envgle-disable-(next-line|line|file)[\s:,]*([a-z][a-z0-9-]*(?:[\s,]+[a-z][a-z0-9-]*)*)/gi;

const idsIn = (tail: string): RuleId[] => {
  const ids: RuleId[] = [];
  for (const token of tail.split(/[\s,]+/)) {
    const id = token.replace(/[.,;]+$/, '');
    if (id.length > 0) {
      ids.push(id as RuleId);
    }
  }
  return ids;
};

interface Marker {
  readonly scope: 'file' | 'next-line' | 'line';
  readonly ids: readonly RuleId[];
}

const markersIn = (line: string): Marker[] => {
  const markers: Marker[] = [];
  MARKER.lastIndex = 0;
  let match = MARKER.exec(line);
  while (match !== null) {
    const scope = (match[1] ?? 'line').toLowerCase();
    markers.push({
      scope: scope === 'file' ? 'file' : scope === 'next-line' ? 'next-line' : 'line',
      ids: idsIn(match[2] ?? ''),
    });
    match = MARKER.exec(line);
  }
  return markers;
};

/** Indexes inline `envgle-disable-*` markers found in the comments of scanned files. */
export function buildSuppressionIndex(sources: readonly SuppressionSource[]): SuppressionIndex {
  const byLocation = new Map<string, Set<RuleId>>();
  const byFile = new Map<string, Set<RuleId>>();

  const addLine = (path: string, line: number, ids: readonly RuleId[]): void => {
    if (ids.length === 0) {
      return;
    }
    const key = `${path}:${line}`;
    const existing = byLocation.get(key);
    if (existing) {
      for (const id of ids) {
        existing.add(id);
      }
    } else {
      byLocation.set(key, new Set(ids));
    }
  };

  for (const source of sources) {
    if (!source.text.includes('envgle-disable')) {
      continue;
    }
    const lines = source.text.split('\n');
    let fileScope = new Set<RuleId>();
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index] ?? '';
      if (!line.includes('envgle-disable')) {
        continue;
      }
      for (const marker of markersIn(line)) {
        if (marker.scope === 'file') {
          for (const id of marker.ids) {
            fileScope.add(id);
          }
        } else if (marker.scope === 'next-line') {
          addLine(source.path, index + 2, marker.ids);
        } else {
          addLine(source.path, index + 1, marker.ids);
        }
      }
    }
    if (fileScope.size > 0) {
      byFile.set(source.path, fileScope);
    }
  }

  return {
    count: byLocation.size + byFile.size,
    files: [...byFile.keys()].sort(),
    isSuppressed(location, ruleId) {
      const ids = byLocation.get(`${location.file}:${location.line}`);
      if (ids?.has(ruleId) === true) {
        return true;
      }
      return byFile.get(location.file)?.has(ruleId) === true;
    },
  };
}

export const emptySuppressionIndex: SuppressionIndex = {
  count: 0,
  files: [],
  isSuppressed: () => false,
};

/** Reads a file for marker scanning, tolerating every I/O and decode failure. */
export function readSuppressionSource(absolutePath: string, relativePath: string, maxBytes: number): SuppressionSource | null {
  try {
    const text = readFileSync(absolutePath, 'utf8');
    const limit = Math.max(1, maxBytes) * 4;
    return { path: relativePath, text: text.length > limit ? text.slice(0, limit) : text };
  } catch {
    return null;
  }
}
