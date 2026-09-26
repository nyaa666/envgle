import type {
  DeclPreview,
  EnvFileKind,
  EnvVarDecl,
  EnvUsage,
  InfraKind,
  InfraRef,
  Report,
  ResolvedConfig,
  RuleId,
  UsageSummary,
  VariableSummary,
} from '../types.js';
import {
  DEFAULT_SECRET_NAME_PATTERN,
  fingerprint,
  groupBy,
  isSecretishName,
  previewValue,
  sortedUnique,
} from '../utils/text.js';

export interface VariableSummaryOptions {
  readonly config: ResolvedConfig;
  readonly includeUndeclared: boolean;
  readonly includeUnused: boolean;
  readonly redact: boolean;
}

/** Config fallback for formatters that have no config of their own; only the name pattern and weak values are read. */
export const DEFAULT_REPORT_CONFIG: ResolvedConfig = {
  include: ['**/*'],
  exclude: [],
  envFiles: [],
  exampleFiles: [],
  ignoreRules: new Set<RuleId>(),
  ignoreVariables: [],
  ignoreFingerprints: new Set<string>(),
  severities: {},
  weakValues: new Set(['changeme', 'change-me', 'password', 'secret', 'todo', 'xxx', 'placeholder']),
  hostileNames: new Set<string>(),
  reservedNames: new Set<string>(),
  secretPatterns: [],
  secretNamePattern: DEFAULT_SECRET_NAME_PATTERN,
  maxFileSizeBytes: 65_536,
  maxLineLength: 2_000,
  ciEnvironmentKinds: {},
  failOn: 'error',
  codeFrameLines: 2,
  followSymlinks: false,
  requireExampleFile: true,
  source: null,
  warnings: [],
};

const PREVIEW_LENGTH = 32;

const byCodeUnit = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

const byDeclLocation = (a: EnvVarDecl, b: EnvVarDecl): number =>
  byCodeUnit(a.file, b.file) || a.line - b.line || a.column - b.column;

const byUsageLocation = (a: EnvUsage, b: EnvUsage): number =>
  byCodeUnit(a.file, b.file) || a.line - b.line || a.column - b.column;

const byRefLocation = (a: InfraRef, b: InfraRef): number =>
  byCodeUnit(a.file, b.file) || a.line - b.line || a.column - b.column;

const CI_KINDS: ReadonlySet<InfraKind> = new Set<InfraKind>(['ci-secret', 'ci-var', 'ci-env']);

const sortedKinds = (values: readonly InfraKind[]): InfraKind[] => [...new Set(values)].sort(byCodeUnit);

const isExampleKind = (kind: EnvFileKind): boolean => kind === 'example' || kind === 'template';

const normalizedValue = (value: string): string => value.trim().toLowerCase();

/** Never throws, even when the configured pattern is not a valid regular expression. */
const secretishName = (name: string, pattern: string): boolean => {
  try {
    return isSecretishName(name, pattern);
  } catch {
    return false;
  }
};

/** Value identity used for conflict detection: hashed for secretish names, previewed otherwise. */
const comparisonKey = (value: string, secretish: boolean): string =>
  secretish ? fingerprint(value) : previewValue(value, { secretish: false, maxLength: PREVIEW_LENGTH });

const firstDescription = (decls: readonly EnvVarDecl[]): string | null => {
  for (const decl of decls) {
    const comments: string[] = [];
    for (const comment of decl.leadingComments ?? []) {
      const trimmed = comment.trim();
      if (trimmed.length > 0) {
        comments.push(trimmed);
      }
    }
    if (comments.length === 0) {
      continue;
    }
    const joined = comments.join(' ').replace(/\s+/g, ' ').trim();
    if (joined.length > 0) {
      return joined;
    }
  }
  return null;
};

/** Example file wins, then a shared file, then the first declaration in file/line order. */
const bestKind = (decls: readonly EnvVarDecl[]): EnvFileKind | null => {
  if (decls.length === 0) {
    return null;
  }
  const preferred = decls.find((decl) => isExampleKind(decl.kind)) ?? decls.find((decl) => decl.shared) ?? decls[0];
  return preferred?.kind ?? null;
};

const toUsageSummary = (usage: EnvUsage): UsageSummary => ({
  file: usage.file,
  line: usage.line,
  accessor: usage.accessor,
  hasFallback: usage.hasFallback,
  required: usage.required,
});

const toDeclPreviews = (decls: readonly EnvVarDecl[], secretish: boolean, redact: boolean): DeclPreview[] =>
  decls.map((decl, index) => {
    const own = comparisonKey(decl.value, secretish);
    return {
      file: decl.file,
      line: decl.line,
      preview: previewValue(decl.value, { secretish: secretish || redact, maxLength: PREVIEW_LENGTH }),
      conflicting: decls.some((other, otherIndex) => otherIndex !== index && comparisonKey(other.value, secretish) !== own),
      shared: decl.shared,
    };
  });

const toUsageSummaries = (usages: readonly EnvUsage[]): UsageSummary[] =>
  usages.slice().sort(byUsageLocation).map(toUsageSummary);

const ciNames = (refs: readonly InfraRef[]): string[] => sortedUnique(refs.filter((ref) => CI_KINDS.has(ref.kind)).map((ref) => ref.name));

/** Builds one VariableSummary per distinct name (declarations, reads, infra), name-sorted; the data source for json, docs and init. */
export const buildVariableSummaries = (
  report: Report,
  options: Partial<VariableSummaryOptions> = {},
): readonly VariableSummary[] => {
  const config = options.config ?? DEFAULT_REPORT_CONFIG;
  const includeUndeclared = options.includeUndeclared ?? false;
  const includeUnused = options.includeUnused ?? true;
  const redact = options.redact ?? true;
  const decls = report.decls ?? [];
  const usages = report.usages ?? [];
  const infra = report.infra ?? [];
  const declsByName = groupBy(decls, (decl) => decl.name);
  const usagesByName = groupBy(usages, (usage) => usage.name);
  const infraByName = groupBy(infra, (ref) => ref.name);
  const names = sortedUnique([...decls.map((decl) => decl.name), ...usages.map((usage) => usage.name), ...infra.map((ref) => ref.name)]);
  const summaries: VariableSummary[] = [];
  for (const name of names) {
    const nameDecls = (declsByName.get(name) ?? []).slice().sort(byDeclLocation);
    const nameUsages = (usagesByName.get(name) ?? []).slice().sort(byUsageLocation);
    const nameRefs = (infraByName.get(name) ?? []).slice().sort(byRefLocation);
    if (nameDecls.length === 0 && !includeUndeclared) {
      continue;
    }
    if (nameDecls.length > 0 && nameUsages.length === 0 && !includeUnused) {
      continue;
    }
    const secretish = secretishName(name, config.secretNamePattern);
    const summary: VariableSummary = {
      name,
      declaredIn: sortedUnique(nameDecls.map((decl) => decl.file)),
      readIn: toUsageSummaries(nameUsages),
      referencedIn: sortedUnique(nameRefs.map((ref) => ref.file)),
      hasValue: nameDecls.some((decl) => decl.hasValue),
      required: nameUsages.some((usage) => usage.required),
      secretish,
      description: firstDescription(nameDecls),
      kind: bestKind(nameDecls),
      hasWeakValue: nameDecls.some(
        (decl) => !isExampleKind(decl.kind) && config.weakValues.has(normalizedValue(decl.value)),
      ),
      values: toDeclPreviews(nameDecls, secretish, redact),
      infraKinds: sortedKinds(nameRefs.map((ref) => ref.kind)),
      ciNames: ciNames(nameRefs),
    };
    summaries.push(summary);
  }
  return summaries;
};
