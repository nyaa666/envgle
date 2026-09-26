# CI integration

envgle is a plain Node CLI, so any CI system that can run `node` can run it.
Two things matter in a pipeline: the exit code, which decides pass or fail, and
the output format, which decides what humans and machines see.

Exit codes:

| Code | Meaning |
| --- | --- |
| `0` | Nothing was reported at or above `--fail-on`. |
| `1` | At least one finding at or above `--fail-on`. |
| `2` | A usage error: an unknown flag, an unknown rule id, a bad flag value, a missing argument, or a refused write (`envgle init --write` will not overwrite an existing file). Nothing was scanned. A config file that cannot be read or that contains something invalid is a warning, not exit `2`. |

Because a usage error is a hard `2`, a CI job that fails with `2` is a bug in
the invocation, not a finding in the code. Re-run the step with `--verbose` and
`--no-color` to see the resolved configuration, its warnings and the per-file
decisions before you go looking in the repository.

## GitHub Actions

### Blocking, with code scanning

This is the recommended setup: it blocks the pull request and uploads SARIF so
findings also appear in the Security tab with inline annotations.

```yaml
name: envgle

on:
  pull_request:
  push:
    branches: [main]

permissions:
  contents: read

concurrency:
  group: envgle-${{ github.ref }}
  cancel-in-progress: true

jobs:
  envgle:
    name: envgle (node ${{ matrix.node }})
    runs-on: ubuntu-latest
    permissions:
      contents: read
      security-events: write
    strategy:
      fail-fast: false
      matrix:
        node: ['20', '22', '24']
    steps:
      - name: Check out the repository
        uses: actions/checkout@v4

      - name: Set up Node.js
        uses: actions/setup-node@v4
        with:
          node-version: ${{ matrix.node }}
          cache: npm

      - name: Install
        run: npm ci

      - name: Audit environment variables
        run: npx envgle scan . --format sarif > envgle.sarif

      - name: Upload SARIF
        if: always() && matrix.node == '20'
        uses: github/codeql-action/upload-sarif@v3
        with:
          sarif_file: envgle.sarif
          category: envgle

      - name: Print the human report
        if: always()
        run: npx envgle scan .
```

The audit step exits `1` when there is a finding at or above `--fail-on`, which
fails the job, so the upload needs `if: always()` to run at all. The result is
the behaviour you want: the findings reach code scanning and the pull request
still goes red. `matrix.node == '20'` keeps the upload to one job, since running
the same SARIF into several categories only produces duplicates.

The upload step needs `security-events: write`, which is why the job above
redeclares permissions. The workflow-level `permissions: contents: read` does
not include it, and without it the upload fails with a permissions error and
nothing appears in the Security tab. If several jobs upload, grant the
permission once at workflow level:

```yaml
permissions:
  contents: read
  security-events: write
```

If your repository is private on a plan without code-scanning upload, or you
simply do not want the Security tab involved, drop the upload step and keep only
the run step: the exit code alone is enough to gate the build.

### Non-blocking, as a pull request comment

Use this when you want visibility before you are ready to block. The job always
succeeds, and the findings are posted as a markdown job summary and as a comment
on the pull request.

```yaml
name: envgle-report

on:
  pull_request:

permissions:
  contents: read
  pull-requests: write

jobs:
  report:
    name: envgle report
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - uses: actions/setup-node@v4
        with:
          node-version: '22'
          cache: npm

      - run: npm ci

      - name: Produce the markdown report
        run: npx envgle scan . --format markdown > envgle.md || true

      - name: Add to the job summary
        if: always()
        run: cat envgle.md >> "$GITHUB_STEP_SUMMARY"

      - name: Comment on the pull request
        if: always()
        uses: actions/github-script@v7
        with:
          script: |
            const fs = require('fs');
            const body = fs.readFileSync('envgle.md', 'utf8');
            const marker = '<!-- envgle -->';
            const { owner, repo } = context.repo;
            const { number: issue_number } = context.issue;
            const comments = await github.rest.issues.listComments({
              owner,
              repo,
              issue_number,
            });
            const existing = comments.data.find((c) => c.body?.includes(marker));
            const payload = `${marker}\n${body}`;
            if (existing) {
              await github.rest.issues.updateComment({
                owner,
                repo,
                comment_id: existing.id,
                body: payload,
              });
            } else {
              await github.rest.issues.createComment({
                owner,
                repo,
                issue_number,
                body: payload,
              });
            }
```

`|| true` on the scan step is deliberate: the report is the artefact, and the
comment is what should be published even when findings exist. The
`if: always()` on the later steps keeps the comment in place after a failing
scan. To block as well, add `npx envgle scan .` as a final step and let its
exit code fail the job.

### Which triggers to use

- `pull_request` is where the value is: findings arrive while the change is
  still being discussed, and the SARIF upload annotates the diff. This is the
  trigger to start with.
- `push` on the default branch catches problems introduced outside a pull
  request, such as a direct push to a hotfix branch, a `.env` file added
  outside review, or a workflow edited by an automation. Keep it, and keep it on
  the default branch only so a busy repository does not run the job twice per
  commit.
- `schedule` is useful for the opposite direction: re-running after a
  dependency or a config change exposes new findings in code nobody touched.
  Findings do not decay on their own, so a nightly run mostly buys you
  notification about newly-introduced patterns in files that were not modified.
- Do not trigger on every tag or every branch by default. Narrow it with a path
  filter if your pipeline is slow:

```yaml
on:
  pull_request:
    paths:
      - '**/.env*'
      - '**/docker-compose*.yml'
      - '**/Dockerfile*'
      - '.github/workflows/**'
      - '**/*.{js,jsx,ts,tsx,mjs,cjs,py,go,rs,java,kt,cs,rb,php,pl,sh,bash,bat,cmd,swift,dart,ex,exs}'
```

## GitLab CI

```yaml
envgle:
  image: node:22-alpine
  stage: test
  script:
    - npm ci
    - npx envgle scan . --format sarif > envgle.sarif || test $? -eq 1
    - npx envgle scan . --format markdown > envgle.md || true
  artifacts:
    when: always
    paths:
      - envgle.sarif
      - envgle.md
    expire_in: 1 week
```

`test $? -eq 1` is needed because GitLab treats exit code `1` as an
infrastructure error rather than a test failure. Exit code `0` and `1` both let
the job continue, so the artifacts are uploaded either way; any other code, `2`
in particular, still fails the job.

The GitLab SAST report schema is not SARIF, so `reports: sast:` cannot consume
`envgle.sarif` directly. Keep the report as a job artifact, as above, or
convert it to the GitLab schema in a small script if you need the Security
dashboard. To annotate the merge request diff instead, post `envgle.md`
yourself with the API:

```yaml
envgle:
  image: node:22-alpine
  stage: test
  script:
    - npm ci
    - npx envgle scan . --format markdown > envgle.md || true
    - |
      if [ -n "$CI_MERGE_REQUEST_IID" ]; then
        body=$(cat envgle.md)
        curl --silent --fail --request POST \
          --header "PRIVATE-TOKEN: $CI_JOB_TOKEN" \
          --form "body=$body" \
          "https://gitlab.com/api/v4/projects/$CI_PROJECT_ID/merge_requests/$CI_MERGE_REQUEST_IID/notes"
      fi
```

To gate the pipeline on the exit code alone, which is all most projects need:

```yaml
envgle:
  image: node:22-alpine
  stage: test
  script:
    - npm ci
    - npx envgle scan .
```

## Azure Pipelines

```yaml
trigger:
  - main

pool:
  vmImage: ubuntu-latest

steps:
  - task: NodeTool@0
    inputs:
      versionSpec: '22.x'
    displayName: Set up Node.js

  - script: npm ci
    displayName: Install

  - script: npx envgle scan . --format sarif > "$(Build.ArtifactStagingDirectory)/envgle.sarif"
    displayName: Audit environment variables
    continueOnError: false

  - task: PublishBuildArtifacts@1
    inputs:
      PathtoPublish: $(Build.ArtifactStagingDirectory)
      ArtifactName: envgle
    displayName: Publish the SARIF report
```

`continueOnError: false` keeps a finding at or above `--fail-on` from turning
the pipeline red. The default `--fail-on error` applies; add `--fail-on warn`
to fail on warnings as well.

## CircleCI

```yaml
version: 2.1

jobs:
  envgle:
    docker:
      - image: cimg/node:22.0
    steps:
      - checkout
      - run:
          name: Install
          command: npm ci
      - run:
          name: Audit environment variables
          command: npx envgle scan .

workflows:
  audit:
    jobs:
      - envgle
```

## Pre-commit hook

To catch the same problems before they are pushed, wire the CLI into a
`pre-commit` framework. The `files` pattern below decides whether the hook runs
at all, which keeps it from firing on a commit that touches nothing relevant.

```yaml
# .pre-commit-config.yaml
repos:
  - repo: local
    hooks:
      - id: envgle
        name: envgle
        entry: npx --no-install envgle scan
        language: system
        types: [text]
        pass_filenames: false
        files: '(\.env|docker-compose|Dockerfile|\.ya?ml)$'
```

With `pass_filenames: false` the hook runs on its own and scans the working
tree, which is what the cross-file rules such as `missing-in-env` and
`prod-crash` need: they cannot be decided from a single file. To pass the staged
paths instead, set `pass_filenames: true`; the run is then faster but misses
every finding that depends on the whole tree, so it is a poor trade for this
tool. `pre-commit run --all-files` bypasses the `files` pattern and audits
everything, which is the right thing to do in a dedicated audit job rather than
on every commit.

## Reduce noise on a legacy repository

A repository that has never been audited will produce a large report on the
first run. Landing all of it in one commit is not a realistic way to adopt a
linter. The approach that works is a baseline plus a shrinking suppression list.

Step 1: see the whole picture without failing the build.

```bash
envgle scan . --fail-on none --format markdown > envgle-baseline.md
```

Step 2: silence the rules that describe debt you are not paying off this week,
in the repository's config file so the choice is reviewable.

```json
{
  "ignoreRules": [
    "missing-from-example",
    "example-out-of-sync",
    "unused-variable",
    "framework-prefix-mismatch",
    "export-prefix"
  ],
  "requireExampleFile": false
}
```

Step 3: silence the names you do not control, with globs rather than a list of
individual names.

```json
{
  "ignoreVariables": [
    "GITHUB_*",
    "CI_*",
    "npm_package_*",
    "NPM_*",
    "**/legacy-integration.env"
  ]
}
```

Step 4: keep the security rules unsuppressed from the start. They are the reason
to adopt the tool, and they are the rules whose findings are cheap to act on.

Step 5: in CI, keep the blocking job strict even while the local profile is
lenient, so a pull request that introduces a new secret fails immediately while
the existing debt stays visible.

```bash
# Local: readable, never blocks.
envgle scan --fail-on none

# CI: blocks on errors, all 28 rules enabled except the baseline suppressions.
envgle scan . --fail-on error --format sarif > envgle.sarif
```

Step 6: shrink the list. Every entry in `ignoreRules` is a piece of debt with an
owner. Remove one per week and the report gets shorter on its own. The same
applies on the command line: `--ignore-rule unused-variable` is useful for one
investigation, but the same suppression belongs in the config file if it is
going to be there next month.

An `--ignore-var` glob is a blunt instrument: it silences every rule for that
name. Prefer `ignoreRules` for "this rule is not relevant here" and
`ignoreVariables` only for "this name is not ours".

## Troubleshooting

| Symptom | Cause | Fix |
| --- | --- | --- |
| A finding looks wrong, or a value is `undefined` where you expect one | A read with no fallback is treated as required, so a variable declared only in a dev-only file is reported by `prod-crash` and the process will indeed see it as undefined in production. | Decide which is true. If the code genuinely handles the absence, give the read an explicit default. If the variable is required, declare it in the shared env file and in the example file. |
| `missing-in-env` fires for a variable your build injects | The injection is not visible in the repository: it comes from the CI runner, the platform, or a bundler at build time. | Add the name to `ignoreVariables` (for example `GITHUB_*`), or map the CI environment with `ciEnvironmentKinds`. Names the scanner knows to be ambient, such as `PATH`, `HOME`, `TERM`, `NO_COLOR`, `NODE_ENV`, `CI`, `GITHUB_ACTIONS` and `RUNNER_TEMP`, are already exempt and never fire. |
| Files are skipped and the report says `gitignore` | `.gitignore` rules prune directories during the walk, so a whole ignored directory such as `node_modules` or `build` is never entered. Individual files are not filtered by `.gitignore`: a git-ignored `.env.local` is still read and analysed, and is reported with `committed: false`, which is why `secret-in-repo` drops to `warn` in it. | If the file you expected is inside an ignored directory, pass `--no-gitignore` to stop honouring `.gitignore` when pruning directories. Only do this on a machine you control: the point of a git-ignored directory is that its contents are not in the repository. |
| Files are skipped and the report says `symlink` | Symbolic links are not followed by default. | Set `"followSymlinks": true` in the config, understanding that the tool will then read outside the project root. |
| Files are skipped and the report says `too-large` | The file is larger than `maxFileSizeKb`, which defaults to `64`. | Raise `maxFileSizeKb`, or ignore the file. Most often this is a generated bundle that should be excluded anyway. |
| Nothing is scanned in a monorepo package | The config was discovered in a parent directory, and `include` in that config does not cover the package's paths. | Run from the repository root, or pass `--config` with a config whose `include` matches the package. |
| Duplicate findings for the same variable in every package | Each package is scanned on its own and each has its own `.env`. | Scan the repository root once, with `include` covering every workspace, instead of one run per package. |
| SARIF does not appear in the Security tab | The uploading job has no `security-events: write` permission. | Add `permissions: security-events: write` to the job, or to the workflow when only one job uploads. |
| SARIF upload fails with a permissions error on a private repository | Code-scanning upload is not available for the repository's plan. | Keep the run step, drop the upload step. The exit code still gates the build. |
| SARIF upload fails with "not a valid category" | The category already exists for this workflow. | Change the `category` input, or omit it so the workflow filename is used. |
| `npm ci` fails in CI but works locally | The lockfile is out of date with `package.json`. | Run `npm install` locally and commit the updated `package-lock.json`. |
| Exit code `2` with no findings printed | A usage error: unknown flag, unknown rule id, bad flag value, missing argument, or a refused `--write`. | Read stderr. It names the offending flag. Nothing was scanned. An unreadable or invalid `--config` is reported as a warning under `--verbose` and the run continues on the defaults instead. |
| Exit code `0` even though the report has findings | The threshold is above them: `failOn` is `none` in the config or `--fail-on none` was passed, or the finding is suppressed by `ignoreRules`, `ignoreVariables`, `ignoreFingerprints` or an inline comment. | Check `failOn` in the config and the `--fail-on` flag, then re-run with `--verbose` to see which suppressions applied. |
| The build failed and you cannot see why | Colour codes and grouping obscure the log. | Add `--no-color` and `--verbose` to the CI step. |
| A finding is suppressed locally but not in CI | The config found by the upward search differs between the two, because the working directories differ. | Pass `--config` explicitly in CI, or run the same path in both. |
