# Architecture

envgle answers one question: for every environment variable name in a
repository, who declares it, who reads it, who references it in infrastructure,
and where do those three sets disagree? Everything in the codebase exists to
produce the data for that question and then compare it.

## Pipeline

```text
  argv
    |
    v
  +----------------------------------------------------------------+
  | cli       src/cli.ts                                           |
  | parse flags, pick the command, own the exit                    |
  | code; scan is the default when none is given                   |
  +----------------------------------------------------------------+
    |
    v
  +----------------------------------------------------------------+
  | config     src/config.ts                                       |
  | discovery order, defaults, validation                          |
  | -> ResolvedConfig, read by every stage below                   |
  +----------------------------------------------------------------+
    |
    v
  +----------------------------------------------------------------+
  | scan       src/scan/index.ts, the only orchestrator            |
  |                                                                |
  | 1. readIgnorePatterns  .gitignore at the root, plus the        |
  |                        nested ones, to a bounded depth         |
  | 2. trackedFiles        git ls-files, or null without git       |
  | 3. walkFiles           directories, size, binary, symlinks,    |
  |                        language. The ignore matcher is asked   |
  |                        about directories only                  |
  | 4. env files           classifyEnvFile + parseEnvFile          |
  |                        -> EnvFileInfo[], EnvVarDecl[]          |
  | 5. code                scanCode over the source files          |
  |                        -> EnvUsage[]                           |
  | 6. infrastructure      compose, Dockerfile, CI, and the        |
  |                        dotenv.config({ path }) references      |
  |                        -> InfraRef[]                           |
  | 7. suppression index   buildSuppressionIndex over every        |
  |                        file read, so markers work in code      |
  | 8. rules               runRules over allRules                  |
  | 9. summary             sort, de-duplicate, count               |
  +----------------------------------------------------------------+
    |
    v
  +----------------------------------------------------------------+
  | rules      src/rules                                           |
  |   contract       10 rules, cross-reference the three sets      |
  |   hygiene         8 rules, dotenv-file-local correctness       |
  |   security       10 rules, naming and credential hygiene       |
  |   context         indexes, suppression, report sink            |
  |   secret-patterns 30 built-in credential shapes                |
  +----------------------------------------------------------------+
    |
    v
  +----------------------------------------------------------------+
  | report     src/report                                          |
  |   human         grouped, colourised, hints, no code frames     |
  |   json          stable, key-sorted                             |
  |   sarif         2.1.0, for code scanning                       |
  |   markdown      tables, for summaries and comments             |
  |   quiet         nothing                                        |
  |   variables     rollup shared by json and markdown             |
  +----------------------------------------------------------------+
    |
    v

    stdout
    exit code 0, 1 or 2
```

The report carries no file contents, so a formatter cannot print a code frame
even if it wanted to. That is the reason `codeFrameLines` is resolved and then
never read.

Each stage is a pure transformation of the previous stage's output. Nothing
downstream re-reads the filesystem, which is what makes a run reproducible and
what makes a rule testable without a temporary directory.

## Module map

One line per file. The tree is exactly 37 modules and nothing in it is dead:
`scripts/check-repo.mjs` fails the build if a module is not reachable from
`src/cli.ts` or `src/index.ts`.

| Module | Responsibility |
| --- | --- |
| `src/types.ts` | Every shared type and the two sealed unions (`RuleId`, `Severity`) the whole codebase narrows to, plus the `Report` shape the engine produces. |
| `src/version.ts` | The version string, the repository and docs base URLs, and `ruleDocsUrl`, so a finding's documentation link is computed rather than typed. |
| `src/config.ts` | Configuration discovery, the precedence order, JSON comment stripping, per-field validation, and the immutable `ResolvedConfig`. Never throws. |
| `src/cli.ts` | `parseArguments`, `buildContext`, `runCli` and `main`. Owns flag parsing, the command list, the help text and the exit codes. |
| `src/index.ts` | The programmatic entry point: re-exports the engine, the rule registry, the formatters and the types. |
| `src/utils/text.ts` | Text primitives: POSIX path normalisation, offset-to-line/column, line extraction, sha256 fingerprints, Shannon entropy, the glob dialect, the built-in secret-name pattern, value redaction and stable key-sorted `JSON.stringify`. |
| `src/utils/walk.ts` | Iterative, non-recursive tree walk. Never throws: every refusal becomes a `SkippedFile` with a reason (`gitignore`, `exclude`, `symlink`, `special`, `extension`, `too-large`, `binary`, `unreadable`). Classifies each file's language from its extension and recognises dotenv file names. Two lists are pruned before anything else: build and tooling directories, and generated wrappers (`gradlew`, `mvnw`, autotools `configure`, `install-sh` and friends) whose thousands of lines of shell and batch read only their own local variables. |
| `src/utils/ignore.ts` | A faithful `.gitignore` matcher: comments, `!` negation, trailing-`/` directory rules, root anchoring, `**` spans, character classes, and last-match-wins, including the rule that a negation cannot re-include a file whose ancestor directory is ignored. |
| `src/dotenv/parse.ts` | The dotenv reader. Produces one `EnvVarDecl` per assignment with quotes, escapes, `export` prefix, `hasValue`, leading comments, inline comments, trailing whitespace, `${VAR}` references and the earlier duplicate line, plus recoverable parse issues and stricter diagnostics. |
| `src/dotenv/format.ts` | The canonical writer: `serializeEnvFile`, `needsQuoting` and `normalizeValue`, exported for programmatic use. A parse/serialize round trip preserves names, values, quote characters, export prefixes, inline comments and leading comments; blank lines collapse because grouping is expressed with comments. `envgle fmt` deliberately does not use it and instead normalises text in place through `formatEnvText` in `src/commands/fmt.ts`, because rewriting a file must change as little as possible. |
| `src/scan/index.ts` | The orchestrator, and the only module that sequences the scan: ignore patterns, the git tracked-file list, the walk, env-file parsing, code scanning, infrastructure scanning, the suppression index, the rule run and the summary. |
| `src/scan/classify.ts` | The dotenv naming convention in one place: `.env.example` and friends are templates, `.env.local` is dev-only, `.env.test` is a test file, and everything else is shared. |
| `src/scan/code.ts` | The accessor table and per-file read extraction. Each of the 41 accessors is a data-table entry with an id, the languages it applies to, and an `extract` function that pushes `EnvUsage` records with `hasFallback`, `required`, `viaImport` and `fallbackLiteral` set. |
| `src/scan/yaml.ts` | An indentation-based reader for the block-style YAML subset that compose and CI files use, plus `${VAR}`, `${VAR:-default}`, `${VAR:?error}`, `${VAR-default}` and `$VAR` interpolation extraction with positions. |
| `src/scan/compose.ts` | docker-compose `environment`, `env_file`, `build.args`, service names, and whether the file is an override. |
| `src/scan/dockerfile.ts` | `FROM`, `ARG`, `ENV`, `COPY --from` and `$VAR` usage, tracked per build stage. |
| `src/scan/ci.ts` | GitHub Actions workflows and action files plus `.gitlab-ci.yml`: `env:`, `secrets:`, `vars:`, `environment:`, and referenced env file paths. |
| `src/scan/git.ts` | The tracked-file list from `git ls-files`, or null when git is unavailable or the directory is not a repository. This is what makes `committed` a fact about the repository rather than a guess. |
| `src/scan/suppress.ts` | The inline marker index for `envgle-disable-line`, `envgle-disable-next-line` and `envgle-disable-file`, keyed by file and line, with comma- or space-separated rule ids. |
| `src/rules/index.ts` | The rules registry: `allRules` in contract, hygiene, security order, plus lookup by id, a type guard for arbitrary strings, and ids sorted deterministically. |
| `src/rules/context.ts` | The immutable `RuleContext`: name-indexed views of declarations, reads and infra references, the sorted name list, the suppression predicate, and the `report` sink that stamps severity, `docsUrl` and the fingerprint. `runRules` isolates a throwing rule and sorts and de-duplicates the findings. |
| `src/rules/contract.ts` | The 10 cross-reference rules, and the ambient-variable list that keeps `missing-in-env` from demanding a declaration for something the OS, the shell, Node or a CI provider injects. These are the only rules that compare all three data sets against each other. |
| `src/rules/hygiene.ts` | The 8 file-local rules: a problem inside one dotenv file, or between two. |
| `src/rules/security.ts` | The 10 naming and secret-hygiene rules. Each check is wrapped so a throw cannot take down the run. |
| `src/rules/secret-patterns.ts` | 30 built-in credential shapes, the merge for user-supplied `secretPatterns` with self-validation, the high-entropy test, and value classification that never exposes the value. |
| `src/report/format.ts` | The human format: a header, findings grouped by file (or one line each with `--short`), severity colouring, dim `hint:` lines, a per-file cap, the docs line and the summary. It prints no code frames, because the report carries no file text. |
| `src/report/json.ts` | The JSON format, produced with key-sorted `stableStringify` so the key order is identical between runs. `durationMs` is the one field that varies. |
| `src/report/sarif.ts` | SARIF 2.1.0 with `%SRCROOT%`-relative paths, static rule metadata kept local so the output does not depend on the rules registry at runtime. |
| `src/report/markdown.ts` | The markdown format: summary and per-rule counts, a per-variable table, a findings section, and `toExampleFile`, which renders a `.env.example` skeleton with every value left empty. |
| `src/report/variables.ts` | The per-variable rollup shared by the JSON and markdown formats, including redaction previews and the config fallback used when a formatter is called without a config. |
| `src/commands/context.ts` | The `CommandContext` every command receives, and the severity rank table. |
| `src/commands/scan.ts` | The `scan` and `check` commands, and the shared plumbing they lend the others: config loading, scan options, the verbose lines, the report renderer and the exit-code policy. `check` prints nothing at all when there are no findings. |
| `src/commands/docs.ts` | The `init` and `docs` commands. `init` prints the generated `.env.example` and, with `--write`, refuses to overwrite an existing file (exit `2`); `docs` prints markdown and `--write [path]` defaults to `docs/environment.md` and does overwrite. |
| `src/commands/fmt.ts` | The `fmt` command and `formatEnvText`, which strips trailing whitespace, guarantees exactly one final newline and sorts keys within each run of adjacent assignments, leaving every value untouched. |
| `src/commands/why.ts` | The `why <NAME>` command: declarations, reads, references and findings for one variable. Exits `2` for a name the project never mentions. |
| `src/commands/rules.ts` | The `rules` command, in a severity-then-id order for humans and in key-sorted JSON with `--json`. |
| `src/commands/usage.ts` | The `USAGE` text, with `{version}` substituted at print time. |

Configuration resolution sits next to the CLI rather than in the pipeline: it
reads one of the four sources, applies the precedence documented in
[configuration](configuration.md), validates the `secretPatterns` entries and
produces the immutable `ResolvedConfig` that every stage reads.

## Data model

The engine's output is a single `Report`, defined in `src/types.ts`. Everything
else in the pipeline is an input to it.

| Field | Type | What it holds |
| --- | --- | --- |
| `tool` | `ToolInfo` | Name and version, so a stored report is self-identifying. |
| `root` | `string` | Absolute project root the run was rooted at. |
| `startedAt` | `string` | Start timestamp, ISO 8601. |
| `durationMs` | `number` | Wall-clock duration. |
| `filesScanned` | `number` | Files read. |
| `bytesScanned` | `number` | Bytes read. |
| `filesSkipped` | `number` | Files the walk refused. |
| `skipped` | `SkippedFile[]` | One entry per refusal, with a machine-readable `reason`. |
| `files` | `EnvFileInfo[]` | One entry per env file: kind (`dev`, `test`, `production`, `local`, `example`, `template`, `unknown`), whether it is shared, dev-only, tracked and committed, declaration count, parse issues, byte size. A referenced file that is not on disk still gets an entry, with `exists: false`. |
| `decls` | `EnvVarDecl[]` | Every declaration, one per assignment. Carries `value`, which is raw and may be a secret, plus `hasValue`, `quoted`, `exported`, `references`, `duplicateOfLine`, `leadingComments`, `inlineComment`, `unquotedInlineComment` and the file's kind, shared and dev-only flags. |
| `usages` | `EnvUsage[]` | Every read, one per access site. Carries the language, the accessor id, and the `hasFallback`, `required`, `viaImport` and `fallbackLiteral` flags. |
| `infra` | `InfraRef[]` | Every reference from compose, Docker or CI. The `kind` says which of the 12 kinds it is; `required`, `refersToFile` and `interpolation` carry the semantics. |
| `manifest` | `PackageManifest \| null` | The nearest `package.json`, used by `framework-prefix-mismatch`. Null when there is none. |
| `findings` | `Finding[]` | The output. Each finding has `ruleId`, `ruleTitle`, `severity`, `message`, `file`, `line`, `column`, `docsUrl`, and optionally `variable`, `hint` and `fingerprint`. |
| `summary` | `ReportSummary` | Counts by severity, counts by rule, variables seen, declared, read, secretish, files scanned, files with findings, rules fired, diagnostics. |
| `diagnostics` | `ReportDiagnostic[]` | Parser-level notes that no rule owns, such as a line that parsed with a recovery. Shown by `--verbose`; no finding references them. |

The three collections are deliberately separate: a name appears in all three
when it is declared, read and referenced, and the contract rules are the only
code that reasons about that overlap. `RuleContext` exposes them pre-indexed by
name (`byName`, `usagesByName`, `infraByName`) plus a sorted `names` list, so a
rule never has to build its own index and never depends on iteration order.

`Finding` has no `value` field, and neither does `ReportDiagnostic` or any other
type in the report. That is the type-level guarantee behind the redaction
promise: there is nowhere in the report to put a secret, and nowhere for a
formatter to read one from, which is also why no output format can print a code
frame.

## Design decisions

- **Zero runtime dependencies.** The published package is plain JavaScript with
  nothing to install beside it, so it can run in a locked-down CI image, a
  Docker build stage or an air-gapped runner without a dependency-resolution
  step. It also means the tool cannot be compromised through its dependency
  tree, which matters for something that reads your secret files.
- **Static string analysis only.** Reads are found by matching known accessor
  shapes against source text, never by executing code, importing a module or
  evaluating an expression. A linter that ran your code would need your runtime
  and your dependencies; one that reads text needs neither.
- **Values are never printed or uploaded.** A value is classified, compared and
  fingerprinted, and then discarded. Reporting uses a truncated sha256, which is
  enough to tell two findings about the same credential apart and useless for
  reconstructing the credential. A pasted CI log cannot leak a secret.
- **Deterministic output.** Files are walked and sorted by relative path,
  findings are sorted by location, JSON keys are sorted, and no rule reads the
  clock. Nothing in the report depends on map iteration order, so a markdown
  report committed to a repository diffs cleanly and a SARIF upload shows no
  phantom changes. The one field that legitimately varies between two runs over
  the same code is the rounded `durationMs`, which appears in the human header
  and in the JSON report; the markdown and SARIF outputs do not carry it.
- **Every rule is a pure function over an immutable context.** A rule receives
  `RuleContext` and calls `report()`. It cannot write files, cannot read the
  filesystem, cannot reach the network and cannot see another rule's findings,
  so rules cannot interact, cannot be order-dependent and are testable against a
  hand-built context. A rule that throws is contained, not fatal.
- **Every language accessor is a data-table entry.** Adding support for a new
  environment API in an existing language is a new row in one table, not a new
  branch in a dispatcher. It keeps the language-specific knowledge in one
  readable place and makes the accessor list enumerable, which is what
  `envgle why` and the docs are built from.
- **YAML is read by indentation, not by a parser.** CI and compose files are a
  small, regular subset of YAML. A dedicated reader gives exact line and column
  positions for free and removes the need for a third-party parser.
- **A faithful `.gitignore` matcher instead of a dependency.** Reusing git's own
  semantics, including negation and directory rules, keeps the directory set
  consistent with what git would hand to a build. It prunes directories only:
  an individual git-ignored file is still read, because the values in it are
  exactly the ones worth checking, and whether it belongs in the repository is
  answered separately from `git ls-files`.
- **Findings carry a docs URL derived from the rule id.** Documentation cannot
  drift from the implementation because the URL is computed, not typed by hand.

## How to add a rule

1. **Add the id to the `RuleId` union in `src/types.ts`.** The union is the
   single source of truth: config validation, `--rule` parsing, the `severities`
   map and the rule registry all narrow to it.
2. **Write the check.** Put it in the module that matches its nature:
   `src/rules/contract.ts` if it compares declarations, reads and infra against
   each other, `src/rules/hygiene.ts` if the problem is inside or between env
   files, `src/rules/security.ts` if it is about naming or credentials. Route
   every finding through the module's `emit` helper, which applies the
   suppression predicate, and give each finding a `message` that names the
   variable and the file, a `variable` and a `hint` with the fix.
3. **Register it** in that module's exported array with `id`, `title`,
   `severity`, `description`, `docs`, `remediation` and `tags`. In
   `contract.ts` and `hygiene.ts` the `docs` anchor is written out as
   `docs/rules.md#<id>`; in `security.ts` it comes from
   `ruleDocsAnchor(id)`. Keep the two forms identical.
4. **Add a `## <id>` section to `docs/rules.md`.** This step is mandatory, not
   optional: `scripts/check-repo.mjs`, which `npm run lint` runs, verifies that
   every id in the `RuleId` union has a matching `## <id>` heading in that file
   and fails the build otherwise. The section should state what the rule
   detects, why it matters, and the same remediation text the rule carries.
5. **Add tests** in the matching `test/rules-*.test.ts`, table-driven, with at
   least one positive case, one negative case and one suppression case. Build
   the context by hand with the existing helpers rather than by scanning a
   temporary tree; only the walker and the readers need fixtures.
6. **Document the configuration surface, if any.** If the rule reads a new
   config list, add the field to `EnvAuditConfig` in `src/types.ts`, document it
   in the table in [docs/configuration.md](configuration.md), and then run
   `npm run verify`.

## How to add a language accessor

1. **Add an entry to the accessor table in `src/scan/code.ts`.** An entry is an
   `Extractor`: an `id`, the display `accessor` string the reports show (for
   example `process.env` or `os.getenv`), the `languages` it applies to, a
   one-line `comment`, and the `extract` function.
2. **Implement `extract` to push `EnvUsage` records** through
   `context.push(usage, location)`. Set the flags honestly, because the rules
   depend on them: `hasFallback` when the read supplies a default, `required`
   when the read throws or indexes the environment directly, `viaImport` for a
   name that came from an import binding such as `$env/static/private`, and
   `fallbackLiteral` with the literal written next to the read. `prod-crash`
   keys off `required` and `secret-fallback-literal` keys off
   `fallbackLiteral`.
3. **Add the file extension if the language is new.** Add it to
   `LANGUAGE_BY_EXTENSION` in `src/utils/walk.ts`, which is what makes the
   walker hand the file to this accessor at all. A new accessor for a language
   whose extension is already mapped needs no change there.
4. **Add a test** that feeds a small source fixture through the accessor and
   asserts the extracted names, the reported accessor id and the flags. One
   fixture per accessor keeps the table honest when someone adds a language.
5. **No rules documentation is needed.** An accessor does not introduce a
   `RuleId`, so `docs/rules.md` needs no new section. Only adding a rule
   triggers the `scripts/check-repo.mjs` rule-documentation check.

## Threat model for the tool itself

envgle reads the files that make up a repository, including files that hold
secrets. That makes the tool's own behaviour worth stating plainly.

- **It only reads files.** Every operation is a read: directory entries, file
  contents, `git ls-files` output and git-ignore rules. There is no write path
  outside the three commands that take `--write`, and no code path that creates,
  moves or deletes a file the user did not name.
- **It spawns no shell.** The single child process it ever starts is `git
  ls-files`, called through `execFileSync` with a fixed argument array, so there
  is no `sh -c` and no command-injection surface. Configuration values, variable
  names and file contents are never interpolated into anything executable; they
  are only matched against regular expressions compiled by the tool itself, and
  a pattern that fails to compile is dropped with a warning rather than
  executed.
- **It writes only when `--write` is passed.** `envgle init --write`,
  `envgle docs --write` and `envgle fmt --write` are the only operations
  that produce a file, each writes exactly the file the command is documented to
  produce, and without the flag the command prints to stdout or reports what it
  would do. `--dry-run` exists to show the effect first. `init --write` refuses
  to overwrite an existing file and exits `2`; `docs --write` overwrites the
  path it was given, so point it at a path you own.
- **It never runs the code it reads.** The only process it starts is `git
  ls-files`, through `execFileSync` with a fixed argument list and no shell, and
  the scan continues unchanged when git is missing. Nothing imports, evaluates
  or executes a file from the project.
- **It never transmits anything.** There is no network client, no telemetry, no
  update check and no remote configuration. The only way a report leaves the
  machine is if you redirect stdout yourself, which is why the SARIF and JSON
  outputs contain no secret values in the first place. SARIF uploaded to code
  scanning contains rule ids, messages, locations and fingerprints, and nothing
  that was read out of a `.env` value.
- **Its own supply chain is empty.** The published tarball has no runtime
  dependencies, so the set of third-party code that can affect a run is empty.
  The development dependencies are `typescript` and `@types/node`.
- **The residual risk is disclosure through the report.** A `Finding` has no
  `value` field, secret-shaped values are replaced with `<redacted>` before
  formatting, and the JSON, SARIF, markdown and human formats all go through
  the same redaction. A credential that leaks is therefore always a leak from
  the repository itself, which is exactly what `secret-in-repo`,
  `secret-in-example`, `secret-fallback-literal` and
  `hardcoded-connection-string` exist to report.
