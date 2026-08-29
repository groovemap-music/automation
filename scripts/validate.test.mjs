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

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const REUSABLE_CI = readFileSync(resolve(ROOT, ".github/workflows/reusable-ci.yml"), "utf8");
const REUSABLE_RELEASE = readFileSync(resolve(ROOT, ".github/workflows/reusable-release.yml"), "utf8");

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

test("current repository satisfies the complete public foundation contract", () => {
  assert.deepEqual(validate(), []);
});
