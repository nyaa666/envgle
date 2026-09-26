import type { Finding, Report, RuleId, RuleTag, Severity } from '../types.js';
import { SEVERITY_RANK } from '../types.js';
import { stableStringify } from '../utils/text.js';

export interface SarifOptions {
  readonly version?: '2.1.0';
  readonly toolVersion: string;
  readonly informationUri: string;
  readonly rootLabel: string;
  readonly notifierName?: string;
}

interface RuleFacts {
  id: RuleId;
  title: string;
  docsUrl: string;
  severity: Severity;
}

const ROOT_ID = '%SRCROOT%';

const SEVERITY_LEVEL: Readonly<Record<Severity, string>> = {
  error: 'error',
  warn: 'warning',
  info: 'note',
};

const SEVERITY_PROPERTY: Readonly<Record<Severity, Severity>> = {
  error: 'error',
  warn: 'warn',
  info: 'info',
};

/** Static SARIF tag metadata, kept local so SARIF output never depends on the rules registry. */
const RULE_TAGS: Readonly<Record<string, readonly RuleTag[]>> = {
  'missing-in-env': ['correctness', 'docs'],
  'missing-from-example': ['docs', 'hygiene'],
  'unused-variable': ['hygiene', 'performance'],
  'prod-crash': ['correctness'],
  'example-out-of-sync': ['docs', 'consistency'],
  'ci-secret-undeclared': ['correctness', 'security'],
  'compose-var-undeclared': ['correctness'],
  'env-file-missing': ['correctness', 'docs'],
  'env-file-untracked': ['hygiene'],
  'framework-prefix-mismatch': ['correctness'],
  'duplicate-key': ['hygiene', 'consistency'],
  'conflicting-values': ['correctness', 'consistency'],
  'empty-value': ['correctness'],
  'unquoted-special-chars': ['correctness'],
  'inline-comment-truncation': ['hygiene'],
  'export-prefix': ['hygiene'],
  'unterminated-quote': ['correctness'],
  'expansion-unsupported': ['correctness'],
  'invalid-name': ['correctness'],
  'reserved-name': ['hygiene'],
  'hostile-name': ['security'],
  'shell-incompatible-name': ['correctness'],
  'weak-secret': ['security'],
  'secret-in-repo': ['security'],
  'secret-in-example': ['security'],
  'secret-fallback-literal': ['security'],
  'debug-flag-shared-env': ['security', 'hygiene'],
  'hardcoded-connection-string': ['security'],
};

/** Short descriptions per rule id; falls back to the finding title when a rule is unknown here. */
const RULE_DESCRIPTIONS: Readonly<Record<string, string>> = {
  'missing-in-env': 'The code reads a variable that no .env file declares, so the program crashes or silently falls back at runtime.',
  'missing-from-example': 'A declared variable is absent from the example file, so new contributors cannot discover it.',
  'unused-variable': 'A variable is declared but never read anywhere in the repository.',
  'prod-crash': 'A required read without a fallback will throw in production when the variable is unset.',
  'example-out-of-sync': 'The example file and the real .env files disagree about which variables exist.',
  'ci-secret-undeclared': 'CI injects a secret that no .env file declares, which hides a real deployment requirement.',
  'compose-var-undeclared': 'docker-compose references a variable that no .env file declares.',
  'env-file-missing': 'An env file is referenced but missing from the repository.',
  'env-file-untracked': 'A shared env file is not tracked by git, so other machines and CI cannot see it.',
  'framework-prefix-mismatch': 'The variable name does not match the framework prefix that the code path requires.',
  'duplicate-key': 'The same key is assigned more than once in one file, so the effective value depends on the parser.',
  'conflicting-values': 'The same variable holds different values across env files.',
  'empty-value': 'A required variable is declared with an empty value.',
  'unquoted-special-chars': 'An unquoted value contains characters that dotenv parsers and shells disagree about.',
  'inline-comment-truncation': 'A trailing comment on an unquoted value is silently dropped or folded into the value.',
  'export-prefix': 'The `export` prefix is unnecessary in a .env file and is not portable to every loader.',
  'unterminated-quote': 'A quoted value is never closed, so the parser swallows the rest of the file.',
  'expansion-unsupported': 'A value uses shell expansion that the dotenv parser does not implement.',
  'invalid-name': 'The key is not a valid POSIX shell identifier, so `export KEY=value` cannot read it.',
  'reserved-name': 'The key shadows a variable the runtime or the shell sets itself.',
  'hostile-name': 'The key can change the behaviour of the process loader itself.',
  'shell-incompatible-name': 'The key cannot be exported by a POSIX shell.',
  'weak-secret': 'A secret-looking value matches a well-known weak placeholder.',
  'secret-in-repo': 'A committed env file contains a value that looks like a real secret.',
  'secret-in-example': 'An example or template file contains a value that looks like a real secret.',
  'secret-fallback-literal': 'A secretish variable is read with a literal fallback, which leaks the secret into the code.',
  'debug-flag-shared-env': 'A debug or trace flag is set in a shared env file, which will be enabled in production.',
  'hardcoded-connection-string': 'A connection string is hardcoded in the code instead of being read from the environment.',
};

const byCodeUnit = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

const positiveInt = (value: number): number =>
  Number.isFinite(value) && value >= 1 ? Math.trunc(value) : 1;

/** Strips drive letters and leading slashes so the SARIF document never contains an absolute path. */
const toRelativeUri = (file: string): string => {
  const posix = file.replace(/\\/g, '/').replace(/^[A-Za-z]:\//, '');
  const trimmed = posix.replace(/^\/+/, '').replace(/^\.\//, '');
  return trimmed.length > 0 ? trimmed : 'unknown';
};

const sarifName = (ruleId: string): string => ruleId.replace(/-/g, '_');

const ruleFacts = (findings: readonly Finding[]): RuleFacts[] => {
  const byId = new Map<RuleId, RuleFacts>();
  for (const finding of findings) {
    const existing = byId.get(finding.ruleId);
    if (existing === undefined) {
      byId.set(finding.ruleId, {
        id: finding.ruleId,
        title: finding.ruleTitle,
        docsUrl: finding.docsUrl,
        severity: finding.severity,
      });
      continue;
    }
    if ((SEVERITY_RANK[finding.severity] ?? 0) > (SEVERITY_RANK[existing.severity] ?? 0)) {
      existing.severity = finding.severity;
    }
    if (existing.title.length === 0) {
      existing.title = finding.ruleTitle;
    }
    if (existing.docsUrl.length === 0) {
      existing.docsUrl = finding.docsUrl;
    }
  }
  return [...byId.values()].sort((a, b) => byCodeUnit(a.id, b.id));
};

const toRuleDescriptor = (rule: RuleFacts): Record<string, unknown> => ({
  id: rule.id,
  name: sarifName(rule.id),
  shortDescription: { text: rule.title },
  fullDescription: { text: RULE_DESCRIPTIONS[rule.id] ?? rule.title },
  helpUri: rule.docsUrl,
  defaultConfiguration: { level: SEVERITY_LEVEL[rule.severity] ?? 'note' },
  properties: {
    tags: RULE_TAGS[rule.id] ?? ['correctness'],
    'envgle/severity': SEVERITY_PROPERTY[rule.severity] ?? 'info',
  },
});

const toResultProperties = (finding: Finding): Record<string, string> => {
  const properties: Record<string, string> = {};
  if (finding.variable !== undefined) {
    properties['variable'] = finding.variable;
  }
  if (finding.hint !== undefined) {
    properties['hint'] = finding.hint;
  }
  if (finding.fingerprint !== undefined) {
    properties['fingerprint'] = finding.fingerprint;
  }
  return properties;
};

const toResult = (finding: Finding, ruleIndex: number): Record<string, unknown> => {
  const uri = toRelativeUri(finding.file);
  const line = positiveInt(finding.line);
  const column = positiveInt(finding.column);
  return {
    ruleId: finding.ruleId,
    ruleIndex,
    level: SEVERITY_LEVEL[finding.severity] ?? 'note',
    message: { text: finding.message },
    locations: [
      {
        physicalLocation: {
          artifactLocation: { uri, uriBaseId: ROOT_ID },
          region: { startLine: line, startColumn: column },
        },
      },
    ],
    partialFingerprints: {
      'envgle/v1': `${finding.ruleId}:${uri}:${line}:${column}`,
    },
    properties: toResultProperties(finding),
  };
};

/** Builds a SARIF 2.1.0 document for GitHub code scanning: one descriptor per rule that fired, one result per finding, no absolute path or secret. */
export const toSarif = (report: Report, options: SarifOptions): string => {
  const findings = report.findings ?? [];
  const rules = ruleFacts(findings);
  const indexById = new Map<RuleId, number>();
  rules.forEach((rule, index) => {
    indexById.set(rule.id, index);
  });
  const driver: Record<string, unknown> = {
    name: report.tool.name,
    version: report.tool.version,
    semanticVersion: options.toolVersion,
    fullName: `${report.tool.name} ${report.tool.version}`,
    rules: rules.map(toRuleDescriptor),
  };
  if (options.informationUri.length > 0) {
    driver['informationUri'] = options.informationUri;
  }
  const invocation: Record<string, unknown> = { executionSuccessful: true };
  if (options.notifierName !== undefined && options.notifierName.length > 0) {
    invocation['toolExecutionNotifications'] = [];
  }
  const run: Record<string, unknown> = {
    tool: { driver },
    originalUriBaseIds: { [ROOT_ID]: { uri: `file:///${toRelativeUri(options.rootLabel)}/` } },
    invocations: [invocation],
    results: findings.map((finding) => toResult(finding, indexById.get(finding.ruleId) ?? 0)),
  };
  const document = {
    $schema: 'https://json.schemastore.org/sarif-2.1.0.json',
    version: options.version ?? '2.1.0',
    runs: [run],
  };
  return `${stableStringify(document, 2)}\n`;
};
