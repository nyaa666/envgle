# Contributing

envgle is a small tool with a hard constraint: it must stay free of runtime
dependencies, it must be deterministic, and it must never print a secret. Pull
requests that keep those three properties are easy to review. Anything that
trades one of them away needs a very good reason.

Issues and discussions happen on the tracker at
[github.com/nyaa666/envgle](https://github.com/nyaa666/envgle).

## Setup

Requires Node 20.11 or newer.

```bash
git clone https://github.com/nyaa666/envgle.git
cd envgle
npm ci
npm run lint
npm test
npm run dogfood
```

| Script | What it does |
| --- | --- |
| `npm run build` | Compiles `src/` and `test/` to `dist/` with `tsc`. |
| `npm run check` | Type-checks only, no emit. |
| `npm test` | Builds, then runs every compiled `dist/test/**/*.test.js` with `node --test`. |
| `npm run test:only` | Runs the test suite against the existing `dist/`, without rebuilding. |
| `npm run lint` | Runs `npm run check` and then `node scripts/check-repo.mjs`, the repository-consistency script. |
| `npm run verify` | `npm run lint` followed by `npm test`. This is the gate. |
| `npm run dogfood` | Runs `envgle scan . --fail-on error` on this repository, so a change that breaks the tool's own env hygiene fails. |

`npm run dogfood` is the one to run before opening a pull request. It is also
worth running `node dist/src/cli.js` by hand: every command in the README works
against this repository, so you can check documentation claims without inventing
a fixture.

## Layout

```text
src/
  types.ts            every shared type, declared exactly once
  version.ts          version, repository URL, rule documentation anchors
  config.ts           configuration discovery, precedence, validation
  cli.ts              argv, option parsing, exit codes
  index.ts            programmatic entry point
  utils/              text.ts, walk.ts, ignore.ts
  dotenv/             parse.ts, format.ts
  scan/               index.ts, classify.ts, code.ts, yaml.ts, compose.ts,
                      dockerfile.ts, ci.ts, git.ts, suppress.ts
  rules/              index.ts, context.ts, contract.ts, hygiene.ts,
                      security.ts, secret-patterns.ts
  report/             format.ts, json.ts, sarif.ts, markdown.ts, variables.ts
  commands/           context.ts, scan.ts, docs.ts, fmt.ts, why.ts, rules.ts,
                      usage.ts
test/                 *.test.ts, mirroring the src layout
scripts/
  check-repo.mjs      repository-consistency checks run by npm run lint
docs/                 configuration.md, rules.md, ci.md, architecture.md
```

`src/types.ts` is the contract. If two modules need the same shape, it is
declared there and imported, never redeclared. The per-file map is in
[docs/architecture.md](docs/architecture.md#module-map).

## Code style

- Two-space indentation, single quotes, semicolons, trailing commas in
  multi-line literals. `.editorconfig` and `.gitattributes` enforce the
  mechanical parts: LF endings, a final newline, no trailing whitespace, UTF-8.
- Strict TypeScript. `strict`, `noUncheckedIndexedAccess`,
  `noImplicitOverride`, `noFallthroughCasesInSwitch`,
  `noPropertyAccessFromIndexSignature`, `useUnknownInCatchVariables`,
  `verbatimModuleSyntax` and `isolatedModules` are all on. Indexing an array
  gives you `T | undefined`; handle it or use a length check.
- ESM only, with explicit `.js` extensions on relative imports. The package is
  `"type": "module"`, so `import { walkFiles } from './utils/walk.js'` is
  correct and the extensionless form will not resolve.
- `import type` for type-only imports. `verbatimModuleSyntax` will elide them
  anyway; writing them explicitly keeps the intent visible.
- `node:fs/promises` and `node:path`, not the callback or sync variants.
- **Never add a runtime dependency.** Not a small one, not a transitive helper.
  If something cannot be written in a few dozen lines of standard library code,
  it belongs in a discussion before it belongs in a pull request. The
  development dependencies (`typescript`, `@types/node`) are the complete list.
- Comments explain why, not what. A comment that restates the next line is
  noise. A comment that records a loader quirk, a precedence rule or a
  security decision is the most valuable thing in the file.
- No emojis in source, comments, commits, docs or issue text.

## Adding a rule

Full detail is in [docs/architecture.md](docs/architecture.md#how-to-add-a-rule).
The short version:

1. Add the id to the `RuleId` union in `src/types.ts`.
2. Write the `check(context)` function in `src/rules/contract.ts`,
   `src/rules/hygiene.ts` or `src/rules/security.ts`, and send every finding
   through that module's `emit` helper so suppression is applied.
3. Register the rule in the module's exported array with `id`, `title`,
   `severity`, `description`, `docs`, `remediation` and `tags`.
4. **Add a `## <id>` section to `docs/rules.md`.** This is mandatory.
   `scripts/check-repo.mjs`, which `npm run lint` runs, checks that every id in
   the `RuleId` union has a matching `## <id>` heading in that file, and fails
   the build if one is missing. A new rule with no documentation will not pass
   `npm run verify`.
5. Add tests in the matching `test/rules-*.test.ts`.
6. If the rule reads a new configuration list, add the field to
   `EnvAuditConfig` and to the table in
   [docs/configuration.md](docs/configuration.md).

A new rule also needs a changelog entry under `## [Unreleased]` in
[CHANGELOG.md](CHANGELOG.md).

## Adding a language accessor

Full detail is in
[docs/architecture.md](docs/architecture.md#how-to-add-a-language-accessor). Add
an `Extractor` entry to the accessor table in `src/scan/code.ts`, push
`EnvUsage` records through `context.push`, set the `hasFallback`, `required`,
`viaImport` and `fallbackLiteral` flags honestly, add the file extension to
`LANGUAGE_BY_EXTENSION` in `src/utils/walk.ts` if the language is new, and add
a fixture-driven test. An accessor adds no `RuleId`, so `docs/rules.md` needs no
new section.

## Tests

- `node:test` and `node:assert`, nothing else. The suite runs with
  `node --test dist/test`, so a test file must compile to `dist/test`.
- Table-driven. Build a list of cases at the top of the test and loop, rather
  than writing a near-duplicate `test(...)` per case. The rule tests already
  follow this shape; match it.
- No network. No test may reach the internet, and no test may depend on a
  package being installed beyond the development dependencies.
- No real clock. `ScanOptions` carries a `now: Date` precisely so a test can
  pass a fixed timestamp. Never call `Date.now()` in a test.
- No dependency on the machine: no absolute paths, no assumptions about the
  home directory, no reliance on the developer's git state, no writes outside
  `test/fixtures` or a temporary directory that the test creates and removes.
- Test names describe the behaviour, not the function: `duplicate-key reports
  the second assignment and names the first line` beats `test duplicate key`.
- Every rule needs at least: one case that fires, one case that must not fire
  (the interesting one is usually a near miss), and one case where
  `ignoreRules`, `ignoreVariables` or an inline suppression stops it.

Run a single file while iterating:

```bash
npm run build
node --test dist/test/rules-security.test.js
```

## Pull requests

- Branch from `main`, one topic per branch.
- Run `npm run verify` and `npm run dogfood` before pushing.
- Update the documentation your change affects: `docs/rules.md` for a new or
  reworded rule, `docs/configuration.md` for a new field,
  `docs/architecture.md` for a new module or a changed pipeline stage,
  `README.md` for a new command or flag, `CHANGELOG.md` for anything a user
  can observe.
- Say what problem the change solves, not just what it edits. A reviewer who
  has to reconstruct the motivation will ask anyway.
- Reference the issue the change closes.
- Small pull requests get reviewed quickly. Splitting a refactor from a
  behaviour change makes both halves reviewable.

### Checklist

- [ ] Tests added or updated, covering the new behaviour and one near miss.
- [ ] `npm run verify` is green.
- [ ] `npm run dogfood` is green.
- [ ] Documentation updated: `docs/rules.md` has a `## <id>` section for any new
      `RuleId`, and every other affected document is current.
- [ ] No runtime dependency added to `dependencies` in `package.json`.
- [ ] No secret, token, credential or private host name in the diff, including
      in test fixtures and example output.
- [ ] Output is deterministic: no timestamps, absolute paths or map iteration
      order in anything a test or a user might diff. The rounded `durationMs`
      in the human header and the JSON report is the one deliberate exception.
- [ ] Commit messages follow Conventional Commits.

## Commits

Conventional Commits, with a type, an optional scope, and a short imperative
summary:

```text
<type>(<scope>): <summary>
```

Types in use: `feat`, `fix`, `perf`, `refactor`, `docs`, `test`, `build`, `ci`,
`chore`. A scope is optional and names the area, for example `rules`, `scan`,
`config`, `report`, `ci`.

```text
feat(rules): report secret fallback literals in C# and Kotlin reads
fix(report): keep SARIF paths relative to the scanned root
docs(ci): add the Azure Pipelines example
test(dotenv): cover CRLF files and a BOM
```

The summary is imperative, lowercase after the type, and under 72 characters.
Explain the why in the body, wrapped at 72 columns. A `BREAKING CHANGE:`
footer is required for a change that alters output in a way a user depends on:
a removed rule, a changed default severity, a changed default configuration
value.

## Reporting a security problem

Do not open a public issue. See [SECURITY.md](SECURITY.md).
