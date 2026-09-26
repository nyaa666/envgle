export { loadConfig, stripJsonComments, discoverConfig } from './config.js';
export { parseEnvFile } from './dotenv/parse.js';
export type { SerializeOptions } from './dotenv/format.js';
export { allRules, getRule, ruleIds, isKnownRule, rulesBySeverity } from './rules/index.js';
export { buildContext, runRules, isIgnoredVariable } from './rules/context.js';
export { DEFAULT_SECRET_PATTERNS, buildSecretPatterns, detectSecret } from './rules/secret-patterns.js';
export { runScan, runScanDetailed } from './scan/index.js';
export { classifyEnvFile } from './scan/classify.js';
export { supportedAccessors, scanCode, scanTextFile } from './scan/code.js';
export { parseYaml, blockOf, findInterpolations } from './scan/yaml.js';
export { isComposeFile, scanCompose } from './scan/compose.js';
export { isDockerfile, scanDockerfile } from './scan/dockerfile.js';
export { isCiFile, scanCi } from './scan/ci.js';
export { createIgnoreMatcher } from './utils/ignore.js';
export { walkFiles, detectLanguage, isEnvFileName } from './utils/walk.js';
export { formatReport, formatSummaryLine } from './report/format.js';
export { toJsonReport, toJsonSummary } from './report/json.js';
export { toSarif } from './report/sarif.js';
export { toMarkdownTable, toExampleFile } from './report/markdown.js';
export { buildVariableSummaries } from './report/variables.js';
export { formatEnvText } from './commands/fmt.js';
export { parseArguments, runCli, buildContext as createCommandContext } from './cli.js';
export { VERSION, REPO_URL, DOCS_BASE_URL, ruleDocsUrl } from './version.js';
export type {
  CliIo,
  EnvAuditConfig,
  EnvFileInfo,
  EnvParseIssue,
  EnvUsage,
  EnvVarDecl,
  Finding,
  InfraRef,
  OutputFormat,
  Report,
  ReportSummary,
  ResolvedConfig,
  Rule,
  RuleId,
  ScanOptions,
  Severity,
  VariableSummary,
} from './types.js';
