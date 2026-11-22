# Security Policy

## Reporting

Please report vulnerabilities privately via GitHub's **Report a vulnerability** (Security → Advisories) on this repository. Do not open a public issue for security problems.

## Untrusted data

GitSphere stores and publishes metadata from public GitHub profiles and repositories. All of it is treated as untrusted:

- Only fields needed for ranking and display are persisted; homepage URLs and other free text are discarded.
- Text is sanitized: control and bidirectional-override characters are removed, lengths are bounded, and credential-shaped strings are redacted (`src/core/sanitize.js`).
- Every file write passes a guard that refuses credential-shaped content. Errors name the file and pattern, never the value.
- CI and the pipeline scan all generated files before committing (`scripts/scan-secrets.js`).

GitHub push protection and secret scanning must stay enabled. The pipeline never bypasses them.

## Incident: GH013 push protection (November 2026)

The former secondary owner-discovery workflow persisted raw repository metadata, including a third party's repository description, into `state/discovery/GH.json`. A credential-shaped string in that metadata triggered GitHub push protection (GH013). The push was blocked, so the value never reached this repository. A scan of the repository's data found no credential-shaped strings.

Remediation: the legacy owner-discovery state and workflow were removed, persisted fields were minimized, and sanitization plus a persistence guard were added with regression tests (`tests/sanitize.test.js`). The blocked string belonged to a third party's public repository on GitHub, not to this project. GitHub's secret scanning notifies providers about exposed tokens in public content. If the alert appears in this repository's Security tab, close it as *used in tests / false positive for this repository* only after confirming it is not a GitSphere credential. **Do not use the "allow secret" bypass link.**
