#!/usr/bin/env node
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isKnownRule } from './rules/index.js';
import { VERSION } from './version.js';
import { runDocsCommand, runInitCommand } from './commands/docs.js';
import { runFmtCommand } from './commands/fmt.js';
import { runRulesCommand } from './commands/rules.js';
import { runScanCommand } from './commands/scan.js';
import { USAGE } from './commands/usage.js';
import { runWhyCommand } from './commands/why.js';
import type { CommandContext } from './commands/context.js';
import type { CliIo, OutputFormat, RuleId, Severity } from './types.js';

const COMMANDS: ReadonlySet<string> = new Set(['scan', 'check', 'init', 'docs', 'fmt', 'why', 'rules', 'help', 'version']);

const VALUE_FLAGS: ReadonlySet<string> = new Set([
  '--format',
  '--fail-on',
  '--config',
  '--project',
  '--max-issues',
  '--max-file-size',
  '--rule',
  '--ignore-rule',
  '--ignore-var',
]);

const OPTIONAL_VALUE_FLAGS: ReadonlySet<string> = new Set(['--write']);

const SWITCH_FLAGS: ReadonlySet<string> = new Set([
  '--check',
  '--dry-run',
  '--help',
  '--json',
  '--no-color',
  '--no-gitignore',
  '--quiet',
  '--short',
  '--verbose',
  '--version',
  '-h',
  '-v',
]);

const FORMATS: ReadonlySet<string> = new Set(['human', 'json', 'sarif', 'markdown', 'quiet']);
const FAIL_ON: ReadonlySet<string> = new Set(['error', 'warn', 'info', 'none']);

export interface ParsedArguments {
  readonly command: string;
  readonly positional: readonly string[];
  readonly values: ReadonlyMap<string, readonly string[]>;
  readonly switches: ReadonlySet<string>;
}

export class UsageError extends Error {}

function push(values: Map<string, string[]>, key: string, value: string): void {
  const existing = values.get(key);
  if (existing) {
    existing.push(value);
  } else {
    values.set(key, [value]);
  }
}

/** Parses argv without any dependency; unknown flags are a usage error. */
export function parseArguments(argv: readonly string[]): ParsedArguments {
  const values = new Map<string, string[]>();
  const switches = new Set<string>();
  const positional: string[] = [];
  let onlyPositionals = false;

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index] ?? '';
    if (onlyPositionals) {
      positional.push(token);
      continue;
    }
    if (token === '--') {
      onlyPositionals = true;
      continue;
    }
    if (!token.startsWith('-') || token === '-') {
      positional.push(token);
      continue;
    }
    const equals = token.indexOf('=');
    const name = equals === -1 ? token : token.slice(0, equals);
    const inlineValue = equals === -1 ? undefined : token.slice(equals + 1);

    if (VALUE_FLAGS.has(name)) {
      if (inlineValue !== undefined) {
        push(values, name, inlineValue);
        continue;
      }
      const next = argv[index + 1];
      if (next === undefined || next.startsWith('-')) {
        throw new UsageError(`option ${name} needs a value`);
      }
      push(values, name, next);
      index += 1;
      continue;
    }
    if (OPTIONAL_VALUE_FLAGS.has(name)) {
      if (inlineValue !== undefined) {
        push(values, name, inlineValue);
        continue;
      }
      const next = argv[index + 1];
      if (next !== undefined && !next.startsWith('-')) {
        push(values, name, next);
        index += 1;
      } else {
        switches.add(name);
      }
      continue;
    }
    if (SWITCH_FLAGS.has(name)) {
      if (inlineValue !== undefined) {
        throw new UsageError(`option ${name} does not take a value`);
      }
      switches.add(name);
      continue;
    }
    throw new UsageError(`unknown option ${name}`);
  }

  const first = positional[0];
  const named = first !== undefined && COMMANDS.has(first);
  const command = named ? first : 'scan';
  const rest = named ? positional.slice(1) : positional;
  return { command, positional: rest, values, switches };
}

const first = (values: ReadonlyMap<string, readonly string[]>, key: string): string | undefined => values.get(key)?.[0];
const all = (values: ReadonlyMap<string, readonly string[]>, key: string): string[] => [...(values.get(key) ?? [])];

function positiveInteger(raw: string | undefined, fallback: number, label: string): number {
  if (raw === undefined) {
    return fallback;
  }
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new UsageError(`${label} must be a positive integer`);
  }
  return parsed;
}

function ruleList(values: ReadonlyMap<string, readonly string[]>, key: string): RuleId[] {
  const ids: RuleId[] = [];
  for (const id of all(values, key)) {
    if (!isKnownRule(id)) {
      throw new UsageError(`unknown rule id "${id}" (see envgle rules)`);
    }
    ids.push(id);
  }
  return ids;
}

export function buildContext(parsed: ParsedArguments, io: CliIo, cwd: string): CommandContext {
  const { values, switches } = parsed;
  const format = first(values, '--format') ?? 'human';
  if (!FORMATS.has(format)) {
    throw new UsageError(`--format must be one of ${[...FORMATS].join(', ')}`);
  }
  const failOn = first(values, '--fail-on') ?? 'error';
  if (!FAIL_ON.has(failOn)) {
    throw new UsageError('--fail-on must be one of error, warn, info, none');
  }
  const configPath = first(values, '--config');
  const projectPath = first(values, '--project');
  const maxFileSize = first(values, '--max-file-size');
  const command = parsed.command;

  const takesPath = command === 'scan' || command === 'check' || command === 'fmt';
  const targetDir = resolve(cwd, projectPath ?? (takesPath ? parsed.positional[0] : undefined) ?? '.');
  const writeTarget =
    first(values, '--write') ?? (command === 'why' ? undefined : parsed.positional[0]);

  if ((command === 'init' || command === 'docs') && parsed.positional[0] !== undefined && switches.has('--write') === false && values.has('--write') === false) {
    throw new UsageError(`${command} takes no positional argument (did you mean --write ${parsed.positional[0]}?)`);
  }

  return {
    command,
    positional: command === 'why' ? parsed.positional : [],
    values,
    switches,
    io,
    cwd,
    targetDir,
    configPath,
    useGitignore: !switches.has('--no-gitignore'),
    format: format as OutputFormat,
    short: switches.has('--short'),
    verbose: switches.has('--verbose'),
    quiet: switches.has('--quiet'),
    dryRun: switches.has('--dry-run'),
    maxIssues: positiveInteger(first(values, '--max-issues'), 20, '--max-issues'),
    maxFileSizeKb: maxFileSize === undefined ? undefined : positiveInteger(maxFileSize, 64, '--max-file-size'),
    failOn: failOn as Severity | 'none',
    onlyRules: ruleList(values, '--rule'),
    ignoreRules: ruleList(values, '--ignore-rule'),
    ignoreVariables: all(values, '--ignore-var'),
    writeTarget,
  };
}

export async function runCli(argv: readonly string[], io: CliIo, cwd: string): Promise<number> {
  let parsed: ParsedArguments;
  try {
    parsed = parseArguments(argv);
  } catch (error) {
    io.stderr(`envgle: ${error instanceof Error ? error.message : String(error)}\n`);
    io.stderr(USAGE.replace('{version}', VERSION));
    return 2;
  }

  if (parsed.switches.has('--help') || parsed.switches.has('-h') || parsed.command === 'help') {
    io.stdout(USAGE.replace('{version}', VERSION));
    return 0;
  }
  if (parsed.switches.has('--version') || parsed.switches.has('-v') || parsed.command === 'version') {
    io.stdout(`${VERSION}\n`);
    return 0;
  }

  let context: CommandContext;
  try {
    context = buildContext(parsed, io, cwd);
  } catch (error) {
    io.stderr(`envgle: ${error instanceof Error ? error.message : String(error)}\n`);
    return 2;
  }

  try {
    switch (context.command) {
      case 'rules':
        return runRulesCommand(context).exitCode;
      case 'why':
        return (await runWhyCommand(context)).exitCode;
      case 'init':
        return (await runInitCommand(context)).exitCode;
      case 'docs':
        return (await runDocsCommand(context)).exitCode;
      case 'fmt':
        return (await runFmtCommand(context)).exitCode;
      default:
        return (await runScanCommand(context)).exitCode;
    }
  } catch (error) {
    io.stderr(`envgle: ${error instanceof Error ? error.message : String(error)}\n`);
    if (context.verbose && error instanceof Error && error.stack !== undefined) {
      io.stderr(`${error.stack}\n`);
    }
    return 2;
  }
}

export { VERSION };
export * from './commands/context.js';
export { buildContext as createCommandContext, parseArguments as parseCliArguments };
export type { CliIo };

function colorEnabled(stream: { isTTY?: boolean }): boolean {
  if (process.env['NO_COLOR'] !== undefined && process.env['NO_COLOR'] !== '') {
    return false;
  }
  if (process.env['FORCE_COLOR'] !== undefined && process.env['FORCE_COLOR'] !== '0') {
    return true;
  }
  if (process.env['TERM'] === 'dumb') {
    return false;
  }
  return stream.isTTY === true;
}

const defaultIo: CliIo = {
  stdout: (text) => {
    process.stdout.write(text);
  },
  stderr: (text) => {
    process.stderr.write(text);
  },
  isColor: colorEnabled(process.stdout),
  cwd: process.cwd(),
};

export async function main(argv: readonly string[] = process.argv.slice(2)): Promise<number> {
  return runCli(argv, defaultIo, process.cwd());
}

const invokedPath = process.argv[1];
const modulePath = fileURLToPath(import.meta.url);
if (invokedPath !== undefined && resolve(invokedPath) === modulePath) {
  process.stdout.on('error', (error: NodeJS.ErrnoException) => {
    if (error.code !== 'EPIPE') {
      throw error;
    }
  });
  main().then(
    (code) => {
      process.exitCode = code;
    },
    (error: unknown) => {
      process.stderr.write(`envgle: unexpected failure: ${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
      process.exitCode = 2;
    },
  );
}
