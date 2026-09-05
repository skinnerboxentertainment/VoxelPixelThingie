# Security

This is a rendering model with no network surface, no credentials, and no
user data. The realistic risks are supply chain: a compromised dependency or
GitHub Action.

Mitigations in place: Dependabot on npm and Actions, CodeQL on push and PR,
secret scanning with push protection, a committed lockfile installed with
`npm ci`, and pinned major versions on every Action.

To report a problem, open a GitHub issue. If it should not be public, use
GitHub's private vulnerability reporting on this repository.
