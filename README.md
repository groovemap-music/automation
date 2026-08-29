# GrooveMap automation

`automation` is the public source of reusable GitHub Actions workflows and composite actions for
GrooveMap repositories. It provides a complete pull-request gate for Python, Rust, Node, mixed,
container, coverage, security, package, and install checks, plus an attested tag-release path.
Callers select their repository-owned commands and consume these interfaces at immutable full
commit revisions.

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
input, failure mode, permission, and release invariant. Read [CONTRIBUTING.md](CONTRIBUTING.md)
before proposing a change and [SECURITY.md](SECURITY.md) before reporting a vulnerability.

## License

The source is available under the [MIT License](LICENSE). [NOTICE](NOTICE) records the copyright,
brand, and third-party boundary.
