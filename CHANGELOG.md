# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

Nothing yet.

## [0.1.0] - 2026-09-26

First release.

### Added

- Cross-referencing engine for environment variables: it collects declarations
  from `.env*` files, reads from 16 languages, and references from
  docker-compose files, Dockerfiles and CI pipelines, then correlates the
  three sets into one report.
- 28 rules in three groups, documented individually in `docs/rules.md`:
  - Contract: `missing-in-env`, `missing-from-example`, `unused-variable`,
    `prod-crash`, `example-out-of-sync`, `ci-secret-undeclared`,
    `compose-var-undeclared`, `env-file-missing`, `env-file-untracked`,
    `framework-prefix-mismatch`.
  - Hygiene: `duplicate-key`, `conflicting-values`, `empty-value`,
    `unquoted-special-chars`, `inline-comment-truncation`, `export-prefix`,
    `unterminated-quote`, `expansion-unsupported`.
  - Security: `invalid-name`, `reserved-name`, `hostile-name`,
    `shell-incompatible-name`, `weak-secret`, `secret-in-repo`,
    `secret-in-example`, `secret-fallback-literal`, `debug-flag-shared-env`,
    `hardcoded-connection-string`.
- Read detection for 16 languages through a data table of 41 accessors,
  including `process.env`, `os.getenv`, `ENV.fetch`, `Deno.env.get`,
  `$env/static/private` import bindings and per-accessor fallback and
  required-access flags.
- Infra parsing for docker-compose `environment`, `env_file`, `build.args` and
  `${VAR}` interpolation, for Dockerfile `ARG`/`ENV`/build-stage usage, and for
  GitHub Actions workflows and actions plus `.gitlab-ci.yml` (including
  `environment:`, `secrets:` and `vars:`).
- Secret detection against 30 built-in credential patterns plus a
  high-entropy test behind secret-looking names. Values are never printed:
  findings carry a truncated sha256 fingerprint instead.
- Four output formats: `human` (grouped by file, colourised, with a `hint:`
  line per finding), `json` (stable, key-sorted), `sarif` (2.1.0, for GitHub
  code scanning) and `markdown` (for job summaries and pull request comments).
  `--format quiet` prints nothing and leaves only the exit code. No format
  prints a code frame, because the report carries no file contents.
- Seven commands: `scan` (the default when none is given), `check`, `init`,
  `docs`, `fmt`, `why` and `rules`, plus `help` and `version` and the
  `--help`/`--version` flags. `init --write` refuses to overwrite an existing
  file; `check` is silent when there is nothing to report.
- `envgle fmt` normalises dotenv files: it strips trailing whitespace,
  guarantees exactly one final newline and sorts keys within each run of adjacent
  assignments, without ever rewriting a value.
- Configuration from an explicit `--config` path, an `"envgle"` key in the
  nearest `package.json`, `.envglerc.json` or `envgle.config.json`, all
  discovered by searching upward from the target directory; every field is
  documented in `docs/configuration.md`.
- `.gitignore` handling: the rules prune directories during the walk, while
  individual git-ignored files are still read and analysed. Anything git does
  not track is reported with `committed: false`, which downgrades
  `secret-in-repo` from `error` to `warn`. `--no-gitignore` turns off the
  directory pruning.
- Global flags: `--format`, `--fail-on`, `--config`, `--project`, `--rule`,
  `--ignore-rule`, `--ignore-var`, `--max-issues`, `--max-file-size`,
  `--short`, `--verbose`, `--dry-run`, `--no-gitignore`, `--no-color`,
  `--quiet`, `--write`, `--check` and `--json`. `--rule` selects which rules run,
  `--ignore-rule` and `ignoreRules` switch rules off.
- Deterministic exit codes: `0` when nothing is at or above `--fail-on`, `1`
  when findings are, `2` on a usage error or a refused write. A config file
  that cannot be read, an unknown key, an unknown rule id in the file, an
  invalid regular expression and a secret pattern that fails its own `test`
  string are warnings, not failures.
- A dotenv parser that reads quoting, comments, `${VAR}` expansion and duplicate
  keys, and a formatter that edits the text in place, so normalising a file
  cannot change what the linter sees in it.
- Inline suppression of individual findings by comment directive in the source
  file: `envgle-disable-line`, `envgle-disable-next-line` and
  `envgle-disable-file`, each accepting several rule ids separated by commas
  or spaces, on top of `ignoreRules`, `ignoreVariables` and
  `ignoreFingerprints`.
- Zero runtime dependencies. `typescript` and `@types/node` are the only
  development dependencies, and the published tarball is plain JavaScript.

[Unreleased]: https://github.com/nyaa666/envgle/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/nyaa666/envgle/releases/tag/v0.1.0
