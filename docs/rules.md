# Rules

envgle reports 28 problems. Every rule has an id, a default severity and a category, and every
finding names the rule that produced it, so `envgle rules --json` and this page stay in sync.

Three severities exist:

- **error** — the code or the configuration cannot work as intended. A variable the application
  requires is not declared, or a credential is committed.
- **warn** — it will work today and break later, usually when the environment differs from the
  machine the file was written on.
- **info** — a hygiene or documentation problem worth cleaning up but not worth failing a build.

`--fail-on` decides which severities fail a run. It defaults to `error`, so warnings and notes are
reported without failing the command unless you ask for it. Per-rule severities can be changed in the
config with `severities`. Three rules choose the severity per finding instead, and ignore that map:
`compose-var-undeclared` (an `error` for `${VAR:?message}`, otherwise `info`), `hostile-name` (an
`error` in a shared file, a `warn` in a developer-only file, an `info` when code merely reads the
name) and `secret-in-repo` (a `warn` in a file git does not track, an `error` otherwise).

Each rule section below ends with the ways to suppress it. Three comment markers are recognised, and
each accepts one or more rule ids separated by commas or spaces:

- `envgle-disable-next-line <rule-id>` on the line before the finding.
- `envgle-disable-line <rule-id>` at the end of the finding's own line.
- `envgle-disable-file <rule-id>` anywhere in the file, which covers every finding of that rule in
  the whole file.

In a dotenv, YAML, Dockerfile or INI file a marker is a `#` comment, and in source code it is a
comment in the language of the file. `"ignoreRules": ["<rule-id>"]` in `.envglerc.json` disables
the rule for the whole repository. The per-rule sections below show the two line-scoped forms; the
file-scoped form works the same way in all of them.

The rules are listed below in the order the engine runs them: the ten contract rules that compare
code against configuration, the eight hygiene rules that read one env file at a time, and the ten
naming and secret rules.

See [configuration.md](configuration.md) for every option, and the [README](../README.md) for the
command line.

## Overview

| Rule | Severity | Category | What it means |
| --- | --- | --- | --- |
| [missing-in-env](#missing-in-env) | error | correctness | Code reads a variable that no env file and no compose, Docker or CI declaration provides. |
| [missing-from-example](#missing-from-example) | error | docs | A variable is declared in a real env file but absent from every example or template file. |
| [unused-variable](#unused-variable) | warn | hygiene | A declared variable has no read in code and no reference in compose, Docker or CI. |
| [prod-crash](#prod-crash) | error | correctness | A read without a default depends on a variable that only `.env.local`-style files declare. |
| [example-out-of-sync](#example-out-of-sync) | error | docs | The example file documents variables nothing uses, or no example file exists at all. |
| [ci-secret-undeclared](#ci-secret-undeclared) | warn | docs | A secret-looking name is required by a CI workflow but missing from every example env file. |
| [compose-var-undeclared](#compose-var-undeclared) | warn | consistency | A `${VAR}` used in docker-compose is neither declared in an env file nor set in `environment:`. |
| [env-file-missing](#env-file-missing) | error | correctness | A compose `env_file` or a dotenv path points at a file that is not on disk. |
| [env-file-untracked](#env-file-untracked) | error | correctness | A referenced env file is dev-only or git-ignored, so a deploy will not contain it. |
| [framework-prefix-mismatch](#framework-prefix-mismatch) | warn | consistency | A variable uses a `REACT_APP_`/`VITE_`/`NEXT_PUBLIC_`-style prefix the project does not use. |
| [duplicate-key](#duplicate-key) | error | correctness | The same name is assigned twice in a single dotenv file, so the last assignment wins. |
| [conflicting-values](#conflicting-values) | warn | consistency | A variable holds different values in two or more real env files, resolved only by loader precedence. |
| [empty-value](#empty-value) | info | hygiene | A key is assigned with no value in a real env file, which usually means an unfilled placeholder. |
| [unquoted-special-chars](#unquoted-special-chars) | warn | hygiene | An unquoted value contains whitespace, `#`, `$`, quotes, backslashes, `=` or a line break. |
| [inline-comment-truncation](#inline-comment-truncation) | warn | correctness | An unquoted value is followed by an inline comment that dotenv strips but Docker and shell sourcing keep. |
| [export-prefix](#export-prefix) | info | hygiene | A key is written as `export KEY=...`, which is invalid for dotenv, `--env-file` and systemd. |
| [unterminated-quote](#unterminated-quote) | error | correctness | A line has an unterminated quote, no separator or otherwise cannot be parsed. |
| [expansion-unsupported](#expansion-unsupported) | warn | correctness | A shared env file uses `${VAR}` expansion, a `dotenv-expand` feature other loaders ignore. |
| [invalid-name](#invalid-name) | warn | hygiene | The name is not a shell identifier or is not `UPPER_SNAKE_CASE`. |
| [reserved-name](#reserved-name) | warn | correctness | The name belongs to the operating system or the toolchain, such as `PATH` or `NODE_PATH`. |
| [hostile-name](#hostile-name) | error | security | A name the dynamic loader, a shell or an interpreter start-up hook acts on, such as `LD_PRELOAD` or `NODE_OPTIONS`. |
| [shell-incompatible-name](#shell-incompatible-name) | warn | hygiene | The name contains a non-ASCII character or is longer than 127 characters. |
| [weak-secret](#weak-secret) | warn | security | A secret-looking variable holds an empty or well-known weak value such as `changeme`. |
| [secret-in-repo](#secret-in-repo) | error | security | A declaration in a loaded env file matches a known credential pattern or passes the entropy test. |
| [secret-in-example](#secret-in-example) | error | security | The same credential detection as `secret-in-repo`, for committed example and template files. |
| [secret-fallback-literal](#secret-fallback-literal) | error | security | Source code supplies a hardcoded default for a secret-looking variable and that default is a credential. |
| [debug-flag-shared-env](#debug-flag-shared-env) | warn | security | A committed env file switches debugging or auth bypasses on for every deployment that sources it. |
| [hardcoded-connection-string](#hardcoded-connection-string) | error | security | A value is a connection string or basic-auth URL that embeds a real password. |

## missing-in-env

**Severity:** error | correctness

Detects a variable the code reads that no env file, compose `environment:` block, Dockerfile or CI
workflow ever declares.

**Bad**

```ts
// src/db/pool.ts
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
```

**Good**

```bash
# .env.example
DATABASE_URL=

# .env
DATABASE_URL=postgres://localhost:5432/app
```

**Why it matters**

The read evaluates to `undefined` at runtime, and nothing in the repository records that a deploy
platform is expected to supply the value, so the failure surfaces on whoever ships the next release.
A variable nobody declared is also invisible to `envgle init`, `envgle why` and the generated
documentation.

**How to fix**

- Add the name to the shared env file the deploy loads, and to the example file with an empty value.
- If the platform injects it, declare the name in the compose `environment:` block or in the CI
  `env:`/`secrets:` list so it is part of the contract.
- If the variable really is optional, give the read a fallback.
- If it is injected by something the scanner can never see, list the name or a glob covering it in
  `ignoreVariables`.

Ambient variables are exempt. A name the operating system, the shell, Node or npm, or a CI provider
injects is not the project's configuration, so this rule does not fire for it: `PATH`, `HOME`,
`TERM`, `NO_COLOR`, `NODE_ENV`, `CI`, `GITHUB_ACTIONS` and `RUNNER_TEMP` are all read in ordinary
code and none of them needs a declaration. For anything else a platform supplies and this list does
not cover, add it to `ignoreVariables` rather than declaring a value you do not control.

**Ignore it**

Put the marker on the line before the finding:

```ts
// envgle-disable-next-line missing-in-env
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
```

Or at the end of the finding's own line:

```text
const pool = new Pool({ connectionString: process.env.DATABASE_URL });  // envgle-disable-line missing-in-env
```

Or once for the whole file, anywhere in it:

```text
// envgle-disable-file missing-in-env
```

Or disable the rule for the whole repository in `.envglerc.json`:

```json
{
  "ignoreRules": ["missing-in-env"]
}
```

## missing-from-example

**Severity:** error | docs

Detects a variable declared in a real env file that no example or template file documents.

**Bad**

```bash
# .env
DATABASE_URL=postgres://localhost:5432/app
STRIPE_SECRET_KEY=sk_live_51EXAMPLEEXAMPLEEXAMPLEEXAMPLEx
```

**Good**

```bash
# .env.example
DATABASE_URL=
STRIPE_SECRET_KEY=
```

**Why it matters**

The example file is the only documentation a new contributor gets, and it is the list most
tooling treats as the contract. A variable missing from it is invisible to reviewers, to
`envgle init`, to `envgle docs` and to any runtime guard driven by the example file.

**How to fix**

- Add the name to `.env.example` (or `.env.sample`, `.env.template`, `.env.dist`) with an empty
  value and a comment describing what belongs there.
- Remove the declaration instead, if the variable is no longer needed.
- Set `exampleFiles` if the template lives under a name the tool does not recognise.

**Ignore it**

```bash
# envgle-disable-next-line missing-from-example
STRIPE_SECRET_KEY=sk_live_51EXAMPLEEXAMPLEEXAMPLEEXAMPLEx
```

```text
STRIPE_SECRET_KEY=sk_live_51EXAMPLEEXAMPLEEXAMPLEEXAMPLEx  # envgle-disable-line missing-from-example
```

```json
{
  "ignoreRules": ["missing-from-example"]
}
```

## unused-variable

**Severity:** warn | hygiene

Detects a declared variable that nothing reads: no source file, no compose key, no Dockerfile
instruction and no CI step.

**Bad**

```bash
# .env
DATABASE_URL=postgres://localhost:5432/app
LEGACY_QUEUE_URL=amqp://localhost:5672
```

**Good**

```bash
# .env
DATABASE_URL=postgres://localhost:5432/app
QUEUE_URL=amqp://localhost:5672
```

```ts
// src/queue.ts
const queue = new Queue(process.env.QUEUE_URL);
```

**Why it matters**

Every unused entry is configuration somebody has to keep in sync, document and remember during
reviews. It also hides real problems: a variable the code reads under a slightly different name
looks like two unrelated settings, one of which is dead.

**How to fix**

- Delete the declaration.
- Or wire it up where the feature is actually implemented.
- Or list it in `ignoreVariables` when it is consumed by a process the scanner cannot see.

**Ignore it**

```bash
# envgle-disable-next-line unused-variable
LEGACY_QUEUE_URL=amqp://localhost:5672
```

```text
LEGACY_QUEUE_URL=amqp://localhost:5672  # envgle-disable-line unused-variable
```

```json
{
  "ignoreRules": ["unused-variable"]
}
```

## prod-crash

**Severity:** error | correctness

Detects a read with no fallback whose variable is declared only in a dev-only file such as
`.env.local` or a `*.local` override.

**Bad**

```bash
# .env.local -- git-ignored, never loaded by a deploy
DATABASE_URL=postgres://user:pw@db.internal:5432/app
```

```ts
// src/db/pool.ts
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
```

**Good**

```bash
# .env -- committed, loaded by every environment
DATABASE_URL=postgres://localhost:5432/app
```

**Why it matters**

The variable resolves on the machine where the file was written and is `undefined` everywhere
else, which usually means the first request in production fails with a driver error that mentions
nothing about the missing setting. A dev-only file is a local override, never a distribution
channel.

**How to fix**

- Ship the variable in the shared env file and document its name in the example file.
- Inject it in the deploy platform, and declare the name in compose `environment:` or CI `env:`.
- Give the read an explicit fallback and handle the fallback branch.

**Ignore it**

```ts
// envgle-disable-next-line prod-crash
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
```

```text
const pool = new Pool({ connectionString: process.env.DATABASE_URL });  // envgle-disable-line prod-crash
```

```json
{
  "ignoreRules": ["prod-crash"]
}
```

## example-out-of-sync

**Severity:** error | docs

Detects an example file that documents variables nothing uses, and a repository that has no example
file at all while other env files exist.

**Bad**

```bash
# .env.example
DATABASE_URL=
OLD_API_KEY=
```

**Good**

```bash
# .env.example
DATABASE_URL=
```

**Why it matters**

An example entry nobody reads is a promise the repository cannot keep: newcomers set a value that
changes nothing, and reviewers cannot tell an intentional placeholder from a leftover. With no
example file at all, the only record of the contract is a git-ignored file nobody can read.

**How to fix**

- Delete the entries that no code, compose file, Dockerfile or workflow references.
- Or declare and use the variable the entry documents.
- Run `envgle init` to create a `.env.example` covering everything the scan found.
- Set `requireExampleFile` to `false` if the project deliberately ships no template.

**Ignore it**

```bash
# envgle-disable-next-line example-out-of-sync
OLD_API_KEY=
```

```text
OLD_API_KEY=  # envgle-disable-line example-out-of-sync
```

```json
{
  "ignoreRules": ["example-out-of-sync"]
}
```

## ci-secret-undeclared

**Severity:** warn | docs

Detects a secret-looking name a CI workflow requires that no example env file documents. The
workflow value itself is never read.

**Bad**

```yaml
# .github/workflows/release.yml
jobs:
  release:
    steps:
      - run: npm publish
        env:
          NODE_AUTH_TOKEN: ${{ secrets.NPM_TOKEN }}
```

**Good**

```bash
# .env.example
NPM_TOKEN=
```

**Why it matters**

Nobody learns that the repository needs a secret called `NPM_TOKEN` until the release job fails,
and the person fixing it is usually the one least able to guess the name. Documenting the name in
the example file puts it next to the code that uses it.

**How to fix**

- Add `NPM_TOKEN=` to the example env file and describe it in the README.
- Or remove the CI reference if the job no longer needs the secret.
- Widen or narrow `secretNamePattern` if the name is classified wrongly.

**Ignore it**

```yaml
# envgle-disable-next-line ci-secret-undeclared
env:
  NODE_AUTH_TOKEN: ${{ secrets.NPM_TOKEN }}
```

```text
NODE_AUTH_TOKEN: ${{ secrets.NPM_TOKEN }}  # envgle-disable-line ci-secret-undeclared
```

```json
{
  "ignoreRules": ["ci-secret-undeclared"]
}
```

## compose-var-undeclared

**Severity:** warn | consistency

Detects a `${VAR}` interpolation in a compose file that no env file declares and no `environment:`
key sets. The `${VAR:?message}` form is reported as an `error`, because compose refuses to start
without it; plain `${VAR}` and `$VAR` are reported as `info` findings under the same rule, whose
default severity is `warn`.

**Bad**

```yaml
# docker-compose.yml
services:
  api:
    image: ghcr.io/acme/api:${IMAGE_TAG}
```

**Good**

```yaml
# docker-compose.yml
services:
  api:
    image: ghcr.io/acme/api:${IMAGE_TAG:-latest}
```

**Why it matters**

Compose substitutes an unset variable with an empty string, so the image reference silently becomes
`ghcr.io/acme/api:` or the tag silently becomes `latest`. Only the `${VAR:?message}` form fails
loudly, and it fails for everyone who forgets to export the variable first.

**How to fix**

- Add the name to an env file compose loads, or set it under the service's `environment:` key.
- Give the interpolation a default with `${VAR:-default}`.
- Use `${VAR:?message}` when the variable really is mandatory.

**Ignore it**

```yaml
# envgle-disable-next-line compose-var-undeclared
image: ghcr.io/acme/api:${IMAGE_TAG}
```

```text
image: ghcr.io/acme/api:${IMAGE_TAG}  # envgle-disable-line compose-var-undeclared
```

```json
{
  "ignoreRules": ["compose-var-undeclared"]
}
```

## env-file-missing

**Severity:** error | correctness

Detects an `env_file` entry in a compose file, or a dotenv path reference, that points at a file
that is not on disk.

**Bad**

```yaml
# docker-compose.yml
services:
  api:
    env_file:
      - .env.production
```

**Good**

```bash
# .env.production -- created and committed
DATABASE_URL=postgres://db.internal:5432/app
```

**Why it matters**

Compose fails immediately with "no such file", but only in the environment that runs it. A
renamed or deleted file is invisible to everything that merely reads the repository, so the break
lands on the deploy rather than on the commit that caused it.

**How to fix**

- Create the file, or correct the relative path in the referring manifest.
- Remember that the path is resolved relative to the compose file, so `env_file: .env` and
  `env_file: ../.env` are different files.
- Check that the file is committed, or [env-file-untracked](#env-file-untracked) will report it next.

**Ignore it**

```yaml
# envgle-disable-next-line env-file-missing
env_file:
  - .env.production
```

```text
- .env.production  # envgle-disable-line env-file-missing
```

```json
{
  "ignoreRules": ["env-file-missing"]
}
```

## env-file-untracked

**Severity:** error | correctness

Detects a referenced env file that is a dev-only override or is git-ignored, so the deploy will not
contain it.

**Bad**

```yaml
# docker-compose.yml
services:
  api:
    env_file:
      - .env.local
```

**Good**

```yaml
# docker-compose.yml
services:
  api:
    env_file:
      - .env.production
    environment:
      DATABASE_URL: ${DATABASE_URL:?DATABASE_URL must be set}
```

**Why it matters**

The file works on the machine that wrote it and is absent everywhere else. Because `.env.local` is
conventionally git-ignored, the configuration that runs production lives on exactly one laptop and
cannot be reviewed.

**How to fix**

- Commit a template of the file and inject the real values in the deploy pipeline.
- Point the manifest at a committed, per-environment file such as `.env.production`.
- Add the variable to the compose `environment:` block so the required name is explicit.

**Ignore it**

```yaml
# envgle-disable-next-line env-file-untracked
env_file:
  - .env.local
```

```text
- .env.local  # envgle-disable-line env-file-untracked
```

```json
{
  "ignoreRules": ["env-file-untracked"]
}
```

## framework-prefix-mismatch

**Severity:** warn | consistency

Detects a variable using a bundler-specific prefix that the project does not actually use. The
known prefixes are `REACT_APP_` (react-scripts, react, next, expo), `VUE_APP_` (vue,
`@vue/cli-service`), `VITE_` (vite), `NEXT_PUBLIC_` (next), `NUXT_PUBLIC_` (nuxt, `@nuxt/kit`) and
`GATSBY_` (gatsby), each matched against the project's `dependencies` and `devDependencies`.

**Bad**

```bash
# .env -- package.json declares no vite dependency
VITE_API_URL=https://api.example.com
```

**Good**

```bash
# .env
APP_API_URL=https://api.example.com
```

**Why it matters**

Bundlers inject prefixed variables into the client bundle and ignore everything else, so a
`VITE_` name in a project without vite is dead configuration that reads as if it were live. The
reverse mistake is worse: a secret behind a public prefix is compiled into JavaScript and served to
every visitor.

**How to fix**

- Rename the variable to the prefix your bundler actually injects, based on the dependencies you
  have.
- Or add the missing dependency if the prefix was intentional.
- Check that no secret is behind `NEXT_PUBLIC_`, `VITE_` or `GATSBY_`.

**Ignore it**

```bash
# envgle-disable-next-line framework-prefix-mismatch
VITE_API_URL=https://api.example.com
```

```text
VITE_API_URL=https://api.example.com  # envgle-disable-line framework-prefix-mismatch
```

```json
{
  "ignoreRules": ["framework-prefix-mismatch"]
}
```

## duplicate-key

**Severity:** error | correctness

Detects a name assigned more than once inside a single dotenv file, where the last assignment wins
without warning.

**Bad**

```bash
# .env
DATABASE_URL=postgres://localhost:5432/app
PORT=3000
DATABASE_URL=postgres://db.internal:5432/app
```

**Good**

```bash
# .env
DATABASE_URL=postgres://db.internal:5432/app
PORT=3000
```

**Why it matters**

Whether the first or the second value is used depends on the loader, and the two common answers are
"the last one" and "the first one". The file reads as if it configures two things while it configures
one, chosen by an implementation detail.

**How to fix**

- Delete the earlier assignment and keep one definition per file.
- Use `.env.local` or a per-environment file for the override instead of editing the shared file.

**Ignore it**

```bash
# envgle-disable-next-line duplicate-key
DATABASE_URL=postgres://db.internal:5432/app
```

```text
DATABASE_URL=postgres://db.internal:5432/app  # envgle-disable-line duplicate-key
```

```json
{
  "ignoreRules": ["duplicate-key"]
}
```

## conflicting-values

**Severity:** warn | consistency

Detects one variable holding different values in two or more real env files, so the effective value
is decided by loader precedence rather than by intent. Values of secret-looking names are never
printed; the message only says the values differ.

**Bad**

```bash
# .env
API_BASE_URL=https://staging.example.com
```

```bash
# .env.production
API_BASE_URL=https://api.example.com
```

**Good**

```bash
# .env.staging
API_BASE_URL=https://staging.example.com

# .env.production
API_BASE_URL=https://api.example.com
```

**Why it matters**

With dotenv-style loaders the file order decides, and different frameworks order the list
differently, so the same repository can resolve the same variable to two different hosts. The
mistake is invisible in review because both files look correct on their own.

**How to fix**

- Align the values across the files.
- Or keep one value per environment in clearly named files so the difference is the point.
- Or give the variable distinct names per environment and select between them explicitly.

**Ignore it**

```bash
# .env.production
# envgle-disable-next-line conflicting-values
API_BASE_URL=https://api.example.com
```

```text
API_BASE_URL=https://api.example.com  # envgle-disable-line conflicting-values
```

```json
{
  "ignoreRules": ["conflicting-values"]
}
```

## empty-value

**Severity:** info | hygiene

Detects `KEY=` with no value in a real env file. Example and template files are never reported,
because an empty value is the correct content there.

**Bad**

```bash
# .env
DATABASE_URL=
STRIPE_SECRET_KEY=
```

**Good**

```bash
# .env
DATABASE_URL=postgres://localhost:5432/app
STRIPE_SECRET_KEY=sk_test_4eC39HqLyjWDarjtT1zdp7dc
```

**Why it matters**

An empty value is either a placeholder nobody replaced, or a deliberate empty string, and the file
does not say which. Code that treats the result as truthy behaves differently in the two cases, and
`secret-in-repo` will still classify a neighbouring real value as a leak worth rotating.

**How to fix**

- Fill in the value in this file.
- Or remove the line and document the name in the example file.
- If the empty string is meaningful, quote it (`KEY=""`) and add a comment saying so.

**Ignore it**

```bash
# envgle-disable-next-line empty-value
STRIPE_SECRET_KEY=
```

```text
STRIPE_SECRET_KEY=  # envgle-disable-line empty-value
```

```json
{
  "ignoreRules": ["empty-value"]
}
```

## unquoted-special-chars

**Severity:** warn | hygiene

Detects an unquoted value containing whitespace, `#`, `$`, a quote, a backslash, `=` or a line
break, any of which some loaders treat as syntax.

**Bad**

```bash
# .env
GREETING=hello world
SENTRY_DSN=https://abc@o1.ingest.sentry.io/2
```

**Good**

```bash
# .env
GREETING="hello world"
SENTRY_DSN="https://abc@o1.ingest.sentry.io/2"
```

**Why it matters**

A space ends the value for one loader and belongs to it for another, and `$` starts an expansion
that only some implementations perform. The result is a value that differs between the test runner
and production without either being wrong on its own.

**How to fix**

- Wrap the value in double quotes so every loader reads the same string.
- Use single quotes when the value must keep a literal `$`.
- Move the value into a secret manager if it is a credential.

**Ignore it**

```bash
# envgle-disable-next-line unquoted-special-chars
GREETING=hello world
```

```text
GREETING=hello world  # envgle-disable-line unquoted-special-chars
```

```json
{
  "ignoreRules": ["unquoted-special-chars"]
}
```

## inline-comment-truncation

**Severity:** warn | correctness

Detects an inline comment on an unquoted value. dotenv strips the comment from the value;
`docker run --env-file` and `set -a; source .env` keep it.

**Bad**

```bash
# .env
DATABASE_URL=postgres://user:pw@host/db # local
```

**Good**

```bash
# .env
# local
DATABASE_URL=postgres://user:pw@host/db
```

**Why it matters**

The same file yields `postgres://user:pw@host/db` under Node and
`postgres://user:pw@host/db # local` under Docker, so the connection string differs by deployment
target and the trailing text ends up in a host name, a password or a query string. It also breaks
any exact comparison against the value.

**How to fix**

- Move the comment to its own line above the assignment.
- Or quote the value and keep the comment outside the quotes: `KEY="value" # comment`.
- Check every other value in the file for the same pattern.

**Ignore it**

```bash
# envgle-disable-next-line inline-comment-truncation
DATABASE_URL=postgres://user:pw@host/db # local
```

```text
DATABASE_URL=postgres://user:pw@host/db # local  # envgle-disable-line inline-comment-truncation
```

```json
{
  "ignoreRules": ["inline-comment-truncation"]
}
```

## export-prefix

**Severity:** info | hygiene

Detects `export KEY=...` in a dotenv file, a form that dotenv, `docker run --env-file` and systemd
reject.

**Bad**

```bash
# .env
export DATABASE_URL=postgres://localhost:5432/app
```

**Good**

```bash
# .env
DATABASE_URL=postgres://localhost:5432/app
```

**Why it matters**

`export` is valid in a file you source and invalid in a file you parse, so the line either becomes
part of the name (`export DATABASE_URL`) or is dropped, depending on the loader. Shell loaders
export every line anyway, so the keyword only ever helps the reader.

**How to fix**

- Delete the `export` keyword.
- If the file is meant to be sourced rather than parsed, keep it out of the `envFiles` globs and
  say so in the README.

**Ignore it**

```bash
# envgle-disable-next-line export-prefix
export DATABASE_URL=postgres://localhost:5432/app
```

```text
export DATABASE_URL=postgres://localhost:5432/app  # envgle-disable-line export-prefix
```

```json
{
  "ignoreRules": ["export-prefix"]
}
```

## unterminated-quote

**Severity:** error | correctness

Detects a line the parser could not read: an unterminated quote, a missing `=` separator, or any
other structural problem.

**Bad**

```bash
# .env
DATABASE_URL="postgres://localhost:5432/app
```

**Good**

```bash
# .env
DATABASE_URL="postgres://localhost:5432/app"
```

**Why it matters**

A loader's recovery for a broken line is its own choice: some swallow the line, some keep the
opening quote in the value, some consume the rest of the file. The variable is then either missing
or wrong, and the file still looks plausible when read by eye.

**How to fix**

- Close the quote on the same line it opens.
- Escape an inner quote, or use the other quote character.
- Nothing downstream can validate the line, because the parser could not read a value from it, so fix
  the line the finding names rather than leaving it for the loader to guess.

**Ignore it**

```bash
# envgle-disable-next-line unterminated-quote
DATABASE_URL="postgres://localhost:5432/app
```

```text
DATABASE_URL="postgres://localhost:5432/app  # envgle-disable-line unterminated-quote
```

```json
{
  "ignoreRules": ["unterminated-quote"]
}
```

## expansion-unsupported

**Severity:** warn | correctness

Detects `${VAR}` expansion inside a shared env file. Only `dotenv-expand` and a few loaders perform
the substitution; compose `env_file`, systemd and most CI secret injectors do not.

**Bad**

```bash
# .env -- shared and committed
DATABASE_URL=postgres://${PGHOST}:5432/${PGDATABASE}
```

**Good**

```bash
# .env
PGHOST=db.internal
PGDATABASE=app
DATABASE_URL=postgres://db.internal:5432/app
```

**Why it matters**

Where the expansion is unsupported the value reaches the application as the literal string
`postgres://${PGHOST}:5432/${PGDATABASE}`, which fails at connection time with a message that
points at the driver instead of at the environment. Dev-only files are not reported, because there
the expansion is under the author's control.

**How to fix**

- Precompute the value and write it out in full.
- Or load the file through `dotenv-expand`, and say so in the README so the requirement is visible.
- Or compose the value from separate variables in the code that needs it.

**Ignore it**

```bash
# envgle-disable-next-line expansion-unsupported
DATABASE_URL=postgres://${PGHOST}:5432/${PGDATABASE}
```

```text
DATABASE_URL=postgres://${PGHOST}:5432/${PGDATABASE}  # envgle-disable-line expansion-unsupported
```

```json
{
  "ignoreRules": ["expansion-unsupported"]
}
```

## invalid-name

**Severity:** warn | hygiene

Detects a name that is not a shell identifier (`[A-Za-z_][A-Za-z0-9_]*`), or that is a valid
identifier but not `UPPER_SNAKE_CASE`.

**Bad**

```bash
# .env
database-url=postgres://localhost:5432/app
2FA_ENABLED=true
```

**Good**

```bash
# .env
DATABASE_URL=postgres://localhost:5432/app
TWO_FA_ENABLED=true
```

**Why it matters**

A name with a dot, a dash or a leading digit cannot be exported by a POSIX shell, Docker or
Kubernetes, and cannot be set with `NAME=value` in a shell script at all. Lowercase names work in
JavaScript but break the moment a shell, a Helm chart or a systemd unit has to set them.

**How to fix**

- Rename the variable to `UPPER_SNAKE_CASE` using ASCII letters, digits and underscores, in the
  env file and in every read of it.
- The finding's message contains a suggested name for a mixed-case variable.

**Ignore it**

```bash
# envgle-disable-next-line invalid-name
database-url=postgres://localhost:5432/app
```

```text
database-url=postgres://localhost:5432/app  # envgle-disable-line invalid-name
```

```json
{
  "ignoreRules": ["invalid-name"]
}
```

## reserved-name

**Severity:** warn | correctness

Detects a declaration whose name the operating system or the toolchain owns. The default list
covers the `PATH`, `HOME`, `USER`, `PWD`, `TERM`, `LANG`, `TMPDIR`, `XDG_*`, Windows and runtime
variables such as `JAVA_HOME`, `GOPATH`, `NODE_PATH`, `PYTHONHOME` and `VIRTUAL_ENV`, and the
effective list comes from `reservedNames` in the config.

**Bad**

```bash
# .env
PATH=/usr/local/bin:/usr/bin:/bin
```

**Good**

```bash
# .env
APP_PATH=/opt/app/bin
```

```ts
// The real PATH stays whatever the operating system and the container image set.
spawn(process.env.APP_PATH!, ['serve']);
```

**Why it matters**

`PATH` controls which binary a shell resolves first, so a committed `PATH` changes the behaviour of
every process that sources the file, not only this application. Overriding `NODE_PATH` or
`PYTHONHOME` has the same effect: the toolchain, not your code, is being reconfigured.

**How to fix**

- Rename the variable to something application-scoped, such as `APP_PATH`.
- Read the reserved variable from the ambient environment instead of setting it.
- Extend `reservedNames` if the project owns a name the default list does not include.

**Ignore it**

```bash
# envgle-disable-next-line reserved-name
PATH=/usr/local/bin:/usr/bin:/bin
```

```text
PATH=/usr/local/bin:/usr/bin:/bin  # envgle-disable-line reserved-name
```

```json
{
  "ignoreRules": ["reserved-name"]
}
```

## hostile-name

**Severity:** error | security

Detects a declaration whose name the dynamic loader, a shell or an interpreter start-up hook acts
on, such as `LD_PRELOAD`, `DYLD_INSERT_LIBRARIES`, `NODE_OPTIONS`, `BASH_ENV`, `IFS`, `PS4`,
`GLIBC_TUNABLES`, `RUBYOPT`, `PERL5OPT`, `JAVA_TOOL_OPTIONS` or `PATH`. The list comes from
`hostileNames` in the config. The severity is `error` in a committed or shared file, `warn` in a
developer-only file, and `info` when the code merely reads a hostile name that nothing declares.

**Bad**

```bash
# .env -- committed and sourced by everyone who clones
NODE_OPTIONS=--require ./patch.js
```

**Good**

```bash
# .env
# Nothing to configure: set the variable in a throwaway shell or in the
# deployment platform, never in a file other people source.
```

**Why it matters**

Whoever controls the value of one of these names controls which code runs in every process that
starts with that environment, which is code execution rather than configuration. In a committed file
it is also an attack on everyone who clones the repository.

**How to fix**

- Delete the variable from the env file.
- If a developer needs it, set it in a throwaway shell or in the platform's configuration.
- If the code must read such a name, declare an explicit value or rely on the platform.

**Ignore it**

```bash
# envgle-disable-next-line hostile-name
NODE_OPTIONS=--require ./patch.js
```

```text
NODE_OPTIONS=--require ./patch.js  # envgle-disable-line hostile-name
```

```json
{
  "ignoreRules": ["hostile-name"]
}
```

## shell-incompatible-name

**Severity:** warn | hygiene

Detects a name that is a valid identifier but cannot be set portably: it contains a non-ASCII
character such as an accented letter, a Cyrillic letter or an emoji, or it is longer than 127
characters. Names that are not identifiers at all are reported by
[invalid-name](#invalid-name).

**Bad**

```bash
# .env
DATABASE_URL_CAFÉ=postgres://localhost:5432/app
```

**Good**

```bash
# .env
DATABASE_URL_CAFE=postgres://localhost:5432/app
```

**Why it matters**

A non-ASCII name cannot be typed or expanded reliably in POSIX shells, `cmd.exe` or a Dockerfile
`ENV` instruction, and byte-wise comparisons between the value in the file and the value in the code
fail as soon as one side is normalised. The 127-character ceiling is the limit several process
environments impose, so a longer name simply cannot be set everywhere.

**How to fix**

- Transliterate the name to ASCII letters, digits and underscores.
- Keep it below 128 characters.
- Rename it in the env file and in every read of it.

**Ignore it**

```bash
# envgle-disable-next-line shell-incompatible-name
DATABASE_URL_CAFÉ=postgres://localhost:5432/app
```

```text
DATABASE_URL_CAFÉ=postgres://localhost:5432/app  # envgle-disable-line shell-incompatible-name
```

```json
{
  "ignoreRules": ["shell-incompatible-name"]
}
```

## weak-secret

**Severity:** warn | security

Detects a secret-looking variable in a loaded env file whose value is empty or one of the known weak
values. The default list includes `changeme`, `change_me`, `change-me`, `password`, `passwd`,
`secret`, `admin`, `root`, `test`, `testing`, `example`, `placeholder`, `todo`, `tbd`, `fixme`,
`your-password`, `your_secret`, `your-api-key`, `my-secret`, `abc123`, `123456`, `12345678`, `qwerty`,
`letmein`, `hunter2`, `default`, `undefined`, `null`, `none`, `empty` and `insert-key-here`; the
effective list comes from `weakValues` in the config. Example and template files are never reported.

**Bad**

```bash
# .env
JWT_SECRET=changeme
```

**Good**

```bash
# .env.example
JWT_SECRET=
```

**Why it matters**

A weak secret passes every check that only looks at whether a value is set, so the deployment looks
configured while the credential is guessable. It is usually committed years earlier, which means it
is also in the git history and in every fork.

**How to fix**

- Generate the value with a password manager or a secret manager and inject it at deploy time.
- Rotate the weak value if it has ever been deployed.
- Keep placeholders in `.env.example`, where they are never reported.
- Extend `weakValues` with the project-specific defaults you want caught.

**Ignore it**

```bash
# envgle-disable-next-line weak-secret
JWT_SECRET=changeme
```

```text
JWT_SECRET=changeme  # envgle-disable-line weak-secret
```

```json
{
  "ignoreRules": ["weak-secret"]
}
```

## secret-in-repo

**Severity:** error | security

Detects a declaration in a loaded env file whose value matches one of the built-in credential
patterns (AWS, GitHub, GitLab, Slack, Stripe, Google, OpenAI, Anthropic, OpenRouter, Groq,
Hugging Face, SendGrid, Mailgun, Mailchimp, Twilio, Telegram, npm, PyPI, Docker Hub, Linear,
Supabase, Firebase, Azure, PEM private keys, JWTs and connection strings) or passes the high-entropy
test behind a secret-looking name. The value itself is never printed: the finding names the patterns
that matched and a truncated SHA-256 fingerprint. A declaration in a file that is not committed is
reported as a warning instead of an error, and a value that is a known placeholder is left to
[weak-secret](#weak-secret).

**Bad**

```bash
# .env -- committed by mistake
STRIPE_SECRET_KEY=sk_live_51EXAMPLEEXAMPLEEXAMPLEEXAMPLEx
```

**Good**

```bash
# .env -- git-ignored
STRIPE_SECRET_KEY=

# .env.example
STRIPE_SECRET_KEY=
```

**Why it matters**

A committed credential is permanent: deleting the line does not remove it from the history, from
forks or from clones, and provider-side logs of past use. It has to be rotated, not just edited.
Reporting the pattern and a fingerprint keeps the report shareable while still identifying the exact
value to rotate.

**How to fix**

- Rotate the credential first, then remove the value from the file.
- Inject it at deploy time from a secret manager or a CI secret.
- Confirm the file is covered by `.gitignore`, and check the history for the old value.
- Add a project-specific pattern through `secretPatterns` if the shape is not recognised.

**Ignore it**

```bash
# envgle-disable-next-line secret-in-repo
STRIPE_SECRET_KEY=sk_live_51EXAMPLEEXAMPLEEXAMPLEEXAMPLEx
```

```text
STRIPE_SECRET_KEY=sk_live_51EXAMPLEEXAMPLEEXAMPLEEXAMPLEx  # envgle-disable-line secret-in-repo
```

```json
{
  "ignoreRules": ["secret-in-repo"]
}
```

## secret-in-example

**Severity:** error | security

Detects a real credential pasted into an example or template file. It uses the same detection as
[secret-in-repo](#secret-in-repo) but only for `.env.example`, `.env.sample`, `.env.template` and
`.env.dist`, and it skips placeholders entirely, because a placeholder is the correct content there.

**Bad**

```bash
# .env.example
AWS_SECRET_ACCESS_KEY=AKIAIOSFODNN7EXAMPLE
```

**Good**

```bash
# .env.example
AWS_SECRET_ACCESS_KEY=
```

**Why it matters**

Example files are committed on purpose and copied verbatim by every new developer and by most setup
instructions, so a credential in one is the most widely distributed credential in the project. It is
usually pasted from a provider console, which means it is a live key rather than an example value.

**How to fix**

- Rotate the exposed key.
- Replace the value with an empty assignment or a placeholder such as `your-api-key-here`.
- Add a line to the README explaining where the real value comes from.

**Ignore it**

```bash
# envgle-disable-next-line secret-in-example
AWS_SECRET_ACCESS_KEY=AKIAIOSFODNN7EXAMPLE
```

```text
AWS_SECRET_ACCESS_KEY=AKIAIOSFODNN7EXAMPLE  # envgle-disable-line secret-in-example
```

```json
{
  "ignoreRules": ["secret-in-example"]
}
```

## secret-fallback-literal

**Severity:** error | security

Detects a read of a secret-looking variable that supplies a literal default, where the literal itself
matches a known credential pattern or passes the high-entropy test.

**Bad**

```python
# src/config.py
api_key = os.getenv("STRIPE_SECRET_KEY", "sk_live_51EXAMPLEEXAMPLEEXAMPLEEXAMPLEx")
```

**Good**

```python
# src/config.py
api_key = os.environ["STRIPE_SECRET_KEY"]
```

**Why it matters**

The fallback is a credential in version control, so the secret leaks even in deployments where the
variable is always set, and it hides a missing configuration instead of failing. Because the key
works, nothing reports it until the key is rotated and the literal becomes the attacker's credential.

**How to fix**

- Remove the fallback for secrets and read the variable so the process fails loudly when it is
  missing.
- If a default is required for development, read an explicit non-secret variable such as
  `STRIPE_KEY_FILE` and load the credential from disk.
- Never commit a working key "just in case".

**Ignore it**

```python
# envgle-disable-next-line secret-fallback-literal
api_key = os.getenv("STRIPE_SECRET_KEY", "sk_live_51EXAMPLEEXAMPLEEXAMPLEEXAMPLEx")
```

```text
api_key = os.getenv("STRIPE_SECRET_KEY", "sk_live_51EXAMPLEEXAMPLEEXAMPLEEXAMPLEx")  # envgle-disable-line secret-fallback-literal
```

```json
{
  "ignoreRules": ["secret-fallback-literal"]
}
```

## debug-flag-shared-env

**Severity:** warn | security

Detects a shared, committed env file that switches debugging or auth bypass on: `DEBUG`,
`DEBUG_MODE`, `DEBUGGER`, `VERBOSE`, `TRACE`, `LOG_LEVEL`, `LOG_VERBOSITY`, `APP_ENV`, `NODE_ENV`,
`ENV`, `RAILS_ENV`, `AUTH_DISABLED`, `DISABLE_AUTH`, `BYPASS_AUTH`, `SKIP_AUTH`, `NO_AUTH`, `MOCK`,
`MOCKING`, `HOT_RELOAD`, `DEV_TOOLS` or `STORYBOOK` set to `true`, `1`, `yes`, `on`, `enabled`,
`debug`, `trace`, `verbose`, `development`, `dev`, `local` or `test`. A quiet `LOG_LEVEL` such as
`info` is fine, and local, test, example and template files are never reported.

**Bad**

```bash
# .env -- committed and loaded by every deployment
DEBUG=true
```

**Good**

```bash
# .env
LOG_LEVEL=info
ENABLE_DEBUG=false
```

**Why it matters**

A debug switch in a shared file is on for every environment that sources it, including production,
where it commonly exposes stack traces, credentials in request logs or an interactive shell. Auth
bypass flags are worse: they remove authentication entirely, and they are the setting most often
left behind after a load test.

**How to fix**

- Delete the switch from the shared file.
- Gate the behaviour behind an explicit opt-in variable that defaults to off, and turn it on only in
  the environment that needs it.
- Set `LOG_LEVEL` to a production-appropriate value and keep debug logs behind a separate flag.

**Ignore it**

```bash
# envgle-disable-next-line debug-flag-shared-env
DEBUG=true
```

```text
DEBUG=true  # envgle-disable-line debug-flag-shared-env
```

```json
{
  "ignoreRules": ["debug-flag-shared-env"]
}
```

## hardcoded-connection-string

**Severity:** error | security

Detects a value that is a connection string or basic-auth URL carrying a real password: at least 8
characters and not an obvious placeholder such as `password`, `changeme`, `user` or `xxx`. Reports
do not overlap with [secret-in-repo](#secret-in-repo): for a secret-looking name outside example
files that rule owns the finding, so this rule covers example and template files and names that are
not secret-looking.

**Bad**

```bash
# .env.example
DATABASE_URL=postgres://appuser:s3cr3t-p4ssw0rd@db.internal:5432/app
```

**Good**

```bash
# .env.example
DATABASE_URL=postgres://appuser@db.internal:5432/app
```

**Why it matters**

The password travels with the host in every file, log and screenshot that contains the URL, and
`hardcoded-connection-string` exists because a connection string is the one value people paste into
tickets and chat messages. A placeholder password is not reported, so the fix is not "make it look
fake", it is "split the credentials".

**How to fix**

- Keep the host, port and database name in the env file, and inject user and password from a secret
  manager or a platform secret.
- Or store the user in the URL and read the password separately in the code that connects.
- Check the git history for the old URL after rotating the password.

**Ignore it**

```bash
# envgle-disable-next-line hardcoded-connection-string
DATABASE_URL=postgres://appuser:s3cr3t-p4ssw0rd@db.internal:5432/app
```

```text
DATABASE_URL=postgres://appuser:s3cr3t-p4ssw0rd@db.internal:5432/app  # envgle-disable-line hardcoded-connection-string
```

```json
{
  "ignoreRules": ["hardcoded-connection-string"]
}
```
