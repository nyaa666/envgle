import { existsSync, writeFileSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { mkdirSync } from 'node:fs';
import { toExampleFile, toMarkdownTable } from '../report/markdown.js';
import { runScan } from '../scan/index.js';
import { loadConfigFor, rootLabel, scanOptionsFor } from './scan.js';
import type { CommandContext, CommandOutcome } from './context.js';

const writesRequested = (context: CommandContext): boolean =>
  context.switches.has('--write') || context.values.has('--write');

function emit(context: CommandContext, content: string, target: string, label: string): CommandOutcome {
  if (!writesRequested(context)) {
    context.io.stdout(content.endsWith('\n') ? content : `${content}\n`);
    return { exitCode: 0 };
  }
  const absolute = resolve(context.cwd, target);
  if (context.dryRun) {
    context.io.stderr(`dry run: would write ${label}\n`);
    context.io.stdout(content.endsWith('\n') ? content : `${content}\n`);
    return { exitCode: 0 };
  }
  if (existsSync(absolute)) {
    context.io.stderr(`${label} already exists; move it aside or pass a different --write path\n`);
    return { exitCode: 2 };
  }
  try {
    writeFileSync(absolute, content, 'utf8');
  } catch (error) {
    context.io.stderr(`cannot write ${label}: ${error instanceof Error ? error.message : String(error)}\n`);
    return { exitCode: 2 };
  }
  context.io.stdout(`wrote ${relative(context.cwd, absolute)}\n`);
  return { exitCode: 0 };
}

export async function runInitCommand(context: CommandContext): Promise<CommandOutcome> {
  const config = loadConfigFor(context);
  const report = await runScan(scanOptionsFor(context, config));
  const target = context.writeTarget ?? '.env.example';
  const content = toExampleFile(report, { config, rootLabel: rootLabel(report.root, context.cwd) });
  return emit(context, content, target, target);
}

export async function runDocsCommand(context: CommandContext): Promise<CommandOutcome> {
  const config = loadConfigFor(context);
  const report = await runScan(scanOptionsFor(context, config));
  const target = context.writeTarget ?? 'docs/environment.md';
  const content = toMarkdownTable(report, {
    config,
    rootLabel: rootLabel(report.root, context.cwd),
    title: 'Environment variables',
    includeFindings: true,
    includeEmpty: false,
  });
  if (context.values.has('--write')) {
    if (context.dryRun) {
      context.io.stderr(`dry run: would write ${target}\n`);
      context.io.stdout(content.endsWith('\n') ? content : `${content}\n`);
      return { exitCode: 0 };
    }
    const absolute = resolve(context.cwd, target);
    try {
      mkdirSync(dirname(absolute), { recursive: true });
      writeFileSync(absolute, content.endsWith('\n') ? content : `${content}\n`, 'utf8');
    } catch (error) {
      context.io.stderr(`cannot write ${target}: ${error instanceof Error ? error.message : String(error)}\n`);
      return { exitCode: 2 };
    }
    context.io.stdout(`wrote ${target}\n`);
    return { exitCode: 0 };
  }
  context.io.stdout(content.endsWith('\n') ? content : `${content}\n`);
  return { exitCode: 0 };
}
