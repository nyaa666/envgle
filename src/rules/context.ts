import type {
  EnvFileInfo,
  Finding,
  FindingInput,
  Report,
  ResolvedConfig,
  Rule,
  RuleContext,
  RuleId,
  Severity,
  SourceLocation,
} from '../types.js';
import { SEVERITY_RANK } from '../types.js';
import { groupBy, matchGlob, sortedUnique } from '../utils/text.js';
import { ruleDocsUrl } from '../version.js';

export interface ContextInit {
  readonly report: Report;
  readonly config: ResolvedConfig;
  readonly suppress?: (location: SourceLocation, ruleId: RuleId) => boolean;
}

export interface RuleRun {
  readonly findings: readonly Finding[];
  readonly errors: readonly { ruleId: string; message: string }[];
}

interface ContextInternals {
  readonly collected: Finding[];
  currentRule: Rule | null;
  readonly definitions: Map<RuleId, Rule>;
}

const INTERNALS = new WeakMap<RuleContext, ContextInternals>();

/** Builds the shared rule context: lookup maps, the sorted name union and the suppression policy. */
export function buildContext(init: ContextInit): RuleContext {
  const files = new Map<string, EnvFileInfo>();
  for (const file of init.report.files) {
    files.set(file.path, file);
  }
  const byName = groupBy(init.report.decls, (decl) => decl.name);
  const usagesByName = groupBy(init.report.usages, (usage) => usage.name);
  const infraByName = groupBy(init.report.infra, (ref) => ref.name);
  const names = sortedUnique([...byName.keys(), ...usagesByName.keys(), ...infraByName.keys()]);
  const state: ContextInternals = { collected: [], currentRule: null, definitions: new Map<RuleId, Rule>() };
  const suppress = init.suppress;
  const context: RuleContext = {
    root: init.report.root,
    config: init.config,
    decls: init.report.decls,
    usages: init.report.usages,
    infra: init.report.infra,
    files,
    manifest: init.report.manifest,
    byName,
    usagesByName,
    infraByName,
    names,
    isSuppressed: (location, ruleId) =>
      suppress === undefined ? init.config.ignoreRules.has(ruleId) : suppress(location, ruleId),
    report: (finding) => {
      state.collected.push(toFinding(finding, ruleFor(state, finding.ruleId), init.config));
    },
  };
  INTERNALS.set(context, state);
  return context;
}

/** True when any `config.ignoreVariables` glob matches the variable name (case-insensitive). */
export function isIgnoredVariable(config: ResolvedConfig, name: string): boolean {
  return config.ignoreVariables.some((glob) => matchGlob(name, glob, true));
}

/** Runs every rule against the context, isolating throws, then sorts and de-duplicates the findings. */
export function runRules(context: RuleContext, rules: readonly Rule[]): RuleRun {
  const state = INTERNALS.get(context);
  const errors: { ruleId: string; message: string }[] = [];
  for (const rule of rules) {
    if (state === undefined) {
      runDetached(context, rule, errors);
      continue;
    }
    state.definitions.set(rule.id, rule);
    state.currentRule = rule;
    try {
      rule.check(context);
    } catch (error) {
      errors.push({ ruleId: rule.id, message: describeError(error) });
    } finally {
      state.currentRule = null;
    }
  }
  return { findings: state === undefined ? [] : finalize(state.collected), errors };
}

function runDetached(context: RuleContext, rule: Rule, errors: { ruleId: string; message: string }[]): void {
  try {
    rule.check(context);
  } catch (error) {
    errors.push({ ruleId: rule.id, message: describeError(error) });
  }
}

function ruleFor(state: ContextInternals, ruleId: RuleId): Rule | undefined {
  const current = state.currentRule;
  if (current !== null && current.id === ruleId) {
    return current;
  }
  return state.definitions.get(ruleId);
}

function resolveSeverity(input: FindingInput, rule: Rule | undefined, config: ResolvedConfig): Severity {
  if (input.severity !== undefined) {
    return input.severity;
  }
  return config.severities[input.ruleId] ?? rule?.severity ?? 'warn';
}

function toFinding(input: FindingInput, rule: Rule | undefined, config: ResolvedConfig): Finding {
  return {
    ruleId: input.ruleId,
    ruleTitle: rule?.title ?? input.ruleId,
    severity: resolveSeverity(input, rule, config),
    message: input.message,
    file: input.location.file,
    line: input.location.line,
    column: input.location.column,
    docsUrl: ruleDocsUrl(input.ruleId),
    ...(input.variable === undefined ? {} : { variable: input.variable }),
    ...(input.hint === undefined ? {} : { hint: input.hint }),
    ...(input.fingerprint === undefined ? {} : { fingerprint: input.fingerprint }),
  };
}

function finalize(findings: readonly Finding[]): Finding[] {
  const seen = new Set<string>();
  const unique: Finding[] = [];
  for (const finding of findings) {
    const key = [finding.ruleId, finding.file, finding.line, finding.column, finding.variable ?? ''].join('\u0000');
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    unique.push(finding);
  }
  return unique.sort(compareFindings);
}

function compareText(a: string, b: string): number {
  if (a === b) {
    return 0;
  }
  return a < b ? -1 : 1;
}

function compareFindings(a: Finding, b: Finding): number {
  return (
    SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity] ||
    compareText(a.file, b.file) ||
    a.line - b.line ||
    a.column - b.column ||
    compareText(a.ruleId, b.ruleId) ||
    compareText(a.message, b.message) ||
    compareText(a.variable ?? '', b.variable ?? '')
  );
}

function describeError(error: unknown): string {
  if (error instanceof Error) {
    return error.message === '' ? error.name : error.message;
  }
  return String(error);
}
