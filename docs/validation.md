# Local validation

The authoritative local command is:

```bash
just check
```

It performs three deterministic phases:

1. Node and Python syntax checks for the validators and tests.
2. Standard-library behavior tests for links, exposure rules, action pins, dependency policy,
   rendered Python/Rust/Node/container job contracts, invariant Dependabot behavior, five distinct
   Graph Explorer browser uploads, and tag-release identity and evidence.
3. Repository validation covering required files, Markdown/local links, MIT and notice metadata,
   Mermaid diagrams, CI permissions, Dependabot ecosystems/labels, immutable action references,
   reusable interface contracts, tag-only publication, and private-material patterns.

Synthetic fixtures live in `fixtures/contracts`. Validation parses the real reusable workflow
declarations, applies fixture inputs and defaults, renders active jobs and steps, and derives
release evidence from those steps. Negative tests mutate the contracts in memory, so failure paths
are proven without editing the checkout, running a service, authenticating, or publishing.
Browser mapping cases specifically reject empty arrays, invalid JSON, duplicate projects and paths,
newline-delimited files, globbed files, artifact-exclusion paths prefixed by `!`, and the retired
multi-flag shape. Adversarial model and extracted-runtime cases cover generic coverage files plus
every browser LCOV and failure-artifact path surface, including surrounding-whitespace variants;
trailing-slash directory-like forms are rejected while canonical nearby file and directory paths
remain valid, and canonical literal paths with `!` in a later segment remain valid.
Runtime and contract-model regressions also prove that the five Graph Explorer LCOV files are in
the deterministic retained artifact downloaded by every per-browser Codecov matrix job, while
automatic Codecov search is disabled for both generic and browser uploads. Even after every report
is restored, the generic upload is limited to its validated comma list and each browser upload is
limited to one LCOV and one matching flag. A
nested-only roundtrip fixture simulates the artifact action stripping its single staging directory:
`coverage/unit.xml`, `coverage/e2e/chromium/lcov.info`, and nested failure results must be restored
at those same workspace-relative paths. Separate negative cases prove that symlink traversal and a
pre-existing destination collision fail closed.

The command reads only the checkout and creates no tracked files. It does not require a package
install, network connection, GitHub token, organization secret, container runtime, or live service.
It validates Dependabot against the declared OpenTofu label taxonomy; confirming and applying the
corresponding live labels is a separate infrastructure gate.

## Extending validation

When a new dependency manifest or action ecosystem is introduced, add its Dependabot entry and a
regression fixture in the same change. When a reusable interface is introduced, add its required
files, documentation links, and behavior checks to the validator. Keep external network checks in
separately named hosted validation; `just check` remains offline and deterministic.
