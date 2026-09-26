import type { EnvFileKind, ResolvedConfig, Rule, RuleContext, RuleId, Severity, SourceLocation } from '../types.js';
import { fingerprint, isEnvVarName, isUpperSnakeCase, matchGlob, sortedUnique } from '../utils/text.js';
import { ruleDocsAnchor } from '../version.js';
import type { DefaultSecretPattern, SecretDetection } from './secret-patterns.js';
import { buildSecretPatterns, detectSecret, isSecretishVariableName } from './secret-patterns.js';

interface NamedSite {
  readonly name: string;
  readonly file: string;
  readonly line: number;
  readonly column: number;
}

interface FindingPayload {
  readonly message: string;
  readonly location: SourceLocation;
  readonly severity?: Severity;
  readonly variable?: string;
  readonly hint?: string;
  readonly fingerprint?: string;
}

interface RuleDef extends Omit<Rule, 'docs'> {}

const compareText = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

const compareSites = (a: NamedSite, b: NamedSite): number =>
  compareText(a.file, b.file) || a.line - b.line || a.column - b.column;

const sortedByLocation = <T extends NamedSite>(items: readonly T[]): T[] => [...items].sort(compareSites);

const firstPerName = <T extends NamedSite>(items: readonly T[]): T[] => {
  const seen = new Set<string>();
  const sites: T[] = [];
  for (const item of sortedByLocation(items)) {
    const key = `${item.file}\u0000${item.name}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    sites.push(item);
  }
  return sites;
};

const locationOf = (site: NamedSite): SourceLocation => ({ file: site.file, line: site.line, column: site.column });

const uppercased = (values: ReadonlySet<string>): ReadonlySet<string> => {
  const result = new Set<string>();
  for (const value of values) {
    result.add(value.toUpperCase());
  }
  return result;
};

const SAMPLE_KINDS: ReadonlySet<EnvFileKind> = new Set<EnvFileKind>(['example', 'template']);
const NON_DEPLOY_KINDS: ReadonlySet<EnvFileKind> = new Set<EnvFileKind>(['example', 'template', 'local', 'test']);
const IDENTIFIER_CHAR = /[A-Za-z0-9_]/;
const DIGIT = /[0-9]/;
const ASCII = /^[\u0000-\u007f]*$/;
const PLACEHOLDER_VALUE = [/^your[-_ ]/, /^<.*>$/, /^\$\{/, /^x+$/i, /^todo$/i, /^changeme$/i, /^replace[-_ ]me/i];
const CONNECTION_PATTERN_IDS: ReadonlySet<string> = new Set<string>(['connection-string-password', 'basic-auth-url']);
const PLACEHOLDER_PASSWORDS: ReadonlySet<string> = new Set<string>([
  'password',
  'pass',
  'passwd',
  'secret',
  'changeme',
  'change-me',
  'change_me',
  'xxx',
  'user',
  'postgres',
  'example',
  'placeholder',
  'mypassword',
  'yourpassword',
  'letmein',
]);
const DEBUG_NAMES: ReadonlySet<string> = new Set<string>([
  'DEBUG',
  'DEBUG_MODE',
  'DEBUGGER',
  'VERBOSE',
  'TRACE',
  'LOG_LEVEL',
  'LOG_VERBOSITY',
  'APP_ENV',
  'NODE_ENV',
  'ENV',
  'RAILS_ENV',
  'AUTH_DISABLED',
  'DISABLE_AUTH',
  'BYPASS_AUTH',
  'SKIP_AUTH',
  'NO_AUTH',
  'MOCK',
  'MOCKING',
  'HOT_RELOAD',
  'DEV_TOOLS',
  'STORYBOOK',
]);
const DEBUG_TRUTHY: ReadonlySet<string> = new Set<string>([
  'true',
  '1',
  'yes',
  'on',
  'enabled',
  'debug',
  'trace',
  'verbose',
  'development',
  'dev',
  'local',
  'test',
]);
const CODE_EXECUTION_HOSTILE: ReadonlySet<string> = new Set<string>([
  'LD_PRELOAD',
  'LD_LIBRARY_PATH',
  'LD_AUDIT',
  'LD_DEBUG',
  'DYLD_INSERT_LIBRARIES',
  'DYLD_LIBRARY_PATH',
  'DYLD_FRAMEWORK_PATH',
  'DYLD_ROOT_PATH',
  'GLIBC_TUNABLES',
  'PATH',
  'NODE_OPTIONS',
  'NODE_REPL_EXTERNAL_MODULE',
  'NODE_PATH',
  'CLASSPATH',
  'BASH_ENV',
  'BASHOPTS',
  'SHELLOPTS',
  'ENV',
  'IFS',
  'PS4',
  'PROMPT_COMMAND',
  'PERL5OPT',
  'PERL5LIB',
  'RUBYOPT',
  'RUBYLIB',
  'PYTHONSTARTUP',
  'PYTHONPATH',
  'PYTHONHOME',
  'PYTHONWARNINGS',
  'JAVA_TOOL_OPTIONS',
  '_JAVA_OPTIONS',
  'JDK_JAVA_OPTIONS',
]);

/** Longest environment variable name that POSIX shells, Windows and Docker all accept. */
const MAX_PORTABLE_NAME_LENGTH = 127;

/** Shortest value that is worth running through the credential patterns. */
const MIN_SECRET_LENGTH = 8;

/** Shortest embedded password that counts as a credential rather than a typo. */
const MIN_PASSWORD_LENGTH = 8;

/** Shortest password the connection-string patterns themselves accept. */
const MIN_URL_PASSWORD_LENGTH = 3;

/** How many "://" separators a single value is searched for before giving up. */
const MAX_URL_ATTEMPTS = 8;

const isSampleFile = (kind: EnvFileKind): boolean => SAMPLE_KINDS.has(kind);

const isIgnoredVariable = (config: ResolvedConfig, name: string): boolean => {
  try {
    return config.ignoreVariables.some((glob) => matchGlob(name, glob, true));
  } catch {
    return false;
  }
};

const isCommittedFile = (context: RuleContext, file: string): boolean => {
  const info = context.files.get(file);
  return info === undefined ? true : info.committed;
};

const inspectValue = (
  context: RuleContext,
  patterns: readonly DefaultSecretPattern[],
  name: string,
  value: string,
): SecretDetection & { readonly secretish: boolean } => {
  const secretish = isSecretishVariableName(name, context.config.secretNamePattern);
  const detection = detectSecret({ value, name, secretish }, patterns, context.config.weakValues);
  return { ...detection, secretish };
};

const extractUrlPassword = (value: string): string | null => {
  let from = 0;
  for (let attempt = 0; attempt < MAX_URL_ATTEMPTS; attempt += 1) {
    const separator = value.indexOf('://', from);
    if (separator < 0) {
      return null;
    }
    const rest = value.slice(separator + 3);
    const colon = rest.indexOf(':');
    const at = colon < 0 ? -1 : rest.indexOf('@', colon + 1);
    if (colon > 0 && at > colon + 1 && at - colon - 1 >= MIN_URL_PASSWORD_LENGTH) {
      return rest.slice(colon + 1, at);
    }
    from = separator + 3;
  }
  return null;
};

const isPlaceholderPassword = (password: string): boolean => {
  const normalized = password.trim().toLowerCase();
  return PLACEHOLDER_PASSWORDS.has(normalized) || /^<.*>$/.test(normalized) || /^x+$/.test(normalized);
};

const isPlaceholderUrl = (value: string): boolean => {
  const password = extractUrlPassword(value);
  return password !== null && isPlaceholderPassword(password);
};

const isPlaceholderValue = (value: string, weakValues: ReadonlySet<string>): boolean => {
  const normalized = value.trim().toLowerCase();
  if (normalized.length === 0 || weakValues.has(normalized)) {
    return true;
  }
  return PLACEHOLDER_VALUE.some((pattern) => pattern.test(normalized));
};

const isReportedHighEntropy = (context: RuleContext, detection: SecretDetection, value: string): boolean =>
  detection.highEntropy &&
  !isPlaceholderValue(value, context.config.weakValues) &&
  !isPlaceholderUrl(value);

const shouldReportSecret = (context: RuleContext, detection: SecretDetection, value: string): boolean =>
  detection.matched.length > 0 || isReportedHighEntropy(context, detection, value);

const matchSummary = (detection: SecretDetection): string => {
  if (detection.matched.length === 0) {
    return 'looks machine-generated (high entropy behind a secret-looking name)';
  }
  const names = sortedUnique(detection.matched.map((pattern) => pattern.name));
  return `matches ${names.length} known credential pattern${names.length === 1 ? '' : 's'} (${names.join(', ')})`;
};

const codePointLabel = (char: string): string => {
  const point = char.codePointAt(0) ?? 0;
  return `U+${point.toString(16).toUpperCase().padStart(4, '0')}`;
};

const nameDefect = (name: string): string | null => {
  if (name.length === 0) {
    return 'the name is empty';
  }
  const first = name[0] ?? '';
  if (DIGIT.test(first)) {
    return `it starts with the digit ${JSON.stringify(first)}`;
  }
  for (const char of name) {
    if (!IDENTIFIER_CHAR.test(char)) {
      return `it contains the character ${JSON.stringify(char)} (${codePointLabel(char)})`;
    }
  }
  return null;
};

const firstNonAscii = (name: string): string | null => {
  for (const char of name) {
    if (!ASCII.test(char)) {
      return char;
    }
  }
  return null;
};

const suggestUpperSnake = (name: string): string => {
  const snake = name
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1_$2')
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/[^A-Za-z0-9_]/g, '_')
    .toUpperCase()
    .replace(/^_+/, '');
  return snake.length > 0 ? snake : `APP_${name}`;
};

const emit = (context: RuleContext, ruleId: RuleId, payload: FindingPayload): void => {
  if (context.isSuppressed(payload.location, ruleId)) {
    return;
  }
  context.report({
    ruleId,
    message: payload.message,
    location: payload.location,
    severity: payload.severity,
    variable: payload.variable,
    hint: payload.hint,
    fingerprint: payload.fingerprint,
  });
};

const defineRule = (definition: RuleDef): Rule => ({
  ...definition,
  docs: ruleDocsAnchor(definition.id),
  check: (context: RuleContext): void => {
    try {
      definition.check(context);
    } catch {
      return;
    }
  },
});

const nameSites = (context: RuleContext): NamedSite[] => {
  const declared = new Set<string>();
  for (const decl of context.decls) {
    declared.add(decl.name);
  }
  const usageOnly = context.usages.filter((usage) => !declared.has(usage.name));
  return firstPerName<NamedSite>([...context.decls, ...usageOnly]);
};

const invalidNameRule: RuleDef = {
  id: 'invalid-name',
  title: 'Invalid environment variable name',
  severity: 'warn',
  description:
    'Environment variable names must be shell identifiers ([A-Za-z_][A-Za-z0-9_]*) and UPPER_SNAKE_CASE. Dots, dashes, spaces, leading digits and non-ASCII letters cannot be exported by POSIX shells, Docker or Kubernetes, and mixed-case names cannot be referenced from shell scripts at all.',
  remediation: 'Rename the variable to UPPER_SNAKE_CASE using only ASCII letters, digits and underscores.',
  tags: ['hygiene'],
  check: (context) => {
    for (const site of nameSites(context)) {
      if (isIgnoredVariable(context.config, site.name)) {
        continue;
      }
      const location = locationOf(site);
      const defect = nameDefect(site.name);
      if (defect !== null) {
        emit(context, 'invalid-name', {
          location,
          variable: site.name,
          message: `Environment variable name ${JSON.stringify(site.name)} is not a valid identifier: ${defect}. Valid names match [A-Za-z_][A-Za-z0-9_]*.`,
          hint: 'Rename it; shells, Docker and Kubernetes cannot address the current name.',
        });
        continue;
      }
      if (!isUpperSnakeCase(site.name)) {
        emit(context, 'invalid-name', {
          location,
          variable: site.name,
          message: `Environment variable name ${JSON.stringify(site.name)} is a valid identifier but is not UPPER_SNAKE_CASE, so shells cannot reference it portably: "export ${site.name}=1" fails in POSIX shells, Docker and Kubernetes.`,
          hint: `Rename it to ${JSON.stringify(suggestUpperSnake(site.name))}.`,
        });
      }
    }
  },
};

const reservedNameRule: RuleDef = {
  id: 'reserved-name',
  title: 'Reserved environment variable name',
  severity: 'warn',
  description:
    'A variable whose name is owned by the operating system or the toolchain. The default list is PATH, HOME, USER, USERNAME, LOGNAME, SHELL, PWD, OLDPWD, HOSTNAME, TERM, LANG, LC_ALL, LC_CTYPE, EDITOR, VISUAL, PAGER, DISPLAY, TMPDIR, TEMP, TMP, the XDG_* directories, the Windows variables (SYSTEMROOT, WINDIR, COMSPEC, PATHEXT, PROGRAMFILES, USERPROFILE, HOMEDRIVE, HOMEPATH, APPDATA, LOCALAPPDATA, ALLUSERSPROFILE, PUBLIC) plus the language runtimes (JAVA_HOME, GOPATH, GOROOT, NODE_PATH, PYTHONHOME, VIRTUAL_ENV, CONDA_PREFIX, GEM_HOME, CARGO_HOME) and the effective list is read from config.reservedNames.',
  remediation: 'Rename the variable to an application-scoped name such as APP_PATH; read the reserved variable from the environment instead of overriding it.',
  tags: ['correctness'],
  check: (context) => {
    const reserved = uppercased(context.config.reservedNames);
    for (const site of firstPerName(context.decls)) {
      if (isIgnoredVariable(context.config, site.name)) {
        continue;
      }
      if (!reserved.has(site.name.toUpperCase())) {
        continue;
      }
      emit(context, 'reserved-name', {
        location: locationOf(site),
        variable: site.name,
        message: `${JSON.stringify(site.name)} is a reserved environment variable owned by the operating system or the toolchain. A shared env file that sets it changes the behaviour of every process that sources it, not only this application.`,
        hint: `Rename it to an application-scoped name such as APP_${site.name}.`,
      });
    }
  },
};

const hostileNameRule: RuleDef = {
  id: 'hostile-name',
  title: 'Hostile environment variable name',
  severity: 'error',
  description:
    'A variable that the dynamic loader, a shell or an interpreter start-up hook acts on (LD_PRELOAD, DYLD_INSERT_LIBRARIES, NODE_OPTIONS, BASH_ENV, IFS, PS4, GLIBC_TUNABLES, RUBYOPT, PERL5OPT, JAVA_TOOL_OPTIONS, _JAVA_OPTIONS, PATH, ...). Whoever controls the value controls what code runs, so it is an error in a committed or shared env file, a warning in a developer-only file and an informational note when the code merely reads it. The effective list is read from config.hostileNames.',
  remediation: 'Delete the variable from the env file; apply such settings in a throwaway developer shell or in the deployment platform, never in a file other people source.',
  tags: ['security'],
  check: (context) => {
    const hostile = uppercased(context.config.hostileNames);
    const codeExecution = uppercased(CODE_EXECUTION_HOSTILE);
    for (const site of firstPerName(context.decls)) {
      if (isIgnoredVariable(context.config, site.name)) {
        continue;
      }
      if (!hostile.has(site.name.toUpperCase())) {
        continue;
      }
      const severity: Severity = site.shared ? 'error' : site.devOnly ? 'warn' : 'error';
      const scope = site.shared
        ? 'The file is committed and other people source it'
        : 'The file is a developer-only override';
      const message = codeExecution.has(site.name.toUpperCase())
        ? `${JSON.stringify(site.name)} is a code-execution switch: whoever sets it decides what the dynamic loader, the shell or the interpreter loads into every process that starts with this environment. ${scope}.`
        : `${JSON.stringify(site.name)} is a hostile environment variable: the runtime or the toolchain changes its behaviour for every process that inherits it. ${scope}.`;
      emit(context, 'hostile-name', {
        location: locationOf(site),
        variable: site.name,
        severity,
        message,
        hint: 'Remove the variable; if a developer needs it, set it in a throwaway shell or in the deployment platform instead.',
      });
    }
    const declared = new Set<string>();
    for (const decl of context.decls) {
      declared.add(decl.name);
    }
    for (const site of firstPerName(context.usages.filter((usage) => !declared.has(usage.name)))) {
      if (isIgnoredVariable(context.config, site.name)) {
        continue;
      }
      if (!hostile.has(site.name.toUpperCase())) {
        continue;
      }
      emit(context, 'hostile-name', {
        location: locationOf(site),
        variable: site.name,
        severity: 'info',
        message: `${JSON.stringify(site.name)} is read by the code but never declared, so the process silently inherits it from the ambient environment: whoever can set that environment (shell profile, CI runner image, container runtime) decides how the process behaves.`,
        hint: 'Declare an explicit value, or drop the read and use the platform the process already runs in.',
      });
    }
  },
};

const shellIncompatibleNameRule: RuleDef = {
  id: 'shell-incompatible-name',
  title: 'Environment variable name is not shell portable',
  severity: 'warn',
  description:
    'The name is a valid identifier but cannot be set portably: it contains a non-ASCII character (accented letters, Cyrillic, emoji) or it is longer than 127 characters, the limit several process environments impose. Names that are not valid identifiers at all are reported by invalid-name instead.',
  remediation: 'Transliterate the name to ASCII letters, digits and underscores and keep it below 128 characters.',
  tags: ['hygiene'],
  check: (context) => {
    for (const site of firstPerName(context.decls)) {
      if (isIgnoredVariable(context.config, site.name)) {
        continue;
      }
      if (!isEnvVarName(site.name)) {
        continue;
      }
      const reasons: string[] = [];
      const nonAscii = firstNonAscii(site.name);
      if (nonAscii !== null) {
        reasons.push(
          `the non-ASCII character ${JSON.stringify(nonAscii)} (${codePointLabel(nonAscii)}) is not addressable in POSIX shells, Windows cmd.exe or Docker`,
        );
      }
      if (site.name.length > MAX_PORTABLE_NAME_LENGTH) {
        reasons.push(`the name is ${site.name.length} characters long (limit ${MAX_PORTABLE_NAME_LENGTH})`);
      }
      if (reasons.length === 0) {
        continue;
      }
      emit(context, 'shell-incompatible-name', {
        location: locationOf(site),
        variable: site.name,
        message: `Environment variable name ${JSON.stringify(site.name)} cannot be set portably: ${reasons.join('; ')}.`,
        hint: 'Use an ASCII UPPER_SNAKE_CASE name below 128 characters.',
      });
    }
  },
};

const weakSecretRule: RuleDef = {
  id: 'weak-secret',
  title: 'Secret variable holds a weak or placeholder value',
  severity: 'warn',
  description:
    'A secret-looking variable in a loaded env file whose value is empty or one of the known weak values. The default list is changeme, change_me, change-me, password, passwd, secret, admin, root, test, testing, example, placeholder, todo, tbd, fixme, your-password, your_secret, your-api-key, my-secret, abc123, 123456, 12345678, qwerty, letmein, hunter2, default, undefined, null, none, empty, insert-key-here; the effective list is read from config.weakValues. Example and template files are never reported, because there a placeholder is the correct content.',
  remediation: 'Generate the value with a password manager or secret manager and inject it at deploy time; keep placeholders in .env.example.',
  tags: ['security'],
  check: (context) => {
    for (const decl of sortedByLocation(context.decls)) {
      if (isIgnoredVariable(context.config, decl.name)) {
        continue;
      }
      if (isSampleFile(decl.kind)) {
        continue;
      }
      if (!isSecretishVariableName(decl.name, context.config.secretNamePattern)) {
        continue;
      }
      const normalized = decl.value.trim().toLowerCase();
      const listed = context.config.weakValues.has(normalized);
      const shaped = PLACEHOLDER_VALUE.some((pattern) => pattern.test(normalized));
      if (normalized.length > 0 && !listed && !shaped) {
        continue;
      }
      const reason =
        normalized.length === 0
          ? 'the value is empty'
          : listed
            ? 'the value is on the weak-value list'
            : 'the value looks like a placeholder';
      const digest = fingerprint(decl.value);
      emit(context, 'weak-secret', {
        location: locationOf(decl),
        variable: decl.name,
        fingerprint: digest,
        message: `Secret variable ${JSON.stringify(decl.name)} in ${decl.file} is not a real credential: ${reason} (fingerprint ${digest}).`,
        hint: 'Generate the value in your secret manager and inject it at deploy time; placeholders belong in .env.example.',
      });
    }
  },
};

const secretInRepoRule: RuleDef = {
  id: 'secret-in-repo',
  title: 'Secret value found in a loaded env file',
  severity: 'error',
  description:
    'A declaration whose value matches one of the known credential patterns (AWS keys, GitHub, GitLab, Slack, Stripe, Google, OpenAI, Anthropic, OpenRouter, Groq, Hugging Face, SendGrid, Mailgun, Mailchimp, Twilio, Telegram, npm, PyPI, Docker Hub, Linear, Supabase, Firebase, Azure, PEM private keys, JWTs, connection strings) or is a high-entropy secret behind a secret-looking name. The value itself is never printed: only the pattern names and a sha256 fingerprint prefix. Files that are not committed (a git-ignored .env.local) are reported as a warning instead of an error, and a value that is a known placeholder is left to weak-secret.',
  remediation: 'Rotate the credential, remove the value from the file and inject it from a secret manager (or a CI/CD secret) at deploy time.',
  tags: ['security'],
  check: (context) => {
    const patterns = buildSecretPatterns(context.config.secretPatterns);
    for (const decl of sortedByLocation(context.decls)) {
      if (isIgnoredVariable(context.config, decl.name)) {
        continue;
      }
      if (isSampleFile(decl.kind)) {
        continue;
      }
      if (decl.value.length < MIN_SECRET_LENGTH) {
        continue;
      }
      const detection = inspectValue(context, patterns, decl.name, decl.value);
      if (!shouldReportSecret(context, detection, decl.value)) {
        continue;
      }
      if (context.config.ignoreFingerprints.has(detection.fingerprint)) {
        continue;
      }
      const committed = isCommittedFile(context, decl.file);
      const action = committed
        ? 'Committed files are permanent: rotate the credential now and delete the value from the file.'
        : 'The file is not committed, so the value will not reach the repository; keep it git-ignored and out of every shared or example file.';
      emit(context, 'secret-in-repo', {
        location: locationOf(decl),
        variable: decl.name,
        severity: committed ? 'error' : 'warn',
        fingerprint: detection.fingerprint,
        message: `The value of ${JSON.stringify(decl.name)} in ${decl.file} ${matchSummary(detection)}. Fingerprint ${detection.fingerprint}. ${action}`,
        hint: 'Only a fingerprint is reported: the value is never printed.',
      });
    }
  },
};

const secretInExampleRule: RuleDef = {
  id: 'secret-in-example',
  title: 'Secret value pasted into an example file',
  severity: 'error',
  description:
    'The same credential detection as secret-in-repo, but for example and template files (.env.example, .env.sample, .env.template, .env.dist), which are committed and copied verbatim by every developer. Placeholder values are skipped entirely, because that is the legitimate content of a template: values on the weak-value list, placeholder shapes such as your-api-key-here, and URLs whose password is an obvious placeholder (password, changeme, user, ...). hardcoded-connection-string reports a template that embeds a real password.',
  remediation: 'Replace the credential with a placeholder such as your-api-key-here and rotate the exposed key.',
  tags: ['security'],
  check: (context) => {
    const patterns = buildSecretPatterns(context.config.secretPatterns);
    for (const decl of sortedByLocation(context.decls)) {
      if (isIgnoredVariable(context.config, decl.name)) {
        continue;
      }
      if (!isSampleFile(decl.kind)) {
        continue;
      }
      if (decl.value.length < MIN_SECRET_LENGTH) {
        continue;
      }
      if (isPlaceholderUrl(decl.value) || isPlaceholderValue(decl.value, context.config.weakValues)) {
        continue;
      }
      const detection = inspectValue(context, patterns, decl.name, decl.value);
      if (!shouldReportSecret(context, detection, decl.value)) {
        continue;
      }
      if (context.config.ignoreFingerprints.has(detection.fingerprint)) {
        continue;
      }
      emit(context, 'secret-in-example', {
        location: locationOf(decl),
        variable: decl.name,
        fingerprint: detection.fingerprint,
        message: `Example file ${decl.file} contains what looks like a real credential for ${JSON.stringify(decl.name)}: the value ${matchSummary(detection)}. Fingerprint ${detection.fingerprint}.`,
        hint: 'Example files are committed: replace the value with a placeholder and rotate the exposed credential.',
      });
    }
  },
};

const secretFallbackLiteralRule: RuleDef = {
  id: 'secret-fallback-literal',
  title: 'Hardcoded secret fallback in source code',
  severity: 'error',
  description:
    'A read of a secret-looking variable that supplies a literal default, where the literal itself matches a known credential pattern or passes the high-entropy test. Source code is version control, so a fallback secret is a leak even when the variable is normally set.',
  remediation: 'Drop the fallback for secrets: read the variable and fail loudly when it is missing.',
  tags: ['security'],
  check: (context) => {
    const patterns = buildSecretPatterns(context.config.secretPatterns);
    for (const usage of sortedByLocation(context.usages)) {
      const literal = usage.fallbackLiteral;
      if (literal === null || literal.length === 0) {
        continue;
      }
      if (isIgnoredVariable(context.config, usage.name)) {
        continue;
      }
      const secretish = isSecretishVariableName(usage.name, context.config.secretNamePattern);
      if (!secretish) {
        continue;
      }
      const detection = inspectValue(context, patterns, usage.name, literal);
      if (!shouldReportSecret(context, detection, literal)) {
        continue;
      }
      if (context.config.ignoreFingerprints.has(detection.fingerprint)) {
        continue;
      }
      emit(context, 'secret-fallback-literal', {
        location: locationOf(usage),
        variable: usage.name,
        fingerprint: detection.fingerprint,
        message: `Code reads ${JSON.stringify(usage.name)} in ${usage.file} with a hardcoded fallback literal that ${matchSummary(detection)}. Fingerprint ${detection.fingerprint}.`,
        hint: 'Remove the fallback for secrets and fail loudly when the variable is missing; the literal is never printed.',
      });
    }
  },
};

const debugFlagSharedEnvRule: RuleDef = {
  id: 'debug-flag-shared-env',
  title: 'Debug switch enabled in a shared env file',
  severity: 'warn',
  description:
    'A shared (committed) env file that turns debugging on: DEBUG, DEBUG_MODE, DEBUGGER, VERBOSE, TRACE, LOG_LEVEL, LOG_VERBOSITY, APP_ENV, NODE_ENV, ENV, RAILS_ENV, AUTH_DISABLED, DISABLE_AUTH, BYPASS_AUTH, SKIP_AUTH, NO_AUTH, MOCK, MOCKING, HOT_RELOAD, DEV_TOOLS, STORYBOOK set to true, 1, yes, on, enabled, debug, trace, verbose, development, dev, local or test. A quiet LOG_LEVEL (info, warn, error) is fine, and local, test and template files are never reported.',
  remediation: 'Delete the switch from the shared file and gate the behaviour behind an explicit opt-in variable (for example ENABLE_DEBUG) that defaults to off.',
  tags: ['security'],
  check: (context) => {
    for (const decl of sortedByLocation(context.decls)) {
      if (!decl.shared || NON_DEPLOY_KINDS.has(decl.kind)) {
        continue;
      }
      if (isIgnoredVariable(context.config, decl.name)) {
        continue;
      }
      if (!DEBUG_NAMES.has(decl.name.toUpperCase())) {
        continue;
      }
      const normalized = decl.value.trim().toLowerCase();
      if (!DEBUG_TRUTHY.has(normalized)) {
        continue;
      }
      emit(context, 'debug-flag-shared-env', {
        location: locationOf(decl),
        variable: decl.name,
        message: `Shared env file ${decl.file} sets ${JSON.stringify(decl.name)}=${JSON.stringify(normalized)} for every deployment that sources it.`,
        hint: `Gate the behaviour behind an explicit opt-in variable (for example ${suggestUpperSnake(`ENABLE_${decl.name}`)}) that defaults to off.`,
      });
    }
  },
};

const hardcodedConnectionStringRule: RuleDef = {
  id: 'hardcoded-connection-string',
  title: 'Connection string with an embedded password',
  severity: 'error',
  description:
    'A declaration whose value is a connection string or basic-auth URL that carries a real password (at least 8 characters, and not an obvious placeholder such as password, changeme, user or xxx). Overlap with secret-in-repo is resolved by ownership: for a secret-looking variable name outside example files secret-in-repo reports it, so this rule only covers example and template files and variables whose name is not secretish.',
  remediation: 'Split the credentials: keep the host in the env file and inject user and password from a secret manager or a ${...} reference.',
  tags: ['security'],
  check: (context) => {
    const patterns = buildSecretPatterns(context.config.secretPatterns);
    for (const decl of sortedByLocation(context.decls)) {
      if (isIgnoredVariable(context.config, decl.name)) {
        continue;
      }
      const sample = isSampleFile(decl.kind);
      const secretish = isSecretishVariableName(decl.name, context.config.secretNamePattern);
      if (!sample && secretish) {
        continue;
      }
      const detection = inspectValue(context, patterns, decl.name, decl.value);
      if (!detection.matched.some((pattern) => CONNECTION_PATTERN_IDS.has(pattern.id))) {
        continue;
      }
      const password = extractUrlPassword(decl.value);
      if (password === null || password.length < MIN_PASSWORD_LENGTH || isPlaceholderPassword(password)) {
        continue;
      }
      if (context.config.ignoreFingerprints.has(detection.fingerprint)) {
        continue;
      }
      const message = sample
        ? `Example file ${decl.file} embeds a plaintext password in ${JSON.stringify(decl.name)}: the value ${matchSummary(detection)}. Fingerprint ${detection.fingerprint}.`
        : `Connection string for ${JSON.stringify(decl.name)} in ${decl.file} embeds a plaintext password (fingerprint ${detection.fingerprint}).`;
      emit(context, 'hardcoded-connection-string', {
        location: locationOf(decl),
        variable: decl.name,
        fingerprint: detection.fingerprint,
        message,
        hint: 'Keep the host in the env file and inject the credentials from a secret manager; the password is never printed.',
      });
    }
  },
};

/** The ten naming and secret-hygiene rules, in the order the rules index exports them. */
export const securityRules: readonly Rule[] = [
  defineRule(invalidNameRule),
  defineRule(reservedNameRule),
  defineRule(hostileNameRule),
  defineRule(shellIncompatibleNameRule),
  defineRule(weakSecretRule),
  defineRule(secretInRepoRule),
  defineRule(secretInExampleRule),
  defineRule(secretFallbackLiteralRule),
  defineRule(debugFlagSharedEnvRule),
  defineRule(hardcodedConnectionStringRule),
];
