# GrooveMap automation

`automation` is the publication-ready source of reusable GitHub Actions workflows and composite
actions for GrooveMap repositories. It provides a complete pull-request gate for Python, Rust,
Node, mixed, container, coverage, security, package, and install checks, plus an attested
tag-release path. Callers select their repository-owned commands and consume these interfaces at
immutable full commit revisions.

The contract is [ready for caller migration](docs/readiness.md) after review and merge. The
repository remains private until the separately approved organization-wide visibility change;
validation and release-contract tests do not change that state.

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
`--mount=type=cache,target=` path in the caller's Dockerfile. The cache key combines the mount ids
with the hash of `dockerfile`, and a mount-id restore-keys prefix supplies the nearest earlier
entry, so a compile layer is reused until the Dockerfile changes. Extraction is skipped on an exact
key hit because the stored cache already matches that Dockerfile. Callers should exclude
`.buildkit-cache/` from their Docker build context.

The input is empty by default. `publish-image` builds that omit it keep their existing behaviour:
no cache step, no injection step, and the same `type=gha` layer cache as before.

## Rust compiler cache

Callers that build Rust get the `sccache` compiler cache backed by the GitHub Actions cache, so a
pull request recompiles only the crates it changed. `reusable-ci.yml` installs the pinned
`mozilla-actions/sccache-action`, exports `RUSTC_WRAPPER=sccache` and `SCCACHE_GHA_ENABLED=true`
before the caller's `setup-command`, and always reports `sccache --show-stats` at the end of
validation. Caller Justfiles are unchanged.

- `rust-compiler-cache` (string, default `auto`) selects the mode. `auto` enables the cache for
  `rust` callers only, `on` also enables it for a `mixed` caller that builds Rust, and `off` disables
  it everywhere. `python` and `node` callers never run the cache steps at any mode, and any other
  value fails the interface validation step before the gate runs.
- `sccache-gha-version` (string, default empty) sets `SCCACHE_GHA_VERSION`, the cache-namespace key.
  Bumping it discards that caller's existing cache entries and touches no other repository.

## Repository boundary

- `groovemap-music/automation` owns reusable workflow and composite-action implementation,
  interface documentation, fixtures, and contract tests.
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
input, failure mode, permission, and release invariant, while the [readiness guide](docs/readiness.md)
records the caller-migration proof and publication gate. Read [CONTRIBUTING.md](CONTRIBUTING.md)
before proposing a change and [SECURITY.md](SECURITY.md) before reporting a vulnerability.

## License

The source is available under the [MIT License](LICENSE). [NOTICE](NOTICE) records the copyright,
brand, and third-party boundary.
