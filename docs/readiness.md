# Caller-migration readiness

The shared automation contract is ready for caller migration after this change is reviewed and
merged. Each caller migration remains owned by that repository and must pin the reviewed merged
automation commit, declare only supported inputs, and map private-library credentials explicitly
when they are still required.

Readiness is proven locally by `just check` without credentials or live service access:

- the actual workflow interfaces are parsed and every referenced input must be declared;
- synthetic Python, Rust, Node, container, and tag-release calls render their job contracts;
- ordinary and Dependabot calls must render identical CI jobs and steps;
- mutable actions, unscoped secret inheritance, and incomplete dependency labels are rejected;
- release trigger, repository, artifact, image, and revision identities are checked; and
- checksum, legal-notice, SBOM, artifact-provenance, and image-provenance evidence is derived from
  the rendered release steps and required by the release fixture.

The fixtures are contract examples, not runnable service source. They contain synthetic names,
commands, revisions, and artifact paths and never authenticate or publish.

## Publication gate

Contract readiness does not change repository visibility. `groovemap-music/automation` remains
private until the separately approved organization-wide visibility change is applied by its owner.
The OpenTofu-managed `dependencies` and `github-actions` labels must also exist before the public
readiness gate is resolved. Neither `just check` nor any workflow in this repository changes
visibility, creates labels, publishes a tag, or modifies organization settings.
