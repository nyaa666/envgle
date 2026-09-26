import type { Finding, Report, ResolvedConfig, VariableSummary } from '../types.js';
import { SEVERITIES } from '../types.js';
import { appendAll, isEnvVarName, sortedUnique, truncate } from '../utils/text.js';
import { DEFAULT_REPORT_CONFIG, buildVariableSummaries } from './variables.js';

export interface MarkdownOptions {
  readonly title: string;
  readonly includeFindings: boolean;
  readonly includeEmpty: boolean;
  readonly redact: boolean;
  readonly config: ResolvedConfig;
  readonly rootLabel: string;
}

const CELL_LIMIT = 60;
const PATH_LIMIT = 3;
const EMPTY_CELL = '\u2014';
const REDACTED = '<redacted>';
const SECRET_NOTE = 'secret - do not commit a real value';

const byCodeUnit = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

const pluralize = (count: number, one: string, many: string): string => (count === 1 ? one : many);

const escapeCell = (value: string): string =>
  value.replace(/\r?\n/g, ' ').replace(/\|/g, '\\|').replace(/`/g, '\\`');

const cell = (value: string | null | undefined): string => {
  if (value === null || value === undefined || value.length === 0) {
    return EMPTY_CELL;
  }
  return truncate(escapeCell(value), CELL_LIMIT);
};

const listCell = (values: readonly string[]): string => {
  if (values.length === 0) {
    return EMPTY_CELL;
  }
  const shown = values.slice(0, PATH_LIMIT).join(', ');
  const hidden = values.length - PATH_LIMIT;
  return cell(hidden > 0 ? `${shown}, +${hidden} more` : shown);
};

const table = (headers: readonly string[], rows: readonly (readonly string[])[]): string[] => {
  const lines = [`| ${headers.join(' | ')} |`, `| ${headers.map(() => '---').join(' | ')} |`];
  for (const row of rows) {
    lines.push(`| ${row.join(' | ')} |`);
  }
  return lines;
};

const metaLine = (report: Report, rootLabel: string): string => {
  const summary = report.summary;
  return [
    `${report.tool.name} ${report.tool.version}`,
    rootLabel,
    `${report.filesScanned} ${pluralize(report.filesScanned, 'file', 'files')}`,
    `${summary.variables} ${pluralize(summary.variables, 'variable', 'variables')}`,
    `${summary.error} ${pluralize(summary.error, 'error', 'errors')}, ${summary.warn} ${pluralize(summary.warn, 'warning', 'warnings')}, ${summary.info} info`,
  ].join(' \u00b7 ');
};

const severityRank = (severity: string): number => (severity === 'error' ? 3 : severity === 'warn' ? 2 : 1);

const severityOf = (findings: readonly Finding[], ruleId: string): string => {
  let severity = 'info';
  let best = 0;
  for (const finding of findings) {
    if (finding.ruleId !== ruleId) {
      continue;
    }
    const rank = severityRank(finding.severity);
    if (rank > best) {
      best = rank;
      severity = finding.severity;
    }
  }
  return severity;
};

const ruleRows = (report: Report): (readonly string[])[] => {
  const findings = report.findings ?? [];
  const counts = new Map<string, number>();
  for (const finding of findings) {
    counts.set(finding.ruleId, (counts.get(finding.ruleId) ?? 0) + 1);
  }
  const keys = sortedUnique([...Object.keys(report.summary.byRule ?? {}), ...counts.keys()]);
  return keys.map((rule) => [
    cell(rule),
    severityOf(findings, rule),
    String(report.summary.byRule[rule] ?? counts.get(rule) ?? 0),
  ]);
};

const defaultCell = (variable: VariableSummary): string => {
  const first = variable.values[0];
  if (first === undefined || first.preview.length === 0) {
    return EMPTY_CELL;
  }
  return first.preview === REDACTED ? REDACTED : cell(first.preview);
};

const variableRow = (variable: VariableSummary): readonly string[] => [
  cell(variable.name),
  variable.required ? 'yes' : 'no',
  listCell(variable.declaredIn),
  listCell(sortedUnique(variable.readIn.map((usage) => usage.file))),
  defaultCell(variable),
  cell(variable.description),
];

const findingsSection = (report: Report): string[] => {
  const findings = report.findings ?? [];
  if (findings.length === 0) {
    return [];
  }
  const grouped = new Map<string, Finding[]>();
  for (const finding of findings) {
    const bucket = grouped.get(finding.ruleId);
    if (bucket === undefined) {
      grouped.set(finding.ruleId, [finding]);
    } else {
      bucket.push(finding);
    }
  }
  const lines: string[] = ['', '## Findings'];
  for (const ruleId of [...grouped.keys()].sort(byCodeUnit)) {
    const bucket = grouped.get(ruleId) ?? [];
    const first = bucket[0];
    if (first !== undefined) {
      lines.push('', `### ${ruleId}`, '', cell(first.ruleTitle), '');
    }
    lines.push(
      `${severityOf(findings, ruleId)} \u00b7 ${bucket.length} ${pluralize(bucket.length, 'finding', 'findings')}`,
      '',
      ...table(
        ['File', 'Line', 'Message'],
        bucket.map((finding) => [cell(finding.file), String(finding.line), cell(finding.message)]),
      ),
    );
  }
  return lines;
};

/** Renders a `docs/environment.md`-ready document: summary counts, a per-variable table (read-but-undeclared names included) and optional findings. */
export const toMarkdownTable = (report: Report, options: Partial<MarkdownOptions> = {}): string => {
  const config = options.config ?? DEFAULT_REPORT_CONFIG;
  const redact = options.redact ?? true;
  const includeEmpty = options.includeEmpty ?? false;
  const includeFindings = options.includeFindings ?? false;
  const rootLabel = options.rootLabel ?? report.root;
  const summary = report.summary;
  const all = buildVariableSummaries(report, { config, redact, includeUndeclared: true });
  const variables = includeEmpty
    ? all
    : all.filter((variable) => variable.declaredIn.length > 0 || variable.readIn.length > 0);
  const ruleCounts = ruleRows(report);
  const lines: string[] = [
    `# ${options.title ?? 'Environment variables'}`,
    '',
    metaLine(report, rootLabel),
    '',
    ...table(
      ['Severity', 'Count'],
      SEVERITIES.map((severity) => [severity, String(summary[severity])]),
    ),
  ];
  if (ruleCounts.length > 0) {
    lines.push('', ...table(['Rule', 'Severity', 'Count'], ruleCounts));
  }
  if (variables.length === 0) {
    lines.push('', 'No environment variables found.');
  } else {
    lines.push(
      '',
      ...table(
        ['Variable', 'Required', 'Declared in', 'Read in', 'Default', 'Description'],
        variables.map(variableRow),
      ),
    );
  }
  if (includeFindings) {
    appendAll(lines, findingsSection(report));
  }
  return `${lines.join('\n')}\n`;
};

const exampleEntry = (variable: VariableSummary): string[] => {
  const lines: string[] = [];
  if (variable.secretish) {
    lines.push(`# ${SECRET_NOTE}`);
  }
  if (variable.description !== null) {
    lines.push(`# ${variable.description}`);
  }
  const read = variable.readIn[0];
  if (read !== undefined) {
    lines.push(`# read in ${read.file}:${read.line}`);
  }
  lines.push(`${variable.name}=`);
  return lines;
};

/** Renders a `.env.example` skeleton in which every value is left empty, so no secret can ever be written. */
export const toExampleFile = (report: Report, options: Partial<MarkdownOptions> = {}): string => {
  const config = options.config ?? DEFAULT_REPORT_CONFIG;
  const variables = buildVariableSummaries(report, {
    config,
    includeUndeclared: true,
    includeUnused: true,
    redact: true,
  }).filter((variable) => isEnvVarName(variable.name));
  const lines: string[] = [
    `# Generated by ${report.tool.name} v${report.tool.version}. Do not edit by hand: regenerate with "${report.tool.name} init --write".`,
    '# Do NOT put real secrets in this file. Leave secret values empty.',
    '',
    '# --- required (no default) ---',
  ];
  for (const variable of variables.filter((candidate) => candidate.required)) {
    appendAll(lines, exampleEntry(variable));
  }
  lines.push('', '# --- optional ---');
  for (const variable of variables.filter((candidate) => !candidate.required)) {
    appendAll(lines, exampleEntry(variable));
  }
  return `${lines.join('\n')}\n`;
};
