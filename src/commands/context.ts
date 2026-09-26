import type { CliIo, OutputFormat, RuleId, Severity } from '../types.js';

export interface CommandContext {
  readonly command: string;
  readonly positional: readonly string[];
  readonly values: ReadonlyMap<string, readonly string[]>;
  readonly switches: ReadonlySet<string>;
  readonly io: CliIo;
  readonly cwd: string;
  readonly targetDir: string;
  readonly configPath: string | undefined;
  readonly useGitignore: boolean;
  readonly format: OutputFormat;
  readonly short: boolean;
  readonly verbose: boolean;
  readonly quiet: boolean;
  readonly dryRun: boolean;
  readonly maxIssues: number;
  readonly maxFileSizeKb: number | undefined;
  readonly failOn: Severity | 'none';
  readonly onlyRules: readonly RuleId[];
  readonly ignoreRules: readonly RuleId[];
  readonly ignoreVariables: readonly string[];
  /** Optional write target, either a flag value or a positional path. */
  readonly writeTarget: string | undefined;
}

export interface CommandOutcome {
  readonly exitCode: number;
}

export const RANK: Readonly<Record<Severity | 'none', number>> = {
  none: 0,
  info: 1,
  warn: 2,
  error: 3,
};
