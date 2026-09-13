# Contract status

The public `groovemap-music/automation` repository is the sole shared workflow and composite-action
owner for GrooveMap. Each caller owns its workflow adoption, must pin a reviewed automation commit,
declare only supported inputs, and map private-library credentials explicitly when they are
required.

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

## Completed public-library cutover

The publication and caller-migration gate is complete: this repository is public, and all active
callers consume its interfaces through reviewed forty-character commit revisions. The organization
`.github` repository remains the owner of profile and community-health content; it does not carry a
second reusable workflow or composite-action implementation.

The OpenTofu-managed `dependencies` and `github-actions` labels required by the publication gate
are present. Visibility, caller migration, and label convergence are retained here as completed
cutover evidence rather than outstanding readiness work. Ongoing repository settings and label
taxonomy changes remain owned by `groovemap-music/infra`.

## Optional private-library compatibility

Public automation does not imply that every caller dependency is public. The optional
`requires-private-library`, `private-library-client-id`, and immutable `private-library-revision`
inputs, together with the explicitly mapped `PRIVATE_LIBRARY_PRIVATE_KEY` secret, remain supported
for callers that still need the private Python library. Missing or incomplete credentials fail the
complete gate; they never select a reduced validation path.

`just check` and the repository's workflows do not change visibility, create labels, migrate
callers, publish an unreviewed tag, or modify organization settings.
