# envgle fixture expectations

This file is the contract between the fixture projects under `test/fixtures/` and the integration suite. The suite scans each fixture directory as its own project root and asserts the findings against the tables below.

- **Rule id**: one of the 28 ids in `docs/rules.md`. Only ids that MUST fire are listed; a rule absent from a table is either silent on that project or deliberately not asserted there.
- **Minimum expected count**: a lower bound, not an exact count. Several rules report one finding per declaration, per file or per reference, and some adjust severity per instance, so a correct implementation always clears the bound.
- **Why**: the exact file and construct that produces the finding.

Invariants for every fixture:

1. The credential-looking values are the documented examples only: `AKIAIOSFODNN7EXAMPLE`, `wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY` and `ghp_EXAMPLEEXAMPLEEXAMPLEEXAMPLEEXAMPLEEXAMPLE1234`. No value in this tree is a real or plausibly live credential.
2. A git-ignored env file is still parsed: `env-file-untracked` can only fire when the engine resolves an env file the walker would have skipped, so "must be ignored" never lists an env file the rules need.
3. Nothing here is executed; the source files are intentionally bad code.
4. `missing-in-env` and `prod-crash` report once per (name, file) pair, so a file that reads several undeclared variables produces one finding per variable.

## node-webapp

| Rule id | Minimum expected count | Why |
| --- | --- | --- |
| ci-secret-undeclared | 1 | `.github/workflows/ci.yml` uses `${{ secrets.DEPLOY_TOKEN }}`, and `.env.example` does not document it. |
| compose-var-undeclared | 1 | `${REQUIRED_VAR}` (and `${OPTIONAL_VAR:-none}`) in `docker-compose.yml` are in no env file and in no `environment:` key. |
| conflicting-values | 1 | `PORT` and `API_BASE_URL` differ between `.env` and the dev-only `.env.local`. |
| debug-flag-shared-env | 1 | `.env` sets `LOG_LEVEL=debug` in a shared file. |
| duplicate-key | 1 | `DATABASE_URL` is assigned twice in `.env` with different values. |
| empty-value | 1 | `EMPTY_SETTING=` in `.env`. |
| env-file-untracked | 1 | `env_file: [.env.local]` names a git-ignored, dev-only file. |
| expansion-unsupported | 1 | `REDIRECT_URL` uses `${API_BASE_URL}` in the shared `.env`. |
| framework-prefix-mismatch | 1 | `REACT_APP_ANALYTICS_KEY` while `package.json` depends on express, dotenv and vite, and on no react-scripts, react, next or expo. |
| inline-comment-truncation | 1 | `GREETING=hello world # shown on the landing page`. |
| missing-from-example | 1 | `PORT`, `LOG_FORMAT`, both AWS names, `JWT_SECRET`, `API_BASE_URL`, `DATABASE_URL`, `GREETING`, `EMPTY_SETTING` and `REDIRECT_URL` are in no example file. |
| missing-in-env | 2 | `process.env.SEARCH_ENDPOINT` in `src/config.js` and `process.env.HOST` in `src/server.ts` are read and never declared. |
| secret-fallback-literal | 1 | `process.env.GITHUB_TOKEN ?? 'ghp_EXAMPLE...1234'` in `src/config.js`. |
| secret-in-example | 1 | `.env.example` carries a real-looking `ghp_` token. |
| secret-in-repo | 2 | `AWS_ACCESS_KEY_ID` (access-key-id pattern) and `AWS_SECRET_ACCESS_KEY` (high entropy behind a secret-looking name). |
| unquoted-special-chars | 2 | `GREETING` carries whitespace, `REDIRECT_URL` carries `$`. |
| unused-variable | 1 | `GREETING`, `EMPTY_SETTING` and `REDIRECT_URL` are declared and never read. |
| weak-secret | 1 | `JWT_SECRET=changeme` in `.env`. |

Must not fire: `compose-var-undeclared` for `APP_NAME` (Dockerfile `ENV`) or `LOG_LEVEL` (compose list form); `debug-flag-shared-env` for the Dockerfile's `NODE_ENV=production`, an infra reference; `secret-in-repo` for the workflow's `secrets.*` values, which are never read; `example-out-of-sync`, because every `.env.example` entry is read or referenced by infra.

Must be ignored: `node_modules/` (named in `.gitignore` and in the walker's default skip list; no such directory ships here).

Language coverage: `process.env.NAME`, `process.env.NAME ?? 'fallback'`, `const { NAME } = process.env`, and the same three forms in TypeScript with a type annotation.

## python-api

| Rule id | Minimum expected count | Why |
| --- | --- | --- |
| example-out-of-sync | 1 | `.env.example` documents `METRICS_ENDPOINT`, which nothing reads or references and no other env file declares. |
| missing-in-env | 1 | `environ.get("X", "y")` in `app/settings.py`; `X` is declared nowhere. |
| prod-crash | 1 | `os.environ["DEBUG_HOST"]` is a required read and `DEBUG_HOST` is declared only in the dev-only `.env.local`. |
| secret-in-repo | 1 | `.env` holds `postgres://user:EXAMPLEpassword@db.internal:5432/app` for `DATABASE_URL`. |

Must not fire: `hardcoded-connection-string` for the same value, because `DATABASE_URL` is secretish and `.env` is not an example file, so `secret-in-repo` owns the finding; `missing-from-example` (every name in `.env` and `.env.local` is documented); `debug-flag-shared-env` (`LOG_LEVEL=info`); `invalid-name` for the single-letter read `X`.

Must be ignored: nothing beyond the walker's default directory skips, none of which ship here (`__pycache__/`, `.venv/`, `venv/`). `app/settings.py` and `app/db.py` must both be scanned.

Language coverage: `os.environ['NAME']` (required), `os.environ.get('NAME')`, `os.getenv('NAME', 'default')`, `environ.get('NAME', 'default')` after `from os import environ`, and a pydantic `class Settings(BaseSettings)` with one field without a default and one with.

## go-service

| Rule id | Minimum expected count | Why |
| --- | --- | --- |
| missing-in-env | 1 | `os.Getenv("METRICS_TOKEN")` in `internal/config.go`; no env file declares it, and `PORT`, `SENTRY_DSN` and `DATABASE_URL` are all documented in `.env.example`, which counts as a declaration. |

Must not fire: `unused-variable` and `example-out-of-sync` (every `.env.example` entry is read); `missing-from-example` (nothing is declared outside the example file); `hostile-name` and `reserved-name` for the Dockerfile's `ENV PATH /usr/local/bin:$PATH`, because a Dockerfile `ENV` is an infra reference rather than a declaration and no Go code reads `PATH`.

Must be ignored: nothing ships beyond the default directory skips; `go.sum` is filler with placeholder hashes and must not be read as configuration.

Language coverage: `os.Getenv("NAME")` and the presence check `os.LookupEnv("NAME")`. The bare `Getenv("NAME")` form is deliberately absent, so it must not be inferred from the `os.` form.

## rust-cli

| Rule id | Minimum expected count | Why |
| --- | --- | --- |
| example-out-of-sync | 1 | The project has no example file while `.env` has real declarations. |
| missing-in-env | 1 | `env::var("API_TOKEN")` in `src/main.rs`; `API_TOKEN` and `DATA_DIR` are declared nowhere. |
| unused-variable | 1 | `SECRET_TOKEN` is declared in `.env` and never read. |
| weak-secret | 1 | `SECRET_TOKEN=changeme` in the shared `.env`. |

Must not fire: `debug-flag-shared-env` for `RUST_LOG=debug`, because `RUST_LOG` is not one of the twenty debug names; `prod-crash` (a plain `env::var` is not a required read, and `API_TOKEN` is undeclared rather than dev-only); `secret-in-repo` (`changeme` is on the weak-value list, which `weak-secret` owns, and the value is below the entropy floor).

Must be ignored: `target/` (default skip; does not ship here). `Cargo.lock` must not be read as configuration.

Language coverage: `env::var("NAME").unwrap_or_default()`, `env::var("NAME").unwrap()` and the bare `env::var("NAME")` with no chain.

## dotnet-microservice

| Rule id | Minimum expected count | Why |
| --- | --- | --- |
| empty-value | 1 | `SMTP_PASSWORD=` in the root `.env`. |
| example-out-of-sync | 1 | The project ships no example file while the root `.env` has declarations. |
| unused-variable | 1 | `SMTP_HOST` and `LOG_LEVEL` are declared and never read. |
| weak-secret | 1 | `SMTP_PASSWORD` is secret-looking and empty. |

Must not fire: `missing-from-example` (with no example file the rule returns early); `invalid-name` (the configuration key `ConnectionStrings:Default` contains a colon and is not an environment variable, so it must never become a variable name); `debug-flag-shared-env` (`ASPNETCORE_ENVIRONMENT` is not a debug name and `LOG_LEVEL=Information` is not truthy); any secret rule for `appsettings.json`, which is plain configuration.

Must be ignored: `apps/Api/appsettings.json` and `apps/Api/Properties/launchSettings.json` must never be treated as env files; `bin/` and `obj/` are default skips.

Language coverage: `Environment.GetEnvironmentVariable("NAME")` and `Environment.GetEnvironmentVariable("NAME", EnvironmentVariableTarget.Local)`. The second argument is an enum, not a fallback literal, so `secret-fallback-literal` must stay silent.

## rails-app

| Rule id | Minimum expected count | Why |
| --- | --- | --- |
| debug-flag-shared-env | 1 | `export RAILS_ENV=development` in the shared `.env`. |
| export-prefix | 3 | `RAILS_ENV`, `SECRET_KEY_BASE` and `REDIS_URL` use the `export` prefix. |

Must not fire: `missing-from-example` and `example-out-of-sync` (the example file and the code agree on all five names); `conflicting-values` (`.env.example` is excluded from that comparison); `secret-in-repo` (`SECRET_KEY_BASE` holds `not-a-real-key`, fifteen characters and therefore below the entropy floor, and no credential pattern matches it); `unused-variable` and `missing-in-env` (all five names are read).

Must be ignored: nothing ships beyond the default directory skips; `vendor/bundle/` and `log/` are not part of this fixture.

Language coverage: `ENV["NAME"]`, `ENV["NAME"] || default`, `ENV.fetch("NAME")`, `ENV.fetch("NAME", "default")` and the block form `ENV.fetch("NAME") { "default" }`. The reads sit outside string interpolation on purpose, because a masked double-quoted string hides them.

## php-laravel

| Rule id | Minimum expected count | Why |
| --- | --- | --- |
| debug-flag-shared-env | 1 | `APP_ENV=local` in the shared `.env`. |
| empty-value | 1 | `APP_KEY=` in `.env`. |
| env-file-missing | 1 | `env_file: [.env.production]` names a file that does not exist. |
| unused-variable | 2 | `REDIS_HOST` and `REDIS_PORT` are declared and never read. |
| weak-secret | 1 | `DB_PASSWORD=secret` in `.env`. |

Must not fire: `compose-var-undeclared` for `${APP_KEY}`, `${DB_HOST:-db}` and `${DB_PASSWORD:?set DB_PASSWORD}`, because all three names are declared in `.env` (the negative case for the required `:?` form); `secret-fallback-literal` for `env('DB_PASSWORD', 'secret')`, because `secret` is on the weak-value list and below the entropy floor; `invalid-name` for `APP_KEY`, which the secret-name pattern does not classify; `missing-from-example` and `example-out-of-sync` (both files agree).

Must be ignored: `vendor/` (default skip; does not ship here), `storage/` and `bootstrap/cache/`.

Language coverage: `env('NAME')` and `env('NAME', 'default')`. The `$_ENV` and `$_SERVER` superglobal forms are deliberately absent.

## clean

This project must produce **zero findings**. The table is empty by contract, and the suite asserts `findings.length === 0` for `test/fixtures/clean`. Nothing may fire, and the reasons are structural rather than suppressed:

- `.env` and `.env.example` hold the same six names, each with a `#` comment above it in the example file: `APP_NAME`, `PORT`, `LOG_LEVEL`, `BACKEND_URL`, `FEATURE_FLAGS`, `REQUEST_TIMEOUT_MS`. No duplication and no second real env file, so no `duplicate-key`, `conflicting-values`, `empty-value` or `example-out-of-sync`.
- No name is secret-looking, so no `weak-secret`, `secret-in-repo`, `secret-in-example`, `secret-fallback-literal` or `hardcoded-connection-string`; `BACKEND_URL` carries no credentials, so no connection-string pattern matches it.
- Every name is ASCII `UPPER_SNAKE_CASE`, and none is reserved, hostile or longer than 127 characters.
- Every value is a bare token: no whitespace, `#`, `$`, quote, backslash, `=` or inline comment, and no `${...}` expansion.
- `src/app.js` reads all six with a `??` fallback, so nothing is missing, required or prod-crash.
- `Dockerfile` re-declares the six with `ENV`, and `docker-compose.yml` lists the same six in `environment:` with literal values: no `env_file:` and no `${...}`, so no `env-file-missing`, `env-file-untracked` or `compose-var-undeclared`.
- `LOG_LEVEL=info` is a quiet value, so `debug-flag-shared-env` stays silent.
- The workflow's only secret is `secrets.DEPLOY_TOKEN`, and `DEPLOY_TOKEN` is documented in `.env.example`, so `ci-secret-undeclared` stays silent.
- There is no `package.json` and no `VITE_`/`REACT_APP_`-style name, so `framework-prefix-mismatch` cannot fire.

Any finding here is a false positive in the tool, not a fixture defect.

Must be ignored: nothing. No `node_modules`, `dist`, `vendor`, binary or git-ignored file ships here, and every file the walker returns must be read.

Language coverage: `process.env.NAME ?? 'default'` only, and the fallbacks are deliberately non-secret literals so `secret-fallback-literal` stays silent.

## edge-cases

| Rule id | Minimum expected count | Why |
| --- | --- | --- |
| conflicting-values | 1 | `SHARED_WITH_BOM` differs between the CRLF `.env` and `.env.bom`. |
| duplicate-key | 1 | `DUPLICATE_KEY` is assigned twice in `.env`. |
| empty-value | 1 | `LAST_BOM_KEY=` in `.env.bom`, after the byte-order mark. |
| example-out-of-sync | 1 | No example file ships with this project. |
| expansion-unsupported | 1 | `EXPANDED=${PLAIN_KEY}-suffix` in the shared `.env`. |
| hostile-name | 2 | `PATH` and `NODE_OPTIONS` are declared in the shared `.env`. |
| inline-comment-truncation | 1 | `HASH_IN_VALUE=abc # trailing comment`. |
| invalid-name | 4 | `key-with-dash`, `lower_case`, `9LEADING` and `DATABASE_É`. |
| reserved-name | 1 | `LANG` is owned by the operating system. `PATH` and `NODE_OPTIONS` are `hostile-name` findings instead, and the two rules do not overlap. |
| unquoted-special-chars | 2 | `EQUALS_IN_VALUE` carries `=`, `EXPANDED` carries `$`. |
| unterminated-quote | 3 | `BARE_KEY` and `YAML_STYLE_KEY` have no `=` separator, and `UNTERMINATED` never closes its quote. |
| unused-variable | 1 | `PLAIN_KEY`, `DUPLICATE_KEY`, the invalid names and `PATH` are declared and never read. |

Parser probes whose outcome is deliberately not asserted: the CRLF line endings in `.env`, the UTF-8 byte-order mark in `.env.bom` (its first line is a comment, so the mark must not end up glued to `BOM_KEY`), the tab-indented line and the blank line in `.env`, and the multi-line quoted values in `.env.quotes`. The run must not fail on any of them, and a multi-line quoted value must never be reported as `unterminated-quote` if the reader supports it.

Must not fire: any secret rule (no credential value ships here); `debug-flag-shared-env` (no debug name is set); `missing-from-example` (with no example file the rule returns early); `missing-in-env` (this project ships no source file); every rule for the skipped paths below; and `shell-incompatible-name` for `DATABASE_É`, which is not a valid identifier and is therefore owned by `invalid-name`.

Must be ignored: `node_modules/some-pkg/.env` (the walker's default directory skip); `dist/bundle.min.js` (skipped with the `dist/` directory - the tool has no `*.min.js` rule of its own, so a minified file outside `dist/` would be read); `vendor/lib.go` (default skip); `logo.png` (skipped for the `.png` extension, and it also carries NUL bytes); `logo.png` is also the binary-sniff case. `app.local.env` is NOT skipped: `.gitignore` prunes directories, so a git-ignored file is still analysed and is reported with `committed: false`, which is what `env-file-untracked` and the `secret-in-repo` severity depend on.

Language coverage: none by design. The only accessors in this project sit inside the ignored files - `process.env.SHOULD_BE_IGNORED` in `dist/bundle.min.js` and `os.Getenv` in `vendor/lib.go` - and neither may reach the report.

### Rules with no firing fixture

- `hardcoded-connection-string` is only asserted as a negative expectation (in `python-api` and `clean/`), because outside example files `secret-in-repo` owns any secret-looking name, and no example file in this tree embeds a password. Adding a case means giving an `.env.example` a value such as `redis://user:EXAMPLEpassword@cache.internal:6379/0`.
- `shell-incompatible-name` cannot fire from the names in this tree: the only non-ASCII name, `DATABASE_É`, is not a valid identifier and `invalid-name` owns it, and the other limit is a name longer than 127 characters, which no fixture declares on purpose.

### Notes for the integrator

- The `conflicting-values` row of `node-webapp` and the `prod-crash` row of `python-api` both need the engine to parse env files the walker would skip (a git-ignored and a dev-only `.env.local`). That is the same capability `env-file-untracked` needs for its documented case; `edge-cases` proves `conflicting-values` without that coupling.
- The enclosing project has no commits yet, and the root `.gitignore` ignores `.env`, `.env.local`, `node_modules/` and `dist/`. `test/fixtures/.gitignore` re-includes the paths that must be tracked, except `node-webapp/.env.local`, which the fixture's own `.gitignore` ignores on purpose: add it with `git add -f`, or a fresh clone reports `env-file-missing` instead of `env-file-untracked`.
- `EnvFileInfo.tracked` is best-effort, so assert rule ids and counts, never severities. If the engine resolves tracking with `git` and the fixture files are untracked, `secret-in-repo` drops from error to warn and `python-api` gains an `env-file-untracked` for its `env_file: [".env"]`; both are environment artefacts, so neither belongs in a table.
- No fixture writes an `envgle-disable-*` marker or a config file, so no rule is suppressed anywhere in this tree.
