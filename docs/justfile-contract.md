# Justfile capability contract

Every GrooveMap repository exposes a small, discoverable automation provider through its
`Justfile`. Reusable workflows select recipes from that provider; they do not own or infer the
repository-specific commands behind them.

## Core contract

`default` and `check` are universal. `setup` is also required when the repository has an
installable toolchain or dependencies. A static documentation or metadata repository may omit
`setup`; that is the only core-recipe exception and must be intentional. Optional capabilities are
implemented only when meaningful to the repository.

| Recipe | Semantics |
| --- | --- |
| `default` | list the repository's supported recipes without changing state |
| `setup` | install the pinned local toolchain or locked dependencies |
| `check` | run the complete deterministic, credential-free, offline validation gate |
| `format` | apply deterministic source formatting |
| `format-check` | verify formatting without modifying files |
| `lint` | run static style and correctness analysis |
| `typecheck` | run static type analysis |
| `test` | run the repository's deterministic test suite |
| `coverage` | generate local coverage evidence |
| `audit` | audit locked dependencies for known vulnerabilities |
| `license-check` | validate locked dependency licenses |
| `secret-scan` | scan source and history for committed secrets |
| `build` | build a local distributable artifact |
| `install-check` | install and smoke-test the built artifact locally |
| `image` | build and inspect a local container image without publishing it |
| `bump-preview` | preview a version change without modifying files |
| `bump` | apply an explicitly requested version change without publishing it |
| `release-dry-run` | build and verify release evidence without publishing it |

## Repository-specific extensions

A repository may expose domain or operator recipes that have no fleet-wide meaning, such as
`catalog-check` or `serve-local`. Its provider-contract validation must declare each extension by
its lowercase, hyphenated recipe name. An undeclared recipe, a stale declaration with no matching
recipe, a duplicate declaration, or an attempt to redeclare a shared capability fails validation.

Extensions remain local: declaration permits the provider and its own workflow references to use
the recipe, but does not add it to the shared vocabulary or give other repositories permission to
depend on its name or behavior. A stateful or network-backed extension also remains outside
`check`, even when explicitly declared.

## Execution boundaries

`check` is safe in a clean checkout and uses no credentials, network services, container registry,
deployed service, or mutable infrastructure. It may compose focused read-only recipes such as
`format-check`, `lint`, `typecheck`, `test`, `audit`, `license-check`, and `secret-scan` only when
those recipes also satisfy that boundary.

Network-backed integration and browser tests must be explicit workflow commands and remain outside
`check`. So do publication, tagging, deployment, infrastructure apply, repository administration,
and other live or stateful operations. `bump` is local and stateful, so automation may invoke it
only after an explicit operator choice. `release-dry-run` proves release artifacts locally;
publication stays in the tag-gated reusable release workflow.

Reusable-workflow examples and fixtures may reference only recipes implemented by the represented
provider. Contract tests use synthetic Justfiles to reject missing recipe references and additions
to this vocabulary that have not been documented.
