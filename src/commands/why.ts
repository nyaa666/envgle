import { buildVariableSummaries } from '../report/variables.js';
import { runScan } from '../scan/index.js';
import { loadConfigFor, scanOptionsFor } from './scan.js';
import type { Finding, Report, ResolvedConfig } from '../types.js';
import type { CommandContext, CommandOutcome } from './context.js';

const pad = (value: string, width: number): string => (value.length >= width ? value : value + ' '.repeat(width - value.length));

const at = (file: string, line: number, column: number): string => `${file}:${line}:${column}`;

function renderVariable(context: CommandContext, config: ResolvedConfig, report: Report, name: string): string {
  const summaries = buildVariableSummaries(report, { config, includeUndeclared: true, includeUnused: true });
  const summary = summaries.find((candidate) => candidate.name === name);
  const findings: readonly Finding[] = report.findings.filter(
    (finding) => finding.variable === name,
  );
  const lines: string[] = [];

  if (summary === undefined) {
    lines.push(`${name} is not declared, read or referenced anywhere in ${context.targetDir === context.cwd ? '.' : context.targetDir}`);
    return lines.join('\n');
  }

  const tags: string[] = [];
  tags.push(summary.required ? 'required' : 'optional');
  if (summary.secretish) {
    tags.push('secret');
  }
  if (summary.hasWeakValue) {
    tags.push('weak value');
  }
  if (summary.declaredIn.length === 0) {
    tags.push('undeclared');
  }
  if (summary.readIn.length === 0) {
    tags.push('never read');
  }
  lines.push(`${name}  [${tags.join(', ')}]`);
  if (summary.description !== null) {
    lines.push(`  ${summary.description}`);
  }

  if (summary.declaredIn.length > 0) {
    lines.push('');
    lines.push('  declared in');
    const width = Math.max(...summary.values.map((value) => at(value.file, value.line, 1).length));
    for (const value of summary.values) {
      const flags = [value.shared ? 'shared' : 'local', value.conflicting ? 'conflicts' : '']
        .filter((flag) => flag.length > 0)
        .join(', ');
      lines.push(`    ${pad(at(value.file, value.line, 1), width)}  ${value.preview || '(empty)'}  ${flags}`);
    }
  }

  if (summary.readIn.length > 0) {
    lines.push('');
    lines.push('  read in');
    for (const usage of summary.readIn) {
      const mode = usage.required ? 'no default' : usage.hasFallback ? 'has default' : 'optional';
      lines.push(`    ${at(usage.file, usage.line, 1)}  ${usage.accessor}  ${mode}`);
    }
  }

  const referenced = summary.referencedIn.filter((file) => !summary.readIn.some((usage) => usage.file === file));
  if (referenced.length > 0) {
    lines.push('');
    lines.push('  referenced in');
    for (const file of referenced) {
      lines.push(`    ${file}`);
    }
  }
  if (summary.ciNames.length > 0) {
    lines.push('');
    lines.push(`  CI names: ${summary.ciNames.join(', ')}`);
  }

  if (findings.length > 0) {
    lines.push('');
    lines.push('  findings');
    for (const finding of findings) {
      lines.push(`    ${pad(finding.severity, 5)}  ${pad(finding.ruleId, 28)}  ${at(finding.file, finding.line, finding.column)}`);
      lines.push(`           ${finding.message}`);
    }
  }
  return lines.join('\n');
}

export async function runWhyCommand(context: CommandContext): Promise<CommandOutcome> {
  const name = context.positional[0];
  if (name === undefined) {
    context.io.stderr('why: missing variable name\n');
    return { exitCode: 2 };
  }
  const config = loadConfigFor(context);
  const report = await runScan(scanOptionsFor(context, config));
  const summaries = buildVariableSummaries(report, { config, includeUndeclared: true, includeUnused: true });
  if (!summaries.some((summary) => summary.name === name)) {
    context.io.stderr(`why: ${name} is not declared, read or referenced in this project\n`);
    return { exitCode: 2 };
  }
  context.io.stdout(`${renderVariable(context, config, report, name)}\n`);
  return { exitCode: 0 };
}
