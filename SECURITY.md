# Security Policy

## Supported versions

envgle is pre-1.0. Security fixes land on the latest release line and on
`main`. Older lines are not patched.

| Version | Supported |
| --- | --- |
| 0.1.x | Yes |
| < 0.1 | No |

## Reporting a vulnerability

Please report security problems privately. Do not open a public issue, a public
discussion or a pull request for a vulnerability that has not been fixed yet.

Use GitHub's private reporting flow on this repository:

1. Open the repository's Security tab at
   [github.com/nyaa666/envgle/security](https://github.com/nyaa666/envgle/security).
2. Choose "Report a vulnerability".
3. Describe the problem, the version or commit you tested, the steps to
   reproduce it, and the impact you expect.

If private reporting is unavailable to you, contact the maintainer directly
through the `nyaa666` account on GitHub and ask for a private channel. Do not
put the details in a public issue.

Please do include:

- The version or commit sha.
- The command you ran and the configuration in effect, with any real values
  replaced by placeholders.
- What you expected and what happened.
- Whether a real credential is exposed. If it is, say so plainly, and say
  whether it is committed, whether it is only in a git-ignored file, and
  whether it has been rotated. That determines how urgent the response is.

Please do not include a working credential, token or password in the report.
Describe its shape instead (`ghp_` followed by 36 characters, for example) and
send the real value only if it is already compromised and you are certain it
should be rotated.

## What to expect

| Stage | Target |
| --- | --- |
| Acknowledgement that the report was received | 3 working days |
| Initial assessment and an expected timeline | 10 working days |
| Fix released, or a reason it will not be | 30 working days from the report |

These are targets for a single-maintainer project, not a service-level
agreement. If a report is accepted, the fix is released as a patch version, the
advisory is published through GitHub, and the reporter is credited unless they
prefer otherwise. Reports are published even when the impact turns out to be
limited, unless doing so would disclose something about an unpatched deployment.

A report is not a precondition for a fix. If you find a problem and fix it
yourself, a pull request is welcome; say in the description that it addresses a
security report so the disclosure history stays coherent.

## What counts as a vulnerability

envgle reads files that contain secrets, so the interesting reports are about
what the tool does with what it reads:

- A secret value appearing in any output format (human, JSON, SARIF, markdown)
  or in an error message, a warning, a stack trace or a crash dump.
- A crafted or hostile input that causes envgle to execute code, spawn a
  process, or write outside the files the active command is documented to
  produce.
- A crafted configuration, `.env` file, compose file, Dockerfile or workflow
  that makes envgle read or disclose a file outside the scanned root.
- A symlink or path handling flaw that escapes the project root, follows a link
  where it should not, or loops forever.
- A regular expression in `secretPatterns` or `secretNamePattern` that can be
  made to hang the process.
- Any network egress. envgle has none by design; finding one is always a
  report.

Not vulnerabilities:

- A false positive or a false negative in a rule. Those are bugs, and belong in
  the issue tracker.
- A credential that is committed to the repository. That is what the
  `secret-in-repo`, `secret-in-example`, `secret-fallback-literal` and
  `hardcoded-connection-string` rules are for, and the correct response is to
  rotate the credential.
- A finding that reveals a value the user explicitly asked to print, for
  example a value in a `.env` file the user committed.
- Denial of service through an enormous repository, unless it is achievable with
  a small input that a normal project would contain.

## What envgle never does

These are design properties, not promises contingent on a configuration:

- **It never transmits findings or values anywhere.** envgle contains no
  network client, no telemetry, no update check and no remote configuration. No
  finding, no variable name, no fingerprint and no file content leaves the
  machine. The only way a report travels is if you redirect stdout yourself, and
  the outputs contain no secret values to begin with.
- **It only reads files.** It creates, moves and deletes nothing except the file
  the active command is documented to write, and only when `--write` is passed.
- **It spawns no process.** There is no shell, no `sh -c` and therefore no
  command-injection surface. File contents and configuration values are matched
  against regular expressions and never interpolated into anything executable.
- **It has no runtime dependencies.** The published package is plain JavaScript
  with an empty `dependencies` map, so there is no third-party code in the path
  between your files and the report.

See the threat model in
[docs/architecture.md](docs/architecture.md#threat-model-for-the-tool-itself)
for the detail behind each of these.
