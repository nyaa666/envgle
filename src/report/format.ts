import type { CliIo, Finding, Report, ResolvedConfig, Severity } from '../types.js';
import { SEVERITIES } from '../types.js';
import { appendAll } from '../utils/text.js';
import { DOCS_BASE_URL } from '../version.js';

export interface FormatOptions {
  readonly io: CliIo;
  readonly config: ResolvedConfig;
  readonly cwd: string;
  readonly maxIssuesPerFile: number;
  readonly short: boolean;
  readonly rootLabel: string;
}

const RESET = '\u001b[0m';
const BOLD = '\u001b[1m';
const DIM = '\u001b[2m';
const RED = '\u001b[31m';
const YELLOW = '\u001b[33m';
const CYAN = '\u001b[36m';
const GREEN = '\u001b[32m';

const NO_PROBLEMS = 'no env problems found';
const SEVERITY_WIDTH = 5;

const SEVERITY_LABEL: Readonly<Record<Severity, string>> = {
  error: 'error',
  warn: 'warning',
  info: 'info',
};

const SEVERITY_CODE: Readonly<Record<Severity, string>> = {
  error: RED,
  warn: YELLOW,
  info: CYAN,
};

const byCodeUnit = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

const pluralize = (count: number, one: string, many: string): string => (count === 1 ? one : many);

const paint = (color: boolean, code: string, text: string): string => (color ? `${code}${text}${RESET}` : text);

const padEnd = (value: string, width: number): string =>
  value.length >= width ? value : value + ' '.repeat(width - value.length);

const severityCountLabel = (severity: Severity, count: number): string => {
  if (severity === 'info') {
    return `${count} info`;
  }
  return `${count} ${pluralize(count, SEVERITY_LABEL[severity], `${SEVERITY_LABEL[severity]}s`)}`;
};

const headerLine = (report: Report, options: FormatOptions): string => {
  const parts = [`${report.tool.name} ${report.tool.version}`];
  if (options.rootLabel.length > 0) {
    parts.push(options.rootLabel);
  }
  if (report.filesScanned > 0) {
    parts.push(`${report.filesScanned} files`);
  }
  if (report.summary.variables > 0) {
    parts.push(`${report.summary.variables} variables`);
  }
  const duration = Math.round(report.durationMs);
  if (Number.isFinite(duration) && duration > 0) {
    parts.push(`${duration}ms`);
  }
  return parts.join(' \u00b7 ');
};

const capLimit = (maxIssuesPerFile: number): number =>
  Number.isFinite(maxIssuesPerFile) && maxIssuesPerFile >= 0
    ? Math.trunc(maxIssuesPerFile)
    : Number.POSITIVE_INFINITY;

const location = (finding: Finding): string => `${finding.file}:${finding.line}:${finding.column}`;

const findingBody = (finding: Finding, ruleWidth: number): string =>
  `${location(finding)}  ${padEnd(finding.severity, SEVERITY_WIDTH)}  ${padEnd(finding.ruleId, ruleWidth)}  `;

const findingLine = (finding: Finding, ruleWidth: number, color: boolean): string =>
  `${paint(color, DIM, location(finding))}  ` +
  `${paint(color, SEVERITY_CODE[finding.severity], padEnd(finding.severity, SEVERITY_WIDTH))}  ` +
  `${paint(color, BOLD, padEnd(finding.ruleId, ruleWidth))}  ` +
  `${finding.message}`;

const hintLine = (finding: Finding, ruleWidth: number, color: boolean): string =>
  `${' '.repeat(findingBody(finding, ruleWidth).length)}${paint(color, DIM, `hint: ${finding.hint}`)}`;

const capLine = (hidden: number, color: boolean): string =>
  paint(color, DIM, `\u2026 and ${hidden} more in this file`);

const docsUrlFor = (findings: readonly Finding[]): string => {
  const first = findings[0];
  return first !== undefined && first.docsUrl.length > 0 ? first.docsUrl : `${DOCS_BASE_URL}/rules.md`;
};

const countsOf = (findings: readonly Finding[], file: string): number =>
  findings.reduce((count, finding) => (finding.file === file ? count + 1 : count), 0);

const shortFindings = (
  findings: readonly Finding[],
  ruleWidth: number,
  limit: number,
  color: boolean,
): { readonly lines: string[]; readonly perFile: Map<string, number> } => {
  const lines: string[] = [];
  const perFile = new Map<string, number>();
  for (const finding of findings) {
    const printed = perFile.get(finding.file) ?? 0;
    if (printed >= limit) {
      perFile.set(finding.file, printed);
      continue;
    }
    perFile.set(finding.file, printed + 1);
    lines.push(findingLine(finding, ruleWidth, color));
  }
  return { lines, perFile };
};

const groupedFindings = (
  findings: readonly Finding[],
  ruleWidth: number,
  limit: number,
  color: boolean,
): string[] => {
  const lines: string[] = [];
  const files = [...new Set(findings.map((finding) => finding.file))].sort(byCodeUnit);
  for (const [position, file] of files.entries()) {
    if (position > 0) {
      lines.push('');
    }
    let printed = 0;
    for (const finding of findings) {
      if (finding.file !== file || printed >= limit) {
        continue;
      }
      lines.push(findingLine(finding, ruleWidth, color));
      printed += 1;
      if (finding.hint !== undefined && finding.hint.length > 0) {
        lines.push(hintLine(finding, ruleWidth, color));
      }
    }
    const total = countsOf(findings, file);
    if (total > printed) {
      lines.push(capLine(total - printed, color));
    }
  }
  return lines;
};

const capLinesFor = (
  findings: readonly Finding[],
  perFile: ReadonlyMap<string, number>,
  color: boolean,
): string[] => {
  const lines: string[] = [];
  for (const file of [...perFile.keys()].sort(byCodeUnit)) {
    const total = countsOf(findings, file);
    const printed = perFile.get(file) ?? 0;
    if (total > printed) {
      lines.push(capLine(total - printed, color));
    }
  }
  return lines;
};

/** Renders a report for a terminal: header, findings grouped by file, dim hints, a docs line and a summary footer. */
export const formatReport = (report: Report, options: FormatOptions): string => {
  const color = options.io.isColor;
  const findings = report.findings ?? [];
  const ruleWidth = findings.reduce((width, finding) => Math.max(width, finding.ruleId.length), 0);
  const limit = capLimit(options.maxIssuesPerFile);
  const lines: string[] = [headerLine(report, options)];
  if (findings.length === 0) {
    const summaryLine = formatSummaryLine(report);
    lines.push('');
    lines.push(summaryLine === NO_PROBLEMS ? paint(color, GREEN, `\u2713 ${NO_PROBLEMS}`) : summaryLine);
    return `${lines.join('\n')}\n`;
  }
  lines.push('');
  if (options.short) {
    const { lines: findingLines, perFile } = shortFindings(findings, ruleWidth, limit, color);
    appendAll(lines, findingLines);
    appendAll(lines, capLinesFor(findings, perFile, color));
  } else {
    appendAll(lines, groupedFindings(findings, ruleWidth, limit, color));
  }
  if (new Set(findings.map((finding) => finding.ruleId)).size > 1) {
    lines.push(paint(color, DIM, `docs: ${docsUrlFor(findings)}`));
  }
  lines.push('', formatSummaryLine(report));
  if (report.summary.error > 0) {
    lines.push(paint(color, DIM, `run with --format json for details \u00b7 see ${docsUrlFor(findings)}`));
  }
  return `${lines.join('\n')}\n`;
};

/** Compact one-liner such as `1 error, 2 warnings, 3 info \u00b7 6 findings in 2 files`, or `no env problems found`. */
export const formatSummaryLine = (report: Report): string => {
  const summary = report.summary;
  const counts: string[] = [];
  for (const severity of SEVERITIES) {
    const count = summary[severity];
    if (count > 0) {
      counts.push(severityCountLabel(severity, count));
    }
  }
  if (counts.length === 0) {
    return NO_PROBLEMS;
  }
  const total = `${summary.total} ${pluralize(summary.total, 'finding', 'findings')}`;
  const files = `${summary.filesWithFindings} ${pluralize(summary.filesWithFindings, 'file', 'files')}`;
  return `${counts.join(', ')} \u00b7 ${total} in ${files}`;
};
