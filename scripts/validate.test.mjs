import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  detectEcosystems,
  extractLinks,
  findExposureIssues,
  validate,
  validateActionReference,
  workflowContractIssues,
} from "./validate.mjs";
import {
  parseWorkflowDefinition,
  renderCiContract,
  renderReleaseContract,
  validateDependabotLabels,
  validateWorkflowCall,
  validateWorkflowSource,
} from "./workflow-contract.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const REUSABLE_CI = readFileSync(resolve(ROOT, ".github/workflows/reusable-ci.yml"), "utf8");
const REUSABLE_RELEASE = readFileSync(resolve(ROOT, ".github/workflows/reusable-release.yml"), "utf8");
const DEPENDABOT = readFileSync(resolve(ROOT, ".github/dependabot.yml"), "utf8");
const FIXTURE_ROOT = resolve(ROOT, "fixtures/contracts");
const fixture = (name) => JSON.parse(readFileSync(resolve(FIXTURE_ROOT, name), "utf8"));

test("extracts local and external Markdown links", () => {
  const markdown = "[docs](docs/README.md)\n[site](https://groovemap.music)\n";
  assert.deepEqual(extractLinks(markdown), ["docs/README.md", "https://groovemap.music"]);
});

test("accepts local and full-revision action references only", () => {
  assert.equal(validateActionReference("./.github/actions/setup"), null);
  assert.equal(validateActionReference("actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1"), null);
  assert.match(validateActionReference("actions/checkout@main"), /immutable digest/);
  assert.match(validateActionReference("actions/checkout@v7"), /immutable digest/);
});

test("representative Python, Rust, Node, and container calls render complete actor-invariant CI graphs", () => {
  for (const name of ["python-ci.json", "rust-ci.json", "node-ci.json", "container-ci.json"]) {
    const scenario = fixture(name);
    const ordinary = renderCiContract(REUSABLE_CI, scenario);
    const dependencyUpdate = renderCiContract(REUSABLE_CI, { ...scenario, actor: "dependabot[bot]" });
    assert.deepEqual(ordinary.issues, [], name);
    assert.deepEqual(dependencyUpdate.issues, [], name);
    assert.deepEqual(dependencyUpdate.jobs, ordinary.jobs, name);
    assert.ok(ordinary.jobs.some((job) => job.id === "validate"), name);
    assert.ok(ordinary.jobs.some((job) => job.id === "result" && job.needs === "validate"), name);
  }
});

test("representative container tag release renders repository-named evidence", () => {
  const scenario = fixture("container-release.json");
  const rendered = renderReleaseContract(REUSABLE_RELEASE, scenario);
  assert.deepEqual(rendered.issues, []);
  assert.equal(rendered.artifactName, scenario.expectedArtifactName);
  assert.equal(rendered.imageName, scenario.expectedImageName);
  assert.deepEqual(rendered.evidence, [
    "artifact-provenance",
    "checksums",
    "image-registry-attestation",
    "image-sbom-provenance",
    "legal-notices",
    "sbom",
  ]);
});

test("detects each supported private-material pattern without echoing content", () => {
  const samples = [
    [["discogs", "ography"].join(""), "legacy-project-name"],
    [["", "Users", "operator", "workspace"].join("/"), "host-local-path"],
    [["https:/", "10.1.2.3", "api"].join("/"), "private-ip-url"],
    [["https:/", "build.ops.internal"].join("/"), "private-hostname"],
    [["ghp", "abcdefghijklmnop"].join("_"), "github-token"],
    [["customer", "id=customer-123"].join("_"), "customer-record"],
    [["SEV", "1234"].join("-"), "incident-record"],
    [["runbooks", "deploy.md"].join("/"), "private-runbook-path"],
  ];
  for (const [sample, expected] of samples) assert.ok(findExposureIssues(sample).includes(expected));
  assert.deepEqual(findExposureIssues("public synthetic fixture"), []);
});

test("detects dependency ecosystems from repository manifests and workflows", () => {
  const root = resolve("/synthetic");
  const files = [resolve(root, "package.json"), resolve(root, "Dockerfile"), resolve(root, "tofu/main.tf")];
  assert.deepEqual([...detectEcosystems(root, files, "steps:\n  - uses: actions/checkout@revision")].sort(), [
    "docker",
    "github-actions",
    "npm",
    "opentofu",
  ]);
});

test("rejects actor-specific or reduced reusable CI gates", () => {
  const unsafe = `
on:
  workflow_call:
jobs:
  validate:
    if: github.actor != 'dependabot[bot]'
    steps:
      - run: fallback-command
`;
  const issues = workflowContractIssues(".github/workflows/reusable-ci.yml", unsafe);
  assert.ok(issues.some((issue) => issue.includes("actor-specific")));
  assert.ok(issues.some((issue) => issue.includes("reduced validation")));

  const scenario = fixture("python-ci.json");
  const reduced = REUSABLE_CI.replace(
    "  validate:\n    name: Required validation",
    "  validate:\n    if: github.actor != 'dependabot[bot]'\n    name: Required validation",
  );
  assert.notEqual(reduced, REUSABLE_CI);
  assert.notDeepEqual(
    renderCiContract(reduced, scenario).jobs,
    renderCiContract(reduced, { ...scenario, actor: "dependabot[bot]" }).jobs,
  );
});

test("rejects missing and extra Dependabot labels", () => {
  assert.deepEqual(validateDependabotLabels(DEPENDABOT, ["dependencies", "github-actions"]), []);
  for (const labels of ["[dependencies]", "[dependencies, github-actions, synthetic-extra]"]) {
    const unsafe = DEPENDABOT.replace("[dependencies, github-actions]", labels);
    assert.ok(validateDependabotLabels(unsafe, ["dependencies", "github-actions"]).length > 0);
  }
});

test("rejects unscoped secret inheritance and undeclared workflow inputs", () => {
  const inherited = REUSABLE_CI.replace("permissions:\n", "secrets: inherit\n\npermissions:\n");
  assert.ok(validateWorkflowSource(inherited).some((issue) => issue.includes("unscoped secret inheritance")));

  const referenced = `${REUSABLE_CI}\n# \${{ inputs.synthetic-undeclared }}\n`;
  assert.ok(validateWorkflowSource(referenced).some((issue) => issue.includes("synthetic-undeclared")));

  const definition = parseWorkflowDefinition(REUSABLE_CI);
  const supplied = { ...fixture("python-ci.json").inputs, "synthetic-undeclared": "value" };
  assert.ok(validateWorkflowCall(definition, supplied).issues.some((issue) => issue.includes("synthetic-undeclared")));
});

test("rejects loss of always-run E2E post-processing", () => {
  const unsafe = REUSABLE_CI.replace(
    "if: always() && inputs.e2e-post-command != ''",
    "if: inputs.e2e-post-command != ''",
  );
  assert.notEqual(unsafe, REUSABLE_CI);
  const issues = workflowContractIssues(".github/workflows/reusable-ci.yml", unsafe);
  assert.ok(issues.some((issue) => issue.includes("E2E post-processing") && issue.includes("always()")));
});

test("rejects loss of always-run coverage retention and upload", () => {
  const withoutRetention = REUSABLE_CI.replace(
    "- name: Retain coverage evidence\n        if: always()",
    "- name: Retain coverage evidence\n        if: success()",
  );
  const withoutUpload = REUSABLE_CI.replace(
    "if: always() && inputs.upload-codecov",
    "if: inputs.upload-codecov",
  );
  assert.notEqual(withoutRetention, REUSABLE_CI);
  assert.notEqual(withoutUpload, REUSABLE_CI);
  assert.ok(
    workflowContractIssues(".github/workflows/reusable-ci.yml", withoutRetention).some(
      (issue) => issue.includes("Retain coverage evidence") && issue.includes("always()"),
    ),
  );
  assert.ok(
    workflowContractIssues(".github/workflows/reusable-ci.yml", withoutUpload).some(
      (issue) => issue.includes("Upload coverage to Codecov") && issue.includes("always()"),
    ),
  );
});

test("rejects a private-library checkout outside the fleet exclusion path", () => {
  for (const [path, workflow] of [
    [".github/workflows/reusable-ci.yml", REUSABLE_CI],
    [".github/workflows/reusable-release.yml", REUSABLE_RELEASE],
  ]) {
    const unsafe = workflow
      .replace("path: python-libraries", "path: .automation/python-libraries")
      .replaceAll("${GITHUB_WORKSPACE}/python-libraries", "${GITHUB_WORKSPACE}/.automation/python-libraries");
    assert.notEqual(unsafe, workflow);
    assert.ok(workflowContractIssues(path, unsafe).some((issue) => issue.includes("root exclusion path")));
  }
});

test("rejects scheduled or floating-tag reusable releases", () => {
  const unsafe = `
on:
  workflow_call:
  schedule:
    - cron: '0 0 * * *'
jobs:
  publish:
    steps:
      - uses: docker/metadata-action@0123456789abcdef0123456789abcdef01234567
        with:
          tags: type=raw,value=latest
`;
  const issues = workflowContractIssues(".github/workflows/reusable-release.yml", unsafe);
  assert.ok(issues.some((issue) => issue.includes("must not schedule")));
  assert.ok(issues.some((issue) => issue.includes("floating or unversioned")));
});

test("rejects repository, artifact, and image identity drift", () => {
  const scenario = fixture("container-release.json");
  const cases = [
    { ...scenario, actualRepositoryName: "fixture-other" },
    { ...scenario, expectedArtifactName: "fixture-other-v1.2.3" },
    { ...scenario, expectedImageName: "fixture-other-worker" },
  ];
  for (const changed of cases) {
    const issues = renderReleaseContract(REUSABLE_RELEASE, changed).issues;
    assert.ok(issues.some((issue) => issue.includes("drift")));
  }

  const sourceCases = [
    [
      REUSABLE_RELEASE.replace('"${REPOSITORY_NAME}" != "${ACTUAL_REPOSITORY_NAME}"', '"${REPOSITORY_NAME}" != "synthetic"'),
      "repository identity guard",
    ],
    [
      REUSABLE_RELEASE.replace("name: ${{ inputs.repository-name }}-${{ github.ref_name }}", "name: synthetic-artifact"),
      "artifact naming",
    ],
    [
      REUSABLE_RELEASE.replace("${{ steps.identity.outputs.image-name }}", "synthetic-image"),
      "image identity",
    ],
  ];
  for (const [source, expected] of sourceCases) {
    assert.ok(renderReleaseContract(source, scenario).issues.some((issue) => issue.includes(expected)), expected);
  }
});

test("rejects blank or malformed image revisions and non-tag publication", () => {
  const scenario = fixture("container-release.json");
  for (const revision of ["", "01234567", "G123456789abcdef0123456789abcdef01234567"]) {
    assert.ok(
      renderReleaseContract(REUSABLE_RELEASE, { ...scenario, revision }).issues.some((issue) => issue.includes("image revision")),
    );
  }
  for (const changed of [
    { ...scenario, eventName: "workflow_dispatch" },
    { ...scenario, ref: "refs/heads/main" },
  ]) {
    assert.ok(renderReleaseContract(REUSABLE_RELEASE, changed).issues.some((issue) => issue.includes("pushed version tag")));
  }

  const withoutRevisionGuard = REUSABLE_RELEASE.replace(
    '"${REVISION}" =~ ^[0-9a-f]{40}$',
    '"${REVISION}" =~ .+',
  );
  assert.ok(
    renderReleaseContract(withoutRevisionGuard, scenario).issues.some((issue) => issue.includes("image revision guard")),
  );
  const withoutTagGuard = REUSABLE_RELEASE.replace("^refs/tags/v[0-9]", "^refs/heads/");
  assert.ok(renderReleaseContract(withoutTagGuard, scenario).issues.some((issue) => issue.includes("version-tag guard")));
});

test("rejects missing legal, SBOM, and provenance release evidence", () => {
  const scenario = fixture("container-release.json");
  const cases = [
    [REUSABLE_RELEASE.replaceAll("NOTICES_PATH", "REMOVED_NOTICE"), "legal-notices"],
    [REUSABLE_RELEASE.replaceAll("SBOM_PATH", "REMOVED_SBOM"), "sbom"],
    [REUSABLE_RELEASE.replace("Attest release artifacts", "Omit release attestation"), "artifact-provenance"],
    [REUSABLE_RELEASE.replace("provenance: mode=max", "provenance: false"), "image-sbom-provenance"],
    [REUSABLE_RELEASE.replace("Attest published image", "Omit image attestation"), "image-registry-attestation"],
  ];
  for (const [source, evidence] of cases) {
    assert.ok(renderReleaseContract(source, scenario).issues.includes(`missing release evidence: ${evidence}`), evidence);
  }
});

test("current repository satisfies the complete shared automation contract", () => {
  assert.deepEqual(validate(), []);
});
