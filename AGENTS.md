# Repository instructions

- Keep `just check` deterministic, credential-free, and free of live service access.
- Pin every external `uses:` reference to a full 40-character commit revision.
- Document and behavior-test reusable workflow/action interfaces in the same change.
- Keep fixtures synthetic; never commit secrets, private endpoints, operational data, or private
  planning artifacts.
- Do not publish, tag, change visibility, or modify organization settings from repository checks.
- Run `just check` before submitting work.
