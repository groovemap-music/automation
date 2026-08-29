# Reusable interfaces

Caller repositories own build semantics. This repository owns orchestration, immutable action
selection, permission boundaries, retained evidence, and failure behavior. Every caller must pin
the selected workflow or action to a reviewed forty-character commit SHA.

## Pull-request CI

`.github/workflows/reusable-ci.yml` exposes one `validate` job and one aggregate `result` job. The
graph never branches on the actor or event type, so a Dependabot pull request runs the same format,
lint, type, test, coverage, contract, dependency-audit, license, secret-scan, package, install,
integration, and container commands as an ordinary pull request. Optional integration and image
steps are repository capabilities, not actor-specific fallbacks.

The caller must provide these nonblank inputs:

- `language`: `python`, `rust`, `node`, or `mixed`;
- `setup-command`: install only locked dependencies;
- `check-command`: authoritative format, lint, type, test, and contract checks;
- `coverage-command`: generate the declared XML or LCOV coverage report;
- `audit-command`, `license-command`, and `secret-scan-command`: security gates;
- `package-command` and `install-command`: build and installed-artifact smoke test; and
- `coverage-files`: reports retained as a repository-named artifact.

`integration-command` and `image-command` are optional only when that repository has no matching
surface. Browser repositories also provide `e2e-command` and the matching `e2e-post-command`;
dependency setup and JavaScript instrumentation use the optional `e2e-setup-command` and
`e2e-instrument-command`. Post-processing and teardown run with `always()` after failed E2E or
integration execution, and coverage retention and optional Codecov upload do the same. These
evidence steps cannot turn a failed validation green: the aggregate `Required result` job remains
fail-closed.

Private Python-library access requires all three explicit inputs: `requires-private-library: true`,
`private-library-client-id`, and an immutable `private-library-revision`, plus the
`PRIVATE_LIBRARY_PRIVATE_KEY` secret. Missing credentials or an invalid revision fails before
setup. The checkout is `${GITHUB_WORKSPACE}/python-libraries`, matching the root path excluded by
consumer `.gitignore` and `.dockerignore` files. There is no source-only or dependency-update
fallback.

A thin caller has this shape; the revision is deliberately synthetic and must be replaced by the
reviewed automation commit:

```yaml
name: CI

on:
  pull_request:
  push:
    branches: [main]

jobs:
  required:
    uses: groovemap-music/automation/.github/workflows/reusable-ci.yml@0123456789abcdef0123456789abcdef01234567
    with:
      language: mixed
      setup-command: just setup
      check-command: just check
      coverage-command: just test
      audit-command: just audit
      license-command: just license-check
      secret-scan-command: just source-check
      package-command: just build
      install-command: just install-check
      e2e-setup-command: uv run playwright install --with-deps chromium
      e2e-instrument-command: node explore/scripts/instrument-coverage.mjs
      e2e-command: just e2e
      e2e-post-command: node explore/scripts/generate-coverage-report.mjs
      coverage-files: |
        coverage.xml
        explore/coverage/lcov.info
```

When E2E is enabled, `e2e-post-command` is mandatory and should be safe to invoke after partial
setup or a failed test. It owns Istanbul report generation and any teardown required to flush
browser coverage. The retained artifact step uses `if-no-files-found: error`, so losing both the
ordinary and browser reports is visible even when an earlier command has already failed.

Repositories that require the private library map the client ID, revision, and secret explicitly.
Infrastructure owns creating those values and making them available to dependency-update runs; if
that rollout is incomplete, those runs fail visibly with the full graph intact.

## Tag release

`.github/workflows/reusable-release.yml` refuses every event except a pushed `v`-prefixed version
tag and rejects a `repository-name` that differs from the caller. The caller's `release-command`
must build from its lock file and produce the declared artifact set, `SHA256SUMS`, locked dependency
notice, and CycloneDX SBOM. The workflow verifies every checksum, retains a repository-and-version
named artifact, and creates a GitHub build-provenance attestation.

When `publish-image` is true, the image is
`ghcr.io/<owner>/<repository-name>` or `ghcr.io/<owner>/<repository-name>-<image-variant>`. Only the
version tag is emitted. The build receives the commit-derived build date, revision, and version,
and emits BuildKit SBOM/provenance plus a registry provenance attestation. The reusable release has
no branch, schedule, floating tag, or unversioned publication path.

The caller is intentionally small:

```yaml
name: Release

on:
  push:
    tags: ["v*"]

jobs:
  release:
    uses: groovemap-music/automation/.github/workflows/reusable-release.yml@0123456789abcdef0123456789abcdef01234567
    with:
      repository-name: catalog-api
      setup-command: just setup
      check-command: just check
      release-command: just release-dry-run
      artifact-path: |
        dist/*.whl
        dist/SHA256SUMS
        dist/THIRD_PARTY_NOTICES.json
        dist/sbom.json
      publish-image: true
    permissions:
      attestations: write
      contents: read
      id-token: write
      packages: write
```

Repository workflows must not add scheduled publication or an unversioned image tag around this
interface.

## Composite actions

`.github/actions/setup-tools` installs the caller's `.mise.toml` toolchain using the pinned mise
action and its cache. `.github/actions/validate-python-policy` applies GrooveMap's shared Python
configuration policy with Python standard-library code. Callers reference either action through
the same full-SHA `groovemap-music/automation` path; reusable workflows inline their small setup
step so they do not contain a mutable self-reference.
