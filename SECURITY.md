# Security policy

## Reporting a vulnerability

Do not open a public issue for a suspected vulnerability. Use the repository's
[private vulnerability reporting form](https://github.com/groovemap-music/automation/security/advisories/new)
and include the affected interface, impact, and a minimal synthetic reproduction.

Do not include organization credentials, live endpoints, customer information, production logs,
or unrelated repository data. If the private form is unavailable, wait for a maintainer-approved
private reporting channel rather than disclosing the issue publicly.

## Supported versions

Security fixes target the current default branch and immutable revisions explicitly identified by
maintainers. Callers remain responsible for updating their pinned automation revision after a fix.

## Automation security boundary

Reusable workflows use least-privilege permissions and declare required secrets explicitly.
Repository validation remains credential-free. Security enforcement and optional hosted-report
upload are separate capabilities; missing upload credentials must never disable local enforcement.
