# Signed Codecov CLI preparation

Mandatory coverage uploads use the existing SHA-pinned Codecov action, with an isolated CLI
verified before installation. Neither TLS verification nor upload failures are optional.

The official historical release is `codecov-cli==11.2.2`. Its SHA-256 is
`6fb5cca1cd92423c568293cc41ddf548ee6fe994f5001533567de3ff6ac46bee` and its signed publisher is
`https://github.com/getsentry/prevent-cli/.github/workflows/release-codecov-cli.yml@refs/tags/v11.2.2`.
The current official Codecov repository retains that tag and source
`8b09705f696b4e363c67e321f975c505b5991337`. This is an exact historical publisher policy, not a
wildcard or third-party fork. The authenticated certificate binds that source, repository,
tag and `release` event. Its publish-environment claim is absent and PyPI's publisher environment
is null; preparation rejects a different environment rather than inventing one.

A pinned `pypi-attestations==0.0.30` / `sigstore==4.5.0` verifier uses the supported public API,
production Fulcio/Rekor/TUF trust, and an exact GitHub Actions OIDC identity. Download errors,
unavailable trust or provenance, malformed/tampered signatures or statements, and mismatched
artifact/publisher/source/ref/event/environment stop before uploader installation. The CLI's
hash-locked dependencies are installed separately, with binary-only distributions, into its own
virtual environment. No project dependency or global environment is changed.

Use Linux **Python 3.12**: the official CLI's parser dependency lacks a Python 3.14 wheel. The
workflow selects `/usr/bin/python3.12` independently of the caller's project toolchain. Hash locks
are resolved for Linux/Python 3.12 and audited without exclusions. The historical release accepts
Click 8.5.0; release 11.3.1 instead excludes the security fix for its Click dependency.

Click's changed default handling loses automatic SHA and other metadata fallbacks. The workflow
therefore supplies supported action overrides from the actual checked-out Git HEAD and GitHub
event: branch, repository, git service, run ID/URL and actual PR number. Unit and browser files,
flags, tokens, `disable_search` and `fail_ci_if_error` retain their existing meaning. Browser jobs
receive the same actual checkout SHA as the validation job; it is not inferred from an unrelated
workflow SHA. Tokenless fixtures demonstrate parsing and coverage collection only; required
consumer PR and pushed-main jobs must prove actual signed uploads.

Source-owned preparation assets are fetched at a fixed immutable automation ancestor revision
and each is checked against a workflow-embedded SHA-256 before execution. Caller checkout files
cannot replace these helpers or locks. Temporary source/verifier/CLI directories are owned,
isolated and removed on every successful or failed job path. Preparation never uploads coverage;
only the existing pinned action runs the verified CLI afterward. No new action, organization
policy change, tag, release or deployment is involved.

`just check` exercises synthetic, credential-free failure and interface fixtures. Public signed
artifact verification, Linux installation and dependency audit are separate evidence; local
fixtures do not substitute for actual required hosted uploads.
