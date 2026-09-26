# Configuration

envgle is configured with a single JSON object. Every field is optional; an
absent field keeps its built-in default. The same object can live in four
places, and any CLI flag always wins over the file. `//` and `/* */` comments
are allowed in the config file, so it can be annotated in place.

## Where the configuration comes from

Resolution order, highest priority first:

1. The path passed to `--config <path>`. No discovery happens, so a
   `.envglerc.json` higher up the tree is not merged in behind it.
2. The `"envgle"` key of the nearest `package.json`, searched upward from the
   target directory.
3. The nearest `.envglerc.json`.
4. The nearest `envgle.config.json`.
5. The built-in defaults, when none of the above exists.

Steps 2 to 4 all search upward, starting at the target directory (the
`[path]` argument, or the current working directory when no path is given) and
stopping at the first directory that provides a source. Whichever source is
found first wins outright: a `package.json` key higher up the tree does not get
merged with a `.envglerc.json` lower down.

The resolved source path is reported by `--verbose`, so it is always possible to
say which file produced a given setting.

Nothing in a config file is fatal. `loadConfig` never throws: an unreadable
file, a file that is not a JSON object, a value of the wrong type, an unknown
key, an unknown rule id in `ignoreRules` or `severities`, a regular expression
that does not compile and a secret pattern that fails its own `test` string are
all dropped, each one recorded in the resolved configuration's `warnings` list,
which `--verbose` prints to stderr. A bad entry degrades that one setting
instead of failing the run. Exit code `2` is reserved for a usage error on the
command line: an unknown flag, an unknown rule id passed to `--rule` or
`--ignore-rule`, or a bad flag value.

```bash
# Use one specific file, regardless of what the tree contains.
envgle scan --config ./config/envgle.strict.json

# Start from an empty configuration instead of the discovered one.
printf '{}\n' > .envgle.empty.json
envgle scan --config .envgle.empty.json
```

## Field reference

| Field | Type | Default | Meaning |
| --- | --- | --- | --- |
| `$schema` | `string` | not set | URL of a JSON Schema, consumed by editors. Purely advisory: the key is ignored at runtime. |
| `include` | `string[]` | `[]` (everything) | Globs a file must match to be scanned. Matched against the project-relative POSIX path and against the bare file name, case-insensitively. An empty array also means "everything". |
| `exclude` | `string[]` | `[]` | Globs that drop a file or skip a directory. Matched the same way as `include`. A directory that matches is not descended into. |
| `envFiles` | `string[]` | `[]` | Extra file names or globs treated as dotenv files on top of the built-in detection. Useful for conventions such as `config/dev.env` or `.envrc`. |
| `exampleFiles` | `string[]` | `[]` | Extra file names or globs treated as the canonical example/template file, on top of `.env.example`, `.env.sample`, `.env.template`, `.env.dist` and their variants. |
| `ignoreRules` | `RuleId[]` | `[]` | Rule ids that never run. Equivalent to repeating `--ignore-rule`. An id that is not one of the 28 is dropped with a warning. |
| `ignoreVariables` | `string[]` | `[]` | Globs matched against variable names (and against referenced env file paths) to silence every rule for the names they match. Equivalent to repeating `--ignore-var`. |
| `ignoreFingerprints` | `string[]` | `[]` | Value fingerprints (the 12-character prefix the tool prints) to suppress, so an intentional test credential does not fire on every run. Matched case-insensitively. |
| `severities` | `Partial<Record<RuleId, Severity>>` | `{}` | Per-rule severity override, e.g. `{"unused-variable": "info"}`. A rule with no entry keeps its own default severity. An unknown rule id is dropped with a warning. The three rules that choose a severity per finding (`compose-var-undeclared`, `hostile-name`, `secret-in-repo`) ignore this map. |
| `weakValues` | `string[]` | 35 placeholders (below) | Values that are never a real credential. Comparison lowercases and trims the value. Adds to the built-in list, it does not replace it. |
| `hostileNames` | `string[]` | 32 loader and shell vectors (below) | Names the dynamic loader, a shell or an interpreter start-up hook acts on. Matched case-insensitively. Adds to the built-in list, it does not replace it. |
| `reservedNames` | `string[]` | 46 OS and toolchain identity names (below) | Names owned by the operating system or the toolchain. Matched case-insensitively. Adds to the built-in list, it does not replace it. |
| `secretPatterns` | `SecretPatternConfig[]` | `[]` (the 30 built-in patterns stay in force) | Extra credential shapes, merged into the built-in list by `id`. See "Extending secret detection". |
| `secretNamePattern` | `string` | the regex below | JavaScript regular expression source, matched case-insensitively against variable names to decide whether a value must be treated as a secret. Replaces the built-in pattern; one that does not compile is dropped with a warning and the default is used. |
| `maxFileSizeKb` | `number` | `64` | Files larger than this many kilobytes are skipped as `too-large` and counted in `filesSkipped`. |
| `maxLineLength` | `number` | `2000` | Reserved. Accepted and validated, but currently unused: no stage reads it, so setting it changes nothing today. |
| `ciEnvironmentKinds` | `Record<string, EnvFileKind>` | the 10 built-in names (below) | Maps a CI environment name (a GitHub Actions `environment:`, a GitLab stage) to an env file kind: `dev`, `test`, `production`, `local`, `example`, `template` or `unknown`. Decides whether a file found through CI is treated as deploy-relevant. Merges with the built-in map, so your entries override single names rather than replacing the set. |
| `failOn` | `Severity` | `"error"` | Lowest severity that makes the process exit `1`. One of `error`, `warn` or `info`. The type is `Severity`, so `none` is not a valid value here: a `none` in the file is dropped with a warning and the default applies. The CLI flag additionally accepts `--fail-on none`, which never fails. |
| `codeFrameLines` | `number` | `2` | Reserved. Accepted and validated, but currently unused: the report carries no file contents, so the human format has nothing to print a frame from. Setting it changes nothing today. |
| `followSymlinks` | `boolean` | `false` | Whether symbolic links are resolved. When `false` a link is skipped as `symlink`; when `true` it is followed, with a visited-real-path set preventing cycles. |
| `requireExampleFile` | `boolean` | `true` | When `true`, a repository with real declarations and no example file is reported once by `example-out-of-sync`. Set to `false` for repositories that genuinely have no `.env.example`. |

Types referenced above:

- `RuleId` is one of the 28 ids, each with a `## <id>` section in
  `docs/rules.md`.
- `Severity` is `error`, `warn` or `info`.
- `SecretPatternConfig` is `{ id, name, pattern, test?, secretish? }`.
- `EnvFileKind` is `dev`, `test`, `production`, `local`, `example`, `template`
  or `unknown`.

## Glob semantics

The same glob dialect is used by `include`, `exclude`, `envFiles`,
`exampleFiles` and `ignoreVariables`:

| Token | Meaning |
| --- | --- |
| `*` | Any run of characters that does not cross a `/`. |
| `**` | Any run of characters including `/`. `**/` also matches zero directories. |
| `?` | Exactly one character, never `/`. |
| `{a,b}` | Alternation: matches `a` or `b`. Nested braces are not expanded. |
| anything else | A literal character. Regex metacharacters are escaped, so `.` and `+` match themselves. |

Matching is always anchored to the whole value and always case-insensitive.
`*` not crossing `/` matters for paths, not for variable names: a variable name
cannot contain `/`, so `*` already covers it. It does matter for the
`ignoreVariables` entries that suppress a missing env file, where the value is a
path such as `apps/api/.env`.

Examples:

| Glob | Matches | Does not match |
| --- | --- | --- |
| `API_*` | `API_KEY`, `API_BASE_URL` | `APP_API_KEY`, which starts with `APP_` |
| `*_TOKEN` | `GITHUB_TOKEN` | `TOKEN`, which has no prefix |
| `{DEV,PROD}_DB_URL` | `DEV_DB_URL`, `PROD_DB_URL` | `STAGING_DB_URL` |
| `G?TOKEN` | `GHTOKEN`, any seven-character name of that shape | `GITHUB_TOKEN`, which is longer, and `TOKEN`, which is shorter |
| `**/*.env` | `apps/api/.env`, and `.env` at the root | `.env.production`, which is a different file name |

`ignoreVariables` suppresses every rule that would otherwise report the name, so
it is the blunt instrument. Prefer `--ignore-rule` for a rule you do not want
anywhere, and `ignoreVariables` for a name that is legitimately outside your
control.

## Extending secret detection

`secretPatterns` does not replace the built-in list; it merges into it:

- An entry whose `id` already exists **replaces** that built-in pattern. This
  is how you narrow a pattern that is too eager on your codebase.
- An entry with a new `id` is **appended** to the merged set.

Every entry is self-validated before it is used:

1. `pattern` must compile as a JavaScript regular expression. An entry that
   does not compile is dropped.
2. When `test` is present, `pattern` must match `test`. An entry whose own test
   string does not match is dropped.

A dropped entry is not fatal: the scan continues without that pattern and the
resolved configuration's `warnings` list names the entry. `--verbose` prints
each of those warnings to stderr. That way a typo in the configuration degrades
one pattern instead of failing the whole run.

```json
{
  "secretPatterns": [
    {
      "id": "internal-service-token",
      "name": "Internal service token",
      "pattern": "(?:svc_[A-Za-z0-9]{40})",
      "test": "svc_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      "secretish": true
    },
    {
      "id": "aws-access-key-id",
      "name": "AWS access key id",
      "pattern": "(?:A3T[A-Z0-9]|AKIA|ASIA)[A-Z0-9]{16}",
      "test": "AKIAIOSFODNN7EXAMPLE",
      "secretish": true
    }
  ]
}
```

The first entry is new, so it is added. The second shares the id of a built-in
pattern, so it replaces it, which is the way to make the tool stricter about one
provider without losing the other 29 shapes.

## Defaults worth knowing

### secretNamePattern

The default decides which names are treated as secret-bearing. Quoted verbatim
from `src/utils/text.ts`:

```regex
(SECRET|TOKEN|PASSWORD|PASSWD|PWD|API_?KEY|PRIVATE_?KEY|ACCESS_?KEY|CREDENTIAL|AUTH_?KEY|SESSION_?KEY|CLIENT_?SECRET|ENCRYPTION|SALT|CERT_?KEY|SIGNING_?KEY|INTERNAL_?(SIGNING_)?KEY|DATABASE_?URL|DSN)
```

A variable whose name matches it is classified as secretish: its value is never
printed, not even in `--format json` or `--format markdown`, and only a
truncated sha256 fingerprint is reported. Add your own house naming scheme, for
example `(TEAM_)?SIGNING_KEY`, by extending the alternation, so the built-in
names stay covered. Replacing the pattern instead of extending it is legal, but
then the built-in names are no longer redacted unless you repeat them.

### weakValues

```json
[
  "changeme", "change-me", "change_me", "password", "passwd", "pwd", "secret",
  "admin", "root", "test", "testing", "example", "placeholder", "todo", "tbd",
  "fixme", "your-password", "your_password", "your-secret", "your_secret",
  "your-api-key", "your_api_key", "my-secret", "abc123", "123456", "12345678",
  "qwerty", "letmein", "hunter2", "default", "undefined", "null", "none",
  "empty", "insert-key-here"
]
```

Comparison lowercases and trims the value first. Entries you add are merged
with these, so a value already on the list stays weak. Example and template
files are never reported by `weak-secret`, because a placeholder is the correct
content there.

### hostileNames

```json
[
  "LD_PRELOAD", "LD_LIBRARY_PATH", "LD_AUDIT", "LD_DEBUG",
  "DYLD_INSERT_LIBRARIES", "DYLD_LIBRARY_PATH", "DYLD_FRAMEWORK_PATH",
  "DYLD_ROOT_PATH", "NODE_OPTIONS", "NODE_REPL_EXTERNAL_MODULE", "NODE_PATH",
  "BASH_ENV", "ENV", "SHELLOPTS", "BASHOPTS", "IFS", "PS4", "PROMPT_COMMAND",
  "PERL5OPT", "PERL5LIB", "RUBYOPT", "RUBYLIB", "PYTHONSTARTUP", "PYTHONPATH",
  "PYTHONHOME", "PYTHONWARNINGS", "GLIBC_TUNABLES", "JAVA_TOOL_OPTIONS",
  "_JAVA_OPTIONS", "JDK_JAVA_OPTIONS", "CLASSPATH", "PATH"
]
```

Rationale: every one of these is a code-execution or interpreter start-up
switch. Whoever controls the value decides what the dynamic loader, the shell or
the runtime loads into every process that starts with that environment, so
declaring one in a file other people source is a defect rather than a style
question. Entries you add are merged with these, so a built-in vector stays
covered. Severity follows the file: an error in a committed or shared file, a
warning in a developer-only file, and an informational note when code merely
reads the name.

### reservedNames

```json
[
  "HOME", "USER", "USERNAME", "LOGNAME", "SHELL", "PWD", "OLDPWD", "HOSTNAME",
  "TERM", "LANG", "LC_ALL", "LC_CTYPE", "EDITOR", "VISUAL", "PAGER", "DISPLAY",
  "TMPDIR", "TEMP", "TMP",
  "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_CACHE_HOME", "XDG_RUNTIME_DIR",
  "SYSTEMROOT", "WINDIR", "COMSPEC", "PATHEXT", "PROGRAMFILES", "USERPROFILE",
  "HOMEDRIVE", "HOMEPATH", "APPDATA", "LOCALAPPDATA", "ALLUSERSPROFILE",
  "PUBLIC", "NUMBER_OF_PROCESSORS", "PROCESSOR_ARCHITECTURE",
  "PROCESSOR_IDENTIFIER", "OS",
  "JAVA_HOME", "GOPATH", "GOROOT", "VIRTUAL_ENV", "CONDA_PREFIX", "GEM_HOME",
  "CARGO_HOME"
]
```

Rationale: these names carry system identity (who the user is, which home
directory, which locale) or sit on a loader's search path. An application that
sets one in a shared env file changes the behaviour of every process that
sources that file, not just its own, which is a reliable source of "works on my
machine" failures.

### ciEnvironmentKinds

The built-in map, which your entries are merged into:

```json
{
  "production": "production",
  "prod": "production",
  "staging": "production",
  "preview": "production",
  "development": "dev",
  "dev": "dev",
  "test": "test",
  "testing": "test",
  "qa": "test",
  "ci": "test"
}
```

A name maps to the file kind a CI `environment:` or GitLab stage produces, so
`staging` counts as a production deploy by default. Only the six kinds `dev`,
`test`, `production`, `local`, `example` and `unknown` are handed to the CI
scanner; `template` is accepted by the field type but narrowed out before use.

## A fully annotated configuration

The commented form below exists to explain the fields. The comments are valid
in all three config locations: `//` and `/* */` are stripped before the file is
parsed, so the annotated form can be saved as it stands.

```jsonc
{
  // $schema is omitted here. Set it to the JSON Schema URL your editor should
  // use for completion; the key has no effect at runtime.

  // Only look at source, manifests and env files. Build output and vendored
  // trees are already skipped by default, this is belt and braces.
  "include": ["**/*"],
  "exclude": [
    "**/fixtures/**",
    "**/__snapshots__/**",
    "**/testdata/**"
  ],

  // The repository does not follow the .env* convention for its service config.
  "envFiles": [
    "config/*.env",
    "**/env.environment"
  ],

  // The team ships .env.dist; treat it as the canonical template.
  "exampleFiles": [
    "**/.env.dist",
    "**/.env.ci.example"
  ],

  // Facts about the deployment that are not visible in the repository.
  "ignoreVariables": [
    "GITHUB_*",
    "CI_*",
    "npm_package_*",
    "**/legacy-integration.env"
  ],

  // Two rules are noise here: the repo has a legacy JS toolchain and the
  // debug switch is intentional in the shared development file.
  "ignoreRules": [
    "framework-prefix-mismatch",
    "debug-flag-shared-env"
  ],

  // Unused variables are worth knowing about, so keep them at error level.
  "severities": {
    "unused-variable": "error",
    "empty-value": "warn"
  },

  // The repository vendors a fixture database whose password is a house word.
  // Entries are added to the 35 built-in placeholders, not substituted for
  // them, so a built-in weak value stays weak.
  "weakValues": [
    "vendored-fixture",
    "internal-dev-only"
  ],

  // Recognise the house naming scheme for signing keys so their values are
  // redacted and never printed. This pattern replaces the built-in one, so the
  // built-in alternatives have to be repeated.
  "secretNamePattern": "(SECRET|TOKEN|PASSWORD|PASSWD|PWD|API_?KEY|PRIVATE_?KEY|ACCESS_?KEY|CREDENTIAL|AUTH_?KEY|SESSION_?KEY|CLIENT_?SECRET|ENCRYPTION|SALT|CERT_?KEY|SIGNING_?KEY|INTERNAL_?(SIGNING_)?KEY|TEAM_?SIGNING_?KEY|DATABASE_?URL|DSN)",

  // One credential shape specific to this organisation.
  "secretPatterns": [
    {
      "id": "acme-service-token",
      "name": "ACME service token",
      "pattern": "(?:acme_[a-z]{2}_[A-Za-z0-9]{40})",
      "test": "acme_eu_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      "secretish": true
    }
  ],

  // Scanning budget and reporting shape. maxLineLength and codeFrameLines are
  // reserved: both are validated and resolved, and neither is read yet.
  "maxFileSizeKb": 256,
  "maxLineLength": 4000,
  "codeFrameLines": 3,

  // A GitHub Actions environment is a production deploy unless named otherwise.
  "ciEnvironmentKinds": {
    "production": "production",
    "staging": "production",
    "preview": "dev",
    "integration": "test"
  },

  // Fail the build on warnings, and never descend through symlinks.
  "failOn": "warn",
  "followSymlinks": false,
  "requireExampleFile": true
}
```

## Recipes

### Monorepo

One config at the root, every workspace discovered. Paths in `include` and
`exclude` are project-relative, and CI variables are ignored because the runner
injects hundreds of them.

```json
{
  "include": ["apps/**", "packages/**", "services/**", "*.env", "*.yml", "*.yaml", "Dockerfile*"],
  "exclude": ["**/node_modules/**", "**/dist/**", "**/.next/**", "**/coverage/**"],
  "envFiles": ["**/config.env", "**/.env.environment"],
  "ignoreVariables": [
    "GITHUB_*",
    "CI_*",
    "npm_package_*",
    "NPM_*",
    "RUNNER_*",
    "npm_config_*"
  ],
  "ciEnvironmentKinds": {
    "production": "production",
    "staging": "production",
    "preview": "dev"
  },
  "requireExampleFile": true,
  "failOn": "error"
}
```

Run it from the repository root so the upward config search finds this file:

```bash
envgle scan .
```

### Strict production policy

Every rule on, the noisiest ones promoted, example files mandatory. Appropriate
for a service whose env file is the contract with its operators.

```json
{
  "failOn": "info",
  "requireExampleFile": true,
  "severities": {
    "unused-variable": "error",
    "empty-value": "error",
    "conflicting-values": "error",
    "export-prefix": "warn",
    "inline-comment-truncation": "error",
    "unquoted-special-chars": "error",
    "framework-prefix-mismatch": "error",
    "secret-fallback-literal": "error"
  },
  "ciEnvironmentKinds": {
    "production": "production"
  }
}
```

### Legacy baseline

For a repository that has to adopt envgle without a big cleanup commit. The
noisiest cross-reference rules are silenced, the security rules stay at full
strength, and local GitHub-runner variables are filtered out.

```json
{
  "ignoreRules": [
    "missing-from-example",
    "example-out-of-sync",
    "unused-variable",
    "framework-prefix-mismatch",
    "export-prefix"
  ],
  "ignoreVariables": [
    "GITHUB_*",
    "CI",
    "CI_*",
    "npm_package_*",
    "NPM_*"
  ],
  "requireExampleFile": false,
  "failOn": "error"
}
```

`HOME` and `USER` need no entry: `missing-in-env` never fires for a name on the
built-in ambient list, which covers the operating system, the shell, Node and
npm, and the common CI providers. Add a name here only when it is injected by
something outside that list.

Remove entries from `ignoreRules` as the repository is cleaned up; the point of
the baseline is that it shrinks.

### Secrets-focused profile

A second job that fails only on credential problems, so it can go red without
the general audit going red. Raise the credential rules to `error` and drop the
noisy cross-reference rules to `info`, then gate on `error`:

```bash
envgle scan . --config .envglerc.secrets.json --fail-on error \
  --format sarif
```

The config it points at:

```json
{
  "failOn": "error",
  "severities": {
    "weak-secret": "error",
    "secret-in-example": "error",
    "hardcoded-connection-string": "error",
    "missing-in-env": "info",
    "missing-from-example": "info",
    "unused-variable": "info",
    "framework-prefix-mismatch": "info"
  },
  "secretNamePattern": "(SECRET|TOKEN|PASSWORD|PASSWD|PWD|API_?KEY|PRIVATE_?KEY|ACCESS_?KEY|CREDENTIAL|AUTH_?KEY|SESSION_?KEY|CLIENT_?SECRET|ENCRYPTION|SALT|CERT_?KEY|SIGNING_?KEY|INTERNAL_?(SIGNING_)?KEY|DATABASE_?URL|DSN|SIGNER_?KEY)",
  "secretPatterns": [
    {
      "id": "internal-signing-key",
      "name": "Internal signing key",
      "pattern": "(?:isk_live_[A-Za-z0-9]{32})",
      "test": "isk_live_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      "secretish": true
    }
  ]
}
```

`--rule` is not used here on purpose: it narrows a run to the rules you name, which
would fight with the list below. `ignoreRules` is the persistent form and
`severities` is how you keep a rule but change how loud it is.

### Fast local profile

The shortest possible run while editing: source directories only, no docs
validation, and a cap on how many findings are printed per file so the terminal
stays readable.

```json
{
  "include": ["src/**", "app/**", "server/**", "*.env", "docker-compose*.yml"],
  "exclude": ["**/dist/**", "**/build/**", "**/coverage/**", "**/*.test.*"],
  "ignoreRules": [
    "missing-from-example",
    "example-out-of-sync",
    "unused-variable",
    "empty-value",
    "export-prefix"
  ],
  "requireExampleFile": false,
  "maxFileSizeKb": 128
}
```

```bash
envgle scan --short --fail-on none --max-issues 5
```

`--max-issues` is a command-line flag with no config field, which is why the
cap belongs here rather than in the JSON. `--fail-on none` overrides any
`failOn` in the file for that run.

## Precedence between the file and the flags

The command line wins over the file for that run. These fields have a direct
flag equivalent:

| Config field | Equivalent flag |
| --- | --- |
| `failOn` | `--fail-on` |
| `maxFileSizeKb` | `--max-file-size` |
| `ignoreRules` | `--ignore-rule` (repeatable) |
| `ignoreVariables` | `--ignore-var` (repeatable) |

`include`, `exclude`, `envFiles` and `exampleFiles` have no flag; change them in
the file. The repeatable flags accumulate on top of the file rather than
replacing it, so `--ignore-rule unused-variable` adds one rule to whatever the
config already suppresses.
