import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  renderCiContract,
  renderReleaseContract,
  validateDependabotLabels,
  validateWorkflowSource,
} from "./workflow-contract.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const MIT_SHA256 = "38b811191c91cc9577669a398064070bfed40c462bd084b789de409144f1b129";
const ALLOWED_EXTERNAL_HOSTS = new Set(["github.com", "groovemap.music"]);
const REQUIRED_FILES = [
  ".github/CODEOWNERS",
  ".github/actions/setup-tools/action.yml",
  ".github/actions/validate-python-policy/action.yml",
  ".github/actions/validate-python-policy/validate.py",
  ".github/dependabot.yml",
  ".github/workflows/ci.yml",
  ".github/workflows/reusable-ci.yml",
  ".github/workflows/reusable-release.yml",
  ".gitignore",
  ".mise.toml",
  "AGENTS.md",
  "CONTRIBUTING.md",
  "Justfile",
  "LICENSE",
  "NOTICE",
  "README.md",
  "SECURITY.md",
  "docs/README.md",
  "docs/architecture.md",
  "docs/governance.md",
  "docs/interfaces.md",
  "docs/readiness.md",
  "docs/validation.md",
  "fixtures/contracts/container-ci.json",
  "fixtures/contracts/container-release.json",
  "fixtures/contracts/browser-ci.json",
  "fixtures/contracts/node-ci.json",
  "fixtures/contracts/python-ci.json",
  "fixtures/contracts/rust-ci.json",
  "scripts/validate.mjs",
  "scripts/validate.test.mjs",
  "scripts/workflow-contract.mjs",
];
const MANIFEST_ECOSYSTEMS = [
  ["package.json", "npm"],
  ["pyproject.toml", "uv"],
  ["uv.lock", "uv"],
  ["Cargo.toml", "cargo"],
  ["Dockerfile", "docker"],
];
const EXPOSURE_PATTERNS = [
  ["legacy-project-name", new RegExp(["discogs", "ography"].join(""), "i")],
  ["host-local-path", /(?:\/Users\/|\/var\/folders\/|[A-Z]:\\Users\\)/],
  ["private-ip-url", /https?:\/\/(?:10\.|192\.168\.|172\.(?:1[6-9]|2\d|3[01])\.)/],
  ["private-hostname", /https?:\/\/[^\s)>]*(?:\.internal|\.corp|\.lan|\.local)(?::\d+)?/i],
  ["private-key", new RegExp(["-----BEGIN", "(?:[A-Z ]+ )?PRIVATE", "KEY-----"].join(" "))],
  ["github-token", /\b(?:ghp|github_pat)_[A-Za-z0-9_]{12,}\b/],
  ["credential-assignment", /\b(?:password|secret|token|api[_-]?key)\s*[:=]\s*["'][^"']{8,}["']/i],
  ["customer-record", /\bcustomer[_ -]?id\s*[:=]\s*[A-Za-z0-9-]+/i],
  ["incident-record", /\b(?:INC|SEV|CASE)-\d{3,}\b/i],
  ["private-runbook-path", /\brunbooks?\//i],
  ["private-planning-path", /(?:\.planning\/|docs\/superpowers\/)/i],
];

function walk(directory) {
  const files = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if ([".git", ".build", "node_modules"].includes(entry.name)) continue;
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) files.push(...walk(path));
    else if (entry.isFile()) files.push(path);
  }
  return files;
}

export function extractLinks(markdown) {
  return [...markdown.matchAll(/!?\[[^\]]*\]\(([^)\s]+)(?:\s+["'][^"']*["'])?\)/g)].map((match) => match[1]);
}

export function findExposureIssues(content) {
  return EXPOSURE_PATTERNS.filter(([, pattern]) => pattern.test(content)).map(([name]) => name);
}

export function validateActionReference(reference) {
  if (reference.startsWith("./")) return null;
  if (/^docker:\/\/[^@\s]+@sha256:[a-f0-9]{64}$/.test(reference)) return null;
  if (/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_./-]+)?@[a-f0-9]{40}$/.test(reference)) return null;
  return `action reference must use a local path or immutable digest: ${reference}`;
}

function requireMarkers(errors, path, content, markers) {
  for (const marker of markers) {
    if (!content.includes(marker)) errors.push(`${path}: required contract marker is missing: ${marker}`);
  }
}

function stepBlock(content, name) {
  const marker = `      - name: ${name}`;
  const start = content.indexOf(marker);
  if (start < 0) return "";
  const next = content.indexOf("\n      - name: ", start + marker.length);
  return content.slice(start, next < 0 ? content.length : next);
}

function requireAlwaysStep(errors, path, content, name, condition) {
  const block = stepBlock(content, name);
  if (!block.includes(`if: ${condition}`)) errors.push(`${path}: ${name} must run with ${condition}`);
}

function requireStepMarkers(errors, path, content, name, markers) {
  const block = stepBlock(content, name);
  for (const marker of markers) {
    if (!block.includes(marker)) errors.push(`${path}: ${name} must contain ${marker}`);
  }
}

export function workflowContractIssues(path, content) {
  const errors = [];
  if (!content.includes("workflow_call:")) errors.push(`${path}: reusable interface must use workflow_call`);
  if (/^\s*schedule:/m.test(content)) errors.push(`${path}: reusable interfaces must not schedule work`);
  if (content.includes("pull_request_target")) errors.push(`${path}: pull_request_target is prohibited`);
  if (/^\s*if:.*(?:github\.actor|dependabot\[bot\])/im.test(content)) {
    errors.push(`${path}: actor-specific job graphs are prohibited`);
  }
  if (/fallback-command|source-only gate/i.test(content)) errors.push(`${path}: reduced validation fallbacks are prohibited`);
  if (content.includes(".automation/python-libraries")) {
    errors.push(`${path}: python-libraries must use the caller's established root exclusion path`);
  }
  if (content.includes("repository: groovemap-music/python-libraries")) {
    requireMarkers(errors, path, content, [
      "path: python-libraries",
      "GROOVEMAP_RUNTIME_REPO=${GITHUB_WORKSPACE}/python-libraries",
      "GROOVEMAP_LIBRARIES_REPO=${GITHUB_WORKSPACE}/python-libraries",
    ]);
  }

  if (path.endsWith("reusable-ci.yml")) {
    requireMarkers(errors, path, content, [
      "language:",
      "check-command:",
      "coverage-command:",
      "audit-command:",
      "license-command:",
      "secret-scan-command:",
      "package-command:",
      "install-command:",
      "coverage-files:",
      "browser-coverage-mapping:",
      "e2e-setup-command:",
      "e2e-instrument-command:",
      "e2e-command:",
      "e2e-post-command:",
      "requires-private-library:",
      "private-library-revision:",
      "Run format, lint, type, test, and contract checks",
      "Generate coverage evidence",
      "Run dependency audit",
      "Validate locked dependency licenses",
      "Scan repository and history for secrets",
      "Build package or application artifact",
      "Install and smoke-test built artifact",
      "Stage workspace-relative coverage evidence",
      "Restore workspace-relative coverage evidence",
      "if-no-files-found: error",
      "include-hidden-files: true",
      "needs: validate",
      "test \"${VALIDATION_RESULT}\" = success",
      "^[0-9a-f]{40}$",
      "no reduced gate is available",
      "upload: ${{ fromJSON(inputs.browser-coverage-mapping) }}",
      "files: ${{ matrix.upload.lcov }}",
      "flags: e2e-${{ matrix.upload.project }}",
      "retained-coverage-paths-json",
      "steps.stage-coverage.outputs.artifact-root",
      "groovemap-coverage-artifact",
      "groovemap-coverage-download",
      "browser LCOV was not restored at its requested path",
      "browser-mapping-valid",
      "codecov-files",
      "files: ${{ steps.interface.outputs.codecov-files }}",
      "steps.interface.outcome == 'success'",
      "needs.validate.outputs.browser-mapping-valid == 'true'",
    ]);
    const codecovUploads = [...content.matchAll(/^\s+uses:\s+codecov\/codecov-action@/gm)];
    if (codecovUploads.length !== 2) {
      errors.push(`${path}: exactly the generic and per-browser explicit Codecov uploads are allowed`);
    }
    requireStepMarkers(errors, path, content, "Upload coverage to Codecov", [
      "files: ${{ steps.interface.outputs.codecov-files }}",
      "flags: ${{ inputs.coverage-flags }}",
      "disable_search: true",
    ]);
    requireStepMarkers(errors, path, content, "Upload browser coverage to Codecov", [
      "files: ${{ matrix.upload.lcov }}",
      "flags: e2e-${{ matrix.upload.project }}",
      "disable_search: true",
    ]);
    requireAlwaysStep(
      errors,
      path,
      content,
      "Run E2E post-processing and teardown",
      "always() && inputs.e2e-post-command != ''",
    );
    requireAlwaysStep(
      errors,
      path,
      content,
      "Stage workspace-relative coverage evidence",
      "always() && steps.interface.outcome == 'success'",
    );
    requireAlwaysStep(
      errors,
      path,
      content,
      "Retain coverage evidence",
      "always() && steps.stage-coverage.outcome == 'success'",
    );
    requireAlwaysStep(
      errors,
      path,
      content,
      "Upload coverage to Codecov",
      "always() && inputs.upload-codecov && steps.interface.outcome == 'success'",
    );
  }

  if (path.endsWith("reusable-release.yml")) {
    requireMarkers(errors, path, content, [
      "attestations: write",
      "id-token: write",
      "packages: write",
      "github.event_name",
      "^refs/tags/v[0-9]",
      "github.event.repository.name",
      "SHA256SUMS",
      "THIRD_PARTY_NOTICES.json",
      "sbom.json",
      "sha256sum --check",
      "actions/attest-build-provenance@",
      "actions/upload-artifact@",
      "artifact-variant:",
      "artifact-name=${artifact_name}",
      "name: ${{ steps.identity.outputs.artifact-name }}",
      "type=ref,event=tag",
      "provenance: mode=max",
      "sbom: true",
      "subject-digest: ${{ steps.image.outputs.digest }}",
    ]);
    if (/type=(?:raw|sha)[^\n]*(?:latest|main)|flavor:\s*[\s\S]*latest=true/i.test(content)) {
      errors.push(`${path}: floating or unversioned image tags are prohibited`);
    }
  }

  return errors;
}

export function detectEcosystems(root, files, workflowText) {
  const ecosystems = new Set();
  if (/^\s*(?:-\s*)?uses:\s*\S+/m.test(workflowText)) ecosystems.add("github-actions");
  for (const [manifest, ecosystem] of MANIFEST_ECOSYSTEMS) {
    if (files.some((path) => relative(root, path) === manifest)) ecosystems.add(ecosystem);
  }
  if (files.some((path) => path.endsWith(".tf"))) ecosystems.add("opentofu");
  return ecosystems;
}

function checkRequiredFiles(errors) {
  for (const path of REQUIRED_FILES) {
    if (!existsSync(resolve(ROOT, path))) errors.push(`${path}: required file is missing`);
  }
}

function checkMarkdown(errors) {
  for (const path of walk(ROOT).filter((file) => file.endsWith(".md"))) {
    const display = relative(ROOT, path);
    const content = readFileSync(path, "utf8");
    if (!content.endsWith("\n")) errors.push(`${display}: missing final newline`);
    if (content.split("\n").some((line) => /[ \t]+$/.test(line))) errors.push(`${display}: trailing whitespace`);
    if (/```(?:plantuml|dot|graphviz|ascii)\b/i.test(content)) errors.push(`${display}: conceptual diagrams must use Mermaid`);

    for (const link of extractLinks(content)) {
      if (link.startsWith("#")) continue;
      if (/^[a-z][a-z0-9+.-]*:/i.test(link)) {
        try {
          const url = new URL(link);
          if (url.protocol !== "https:") errors.push(`${display}: external link must use HTTPS: ${link}`);
          else if (!ALLOWED_EXTERNAL_HOSTS.has(url.hostname)) errors.push(`${display}: external host is not allowlisted: ${url.hostname}`);
        } catch {
          errors.push(`${display}: malformed external link`);
        }
        continue;
      }
      const local = decodeURIComponent(link.split("#", 1)[0]);
      if (!local) continue;
      const target = resolve(dirname(path), local);
      if (!target.startsWith(`${ROOT}/`) || !existsSync(target)) errors.push(`${display}: broken or escaping local link: ${link}`);
    }
  }

  const architecture = readFileSync(resolve(ROOT, "docs/architecture.md"), "utf8");
  if (!architecture.includes("```mermaid")) errors.push("docs/architecture.md: Mermaid architecture diagram is required");
}

function checkLegalBoundary(errors) {
  const license = readFileSync(resolve(ROOT, "LICENSE"));
  const actual = createHash("sha256").update(license).digest("hex");
  if (actual !== MIT_SHA256) errors.push("LICENSE: expected the approved unmodified MIT text");
  const notice = readFileSync(resolve(ROOT, "NOTICE"), "utf8");
  for (const phrase of ["GrooveMap automation", "MIT License", "not licensed", "Third-party actions"]) {
    if (!notice.includes(phrase)) errors.push(`NOTICE: required metadata is missing: ${phrase}`);
  }
}

function checkAutomationPolicy(errors, files) {
  const workflowPaths = files.filter((path) => path.includes(`${resolve(ROOT, ".github/workflows")}/`) && /\.ya?ml$/.test(path));
  const actionPaths = files.filter((path) => path.includes(`${resolve(ROOT, ".github/actions")}/`) && /action\.ya?ml$/.test(path));
  const workflows = workflowPaths.map((path) => readFileSync(path, "utf8")).join("\n");
  for (const path of [...workflowPaths, ...actionPaths]) {
    const content = readFileSync(path, "utf8");
    for (const match of content.matchAll(/^\s*(?:-\s*)?uses:\s*([^\s#]+)/gm)) {
      const issue = validateActionReference(match[1]);
      if (issue) errors.push(`${relative(ROOT, path)}: ${issue}`);
    }
    if (workflowPaths.includes(path)) {
      errors.push(...validateWorkflowSource(content).map((issue) => `${relative(ROOT, path)}: ${issue}`));
    }
  }

  for (const path of workflowPaths.filter((path) => path.includes("reusable-"))) {
    errors.push(...workflowContractIssues(relative(ROOT, path), readFileSync(path, "utf8")));
  }

  const ci = readFileSync(resolve(ROOT, ".github/workflows/ci.yml"), "utf8");
  if (!ci.includes("permissions:\n  contents: read")) errors.push(".github/workflows/ci.yml: read-only contents permission is required");
  if (ci.includes("secrets.") || ci.includes("secrets: inherit")) errors.push(".github/workflows/ci.yml: foundation validation must not use secrets");

  const dependabot = readFileSync(resolve(ROOT, ".github/dependabot.yml"), "utf8");
  const ecosystems = detectEcosystems(ROOT, files, workflows);
  for (const ecosystem of ecosystems) {
    if (!dependabot.includes(`package-ecosystem: ${ecosystem}`)) errors.push(`.github/dependabot.yml: missing ${ecosystem} ecosystem`);
  }
  errors.push(...validateDependabotLabels(dependabot, ["dependencies", "github-actions"]).map((issue) => `.github/dependabot.yml: ${issue}`));
}

function checkContractFixtures(errors) {
  const ci = readFileSync(resolve(ROOT, ".github/workflows/reusable-ci.yml"), "utf8");
  const release = readFileSync(resolve(ROOT, ".github/workflows/reusable-release.yml"), "utf8");
  const fixtureRoot = resolve(ROOT, "fixtures/contracts");
  const fixturePaths = readdirSync(fixtureRoot).filter((name) => name.endsWith(".json")).sort();
  const capabilities = new Set();

  for (const name of fixturePaths) {
    const display = `fixtures/contracts/${name}`;
    let fixture;
    try {
      fixture = JSON.parse(readFileSync(resolve(fixtureRoot, name), "utf8"));
    } catch {
      errors.push(`${display}: invalid JSON fixture`);
      continue;
    }
    capabilities.add(fixture.capability);

    if (fixture.kind === "ci") {
      const ordinary = renderCiContract(ci, fixture);
      const dependencyUpdate = renderCiContract(ci, { ...fixture, actor: "dependabot[bot]" });
      for (const issue of ordinary.issues) errors.push(`${display}: ${issue}`);
      for (const issue of dependencyUpdate.issues) errors.push(`${display}: Dependabot: ${issue}`);
      if (JSON.stringify(ordinary.jobs) !== JSON.stringify(dependencyUpdate.jobs)) {
        errors.push(`${display}: Dependabot must render the identical job and step graph`);
      }
      if (!ordinary.jobs.some((job) => job.id === "result" && job.needs.includes("validate"))) {
        errors.push(`${display}: rendered CI contract must contain the fail-closed result job`);
      }
      if (fixture.capability === "container") {
        const steps = ordinary.jobs.flatMap((job) => job.steps);
        if (!steps.includes("Build and inspect local container")) errors.push(`${display}: container image validation is missing`);
      }
    } else if (fixture.kind === "release") {
      const rendered = renderReleaseContract(release, fixture);
      for (const issue of rendered.issues) errors.push(`${display}: ${issue}`);
    } else {
      errors.push(`${display}: kind must be ci or release`);
    }
  }

  for (const capability of ["python", "rust", "node", "container", "browser", "tag-release"]) {
    if (!capabilities.has(capability)) errors.push(`fixtures/contracts: missing representative ${capability} fixture`);
  }
}

function checkExposure(errors, files) {
  for (const path of files) {
    const display = relative(ROOT, path);
    const content = readFileSync(path, "utf8");
    for (const issue of findExposureIssues(content)) errors.push(`${display}: exposure rule matched: ${issue}`);
  }
}

export function validate() {
  const errors = [];
  const files = walk(ROOT);
  checkRequiredFiles(errors);
  checkMarkdown(errors);
  checkLegalBoundary(errors);
  checkAutomationPolicy(errors, files);
  checkContractFixtures(errors);
  checkExposure(errors, files);
  return errors;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const errors = validate();
  if (errors.length > 0) {
    for (const error of errors) console.error(`ERROR ${error}`);
    process.exit(1);
  }
  console.log("validated repository");
}
