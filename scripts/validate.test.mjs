import assert from "node:assert/strict";
import { resolve } from "node:path";
import test from "node:test";

import { detectEcosystems, extractLinks, findExposureIssues, validate, validateActionReference } from "./validate.mjs";

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

test("current repository satisfies the complete public foundation contract", () => {
  assert.deepEqual(validate(), []);
});
