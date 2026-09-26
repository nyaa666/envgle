/**
 * envgle — shared contracts.
 *
 * Every module under src/ imports its types from this file. Types are declared
 * here exactly once; modules must never redeclare them.
 *
 * Conventions used across the codebase:
 * - All paths are project-root-relative POSIX strings ("apps/api/.env").
 * - All line/column numbers are 1-based.
 * - Values inside EnvVarDecl.value are raw secrets: they may reach a report
 *   in redacted form only, never verbatim.
 */

export type Severity = 'error' | 'warn' | 'info';

export const SEVERITIES: readonly Severity[] = ['error', 'warn', 'info'];

export const SEVERITY_RANK: Readonly<Record<Severity, number>> = {
  error: 3,
  warn: 2,
  info: 1,
};

export type Language =
  | 'javascript'
  | 'typescript'
  | 'python'
  | 'go'
  | 'rust'
  | 'java'
  | 'kotlin'
  | 'csharp'
  | 'ruby'
  | 'php'
  | 'perl'
  | 'shell'
  | 'batch'
  | 'swift'
  | 'dart'
  | 'elixir'
  | 'unknown';

export type RuleId =
  | 'missing-in-env'
  | 'missing-from-example'
  | 'unused-variable'
  | 'prod-crash'
  | 'example-out-of-sync'
  | 'ci-secret-undeclared'
  | 'compose-var-undeclared'
  | 'env-file-missing'
  | 'env-file-untracked'
  | 'framework-prefix-mismatch'
  | 'duplicate-key'
  | 'conflicting-values'
  | 'empty-value'
  | 'unquoted-special-chars'
  | 'inline-comment-truncation'
  | 'export-prefix'
  | 'unterminated-quote'
  | 'expansion-unsupported'
  | 'invalid-name'
  | 'reserved-name'
  | 'hostile-name'
  | 'shell-incompatible-name'
  | 'weak-secret'
  | 'secret-in-repo'
  | 'secret-in-example'
  | 'secret-fallback-literal'
  | 'debug-flag-shared-env'
  | 'hardcoded-connection-string';

export type RuleTag = 'correctness' | 'security' | 'hygiene' | 'docs' | 'consistency' | 'performance';

export interface SourceLocation {
  readonly file: string;
  readonly line: number;
  readonly column: number;
}

export interface Finding {
  readonly ruleId: RuleId;
  readonly ruleTitle: string;
  readonly severity: Severity;
  readonly message: string;
  readonly file: string;
  readonly line: number;
  readonly column: number;
  readonly docsUrl: string;
  readonly variable?: string;
  readonly hint?: string;
  readonly fingerprint?: string;
}

export type EnvFileKind = 'dev' | 'test' | 'production' | 'local' | 'example' | 'template' | 'unknown';

export interface EnvFileClassification {
  readonly kind: EnvFileKind;
  /** Intended to be committed and consumed by other people/CI (not local, not example). */
  readonly shared: boolean;
  /** Best-effort: tracked by git, or (no git) present and not ignored. */
  readonly tracked: boolean;
  /** Only meaningful for developers' machines or tests, never for deploys. */
  readonly devOnly: boolean;
}

export type EnvParseIssueKind = 'unterminated-quote' | 'no-separator' | 'unknown';

export interface EnvParseIssue {
  readonly kind: EnvParseIssueKind;
  readonly message: string;
  readonly file: string;
  readonly line: number;
  readonly column: number;
}

export interface EnvVarDecl {
  readonly name: string;
  readonly file: string;
  readonly line: number;
  readonly column: number;
  /** Raw value: surrounding quotes removed, escapes resolved. RAW SECRET — redact before output. */
  readonly value: string;
  /** False for `KEY=`, bare `KEY`, and for `KEY=` followed by nothing. */
  readonly hasValue: boolean;
  readonly quoted: '"' | "'" | null;
  readonly exported: boolean;
  /** Names referenced through ${NAME} / ${NAME:-default} / $NAME inside the value. */
  readonly references: readonly string[];
  /** 1-based line of an earlier declaration of the same name in the same file, else null. */
  readonly duplicateOfLine: number | null;
  /** Comment lines directly above the assignment, `#` stripped and trimmed. */
  readonly leadingComments: readonly string[];
  /** `#`-stripped text of a trailing comment on the same line, for quoted values. */
  readonly inlineComment: string | null;
  /** Text after an unquoted value that starts with whitespace + `#`. */
  readonly unquotedInlineComment: string | null;
  readonly hasTrailingWhitespace: boolean;
  readonly kind: EnvFileKind;
  /** Whole-file facts, copied from the containing EnvFileInfo. */
  readonly shared: boolean;
  readonly devOnly: boolean;
}

export interface EnvFileInfo {
  readonly path: string;
  readonly kind: EnvFileKind;
  readonly exists: boolean;
  readonly shared: boolean;
  readonly devOnly: boolean;
  readonly tracked: boolean;
  readonly declCount: number;
  readonly issues: readonly EnvParseIssue[];
  /** False when the file is git-ignored or a dev-only override such as .env.local. */
  readonly committed: boolean;
  readonly byteSize: number;
}

export interface EnvUsage {
  readonly name: string;
  readonly file: string;
  readonly line: number;
  readonly column: number;
  readonly language: Language;
  /** Accessor id, e.g. "process.env", "os.getenv", "Deno.env.get". */
  readonly accessor: string;
  /** The read supplies a default (getenv('X','d'), process.env.X ?? 'd', ENV.fetch('X','d')). */
  readonly hasFallback: boolean;
  /** The read throws or asserts when the variable is absent (os.environ['X'], ENV['X']). */
  readonly required: boolean;
  /** The name came from an import binding (SvelteKit `$env/static/private`). */
  readonly viaImport: boolean;
  /** A literal default was written next to the read, e.g. os.getenv('X', 'dev'). */
  readonly fallbackLiteral: string | null;
}

export type InfraKind =
  | 'compose-environment'
  | 'compose-interpolation'
  | 'compose-env-file'
  | 'compose-build-arg'
  | 'dockerfile-env'
  | 'dockerfile-arg'
  | 'dockerfile-usage'
  | 'ci-env'
  | 'ci-secret'
  | 'ci-var'
  | 'ci-env-usage'
  | 'dotenv-path';

export interface InfraRef {
  readonly name: string;
  readonly file: string;
  readonly line: number;
  readonly column: number;
  readonly kind: InfraKind;
  /** True for `${VAR:?message}` in compose, or a `secrets:` entry in CI. */
  readonly required: boolean;
  /** For `env_file:` / dotenv path references: the referenced path. */
  readonly refersToFile: boolean;
  /** Interpolation flag: the reference appears as ${VAR} or $VAR rather than a plain declaration. */
  readonly interpolation: boolean;
}

export interface PackageManifest {
  readonly path: string | null;
  readonly name: string | null;
  readonly dependencies: readonly string[];
  readonly devDependencies: readonly string[];
  readonly scripts: Readonly<Record<string, string>>;
  readonly engines: Readonly<Record<string, string>>;
  /**
   * Dependencies declared by any other package.json under the scan root. A
   * monorepo keeps its framework dependency next to the app that uses it, so
   * rules that reason about frameworks need the whole workspace view.
   */
  readonly relatedDependencies?: readonly string[];
}

export interface DeclPreview {
  readonly file: string;
  readonly line: number;
  readonly preview: string;
  readonly conflicting: boolean;
  readonly shared: boolean;
}

export interface UsageSummary {
  readonly file: string;
  readonly line: number;
  readonly accessor: string;
  readonly hasFallback: boolean;
  readonly required: boolean;
}

export interface VariableSummary {
  readonly name: string;
  readonly declaredIn: readonly string[];
  readonly readIn: readonly UsageSummary[];
  readonly referencedIn: readonly string[];
  readonly hasValue: boolean;
  /** Some read has no fallback, so the program depends on it being set. */
  readonly required: boolean;
  readonly secretish: boolean;
  readonly description: string | null;
  readonly kind: EnvFileKind | null;
  readonly hasWeakValue: boolean;
  readonly values: readonly DeclPreview[];
  readonly infraKinds: readonly InfraKind[];
  readonly ciNames: readonly string[];
}

export interface ReportSummary {
  readonly error: number;
  readonly warn: number;
  readonly info: number;
  readonly total: number;
  readonly byRule: Readonly<Record<string, number>>;
  readonly variables: number;
  readonly declared: number;
  readonly read: number;
  readonly secretish: number;
  readonly filesScanned: number;
  readonly filesWithFindings: number;
  readonly rulesFired: number;
  readonly diagnostics?: number;
}

export interface SkippedFile {
  readonly file: string;
  readonly reason: string;
}

export interface ToolInfo {
  readonly name: string;
  readonly version: string;
}

export interface ReportDiagnostic {
  readonly file: string;
  readonly line: number;
  readonly column: number;
  readonly code: string;
  readonly severity: 'error' | 'warn';
  readonly message: string;
}

export interface Report {
  readonly tool: ToolInfo;
  readonly root: string;
  readonly startedAt: string;
  readonly durationMs: number;
  readonly filesScanned: number;
  readonly bytesScanned: number;
  readonly filesSkipped: number;
  readonly skipped: readonly SkippedFile[];
  readonly files: readonly EnvFileInfo[];
  readonly decls: readonly EnvVarDecl[];
  readonly usages: readonly EnvUsage[];
  readonly infra: readonly InfraRef[];
  readonly manifest: PackageManifest | null;
  readonly findings: readonly Finding[];
  readonly summary: ReportSummary;
  /** Parser level notes that no rule owns, shown by `--verbose`. */
  readonly diagnostics?: readonly ReportDiagnostic[];
}

export interface FindingInput {
  readonly ruleId: RuleId;
  readonly message: string;
  readonly location: SourceLocation;
  /** Per-instance override; final severity is input ?? config.severities[ruleId] ?? rule.severity. */
  readonly severity?: Severity;
  readonly variable?: string;
  readonly hint?: string;
  readonly fingerprint?: string;
}

export interface RuleContext {
  readonly root: string;
  readonly config: ResolvedConfig;
  readonly decls: readonly EnvVarDecl[];
  readonly usages: readonly EnvUsage[];
  readonly infra: readonly InfraRef[];
  readonly files: ReadonlyMap<string, EnvFileInfo>;
  readonly manifest: PackageManifest | null;
  readonly byName: ReadonlyMap<string, readonly EnvVarDecl[]>;
  readonly usagesByName: ReadonlyMap<string, readonly EnvUsage[]>;
  readonly infraByName: ReadonlyMap<string, readonly InfraRef[]>;
  /** All distinct names known from declarations, reads and infra, sorted. */
  readonly names: readonly string[];
  /** True when the finding at that location is suppressed by config or an inline comment. */
  readonly isSuppressed: (location: SourceLocation, ruleId: RuleId) => boolean;
  report(finding: FindingInput): void;
}

export interface Rule {
  readonly id: RuleId;
  readonly title: string;
  readonly severity: Severity;
  readonly description: string;
  /** Anchor-only documentation path, e.g. "docs/rules.md#missing-in-env". */
  readonly docs: string;
  readonly remediation: string;
  readonly tags: readonly RuleTag[];
  check(context: RuleContext): void;
}

export interface SecretPatternConfig {
  readonly id: string;
  readonly name: string;
  readonly pattern: string;
  /** Optional unit test string; the pattern must match it. */
  readonly test?: string;
  /** Variables matching this id are treated as secretish (no value is ever printed). */
  readonly secretish?: boolean;
}

export interface EnvAuditConfig {
  $schema?: string;
  include?: string[];
  exclude?: string[];
  /** Extra file names/globs treated as env files. */
  envFiles?: string[];
  /** File names/globs treated as the canonical example/template file. */
  exampleFiles?: string[];
  ignoreRules?: RuleId[];
  ignoreVariables?: string[];
  ignoreFingerprints?: string[];
  severities?: Partial<Record<RuleId, Severity>>;
  weakValues?: string[];
  hostileNames?: string[];
  reservedNames?: string[];
  secretPatterns?: SecretPatternConfig[];
  secretNamePattern?: string;
  maxFileSizeKb?: number;
  maxLineLength?: number;
  /** CI environment name (GitHub Actions `environment:`, GitLab stage) to file kind. */
  ciEnvironmentKinds?: Record<string, EnvFileKind>;
  failOn?: Severity;
  codeFrameLines?: number;
  followSymlinks?: boolean;
  requireExampleFile?: boolean;
}

export interface ResolvedConfig {
  readonly include: readonly string[];
  readonly exclude: readonly string[];
  readonly envFiles: readonly string[];
  readonly exampleFiles: readonly string[];
  readonly ignoreRules: ReadonlySet<RuleId>;
  readonly ignoreVariables: readonly string[];
  readonly ignoreFingerprints: ReadonlySet<string>;
  readonly severities: Readonly<Partial<Record<RuleId, Severity>>>;
  readonly weakValues: ReadonlySet<string>;
  readonly hostileNames: ReadonlySet<string>;
  readonly reservedNames: ReadonlySet<string>;
  readonly secretPatterns: readonly SecretPatternConfig[];
  readonly secretNamePattern: string;
  readonly maxFileSizeBytes: number;
  readonly maxLineLength: number;
  readonly ciEnvironmentKinds: Readonly<Record<string, EnvFileKind>>;
  readonly failOn: Severity;
  readonly codeFrameLines: number;
  readonly followSymlinks: boolean;
  readonly requireExampleFile: boolean;
  /** Absolute path of the config file that was loaded, or null for defaults. */
  readonly source: string | null;
  /** Non-fatal problems found while reading the config file. */
  readonly warnings: readonly string[];
}

export interface ScanOptions {
  readonly root: string;
  readonly config: ResolvedConfig;
  readonly now: Date;
  /** When false, `.gitignore` is not consulted. Defaults to true. */
  readonly useGitignore?: boolean;
}

export type OutputFormat = 'human' | 'json' | 'sarif' | 'markdown' | 'quiet';

export interface CliIo {
  readonly stdout: (text: string) => void;
  readonly stderr: (text: string) => void;
  readonly isColor: boolean;
  readonly cwd: string;
}

export interface CliResult {
  readonly exitCode: number;
}
