import type { Finding, Report, ResolvedConfig, RuleId, Severity } from '../types.js';
import { SEVERITY_RANK } from '../types.js';
import { stableStringify } from '../utils/text.js';
import { DEFAULT_REPORT_CONFIG, buildVariableSummaries } from './variables.js';

export interface JsonOptions {
  readonly pretty: boolean;
  readonly includeSource: boolean;
  readonly rootLabel: string;
  readonly redact: boolean;
  readonly sort: boolean;
  readonly groupBy: 'file' | 'rule' | 'variable' | 'none';
  readonly config: ResolvedConfig;
  readonly includeSkipped: boolean;
  readonly includeVariables: boolean;
}

interface JsonFinding {
  ruleId: RuleId;
  ruleTitle: string;
  severity: Severity;
  message: string;
  file: string;
  line: number;
  column: number;
  docsUrl: string;
  variable?: string;
  hint?: string;
  fingerprint?: string;
}

interface JsonIssue {
  kind: string;
  message: string;
  file: string;
  line: number;
  column: number;
}

interface JsonFile {
  readonly path: string;
  readonly kind: string;
  readonly exists: boolean;
  readonly shared: boolean;
  readonly devOnly: boolean;
  readonly tracked: boolean;
  readonly committed: boolean;
  readonly declCount: number;
  readonly issues: readonly JsonIssue[];
}

interface JsonGroup {
  readonly key: string;
  readonly count: number;
  readonly findings: readonly number[];
}

const byCodeUnit = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

const byFinding = (a: Finding, b: Finding): number => {
  const rank = (SEVERITY_RANK[b.severity] ?? 0) - (SEVERITY_RANK[a.severity] ?? 0);
  if (rank !== 0) {
    return rank;
  }
  return byCodeUnit(a.file, b.file) || a.line - b.line || a.column - b.column || byCodeUnit(a.ruleId, b.ruleId);
};

const toJsonFinding = (finding: Finding): JsonFinding => {
  const out: JsonFinding = {
    ruleId: finding.ruleId,
    ruleTitle: finding.ruleTitle,
    severity: finding.severity,
    message: finding.message,
    file: finding.file,
    line: finding.line,
    column: finding.column,
    docsUrl: finding.docsUrl,
  };
  if (finding.variable !== undefined) {
    out.variable = finding.variable;
  }
  if (finding.hint !== undefined) {
    out.hint = finding.hint;
  }
  if (finding.fingerprint !== undefined) {
    out.fingerprint = finding.fingerprint;
  }
  return out;
};

const toJsonFiles = (report: Report): JsonFile[] =>
  (report.files ?? [])
    .slice()
    .sort((a, b) => byCodeUnit(a.path, b.path))
    .map((file) => ({
      path: file.path,
      kind: file.kind,
      exists: file.exists,
      shared: file.shared,
      devOnly: file.devOnly,
      tracked: file.tracked,
      committed: file.committed,
      declCount: file.declCount,
      issues: (file.issues ?? []).map((issue) => ({
        kind: issue.kind,
        message: issue.message,
        file: issue.file,
        line: issue.line,
        column: issue.column,
      })),
    }));

const groupKey = (finding: Finding, groupBy: 'file' | 'rule' | 'variable'): string => {
  if (groupBy === 'file') {
    return finding.file;
  }
  if (groupBy === 'rule') {
    return finding.ruleId;
  }
  return finding.variable ?? '';
};

const toGroups = (
  findings: readonly Finding[],
  groupBy: 'file' | 'rule' | 'variable' | 'none',
): JsonGroup[] => {
  if (groupBy === 'none') {
    return [];
  }
  const buckets = new Map<string, number[]>();
  for (const [index, finding] of findings.entries()) {
    const key = groupKey(finding, groupBy);
    const bucket = buckets.get(key);
    if (bucket === undefined) {
      buckets.set(key, [index]);
    } else {
      bucket.push(index);
    }
  }
  return [...buckets.entries()]
    .sort((a, b) => byCodeUnit(a[0], b[0]))
    .map(([key, indices]) => ({ key, count: indices.length, findings: indices }));
};

const roundedDuration = (durationMs: number): number =>
  Number.isFinite(durationMs) ? Math.round(durationMs) : 0;

/** Serialises the whole report as deterministic JSON; `includeSource` is reserved and never emits `source`, since a Report carries no file text. */
export const toJsonReport = (report: Report, options: Partial<JsonOptions> = {}): string => {
  const pretty = options.pretty ?? true;
  const rootLabel = options.rootLabel ?? report.root;
  const redact = options.redact ?? true;
  const sort = options.sort ?? true;
  const groupBy = options.groupBy ?? 'none';
  const includeSkipped = options.includeSkipped ?? false;
  const includeVariables = options.includeVariables ?? true;
  const config = options.config ?? DEFAULT_REPORT_CONFIG;
  const ordered = (report.findings ?? []).slice();
  if (sort) {
    ordered.sort(byFinding);
  }
  const findings = ordered.map(toJsonFinding);
  const payload: Record<string, unknown> = {
    schemaVersion: 1,
    tool: { name: report.tool.name, version: report.tool.version },
    root: rootLabel,
    durationMs: roundedDuration(report.durationMs),
    summary: report.summary,
    files: toJsonFiles(report),
    variables: includeVariables ? buildVariableSummaries(report, { config, redact }) : [],
    findings,
    groups: toGroups(findings, groupBy),
  };
  if (includeSkipped) {
    payload['skipped'] = (report.skipped ?? []).map((entry) => ({ file: entry.file, reason: entry.reason }));
  }
  return stableStringify(payload, pretty ? 2 : 0);
};

/** Serialises the schema version, tool identity, root label and finding counts only. */
export const toJsonSummary = (report: Report, options: Partial<JsonOptions> = {}): string => {
  const rootLabel = options.rootLabel ?? report.root;
  return stableStringify(
    {
      schemaVersion: 1,
      tool: { name: report.tool.name, version: report.tool.version },
      root: rootLabel,
      summary: report.summary,
    },
    (options.pretty ?? true) ? 2 : 0,
  );
};
