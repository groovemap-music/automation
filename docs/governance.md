# Governance boundary

## Repository-owned material

Under accepted ADR 0002, this repository owns reusable workflows, composite actions, synthetic
fixtures, public interface documentation, and tests for those interfaces. The organization
`.github` repository does not own reusable CI. This repository is public, and all content here must
remain suitable for public review.

The MIT license covers repository source. It does not grant rights to GrooveMap names or logos,
and it does not replace the licenses of third-party actions or tools.

## Separately owned controls

The `.github` repository owns organization profile and shared community-health content. The
`infra` repository owns GitHub settings, teams, protected branches, secrets, and the standard
issue-label taxonomy. Dependabot configuration here may reference only labels declared by that
OpenTofu-managed taxonomy.

The declared dependency labels are `dependencies` and `github-actions`. Their initial creation,
the repository visibility change, and caller convergence were separate organization operations;
those publication gates are completed historical evidence. Repository validation checks the
declared contract but does not apply infrastructure. Future visibility, settings, or label changes
remain operator-controlled through their owning boundary.

Private deployment instructions and operational procedures remain in their owning private
repositories. Redacting such material is not a publication strategy; it must not enter this
repository.

## Change discipline

Reusable interfaces are versioned by immutable source revision. A change that alters permissions,
inputs, outputs, required secrets, job identity, or failure behavior must update documentation and
contract tests. Publication and repository visibility are separate operator-controlled actions.
