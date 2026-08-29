# Local validation

The authoritative local command is:

```bash
just check
```

It performs three deterministic phases:

1. Node and Python syntax checks for the validators and tests.
2. Standard-library behavior tests for links, exposure rules, action pins, dependency policy,
   rendered Python/Rust/Node/container job contracts, invariant Dependabot behavior, and
   tag-release identity and evidence.
3. Repository validation covering required files, Markdown/local links, MIT and notice metadata,
   Mermaid diagrams, CI permissions, Dependabot ecosystems/labels, immutable action references,
   reusable interface contracts, tag-only publication, and private-material patterns.

Synthetic fixtures live in `fixtures/contracts`. Validation parses the real reusable workflow
declarations, applies fixture inputs and defaults, renders active jobs and steps, and derives
release evidence from those steps. Negative tests mutate the contracts in memory, so failure paths
are proven without editing the checkout, running a service, authenticating, or publishing.

The command reads only the checkout and creates no tracked files. It does not require a package
install, network connection, GitHub token, organization secret, container runtime, or live service.
It validates Dependabot against the declared OpenTofu label taxonomy; confirming and applying the
corresponding live labels is a separate infrastructure gate.

## Extending validation

When a new dependency manifest or action ecosystem is introduced, add its Dependabot entry and a
regression fixture in the same change. When a reusable interface is introduced, add its required
files, documentation links, and behavior checks to the validator. Keep external network checks in
separately named hosted validation; `just check` remains offline and deterministic.
