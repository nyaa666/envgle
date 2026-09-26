# Pull request

> Fill in every section. Delete this line and any guidance you do not need.

## What this changes

> One or two sentences on the problem this solves. A reviewer should be able to
> read this and understand the motivation without opening the diff. If the
> change is driven by an issue, reference it here.

## How it was tested

> Which commands you ran, and what a reviewer should run to see the same
> result. For a new rule, name the test file and the cases you added. For a
> behaviour change, say what you checked by hand: a real repository, a fixture,
> or both.

```bash
npm run verify
npm run dogfood
```

## Checklist

- [ ] Tests added or updated, including at least one negative case for new rules.
- [ ] `npm run verify` passes.
- [ ] `npm run dogfood` passes.
- [ ] Documentation updated. A new `RuleId` has a matching `## <id>` section in
      `docs/rules.md`; a new configuration field is in the table in
      `docs/configuration.md`; a new accessor or pipeline stage is reflected in
      `docs/architecture.md`; a new command or flag is in `README.md`.
- [ ] `CHANGELOG.md` has an entry under `## [Unreleased]`.
- [ ] No runtime dependency added to `dependencies`.
- [ ] No secret, token, credential or private host name anywhere in the diff,
      including test fixtures and example output.
- [ ] Output stays deterministic: no timestamps, absolute paths or map
      iteration order in anything a user might diff.

## Notes for the reviewer

> Optional. Anything that deserves extra attention: a decision you were unsure
> about, a false-positive trade-off you made, a case you deliberately did not
> handle.

## Commit messages

> This project follows Conventional Commits: `type(scope): summary`, with the
> summary imperative, lowercase after the type, and under 72 characters. Explain
> the why in the body. Add a `BREAKING CHANGE:` footer for anything that alters
> output a user depends on. See `CONTRIBUTING.md` for the full list.
