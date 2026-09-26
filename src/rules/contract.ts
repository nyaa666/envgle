import type {
  EnvFileInfo,
  EnvFileKind,
  EnvUsage,
  EnvVarDecl,
  FindingInput,
  InfraRef,
  Rule,
  RuleContext,
  SourceLocation,
} from '../types.js';
import { isSecretishName, matchAnyGlob, resolveRelativePath, sortedUnique } from '../utils/text.js';
import { isIgnoredVariable } from './context.js';

const DECLARING_INFRA_KINDS: readonly string[] = ['compose-environment', 'dockerfile-env', 'ci-env'];
const EXAMPLE_BASENAMES: readonly string[] = [
  '.env.example',
  '.env.example.local',
  '.env.sample',
  '.env.sample.local',
  '.env.template',
  '.env.dist',
];
const EXAMPLE_GLOBS: readonly string[] = [
  '.env.example*',
  '.env.sample*',
  '.env.template*',
  '.env.dist*',
  '*.env.example*',
  '*.env.sample*',
  '*.env.template*',
  '*.env.dist*',
];
const FRAMEWORK_PREFIXES: readonly { prefix: string; packages: readonly string[] }[] = [
  { prefix: 'REACT_APP_', packages: ['react-scripts', 'react', 'next', 'expo'] },
  { prefix: 'VUE_APP_', packages: ['vue', '@vue/cli-service'] },
  { prefix: 'VITE_', packages: ['vite'] },
  { prefix: 'NEXT_PUBLIC_', packages: ['next'] },
  { prefix: 'NUXT_PUBLIC_', packages: ['nuxt', '@nuxt/kit'] },
  { prefix: 'GATSBY_', packages: ['gatsby'] },
];

const isExampleKind = (kind: EnvFileKind): boolean => kind === 'example' || kind === 'template';

const basename = (path: string): string => {
  const index = path.lastIndexOf('/');
  return index === -1 ? path : path.slice(index + 1);
};

const directoryOf = (path: string): string => {
  const index = path.lastIndexOf('/');
  return index <= 0 ? '' : path.slice(0, index);
};

/** True when the file is a canonical example/template env file by kind, basename or config glob. */
const isExampleFile = (context: RuleContext, path: string): boolean => {
  const file = context.files.get(path);
  if (file !== undefined && isExampleKind(file.kind)) {
    return true;
  }
  return (
    EXAMPLE_BASENAMES.includes(basename(path)) ||
    matchAnyGlob(path, EXAMPLE_GLOBS) ||
    matchAnyGlob(path, context.config.exampleFiles, true)
  );
};

const isExampleDecl = (context: RuleContext, decl: EnvVarDecl): boolean =>
  isExampleKind(decl.kind) || isExampleFile(context, decl.file);

const isDevOnlyDecl = (context: RuleContext, decl: EnvVarDecl): boolean =>
  decl.devOnly || context.files.get(decl.file)?.devOnly === true;

const isDeclared = (context: RuleContext, name: string): boolean => (context.byName.get(name)?.length ?? 0) > 0;

const isRead = (context: RuleContext, name: string): boolean => (context.usagesByName.get(name)?.length ?? 0) > 0;

const hasInfra = (context: RuleContext, name: string): boolean => (context.infraByName.get(name)?.length ?? 0) > 0;

/** Names carrying at least one reference of the given kinds, computed once per rule. */
const namesWithInfraKind = (context: RuleContext, kinds: readonly string[]): Set<string> => {
  const names = new Set<string>();
  for (const ref of context.infra) {
    if (kinds.includes(ref.kind)) {
      names.add(ref.name);
    }
  }
  return names;
};

const sortedDecls = (decls: readonly EnvVarDecl[]): EnvVarDecl[] =>
  [...decls].sort((a, b) => (a.file === b.file ? a.line - b.line : a.file < b.file ? -1 : 1));

const firstDeclPerFile = (context: RuleContext, name: string, filter?: (decl: EnvVarDecl) => boolean): EnvVarDecl[] => {
  const seen = new Set<string>();
  const firsts: EnvVarDecl[] = [];
  for (const decl of sortedDecls(context.byName.get(name) ?? [])) {
    if (filter !== undefined && !filter(decl)) {
      continue;
    }
    if (seen.has(decl.file)) {
      continue;
    }
    seen.add(decl.file);
    firsts.push(decl);
  }
  return firsts;
};

const sortedUsages = (usages: readonly EnvUsage[]): EnvUsage[] =>
  [...usages].sort((a, b) => (a.file === b.file ? a.line - b.line : a.file < b.file ? -1 : 1));

/** First usage of every distinct name in every file, so one file reports each undeclared name once. */
const firstUsagePerFile = (usages: readonly EnvUsage[]): EnvUsage[] => {
  const seen = new Set<string>();
  const firsts: EnvUsage[] = [];
  for (const usage of sortedUsages(usages)) {
    const key = `${usage.name}\u0000${usage.file}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    firsts.push(usage);
  }
  return firsts;
};

const exampleNames = (context: RuleContext): Set<string> => {
  const names = new Set<string>();
  for (const decl of context.decls) {
    if (isExampleDecl(context, decl)) {
      names.add(decl.name);
    }
  }
  return names;
};

const examplePaths = (context: RuleContext): string[] => {
  const paths = new Set<string>();
  for (const path of context.files.keys()) {
    if (isExampleFile(context, path)) {
      paths.add(path);
    }
  }
  for (const decl of context.decls) {
    if (isExampleDecl(context, decl)) {
      paths.add(decl.file);
    }
  }
  return sortedUnique([...paths]);
};

/**
 * Candidate repo-relative paths a file reference may point at, in resolution order.
 *
 * A reference written with directory components (`../.env`, `shared/.env`) is resolved
 * and used as-is: guessing a same-named file somewhere else in the tree would report
 * a file that exists instead of the one the manifest actually points at. A bare name
 * (`.env`, `prod.env`) additionally falls back to the repository root, which is how
 * `env_file: [.env]` in a `deploy/` subdirectory finds the shared file.
 */
const resolveFileRef = (ref: InfraRef): string[] => {
  const raw = targetPath(ref);
  const directory = directoryOf(ref.file);
  const resolved = directory === '' ? raw : resolveRelativePath(directory, raw);
  return raw.includes('/') || directory === '' ? [resolved] : [resolved, raw];
};

/** The env file a file reference points at, or undefined when nothing on disk matches. */
const resolveEnvFile = (context: RuleContext, ref: InfraRef): EnvFileInfo | undefined => {
  for (const candidate of resolveFileRef(ref)) {
    const file = context.files.get(candidate);
    if (file !== undefined && file.exists) {
      return file;
    }
  }
  return undefined;
};

const targetPath = (ref: InfraRef): string => ref.name.replace(/\\/g, '/').replace(/^\.\//, '');

/** Sends a finding to the context unless the location is suppressed for its rule. */
const emit = (context: RuleContext, input: FindingInput): void => {
  if (!context.isSuppressed(input.location, input.ruleId)) {
    context.report(input);
  }
};

const at = (file: string, line: number, column: number): SourceLocation => ({ file, line, column });

/**
 * Variables the operating system, the shell or the CI provider injects on its
 * own. They are read in ordinary code but are not the project's configuration,
 * so `missing-in-env` must not demand a declaration for them.
 */
export const AMBIENT_VARIABLES: ReadonlySet<string> = new Set([
  // POSIX and shells
  'PATH', 'HOME', 'PWD', 'OLDPWD', 'SHELL', 'LANG', 'LC_ALL', 'LC_CTYPE', 'LANGUAGE', 'TZ', 'TERM', 'TERMINFO',
  'TMPDIR', 'TEMP', 'TMP', 'USER', 'LOGNAME', 'HOSTNAME', 'EDITOR', 'VISUAL', 'PAGER', 'DISPLAY', 'SSH_AUTH_SOCK',
  'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_CACHE_HOME', 'XDG_RUNTIME_DIR', 'XDG_SESSION_TYPE', 'DBUS_SESSION_BUS_ADDRESS',
  'MAIL', 'SHLVL', 'COLUMNS', 'LINES', 'PS1', 'HISTSIZE',
  // Windows
  'SYSTEMROOT', 'WINDIR', 'COMSPEC', 'PATHEXT', 'USERPROFILE', 'HOMEDRIVE', 'HOMEPATH', 'APPDATA', 'LOCALAPPDATA',
  'ALLUSERSPROFILE', 'PUBLIC', 'PROGRAMFILES', 'PROGRAMFILES(X86)', 'COMMONPROGRAMFILES', 'COMMONPROGRAMFILES(X86)',
  'PROGRAMDATA', 'PROGRAMW6432', 'PSMODULEPATH', 'COMPUTERNAME', 'USERNAME', 'NUMBER_OF_PROCESSORS',
  'PROCESSOR_ARCHITECTURE', 'PROCESSOR_IDENTIFIER', 'PROCESSOR_REVISION', 'PROCESSOR_LEVEL', 'OS',
  // Node and npm
  'NODE_ENV', 'NODE_DEBUG', 'NPM_CONFIG_LOGLEVEL', 'NPM_CONFIG_PREFIX', 'NPM_CONFIG_REGISTRY', 'NPM_CONFIG_USERCONFIG',
  'NPM_CONFIG_CACHE', 'NPM_LIFECYCLE_EVENT', 'NPM_PACKAGE_NAME', 'NPM_VERSION', 'INIT_CWD',
  // CI providers
  'CI', 'CONTINUOUS_INTEGRATION', 'BUILD_NUMBER', 'BUILD_ID', 'BUILD_VCS_NUMBER', 'CI_COMMIT_SHA', 'CI_JOB_ID',
  'CI_PROJECT_ID', 'CI_PIPELINE_ID', 'GITHUB_ACTIONS', 'GITHUB_WORKFLOW', 'GITHUB_RUN_ID', 'GITHUB_RUN_NUMBER',
  'GITHUB_REPOSITORY', 'GITHUB_REF', 'GITHUB_SHA', 'GITHUB_HEAD_REF', 'GITHUB_BASE_REF', 'GITHUB_EVENT_NAME',
  'GITHUB_ACTOR', 'GITHUB_WORKSPACE', 'GITHUB_SERVER_URL', 'GITHUB_API_URL', 'GITHUB_OUTPUT', 'GITHUB_ENV',
  'GITHUB_PATH', 'GITHUB_STEP_SUMMARY', 'RUNNER_OS', 'RUNNER_ARCH', 'RUNNER_NAME', 'RUNNER_TEMP', 'RUNNER_TOOL_CACHE',
  'RUNNER_DEBUG', 'RUNNER_TRACKING_ID', 'TF_BUILD', 'BUILD_BUILDID', 'BUILD_SOURCEVERSION', 'TEAMCITY_VERSION',
  'APPVEYOR', 'CIRCLECI', 'CIRCLE_BRANCH', 'CIRCLE_SHA1', 'TRAVIS', 'TRAVIS_COMMIT', 'DRONE', 'BUILDKITE',
  'BUILDKITE_BUILD_ID', 'CODEBUILD_BUILD_ID', 'CODEBUILD_BUILD_ARN', 'JENKINS_URL', 'JENKINS_HOME', 'HUDSON_URL',
  'AGENT_NAME', 'AGENT_ID', 'AGENT_WORKFOLDER', 'TFVC', 'SYSTEM_TEAMPROJECTID',
  // Tooling conventions
  'NO_COLOR', 'FORCE_COLOR', 'CLICOLOR', 'CLICOLOR_FORCE', 'COLORTERM', 'EDITOR_VISUAL', 'SSL_CERT_FILE',
  'SSL_CERT_DIR', 'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'http_proxy', 'https_proxy', 'no_proxy',
  'PYENV_VERSION', 'VIRTUAL_ENV_DISABLE_PROMPT', 'GOPATH', 'GOCACHE', 'GOMODCACHE', 'CARGO_HOME', 'RUSTUP_HOME',
  'JAVA_HOME', 'GRADLE_USER_HOME', 'GEM_HOME', 'GEM_PATH', 'BASH_ENV', 'ENV', 'SHELLOPTS', 'BASHOPTS',
]);

/** Reports code that reads a variable no env file and no infra declaration provides. */
const checkMissingInEnv = (context: RuleContext): void => {
  const declaredByInfra = namesWithInfraKind(context, DECLARING_INFRA_KINDS);
  for (const usage of firstUsagePerFile(context.usages)) {
    if (
      isIgnoredVariable(context.config, usage.name) ||
      AMBIENT_VARIABLES.has(usage.name) ||
      isDeclared(context, usage.name)
    ) {
      continue;
    }
    if (declaredByInfra.has(usage.name)) {
      continue;
    }
    emit(context, {
      ruleId: 'missing-in-env',
      message: `${usage.name} is read in ${usage.file} but never declared in any env file`,
      location: at(usage.file, usage.line, usage.column),
      variable: usage.name,
      hint: 'declare it in .env.example (envgle init) and keep a committed value in the shared env file',
    });
  }
};

/** Reports real declarations that no example or template file documents. */
const checkMissingFromExample = (context: RuleContext): void => {
  const examples = examplePaths(context);
  if (examples.length === 0) {
    return;
  }
  const documented = exampleNames(context);
  const example = examples[0] ?? '.env.example';
  for (const name of context.names) {
    if (isIgnoredVariable(context.config, name) || documented.has(name)) {
      continue;
    }
    for (const decl of firstDeclPerFile(context, name, (item) => !isExampleDecl(context, item))) {
      emit(context, {
        ruleId: 'missing-from-example',
        message: `${name} is declared in ${decl.file} but is not documented in ${example}`,
        location: at(decl.file, decl.line, decl.column),
        variable: name,
        hint: `add ${name} to ${example} so contributors and deploys know it exists`,
      });
    }
  }
};

/** Reports declarations that neither code, compose, Docker nor CI ever reads. */
const checkUnusedVariable = (context: RuleContext): void => {
  for (const name of context.names) {
    if (isIgnoredVariable(context.config, name) || isRead(context, name) || hasInfra(context, name)) {
      continue;
    }
    const first = sortedDecls(context.byName.get(name) ?? [])[0];
    if (first === undefined) {
      continue;
    }
    emit(context, {
      ruleId: 'unused-variable',
      message: `${name} is declared but never read by code, compose, Docker or CI`,
      location: at(first.file, first.line, first.column),
      variable: name,
      hint: 'remove the declaration or wire the variable up where it is needed',
    });
  }
};

/** Reports required reads that only a dev-only env file can satisfy. */
const checkProdCrash = (context: RuleContext): void => {
  const ciSecretNames = namesWithInfraKind(context, ['ci-secret']);
  for (const name of context.names) {
    if (isIgnoredVariable(context.config, name)) {
      continue;
    }
    const decls = context.byName.get(name) ?? [];
    if (decls.length === 0 || !decls.every((decl) => isDevOnlyDecl(context, decl))) {
      continue;
    }
    if (ciSecretNames.has(name)) {
      continue;
    }
    const required = firstUsagePerFile((context.usagesByName.get(name) ?? []).filter((usage) => usage.required));
    if (required.length === 0) {
      continue;
    }
    const devOnlyFiles = sortedUnique(decls.map((decl) => decl.file));
    for (const usage of required) {
      emit(context, {
        ruleId: 'prod-crash',
        message: `${name} is required in ${usage.file} but only ${devOnlyFiles.join(', ')} declares it, so it will be undefined in production`,
        location: at(usage.file, usage.line, usage.column),
        variable: name,
        hint: 'document it in the example env file, commit it to the shared env file or give the read a default',
      });
    }
  }
};

/** Reports example entries nothing uses, or a repository with no example file at all. */
const checkExampleOutOfSync = (context: RuleContext): void => {
  const examples = examplePaths(context);
  if (examples.length > 0) {
    for (const name of context.names) {
      if (isIgnoredVariable(context.config, name) || isRead(context, name) || hasInfra(context, name)) {
        continue;
      }
      const decls = firstDeclPerFile(context, name, (item) => isExampleDecl(context, item));
      const first = decls[0];
      if (first === undefined || firstDeclPerFile(context, name, (item) => !isExampleDecl(context, item)).length > 0) {
        continue;
      }
      emit(context, {
        ruleId: 'example-out-of-sync',
        message: `${name} is documented in ${first.file} but is declared nowhere else and never read by code, compose, Docker or CI`,
        location: at(first.file, first.line, first.column),
        variable: name,
        hint: 'remove the entry, or declare and use the variable it documents',
      });
    }
    return;
  }
  if (!context.config.requireExampleFile) {
    return;
  }
  const first = sortedDecls(context.decls.filter((decl) => !isExampleDecl(context, decl)))[0];
  if (first === undefined) {
    return;
  }
  emit(context, {
    ruleId: 'example-out-of-sync',
    message: `no example env file is committed, so ${first.name} and every other variable is undocumented`,
    location: at(first.file, first.line, first.column),
    variable: first.name,
    hint: 'run envgle init to create .env.example',
  });
};

/** Reports CI secrets nobody knows are required, without touching the workflow value. */
const checkCiSecretUndeclared = (context: RuleContext): void => {
  const documented = exampleNames(context);
  for (const ref of context.infra) {
    if (ref.kind !== 'ci-secret' || documented.has(ref.name)) {
      continue;
    }
    if (isIgnoredVariable(context.config, ref.name)) {
      continue;
    }
    if (!isSecretishName(ref.name, context.config.secretNamePattern)) {
      continue;
    }
    emit(context, {
      ruleId: 'ci-secret-undeclared',
      message: `${ref.name} is a secret in ${ref.file} but is not documented in any example env file`,
      location: at(ref.file, ref.line, ref.column),
      variable: ref.name,
      hint: `add ${ref.name}= to the example env file and list it in the README`,
    });
  }
};

/** Reports compose interpolations nothing declares, with a per-instance severity. */
const checkComposeVarUndeclared = (context: RuleContext): void => {
  const setInEnvironment = namesWithInfraKind(context, ['compose-environment']);
  for (const ref of context.infra) {
    if (ref.kind !== 'compose-interpolation' || isDeclared(context, ref.name)) {
      continue;
    }
    if (isIgnoredVariable(context.config, ref.name)) {
      continue;
    }
    if (setInEnvironment.has(ref.name)) {
      continue;
    }
    emit(context, {
      ruleId: 'compose-var-undeclared',
      message: `${ref.name} is interpolated in ${ref.file} but is neither declared in an env file nor set in environment:`,
      location: at(ref.file, ref.line, ref.column),
      variable: ref.name,
      severity: ref.required ? 'error' : 'info',
      hint: ref.required
        ? 'add the variable to environment: or to the referenced env_file, otherwise compose fails at up'
        : `declare ${ref.name} in an env file or use \${${ref.name}:-default} in ${ref.file}`,
    });
  }
};

/** Reports env files referenced by compose or dotenv paths that are not on disk. */
const checkEnvFileMissing = (context: RuleContext): void => {
  const reported = new Set<string>();
  for (const ref of context.infra) {
    if (!ref.refersToFile) {
      continue;
    }
    const target = targetPath(ref);
    if (isIgnoredVariable(context.config, target) || resolveEnvFile(context, ref) !== undefined) {
      continue;
    }
    const key = `${ref.file}\u0000${target}`;
    if (reported.has(key)) {
      continue;
    }
    reported.add(key);
    emit(context, {
      ruleId: 'env-file-missing',
      message: `${ref.file} references ${target} which does not exist`,
      location: at(ref.file, ref.line, ref.column),
      hint: 'create the file or fix the relative path to the env file',
    });
  }
};

/** Reports env files a deploy cannot rely on because they are dev-only or untracked. */
const checkEnvFileUntracked = (context: RuleContext): void => {
  const reported = new Set<string>();
  for (const ref of context.infra) {
    if (!ref.refersToFile) {
      continue;
    }
    const target = targetPath(ref);
    if (isIgnoredVariable(context.config, target)) {
      continue;
    }
    const file = resolveEnvFile(context, ref);
    if (file === undefined || (!file.devOnly && file.committed)) {
      continue;
    }
    const key = `${ref.file}\u0000${target}`;
    if (reported.has(key)) {
      continue;
    }
    reported.add(key);
    const reason = file.devOnly ? 'is a dev-only file' : 'is not tracked by git';
    emit(context, {
      ruleId: 'env-file-untracked',
      message: `${ref.file} references ${target} which ${reason}, so the deploy will not have it`,
      location: at(ref.file, ref.line, ref.column),
      hint: 'commit a template of the file or inject the variables in the deploy pipeline',
    });
  }
};

/** Reports bundler-specific variable prefixes the project does not actually use. */
const checkFrameworkPrefixMismatch = (context: RuleContext): void => {
  const manifest = context.manifest;
  if (manifest === null) {
    return;
  }
  const dependencies = new Set(
    [
      ...manifest.dependencies,
      ...manifest.devDependencies,
      ...(manifest.relatedDependencies ?? []),
    ].map((name) => name.toLowerCase()),
  );
  for (const name of context.names) {
    if (isIgnoredVariable(context.config, name)) {
      continue;
    }
    const prefix = FRAMEWORK_PREFIXES.find((entry) => name.startsWith(entry.prefix));
    if (prefix === undefined || prefix.packages.some((pkg) => dependencies.has(pkg))) {
      continue;
    }
    for (const decl of firstDeclPerFile(context, name)) {
      emit(context, {
        ruleId: 'framework-prefix-mismatch',
        message: `${name} uses the ${prefix.prefix} prefix, but this project depends on none of ${prefix.packages.join(', ')}`,
        location: at(decl.file, decl.line, decl.column),
        variable: name,
        hint: 'rename the variable to the prefix your bundler actually injects, or add the matching dependency',
      });
    }
  }
};

export const contractRules: readonly Rule[] = [
  {
    id: 'missing-in-env',
    title: 'Variable read but never declared',
    severity: 'error',
    description: 'Code reads a variable that no env file and no compose/Docker/CI declaration provides.',
    docs: 'docs/rules.md#missing-in-env',
    remediation: 'Declare the variable in the shared env file and list it in .env.example.',
    tags: ['correctness'],
    check: checkMissingInEnv,
  },
  {
    id: 'missing-from-example',
    title: 'Declaration missing from the example file',
    severity: 'error',
    description: 'A variable is declared in a real env file but absent from every example or template file.',
    docs: 'docs/rules.md#missing-from-example',
    remediation: 'Add the variable to the example env file with an empty or placeholder value.',
    tags: ['docs'],
    check: checkMissingFromExample,
  },
  {
    id: 'unused-variable',
    title: 'Variable declared but never used',
    severity: 'warn',
    description: 'A declared variable has no read in code and no reference in compose, Docker or CI.',
    docs: 'docs/rules.md#unused-variable',
    remediation: 'Delete the declaration, or use it where the feature is implemented.',
    tags: ['hygiene'],
    check: checkUnusedVariable,
  },
  {
    id: 'prod-crash',
    title: 'Required read only provided by a dev-only file',
    severity: 'error',
    description: 'A read without a default depends on a variable that only .env.local-style files declare.',
    docs: 'docs/rules.md#prod-crash',
    remediation: 'Ship the variable in the shared env file, document it in the example file, or add a fallback.',
    tags: ['correctness'],
    check: checkProdCrash,
  },
  {
    id: 'example-out-of-sync',
    title: 'Example file out of sync with reality',
    severity: 'error',
    description: 'The example file documents variables nothing uses, or no example file exists at all.',
    docs: 'docs/rules.md#example-out-of-sync',
    remediation: 'Prune unused entries, or run envgle init to create a .env.example.',
    tags: ['docs'],
    check: checkExampleOutOfSync,
  },
  {
    id: 'ci-secret-undeclared',
    title: 'Undocumented CI secret',
    severity: 'warn',
    description: 'A secretish name is required by a CI workflow but missing from every example env file.',
    docs: 'docs/rules.md#ci-secret-undeclared',
    remediation: 'Add the empty name to the example env file and explain it in the README.',
    tags: ['docs'],
    check: checkCiSecretUndeclared,
  },
  {
    id: 'compose-var-undeclared',
    title: 'Compose interpolation with no source',
    severity: 'warn',
    description: 'A ${VAR} used in docker-compose is neither declared in an env file nor set in environment:.',
    docs: 'docs/rules.md#compose-var-undeclared',
    remediation: 'Declare the variable in an env file, set it in environment:, or use a ${VAR:-default} default.',
    tags: ['consistency'],
    check: checkComposeVarUndeclared,
  },
  {
    id: 'env-file-missing',
    title: 'Referenced env file does not exist',
    severity: 'error',
    description: 'compose env_file or a dotenv path points at a file that is not on disk.',
    docs: 'docs/rules.md#env-file-missing',
    remediation: 'Create the file or correct the relative path in the referring manifest.',
    tags: ['correctness'],
    check: checkEnvFileMissing,
  },
  {
    id: 'env-file-untracked',
    title: 'Referenced env file will not be deployed',
    severity: 'error',
    description: 'A referenced env file is dev-only or git-ignored, so a deploy will not contain it.',
    docs: 'docs/rules.md#env-file-untracked',
    remediation: 'Commit a template of the file or inject the variables in the deploy pipeline.',
    tags: ['correctness'],
    check: checkEnvFileUntracked,
  },
  {
    id: 'framework-prefix-mismatch',
    title: 'Framework prefix with no matching dependency',
    severity: 'warn',
    description: 'A variable uses a REACT_APP_/VITE_/NEXT_PUBLIC_-style prefix the project does not use.',
    docs: 'docs/rules.md#framework-prefix-mismatch',
    remediation: 'Rename the variable to the prefix your bundler injects, or add the matching dependency.',
    tags: ['consistency'],
    check: checkFrameworkPrefixMismatch,
  },
];
