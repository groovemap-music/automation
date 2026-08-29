# Governance boundary

## Repository-owned material

This repository owns reusable workflows, composite actions, synthetic fixtures, public interface
documentation, and tests for those interfaces. All content must be suitable for public review.

The MIT license covers repository source. It does not grant rights to GrooveMap names or logos,
and it does not replace the licenses of third-party actions or tools.

## Separately owned controls

The `.github` repository owns organization profile and shared community-health content. The
`infra` repository owns GitHub settings, teams, protected branches, secrets, and the standard
issue-label taxonomy. Dependabot configuration here may reference only labels declared by that
OpenTofu-managed taxonomy.

The declared dependency labels are `dependencies` and `github-actions`. Their live creation and
fleet convergence remain gated on a separately approved OpenTofu apply. Repository validation
checks the declared contract but does not apply infrastructure or claim public readiness before
that external gate completes.

Private deployment instructions and operational procedures remain in their owning private
repositories. Redacting such material is not a publication strategy; it must not enter this
repository.

## Change discipline

Reusable interfaces are versioned by immutable source revision. A change that alters permissions,
inputs, outputs, required secrets, job identity, or failure behavior must update documentation and
contract tests. Publication and repository visibility are separate operator-controlled actions.
