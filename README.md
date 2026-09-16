# GrooveMap automation

`automation` is the public source of reusable GitHub Actions workflows and composite
actions for GrooveMap repositories. It provides a complete pull-request gate for Python, Rust,
Node, mixed, container, coverage, security, package, and install checks, plus an attested
tag-release path. Callers select their repository-owned commands and consume these interfaces at
immutable full commit revisions.

The maintained contract and its local evidence are summarized in [contract status](docs/readiness.md).
Repository visibility is an operator-controlled concern; validation and release-contract tests do
not change it.

## Development

Install the pinned tools, then run the complete credential-free gate:

```bash
mise install
just check
```

`just check` uses only Node.js and Python standard-library APIs. It validates syntax, runs behavior
tests, checks Markdown links, verifies legal and governance files, enforces immutable action
references, checks Dependabot coverage, and scans the current tree for common private-material
patterns. It does not access organization secrets, call GitHub APIs, publish artifacts, or change
external state.

Python callers can also pin the credential-free
[`validate-database-fixtures`](docs/interfaces.md#composite-actions) composite action to reject new
unspecced Neo4j and PostgreSQL pytest fixtures before running their repository-owned `just check`.

## Release image build caching

`.github/workflows/reusable-release.yml` accepts an optional `buildkit-cache-mounts` input: a JSON
object mapping each BuildKit cache-mount id to its absolute container path. A BuildKit cache mount
is builder-local and a hosted runner starts with an empty builder, so the mapped directories are
restored from the Actions cache before the image build and saved after it.

```yaml
      publish-image: true
      dockerfile: Dockerfile
      buildkit-cache-mounts: |
        {
          "sccache-cache": "/root/.cache/sccache",
          "cargo-registry": "/usr/local/cargo/registry"
        }
```

Each id becomes the workspace directory `.buildkit-cache/<id>` and each value must match the
`--mount=type=cache,target=` path in the caller's Dockerfile. The cache key is
`buildkit-mounts-<ids>-<image-name>-<runner>-<dockerfile-hash>`, where `<ids>` are the sorted mount
ids, `<image-name>` is the resolved image name (including any `image-variant` suffix), and
`<runner>` is `inputs.runner` lowercased with every run of non-alphanumeric characters collapsed to
a single hyphen (for example `ubuntu-24.04` becomes `ubuntu-24-04`). The matching restore-keys
prefix is `buildkit-mounts-<ids>-<image-name>-<runner>-`, so a compile layer is reused until the
Dockerfile changes, but two callers that differ only in `image-variant` or `runner` never share or
collide over the same cache entry. Extraction is skipped on an exact key hit because the stored
cache already matches that Dockerfile. Callers should exclude `.buildkit-cache/` from their Docker
build context.

The input is empty by default. `publish-image` builds that omit it keep their existing behaviour:
no cache step, no injection step, and the same `type=gha` layer cache as before.

## Rust compiler cache

Callers that build Rust get the `sccache` compiler cache backed by the GitHub Actions cache, so a
pull request recompiles only the crates it changed. `reusable-ci.yml` installs the pinned
`mozilla-actions/sccache-action`, exports `RUSTC_WRAPPER=sccache` and `SCCACHE_GHA_ENABLED=true`
before the caller's `setup-command`, and always reports `sccache --show-stats` at the end of
validation. Caller commands remain repository-owned and follow the documented
[Justfile capability contract](docs/justfile-contract.md).

- `rust-compiler-cache` (string, default `auto`) selects the mode. `auto` enables the cache for
  `rust` callers only, `on` also enables it for a `mixed` caller that builds Rust, and `off` disables
  it everywhere. `python` and `node` callers never run the cache steps at any mode, and any other
  value fails the interface validation step before the gate runs.
- `sccache-gha-version` (string, default empty) sets `SCCACHE_GHA_VERSION`, the cache-namespace key.
  Bumping it discards that caller's existing cache entries and touches no other repository.

## Organization Actions allowlist

The organization restricts Actions to a selected set, so a reusable workflow may only call an
action the organization has admitted. [`policy/actions-allowlist.json`](policy/actions-allowlist.json)
records the live `orgs/groovemap-music/actions/permissions/selected-actions` response, and
`just check` fails any `uses:` reference in this repository that is not GitHub-owned (the `actions`
and `github` owners), not a local `./` or digest-pinned `docker://` reference, and not matched by a
recorded pattern. The rule exists because on 2026-09-05 `reusable-ci.yml` began calling
`mozilla-actions/sccache-action` while that pattern was absent from the organization allowlist, so
every caller repository failed at workflow startup with `is not allowed in groovemap-music/<repo>`
until the pattern was added on 2026-09-15; the gate now catches that mismatch before the change
merges. An operator keeps the two in step in a fixed order: the settings owner widens the live
policy first with `gh api -X PUT orgs/groovemap-music/actions/permissions/selected-actions`, then
the snapshot is updated here in a reviewed commit, and
`gh api orgs/groovemap-music/actions/permissions/selected-actions | diff -u policy/actions-allowlist.json -`
confirms the file still matches. `verified_allowed` is recorded but never admits a reference on its
own, because creator verification cannot be established offline; a verified creator's action still
needs its own recorded pattern.

## Repository boundary

- The public `groovemap-music/automation` repository solely owns reusable workflow and
  composite-action implementation,
  interface documentation, fixtures, and contract tests under accepted ADR 0002.
- Caller repositories own their language-, service-, and image-specific commands and pin this
  repository by full commit revision.
- `groovemap-music/.github` owns the organization profile and shared community-health files.
- `groovemap-music/infra` owns private organization controls, repository settings, teams,
  protected branches, secrets, and the label taxonomy used by Dependabot.

No deployment topology, credentials, private endpoints, operational records, or raw planning
artifacts belong here. Examples and fixtures must use reserved synthetic values.

## Documentation

See the [documentation index](docs/README.md) for the architecture, governance boundary, and
local validation contract. The [interface guide](docs/interfaces.md) documents every reusable
input, failure mode, permission, and release invariant, while [contract status](docs/readiness.md)
records the local proof and operator-controlled publication boundary. Read [CONTRIBUTING.md](CONTRIBUTING.md)
before proposing a change and [SECURITY.md](SECURITY.md) before reporting a vulnerability.

## License

The source is available under the [MIT License](LICENSE). [NOTICE](NOTICE) records the copyright,
brand, and third-party boundary.
