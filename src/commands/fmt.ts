import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseEnvFile } from '../dotenv/parse.js';
import { appendAll } from '../utils/text.js';
import { runScan } from '../scan/index.js';
import { loadConfigFor, scanOptionsFor } from './scan.js';
import type { EnvVarDecl } from '../types.js';
import type { CommandContext, CommandOutcome } from './context.js';

interface DeclRecord {
  readonly name: string;
  readonly start: number;
  readonly end: number;
}

const byCodeUnit = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** One record per assignment, spanning its leading comments but never a blank line. */
function recordsFor(decls: readonly EnvVarDecl[], lines: readonly string[]): DeclRecord[] {
  return decls
    .map((decl, index) => {
      const next = decls[index + 1];
      const start = Math.max(1, decl.line - decl.leadingComments.length);
      const nextStart = next === undefined ? lines.length + 1 : Math.max(start, next.line - next.leadingComments.length);
      let end = nextStart - 1;
      while (end > start && (lines[end - 1] ?? '').trim().length === 0) {
        end -= 1;
      }
      return { name: decl.name, start, end: Math.max(start, end) };
    })
    .sort((a, b) => a.start - b.start);
}

export interface FormatOutcome {
  readonly file: string;
  readonly detail: string;
}

/**
 * Deterministic dotenv formatting: strip trailing whitespace, guarantee exactly one
 * final newline, and sort keys within each run of adjacent assignments. Blank lines
 * and comment lines keep their grouping, and values are never rewritten.
 */
export function formatEnvText(text: string): { output: string; detail: string } {
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const rawLines = text.split(/\r?\n/);
  const hadFinalNewline = text.length === 0 || text.endsWith('\n') || text.endsWith('\r');
  const lines = rawLines[rawLines.length - 1] === '' ? rawLines.slice(0, -1) : rawLines;

  const hadTrailingWhitespace = lines.some((line) => /[ \t]+$/.test(line));
  const cleaned = lines.map((line) => line.replace(/[ \t]+$/, ''));
  const output = [...cleaned];

  const parsed = parseEnvFile('memory', text, { kind: 'dev', shared: true, devOnly: false });
  const records = recordsFor(parsed.decls, cleaned);

  let sortedKeys = false;
  let cursor = 0;
  while (cursor < records.length) {
    let end = cursor;
    while (end + 1 < records.length) {
      const current = records[end];
      const following = records[end + 1];
      if (current === undefined || following === undefined || following.start !== current.end + 1) {
        break;
      }
      end += 1;
    }
    const run = records.slice(cursor, end + 1);
    const names = run.map((record) => record.name);
    const sorted = [...names].sort(byCodeUnit);
    if (names.join('\u0000') !== sorted.join('\u0000')) {
      sortedKeys = true;
      const first = run[0];
      const last = run[run.length - 1];
      if (first !== undefined && last !== undefined) {
        const reordered: string[] = [];
        for (const name of sorted) {
          const record = run.find((candidate) => candidate.name === name);
          if (record !== undefined) {
            appendAll(reordered, cleaned.slice(record.start - 1, record.end));
          }
        }
        output.splice(first.start - 1, last.end - first.start + 1, ...reordered);
      }
    }
    cursor = end + 1;
  }

  const details: string[] = [];
  if (hadTrailingWhitespace) {
    details.push('trailing whitespace');
  }
  if (sortedKeys) {
    details.push('key order');
  }
  if (!hadFinalNewline && output.length > 0) {
    details.push('final newline');
  }
  const body = output.join(eol);
  return { output: body.length > 0 ? `${body}${eol}` : body, detail: details.join(', ') };
}

export async function runFmtCommand(context: CommandContext): Promise<CommandOutcome> {
  const config = loadConfigFor(context);
  const report = await runScan(scanOptionsFor(context, config));
  const write = (context.values.has('--write') || context.switches.has('--write')) && !context.dryRun;

  const outcomes: FormatOutcome[] = [];
  let checked = 0;
  for (const file of report.files) {
    if (!file.exists) {
      continue;
    }
    checked += 1;
    const absolute = join(report.root, file.path);
    let text: string;
    try {
      text = readFileSync(absolute, 'utf8');
    } catch {
      continue;
    }
    const { output, detail } = formatEnvText(text);
    if (output === text) {
      continue;
    }
    outcomes.push({ file: file.path, detail });
    if (write) {
      try {
        writeFileSync(absolute, output, 'utf8');
      } catch (error) {
        context.io.stderr(`cannot write ${file.path}: ${error instanceof Error ? error.message : String(error)}\n`);
        return { exitCode: 2 };
      }
    }
  }

  if (outcomes.length === 0) {
    context.io.stdout(`${checked} dotenv file${checked === 1 ? '' : 's'} already normalised\n`);
    return { exitCode: 0 };
  }

  for (const outcome of outcomes) {
    context.io.stdout(`fix  ${outcome.file}  ${outcome.detail}\n`);
  }
  if (write) {
    context.io.stdout(`rewrote ${outcomes.length} file${outcomes.length === 1 ? '' : 's'}\n`);
    return { exitCode: 0 };
  }
  context.io.stdout(`${outcomes.length} file${outcomes.length === 1 ? '' : 's'} would change; run with --write to apply\n`);
  return { exitCode: 1 };
}
