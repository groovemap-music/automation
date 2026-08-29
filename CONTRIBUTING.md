# Contributing

Thank you for helping improve GrooveMap automation. Changes should keep reusable behavior
repository-neutral, explicit, and testable.

## Before opening a change

1. Discuss substantial interface or permission changes before implementation.
2. Install the pinned tool versions with `mise install`.
3. Add or update contract tests for observable workflow or action behavior.
4. Run `just check` from a clean checkout.
5. Explain compatibility, permission, and caller migration effects in the change description.

Every external `uses:` reference must use a full 40-character commit revision. Reusable inputs,
outputs, permissions, required secrets, and failure behavior must be documented alongside their
implementation. Do not weaken validation for dependency-update pull requests.

## Public-safe contributions

Use reserved example domains, synthetic identifiers, and fabricated fixtures. Do not contribute
credentials, organization secrets, private network locations, customer or incident data,
deployment instructions, private runbooks, or raw planning material. Follow [SECURITY.md](SECURITY.md)
for vulnerability reports instead of opening a public issue.

Contributions accepted into this repository are licensed under its [MIT License](LICENSE).
