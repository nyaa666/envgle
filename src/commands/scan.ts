import { relative, resolve } from 'node:path';
import { loadConfig } from '../config.js';
import { formatReport, formatSummaryLine } from '../report/format.js';
import { toJsonReport } from '../report/json.js';
import { toMarkdownTable } from '../report/markdown.js';
import { toSarif } from '../report/sarif.js';
import { runScanDetailed } from '../scan/index.js';
import { toPosix } from '../utils/text.js';
import { ruleIds } from '../rules/index.js';
import { REPO_URL, ruleDocsUrl, VERSION } from '../version.js';
import { RANK } from './context.js';
import type { CommandContext, CommandOutcome } from './context.js';
import type { Report, ResolvedConfig, ScanOptions } from '../types.js';

const SEVERITY_RANK: Readonly<Record<string, number>> = { error: 3, warn: 2, info: 1 };

export function severityOf(report: Report, level: string): number {
  return SEVERITY_RANK[level] ?? 0;
}

export function findingsAtOrAbove(report: Report, level: string): number {
  const threshold = severityOf(report, level);
  return report.findings.filter((finding) => (SEVERITY_RANK[finding.severity] ?? 0) >= threshold).length;
}

export function exitCodeFor(report: Report, level: string): 0 | 1 {
  if (level === 'none') {
    return 0;
  }
  return findingsAtOrAbove(report, level) > 0 ? 1 : 0;
}

export function loadConfigFor(context: CommandContext): ResolvedConfig {
  const ignored =
    context.onlyRules.length > 0
      ? [...context.ignoreRules, ...ruleIds().filter((id) => !context.onlyRules.includes(id))]
      : [...context.ignoreRules];
  const overrides = {
    ...(ignored.length > 0 ? { ignoreRules: ignored } : {}),
    ...(context.ignoreVariables.length > 0 ? { ignoreVariables: [...context.ignoreVariables] } : {}),
    ...(context.maxFileSizeKb === undefined ? {} : { maxFileSizeKb: context.maxFileSizeKb }),
  };
  return loadConfig({ root: context.targetDir, configPath: context.configPath, overrides });
}

export function scanOptionsFor(context: CommandContext, config: ResolvedConfig): ScanOptions {
  return {
    root: context.targetDir,
    config,
    now: new Date(),
    useGitignore: context.useGitignore,
  };
}

export function rootLabel(root: string, cwd: string): string {
  const rel = toPosix(relative(cwd, root));
  return rel === '' ? '.' : rel;
}

export function verboseLines(context: CommandContext, config: ResolvedConfig, report: Report, extras: readonly string[]): string[] {
  const lines: string[] = [];
  lines.push(`config: ${config.source ?? 'built-in defaults'}`);
  for (const warning of config.warnings) {
    lines.push(`config warning: ${warning}`);
  }
  lines.push(
    `scanned: ${report.filesScanned} files, ${report.bytesScanned} bytes, ${report.usages.length} reads, ${report.decls.length} declarations, ${report.infra.length} infra references`,
  );
  for (const extra of extras) {
    lines.push(extra);
  }
  if (report.diagnostics !== undefined && report.diagnostics.length > 0) {
    lines.push(`parser notes: ${report.diagnostics.length}`);
    for (const diagnostic of report.diagnostics.slice(0, 20)) {
      lines.push(`  ${diagnostic.file}:${diagnostic.line}:${diagnostic.column}  ${diagnostic.code}  ${diagnostic.message}`);
    }
  }
  if (report.skipped.length > 0) {
    const grouped = new Map<string, number>();
    for (const entry of report.skipped) {
      grouped.set(entry.reason, (grouped.get(entry.reason) ?? 0) + 1);
    }
    const summary = [...grouped.entries()]
      .sort((a, b) => (a[0] < b[0] ? -1 : 1))
      .map(([reason, count]) => `${reason}: ${count}`)
      .join(', ');
    lines.push(`skipped: ${report.skipped.length} (${summary})`);
  }
  lines.push(`duration: ${report.durationMs} ms`);
  if (context.verbose && report.summary.error > 0) {
    lines.push(`exit code 1 unless --fail-on none: ${report.summary.error} error findings`);
  }
  return lines;
}

export function renderReport(context: CommandContext, config: ResolvedConfig, report: Report): string {
  if (context.quiet) {
    return '';
  }
  const label = rootLabel(report.root, context.cwd);
  switch (context.format) {
    case 'json':
      return toJsonReport(report, { config, rootLabel: label, pretty: true, includeSkipped: true, includeVariables: true, groupBy: 'none' });
    case 'sarif':
      return toSarif(report, { toolVersion: VERSION, informationUri: REPO_URL, rootLabel: label });
    case 'markdown':
      return toMarkdownTable(report, { config, rootLabel: label, includeFindings: true, includeEmpty: false });
    case 'quiet':
      return '';
    default:
      return formatReport(report, {
        io: context.io,
        config,
        cwd: context.cwd,
        maxIssuesPerFile: context.maxIssues,
        short: context.short,
        rootLabel: label,
      });
  }
}

export async function runScanCommand(context: CommandContext): Promise<CommandOutcome> {
  const config = loadConfigFor(context);
  const result = await runScanDetailed(scanOptionsFor(context, config));
  const report = result.report;

  if (!(context.quiet) && context.format !== 'quiet' && !(context.command === 'check' && report.findings.length === 0)) {
    const rendered = renderReport(context, config, report);
    if (rendered.length > 0) {
      context.io.stdout(rendered.endsWith('\n') ? rendered : `${rendered}\n`);
    }
  }
  if (context.verbose) {
    const extras = [
      `inline suppressions: ${result.suppressions.count}`,
      ...(result.suppressions.files.length > 0 ? [`suppression files: ${result.suppressions.files.join(', ')}`] : []),
      ...(result.ruleErrors.length > 0
        ? [`rule failures: ${result.ruleErrors.map((error) => `${error.ruleId} (${error.message})`).join(', ')}`]
        : []),
    ];
    for (const line of verboseLines(context, config, report, extras)) {
      context.io.stderr(`${line}\n`);
    }
  } else if (report.summary.error > 0) {
    context.io.stderr(`try: envgle why ${report.findings.find((finding) => finding.severity === 'error')?.variable ?? '<NAME>'} or see ${ruleDocsUrl('missing-in-env')}\n`);
  }

  return { exitCode: exitCodeFor(report, context.failOn) };
}

export function reportSummaryForCli(report: Report): string {
  return formatSummaryLine(report);
}

export const FAIL_ON_LEVELS: readonly string[] = ['error', 'warn', 'info', 'none'];

export const RANK_EXPORT = RANK;

export function resolveWritePath(context: CommandContext, fallback: string): string {
  return resolve(context.cwd, context.writeTarget ?? fallback);
}
