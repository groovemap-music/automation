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
- `coverage-files`: newline-separated, explicit repository-relative report paths retained as a
  repository-named artifact. Empty entries, duplicates, globs, commas, absolute paths, parent
  traversal, trailing slashes, non-canonical paths, and a leading `!` are rejected before retention
  or upload. A
  leading `!` would be interpreted as an exclusion by artifact upload; `!` remains valid elsewhere
  in an otherwise canonical literal path.

`integration-command` and `image-command` are optional only when that repository has no matching
surface. Browser repositories also provide `e2e-command` and the matching `e2e-post-command`;
dependency setup and JavaScript instrumentation use the optional `e2e-setup-command` and
`e2e-instrument-command`. Post-processing and teardown run with `always()` after failed E2E or
integration execution, and coverage retention and optional Codecov upload do the same. These
evidence steps cannot turn a failed validation green: the aggregate `Required result` job remains
fail-closed.

Artifact retention consumes `coverage-files` with its newline-separated shape intact. After
validation, the workflow deterministically joins the same ordered paths with commas for Codecov's
`files` input. Callers therefore declare one canonical path list without relying on Codecov to
interpret a multiline scalar or on artifact upload to interpret comma-separated paths. Automatic
Codecov report search is disabled, so the generic upload contains exactly that validated comma
list even when browser reports are also present in the workspace.

Browser repositories that upload coverage also provide `browser-coverage-mapping` as a JSON array.
Every entry contains exactly `project`, `lcov`, and `artifacts`:

- `project` is a unique lowercase browser-project slug. Codecov receives exactly one flag derived
  as `e2e-<project>`;
- `lcov` is one unique, explicit repository-relative `.info` or `.lcov` file. Newlines, commas,
  globs, absolute paths, parent traversal, trailing slashes, non-canonical whitespace, and an
  exclusion-prefixed leading `!` are rejected; and
- `artifacts` is a nonempty array of unique, explicit repository-relative directories or files
  containing that project's traces, screenshots, videos, raw coverage, or other failure evidence.
  The same canonical literal-path rules apply, including rejection of a leading `!` while allowing
  `!` in later path segments.

The reusable workflow validates the complete mapping before browser execution and builds one
deterministic retained-path list: generic `coverage-files` first, then each project's LCOV file and
failure-artifact paths in mapping order. A path present in more than one category is retained once;
duplicate projects, duplicate mapped LCOV files, and duplicate mapped failure paths remain invalid.
It copies each existing declaration beneath a single temporary `workspace/` payload while retaining
the complete repository-relative path and records the ordered declarations in a manifest. The
artifact uploader receives that one staging root, so its least-common-ancestor normalization cannot
strip a leading path segment such as `coverage/`. Each browser matrix job downloads the root and
reconstructs the payload beneath its clean workspace before verifying that its exact mapped LCOV
path is a regular file. Although reconstruction restores every retained report for deterministic
evidence, automatic Codecov report search remains disabled and each matrix upload sends only its
one mapped LCOV under its one `e2e-<project>` flag.

Staging and reconstruction reject symlinks, paths that escape the workspace, undeclared payload
entries, duplicate manifest paths, and destination collisions. This keeps sequential browser runs
isolated: callers must write each project's failure evidence only beneath that project's mapped
paths and must not clear an earlier project's paths when starting the next project. An empty JSON
array, malformed project, newline, glob, or former multi-flag shape fails before upload. Omitting the
input remains supported for non-browser callers.

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
      browser-coverage-mapping: >-
        [{"project":"chromium","lcov":"coverage/e2e/chromium/lcov.info","artifacts":["test-results/chromium","coverage/e2e/raw/chromium"]},
        {"project":"firefox","lcov":"coverage/e2e/firefox/lcov.info","artifacts":["test-results/firefox","coverage/e2e/raw/firefox"]}]
      coverage-files: |
        coverage.xml
        explore/coverage/lcov.info
        coverage/e2e/lcov.info
      coverage-flags: python,javascript,e2e,explorer
      upload-codecov: true
    secrets:
      CODECOV_TOKEN: ${{ secrets.CODECOV_TOKEN }}
```

When E2E is enabled, `e2e-post-command` is mandatory and should be safe to invoke after partial
setup or a failed test. It owns Istanbul report generation and any teardown required to flush
browser coverage. The retained artifact step uses `if-no-files-found: error`, so losing both the
ordinary and browser reports is visible even when an earlier command has already failed.
Mapped project LCOV files and failure directories are added to that retained artifact automatically;
they do not need entries in `coverage-files`. If a mapped LCOV is also a generic coverage report,
the retained-path union includes it only once while the generic Codecov upload still receives it.

Repositories that require the private library map the client ID, revision, and secret explicitly.
Infrastructure owns creating those values and making them available to dependency-update runs; if
that rollout is incomplete, those runs fail visibly with the full graph intact.

## Tag release

`.github/workflows/reusable-release.yml` refuses every event except a pushed `v`-prefixed version
tag and rejects a `repository-name` that differs from the caller. The caller's `release-command`
must build from its lock file and produce the declared artifact set, `SHA256SUMS`, locked dependency
notice, and CycloneDX SBOM. The workflow verifies every checksum, retains a repository-and-version
named artifact, and creates a GitHub build-provenance attestation. A caller that invokes the
workflow once keeps the stable `<repository-name>-<version>` artifact name. A caller with multiple
release jobs for the same tag must give each job a distinct `artifact-variant`; the resulting name
is `<repository-name>-<version>-<artifact-variant>`. Variants are lowercase hyphen-separated slugs,
so unsafe or path-like values fail before release work begins.

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

For example, parallel `primary` and `performance` jobs supply `artifact-variant: primary` and
`artifact-variant: performance`. They retain distinct artifacts while a repository with one release
job omits the input and preserves its existing artifact name.

Repository workflows must not add scheduled publication or an unversioned image tag around this
interface.

## Composite actions

`.github/actions/setup-tools` installs the caller's `.mise.toml` toolchain using the pinned mise
action and its cache. `.github/actions/validate-python-policy` applies GrooveMap's shared Python
configuration policy with Python standard-library code. Callers reference either action through
the same full-SHA `groovemap-music/automation` path; reusable workflows inline their small setup
step so they do not contain a mutable self-reference.
