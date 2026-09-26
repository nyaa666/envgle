# envgle

envgle is a linter for environment variables. It finds the variables your code reads, the
variables your `.env*` files, compose files, Dockerfiles and CI workflows declare, cross-references
the two sides, and reports 28 ways they disagree — as text, JSON, SARIF or markdown.

[![npm version](https://img.shields.io/npm/v/envgle)](https://www.npmjs.com/package/envgle)
[![license](https://img.shields.io/badge/license-MIT-blue)](LICENSE)
[![CI](https://github.com/nyaa666/envgle/actions/workflows/ci.yml/badge.svg)](https://github.com/nyaa666/envgle/actions/workflows/ci.yml)

- Node 20.11 or newer, TypeScript, ESM.
- No runtime dependencies.
- Never prints, logs or uploads a value. Findings carry the variable name, the pattern that matched
  and a truncated SHA-256 fingerprint.
- Exit codes and SARIF output, so it works as a CI gate and as a GitHub code scanning source.

## Why

### A variable that only exists on your laptop

`src/db/pool.ts` reads `process.env.DATABASE_URL` and passes it straight to the driver. It is not in
`.env`; it is in the developer's `.env.local`, which is git-ignored, so the value is `undefined` in
every deployed environment. Nothing fails at boot because the driver is lazy: the first request that
touches the pool raises an error about a connection string, several minutes after the deploy, and
nothing in the message mentions a missing setting. `envgle` reports it before the deploy, with
the file and line of the read:

```text
src/db/pool.ts:11:14  error  missing-in-env  DATABASE_URL is read in src/db/pool.ts but never declared in any env file
```

The same shape is caught one step further along: when the name is in `.env.local` and nowhere else,
[`prod-crash`](docs/rules.md#prod-crash) reports the required read that a dev-only file satisfies.

### A credential pasted into the example file

`.env.example` is committed on purpose and copied verbatim by every new developer, so it is the most
widely distributed file in the repository. Someone pastes a value from the AWS console instead of
leaving the key empty, and the key is now in the git history, in every clone and in every fork.
`envgle` matches the value against 30 credential patterns and reports the file, the line, the
pattern names and a fingerprint so the value can be correlated without being disclosed:

```text
.env.example:7:1  error  secret-in-example  Example file .env.example contains what looks like a real credential for "AWS_SECRET_ACCESS_KEY": the value matches 1 known credential pattern (AWS access key id). Fingerprint a4474245c2b8.
```

The fix is the same either way: rotate the key, leave the name in the example file with an empty
value.

### A comment that one loader keeps and another strips

`DATABASE_URL=postgres://user:pw@host/db # local` is the same line in every environment, and it does
not mean the same thing. `dotenv` strips the comment, so the value is `postgres://user:pw@host/db`.
`docker run --env-file .env` does not strip inline comments, so the value is
`postgres://user:pw@host/db # local` and the connection fails with an unparsable host. Nothing in the
file says which loader is in use, and the test suite only ever runs the first one.
[`inline-comment-truncation`](docs/rules.md#inline-comment-truncation) names the line and the two
loaders, and a dozen related rules cover the rest of the formatting space where loaders disagree:
unquoted values with spaces or `$`, `export` prefixes, duplicate keys, and `${VAR}` expansion that
only `dotenv-expand` performs.

## Install

```bash
npm install --save-dev envgle
npx envgle

pnpm add --save-dev envgle

bunx envgle
```

The package installs one executable, `envgle`. `package.json` also declares a programmatic entry
point at `dist/src/index.js`, which re-exports the scanner, the rule registry, the report formatters
and the shared types. The `envgle` command does not load that module, so the CLI is unaffected;
`dist/src/index.js` does not currently import, because `src/dotenv/format.ts` declares its exports
without implementing them. See [docs/architecture.md](docs/architecture.md#module-map).

## Quick start

```bash
npx envgle               # audit the current directory
npx envgle init --write  # create .env.example from everything the scan found
npx envgle check         # same scan, exit 1 when there are errors (for CI)
```

Output produced by `npx envgle --short`:

```text
envgle 0.1.0 · 12 files · 19 variables · 38ms

src/db/pool.ts:11:14  error  missing-in-env          DATABASE_URL is read in src/db/pool.ts but never declared in any env file
.env:9:1  warn   unused-variable         REDIS_URL is declared but never read by code, compose, Docker or CI
docker-compose.yml:12:6  warn   compose-var-undeclared  POSTGRES_HOST is interpolated in docker-compose.yml but is neither declared in an env file nor set in environment:
docs: https://github.com/nyaa666/envgle/blob/main/docs/rules.md#missing-in-env

1 error, 2 warnings · 3 findings in 3 files
run with --format json for details · see https://github.com/nyaa666/envgle/blob/main/docs/rules.md
```

Every finding is `file:line:column`, a severity keyword, the rule id and a message. Without
`--short` each finding is grouped under its file and followed by a `hint:` line. `--format json`,
`--format sarif` and `--format markdown` produce the same findings for machines.

## Commands

| Command | What it does | Example |
| --- | --- | --- |
| `envgle scan [path]` | Audit a directory and print findings. The default command when no command is given. | `envgle scan apps/api` |
| `envgle check [path]` | Audit for CI: the same scan, but the process exits `1` when there are findings at or above `--fail-on`, and prints nothing at all when there are none. | `envgle check --format sarif > envgle.sarif` |
| `envgle init [--write [path]]` | Print a `.env.example` covering every variable the scan found, with every value left empty. `--write` writes it to `path` instead of `.env.example`, and refuses to overwrite an existing file (exit `2`). | `envgle init --write` |
| `envgle docs [--write [path]]` | Print a markdown reference: a per-variable table (required, declared in, read in, redacted default, description), counts per severity and per rule, and a findings section. `--write [path]` saves it, defaulting to `docs/environment.md`, and overwrites an existing file. | `envgle docs --write docs/variables.md` |
| `envgle fmt [--write]` | Normalise every dotenv file: strip trailing whitespace, guarantee exactly one final newline, and sort keys within each run of adjacent assignments. With no flag it only reports and exits `1` when a file would change; `--check` is accepted and behaves the same; `--dry-run` never writes. Multi-line quoted values are never split. | `envgle fmt --check` |
| `envgle why <NAME>` | Show every declaration, read and reference of a single variable. Exits `2` for a name the project never mentions. | `envgle why DATABASE_URL` |
| `envgle rules [--json]` | List the 28 rules with their default severities and categories. | `envgle rules --json` |
| `envgle help` | Print usage. Same as `--help`. | `envgle help` |
| `envgle version` | Print the version. Same as `--version`. | `envgle version` |

### Global flags

| Flag | What it does |
| --- | --- |
| `--format <human\|json\|sarif\|markdown\|quiet>` | Choose the output format. Default `human`. |
| `--fail-on <error\|warn\|info\|none>` | Lowest severity that makes the command exit `1`. Default `error`. |
| `--config <path>` | Load this config file instead of searching for one. An unreadable or invalid file is a warning, not a fatal error: the run continues on the built-in defaults. |
| `--project <dir>` | Set the project root independently of the path being scanned. |
| `--no-color` | Disable ANSI colour. |
| `--quiet` | Print nothing at all; only the exit code is set. |
| `--max-issues <n>` | Print at most `n` findings per file, then a count of the rest. |
| `--max-file-size <kb>` | Skip files larger than this, in kilobytes, and list them as skipped. |
| `--rule <id>` | Run only this rule; every other rule is switched off. An unknown id is a usage error. Repeatable. |
| `--ignore-rule <id>` | Do not run this rule. Repeatable. |
| `--ignore-var <glob>` | Skip this variable name everywhere. Repeatable. |
| `--short` | One line per finding, no grouping and no hints. |
| `--verbose` | Print the resolved config path and its warnings, the scan counts, the parser notes, the skip reasons with their counts, and the duration, all to stderr. |
| `--dry-run` | Print what would change and write nothing. |
| `--no-gitignore` | Stop honouring `.gitignore` when pruning directories during the walk. |

### Exit codes

| Code | Meaning |
| --- | --- |
| `0` | No findings at or above `--fail-on`. |
| `1` | Findings at or above `--fail-on`. |
| `2` | A usage error (an unknown flag, an unknown rule id, a bad flag value, a missing argument) or a refused write: `envgle init --write` will not overwrite an existing file, and `envgle fmt --write` reports a write failure. A config file that cannot be read or contains something invalid is a warning, not exit `2`. |

## Configuration

Create `.envglerc.json` in the project root:

```json
{
  "include": ["src/**", "apps/**", "docker-compose*.yml", "Dockerfile*", ".github/workflows/**"],
  "exclude": ["**/node_modules/**", "**/dist/**", "**/fixtures/**"],
  "envFiles": [".env*", "config/env/**"],
  "exampleFiles": [".env.example", "config/env/*.example"],
  "ignoreRules": ["framework-prefix-mismatch"],
  "ignoreVariables": ["AWS_*", "INTERNAL_*"],
  "weakValues": ["acme-fixture-password"],
  "hostileNames": ["ACME_LD_AUDIT"],
  "maxFileSizeKb": 256,
  "failOn": "error"
}
```

`weakValues`, `hostileNames`, `reservedNames`, `exampleFiles` and `ciEnvironmentKinds` add to the
built-in lists rather than replacing them, so an entry you write never removes coverage you already
had. `secretPatterns` merges by `id`: an entry with a new id is added, an entry that reuses a
built-in id replaces that one pattern.

The same keys work under an `"envgle"` key in `package.json`. Configuration is resolved in this
order, and the first match wins:

1. The file given with `--config`.
2. The nearest `package.json` with an `"envgle"` key.
3. The nearest `.envglerc.json`.
4. The nearest `envgle.config.json`.

The search starts at the directory being scanned and walks upwards, so a monorepo can put a
different config in each package. When nothing matches, the built-in defaults apply. The config
file may contain `//` and `/* */` comments. An unknown key, an unknown rule id, an invalid regular
expression or a secret pattern that fails its own `test` string is a warning under `--verbose` and
is dropped; none of them is fatal.

Every field, its type and its default is documented in
[docs/configuration.md](docs/configuration.md).

## Rules

28 rules in three groups: contract rules that compare code against configuration, hygiene rules that
read one env file at a time, and naming and secret rules. Each row links to the full documentation
for that rule.

| Rule | Severity | What it means |
| --- | --- | --- |
| [missing-in-env](docs/rules.md#missing-in-env) | error | Code reads a variable that no env file and no compose, Docker or CI declaration provides. |
| [missing-from-example](docs/rules.md#missing-from-example) | error | A variable is declared in a real env file but absent from every example or template file. |
| [unused-variable](docs/rules.md#unused-variable) | warn | A declared variable has no read in code and no reference in compose, Docker or CI. |
| [prod-crash](docs/rules.md#prod-crash) | error | A read without a default depends on a variable that only `.env.local`-style files declare. |
| [example-out-of-sync](docs/rules.md#example-out-of-sync) | error | The example file documents variables nothing uses, or no example file exists at all. |
| [ci-secret-undeclared](docs/rules.md#ci-secret-undeclared) | warn | A secret-looking name is required by a CI workflow but missing from every example env file. |
| [compose-var-undeclared](docs/rules.md#compose-var-undeclared) | warn | A `${VAR}` used in docker-compose is neither declared in an env file nor set in `environment:`. |
| [env-file-missing](docs/rules.md#env-file-missing) | error | A compose `env_file` or a dotenv path points at a file that is not on disk. |
| [env-file-untracked](docs/rules.md#env-file-untracked) | error | A referenced env file is dev-only or git-ignored, so a deploy will not contain it. |
| [framework-prefix-mismatch](docs/rules.md#framework-prefix-mismatch) | warn | A variable uses a `REACT_APP_`/`VITE_`/`NEXT_PUBLIC_`-style prefix the project does not use. |
| [duplicate-key](docs/rules.md#duplicate-key) | error | The same name is assigned twice in a single dotenv file, so the last assignment wins. |
| [conflicting-values](docs/rules.md#conflicting-values) | warn | A variable holds different values in two or more real env files, resolved only by loader precedence. |
| [empty-value](docs/rules.md#empty-value) | info | A key is assigned with no value in a real env file. |
| [unquoted-special-chars](docs/rules.md#unquoted-special-chars) | warn | An unquoted value contains whitespace, `#`, `$`, quotes, backslashes, `=` or a line break. |
| [inline-comment-truncation](docs/rules.md#inline-comment-truncation) | warn | An inline comment that dotenv strips but Docker and shell sourcing keep. |
| [export-prefix](docs/rules.md#export-prefix) | info | `export KEY=...`, which is invalid for dotenv, `--env-file` and systemd. |
| [unterminated-quote](docs/rules.md#unterminated-quote) | error | A line has an unterminated quote, no separator, or otherwise cannot be parsed. |
| [expansion-unsupported](docs/rules.md#expansion-unsupported) | warn | `${VAR}` expansion in a shared env file, which only `dotenv-expand` performs. |
| [invalid-name](docs/rules.md#invalid-name) | warn | The name is not a shell identifier or is not `UPPER_SNAKE_CASE`. |
| [reserved-name](docs/rules.md#reserved-name) | warn | The name belongs to the operating system or the toolchain, such as `PATH` or `NODE_PATH`. |
| [hostile-name](docs/rules.md#hostile-name) | error | A name the dynamic loader, a shell or an interpreter start-up hook acts on. |
| [shell-incompatible-name](docs/rules.md#shell-incompatible-name) | warn | The name contains a non-ASCII character or is longer than 127 characters. |
| [weak-secret](docs/rules.md#weak-secret) | warn | A secret-looking variable holds an empty or well-known weak value such as `changeme`. |
| [secret-in-repo](docs/rules.md#secret-in-repo) | error | A value in a loaded env file matches a known credential pattern or passes the entropy test. |
| [secret-in-example](docs/rules.md#secret-in-example) | error | The same detection, for committed example and template files. |
| [secret-fallback-literal](docs/rules.md#secret-fallback-literal) | error | Source code hardcodes a credential as the default for a secret-looking variable. |
| [debug-flag-shared-env](docs/rules.md#debug-flag-shared-env) | warn | A committed env file enables debugging or disables authentication for every deployment. |
| [hardcoded-connection-string](docs/rules.md#hardcoded-connection-string) | error | A connection string or basic-auth URL embeds a real password. |

`--fail-on` defaults to `error`, so the 13 warning rules and the 2 info rules are reported but do not
fail a run. Change that with `--fail-on warn`, or change one rule with `severities` in the
config. Three markers suppress a single finding in place, and each accepts several rule ids
separated by commas or spaces: `envgle-disable-next-line <rule-id>` on the line before the
finding, `envgle-disable-line <rule-id>` at the end of the finding's own line, and
`envgle-disable-file <rule-id>` anywhere in the file, which covers every finding of that rule in
it. `"ignoreRules": ["<rule-id>"]` in `.envglerc.json` disables the rule for the whole repository.
The markers are documented in [docs/rules.md](docs/rules.md).

## CI

GitHub Actions, with the SARIF report uploaded to code scanning so findings appear on the pull
request:

```yaml
name: ci

on:
  push:
    branches: [main]
  pull_request:

jobs:
  env-audit:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 20
          cache: npm
      - run: npm ci
      - name: Audit environment variables
        run: npx envgle check --format sarif > envgle.sarif
      - name: Upload SARIF
        if: always()
        uses: github/codeql-action/upload-sarif@v3
        with:
          sarif_file: envgle.sarif
          category: envgle
```

`if: always()` matters: `envgle check` exits `1` when there is a finding at or above `--fail-on`,
which is `error` by default, and without it the upload step would be skipped exactly when there is
something to report.

GitLab CI, one job:

```yaml
env-audit:
  image: node:20
  script:
    - npx --yes envgle check --format sarif > envgle.sarif
  artifacts:
    paths: [envgle.sarif]
```

Pre-commit, as a plain hook in `.git/hooks/pre-commit`:

```bash
#!/usr/bin/env sh
npx envgle check
```

```bash
chmod +x .git/hooks/pre-commit
```

Or with the [pre-commit](https://pre-commit.com) framework, in `.pre-commit-config.yaml`:

```yaml
repos:
  - repo: local
    hooks:
      - id: envgle
        name: envgle
        entry: npx envgle check
        language: system
        pass_filenames: false
        always_run: true
```

See [docs/ci.md](docs/ci.md) for other CI systems, exit-code policy and how to introduce the gate
gradually.

## What it does not do

- **It does not run your code.** Analysis is static string analysis over text. Nothing is imported,
  executed or evaluated, and the application is never started. A `.env` file is parsed, not loaded.
- **Dynamic keys are not detected.** `process.env[name]`, `os.environ.get(key)` where `key` is a
  variable, and names assembled at runtime are invisible. Only literal names, and names reached
  through a statically known import binding, are collected.
- **Values are never printed or uploaded.** Findings and reports carry the variable name, the
  matched pattern names and a truncated SHA-256 fingerprint — nothing else. That holds for
  `--format json` and for the SARIF uploaded to code scanning.
- **Session-only and platform-only variables are invisible.** A value exported in somebody's shell,
  set by a container orchestrator or injected by a deployment platform is only known if its name
  appears in a file the scan reads. Declare the names in compose, Dockerfile or CI and they become
  part of the contract.
- **`.gitignore` prunes directories, not files.** The rules from `.gitignore` (and from nested
  `.gitignore` files, to a bounded depth) are used to decide which directories the walk descends
  into. Individual files that `.gitignore` matches are still read and analysed, so a
  git-ignored `.env.local` is analysed by default. Whether a file is in the repository is a
  separate fact: anything git does not track is reported with `committed: false`, which downgrades
  `secret-in-repo` from `error` to `warn` and makes `env-file-untracked` fire when a manifest
  references it. `--no-gitignore` turns off the directory pruning.
- **Compose `env_file` values are not expanded at build time.** The file is read as written, so a
  `${VAR}` inside a compose `env_file` is passed through rather than substituted; only
  `${VAR}` interpolation in the compose file itself is resolved against the environment.
- **Values are not validated.** A port that should be a number, a URL that should be reachable and a
  timeout that is too long are not checked. envgle reasons about which variables exist and where,
  not about what they contain.

## Comparison

All four tools below are good at what they do. The difference is scope.

| Tool | Scope | Catches | Does not catch |
| --- | --- | --- | --- |
| **envgle** | `.env*` declarations, variable reads in 16 languages, and references in compose files, Dockerfiles and CI pipelines. | The code-to-config contract: variables read but never declared, declared but never used, undocumented in the example file, satisfied only by a dev-only file, or set to conflicting values per file. Also the formatting space where dotenv, Docker, systemd and shell loaders disagree, and credential shapes inside env files and in a hardcoded source-code fallback. | Secrets anywhere else in the source tree, and secrets in git history. Runtime behaviour. The meaning of a value. |
| [dotenv-safe](https://github.com/rolodato/dotenv-safe) | Runtime, at process start. It loads `.env` and then checks `process.env`. | Names listed in `.env.example` that are absent from the environment afterwards, with `allowEmptyValues` for intentionally empty ones, and a `MissingEnvVarsError` naming every one. Because it compares the live environment it works for values supplied by any means, including a shell or the platform. | Values that are present but wrong, and variables the example file forgets to list — the example file is the source of truth, so an omission is invisible. Nothing about compose, Docker or CI, and nothing before the process starts. |
| [env-critic](https://www.npmjs.com/package/env-critic) | Static analysis of dotenv files themselves. | Dotenv syntax and structure, with a deeper set of parser-specific checks than envgle has, plus duplicate and conflicting keys and weak or dangerous values. A good second opinion on one file. | Anything about source code, compose, Docker or CI. It has no view of what the application reads, so it cannot tell a missing declaration from a missing read. |
| [gitleaks](https://github.com/gitleaks/gitleaks) | Secrets, in git history (`git log -p`), in directories and on stdin. | A large configurable rule set of provider-specific credential patterns with entropy thresholds and allowlists, including keys that were deleted years ago and would never appear in the working tree. | The code-to-config contract: whether a variable is declared, documented or used. It also does not know that a value in a live `.env` file is weak rather than credential-shaped. |
| [eslint-plugin-env](https://github.com/rtsao/eslint-plugin-env) | ESLint rules for universal (browser and Node) code. | Globals used outside the branch guarded by a static build-time variable such as `APP_ENV`, so a bundler can eliminate the dead branch. Useful for keeping client/server splits honest. | `.env` files, secrets, cross-file reasoning, compose, Docker or CI. It operates on one file at a time inside ESLint. |

The two secret scanners are complementary rather than competing. gitleaks answers "is there a
credential in this repository or its history"; envgle answers "is the environment contract in this
working tree coherent, and does a live env file contain something that should be rotated". Running
both is the reasonable setup.

## Roadmap

- **A `--baseline <file>`** that accepts a JSON or SARIF report of already-known findings, so a
  repository with years of accumulated drift can adopt envgle without a single big-bang cleanup.
- **A published JSON Schema** for the config file, so editors validate `.envglerc.json` and the
  `package.json` `"envgle"` key while you type.
- **An editor extension** (LSP) reporting findings inline as you edit env files, compose files and
  source files, instead of at the next command run.
- **More languages and more manifest formats.** Read detection covers 16 languages today; Terraform,
  Helm and Kubernetes manifests are the obvious next targets.
- **A `--watch` mode** that re-runs the scan when an env file, manifest or source file changes.

Nothing on this list exists yet, and nothing on it is promised for a particular release.

## Documentation

- [docs/rules.md](docs/rules.md) — all 28 rules, with examples and how to suppress each one.
- [docs/configuration.md](docs/configuration.md) — every config field, its type and its default.
- [docs/ci.md](docs/ci.md) — CI integration, exit codes and rollout.
- [docs/architecture.md](docs/architecture.md) — how the scanner and the rule engine are put
  together.

## Contributing

Bug reports, rule proposals and pull requests are welcome. Read [CONTRIBUTING.md](CONTRIBUTING.md)
first: it covers the rule contract, the test requirements and the repository checks.

## Security

Please report vulnerabilities privately rather than in a public issue. See
[SECURITY.md](SECURITY.md) for the disclosure process and the supported versions.

## License

[MIT](LICENSE)
