import assert from "node:assert/strict";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  detectEcosystems,
  extractLinks,
  findExposureIssues,
  validate,
  validateActionPin,
  validateActionReference,
  workflowContractIssues,
} from "./validate.mjs";
import {
  parseWorkflowDefinition,
  renderCiContract,
  renderReleaseContract,
  validateBrowserCoverageMapping,
  validateBuildkitCacheMounts,
  validateCoverageFiles,
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

function runInterfaceRuntime({
  browserMapping = "",
  coverageFiles = "coverage.xml",
} = {}) {
  const match = REUSABLE_CI.match(/          python3 - <<'PY'\n([\s\S]*?)\n          PY/);
  assert.ok(match, "inline browser mapping validator must be present");
  const script = match[1].split("\n").map((line) => line.slice(10)).join("\n");
  const directory = mkdtempSync(resolve(tmpdir(), "groovemap-browser-contract-"));
  const output = resolve(directory, "github-output");
  try {
    const result = spawnSync("python3", ["-c", script], {
      encoding: "utf8",
      env: {
        ...process.env,
        BROWSER_COVERAGE_MAPPING: browserMapping,
        COVERAGE_FILES: coverageFiles,
        GITHUB_OUTPUT: output,
      },
    });
    return { ...result, output: result.status === 0 ? readFileSync(output, "utf8") : "" };
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

const runBrowserMappingRuntime = (browserMapping) => runInterfaceRuntime({ browserMapping });

function inlinePythonForStep(stepName) {
  const jobs = parseWorkflowDefinition(REUSABLE_CI).jobs;
  const step = jobs.flatMap((job) => job.steps).find((candidate) => candidate.name === stepName);
  assert.ok(step, `${stepName} must be present`);
  const match = step.raw.match(/          python3 - <<'PY'\n([\s\S]*?)\n          PY/);
  assert.ok(match, `${stepName} must contain one inline Python program`);
  return match[1].split("\n").map((line) => line.slice(10)).join("\n");
}

function runWorkflowPythonStep(stepName, environment) {
  return spawnSync("python3", ["-c", inlinePythonForStep(stepName)], {
    encoding: "utf8",
    env: { ...process.env, ...environment },
  });
}

function runReleaseIdentityRuntime({ artifactVariant = "" } = {}) {
  const jobs = parseWorkflowDefinition(REUSABLE_RELEASE).jobs;
  const step = jobs
    .flatMap((job) => job.steps)
    .find((candidate) => candidate.name === "Enforce version-tag trigger and repository identity");
  assert.ok(step, "release identity step must be present");
  const match = step.raw.match(/        run: \|\n([\s\S]*)/);
  assert.ok(match, "release identity step must contain one inline Bash program");
  const script = match[1].split("\n").map((line) => line.slice(10)).join("\n");
  const directory = mkdtempSync(resolve(tmpdir(), "groovemap-release-identity-"));
  const output = resolve(directory, "github-output");
  try {
    const result = spawnSync("bash", ["-euo", "pipefail", "-c", script], {
      encoding: "utf8",
      env: {
        ...process.env,
        EVENT_NAME: "push",
        REF: "refs/tags/v1.2.3",
        REPOSITORY_NAME: "fixture-container",
        ACTUAL_REPOSITORY_NAME: "fixture-container",
        REVISION: "0123456789abcdef0123456789abcdef01234567",
        IMAGE_VARIANT: "worker",
        ARTIFACT_VARIANT: artifactVariant,
        TAG_NAME: "v1.2.3",
        PUBLISH_IMAGE: "true",
        GITHUB_OUTPUT: output,
      },
    });
    return {
      ...result,
      output: result.status === 0 ? readFileSync(output, "utf8") : "",
    };
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

function runBuildkitCacheRuntime(mapping) {
  const match = REUSABLE_RELEASE.match(/          python3 - <<'PY'\n([\s\S]*?)\n          PY/);
  assert.ok(match, "BuildKit cache-mount resolver must be present");
  const script = match[1].split("\n").map((line) => line.slice(10)).join("\n");
  const directory = mkdtempSync(resolve(tmpdir(), "groovemap-buildkit-cache-"));
  const output = resolve(directory, "github-output");
  try {
    const result = spawnSync("python3", ["-c", script], {
      encoding: "utf8",
      cwd: directory,
      env: {
        ...process.env,
        BUILDKIT_CACHE_MOUNTS: mapping,
        GITHUB_OUTPUT: output,
      },
    });
    return {
      ...result,
      directory,
      output: existsSync(output) ? readFileSync(output, "utf8") : "",
      created: (name) => existsSync(resolve(directory, ".buildkit-cache", name)),
    };
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

function jsonOutput(output, name) {
  const match = output.match(new RegExp(`^${name}=(.*)$`, "m"));
  assert.ok(match, `${name} JSON output must be present`);
  return JSON.parse(match[1]);
}

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
    assert.ok(ordinary.jobs.some((job) => job.id === "result" && job.needs.includes("validate")), name);
    assert.equal(ordinary.codecovFiles, scenario.inputs["coverage-files"].replaceAll("\n", ","), name);
  }
});

test("renders newline-separated artifact paths as deterministic explicit Codecov files", () => {
  const coverageFiles = "coverage.xml\nfrontend/coverage/lcov.info\ncoverage/e2e/lcov.info";
  const validated = validateCoverageFiles(coverageFiles);
  assert.deepEqual(validated.issues, []);
  assert.deepEqual(validated.paths, [
    "coverage.xml",
    "frontend/coverage/lcov.info",
    "coverage/e2e/lcov.info",
  ]);
  assert.equal(validated.codecovFiles, "coverage.xml,frontend/coverage/lcov.info,coverage/e2e/lcov.info");

  const runtime = runInterfaceRuntime({ coverageFiles });
  assert.equal(runtime.status, 0, runtime.stderr);
  assert.match(
    runtime.output,
    /^codecov-files=coverage\.xml,frontend\/coverage\/lcov\.info,coverage\/e2e\/lcov\.info$/m,
  );

  const validateJob = parseWorkflowDefinition(REUSABLE_CI).jobs.find((job) => job.id === "validate");
  const staged = validateJob.steps.find((step) => step.name === "Stage workspace-relative coverage evidence");
  const retained = validateJob.steps.find((step) => step.name === "Retain coverage evidence");
  const uploaded = validateJob.steps.find((step) => step.name === "Upload coverage to Codecov");
  assert.match(
    staged.raw,
    /RETAINED_COVERAGE_PATHS_JSON: \$\{\{ steps\.interface\.outputs\.retained-coverage-paths-json \}\}/,
  );
  assert.match(retained.raw, /^          path: \$\{\{ steps\.stage-coverage\.outputs\.artifact-root \}\}$/m);
  assert.doesNotMatch(retained.raw, /\$\{\{ inputs\.coverage-files \}\}/);
  assert.match(uploaded.raw, /^          files: \$\{\{ steps\.interface\.outputs\.codecov-files \}\}$/m);
  assert.match(uploaded.raw, /^          disable_search: true$/m);
  assert.doesNotMatch(uploaded.raw, /^          files: \$\{\{ inputs\.coverage-files \}\}$/m);

  const crlf = runInterfaceRuntime({ coverageFiles: "coverage.xml\r\ncoverage/lcov.info\r\n" });
  assert.equal(crlf.status, 0, crlf.stderr);
  assert.match(crlf.output, /^codecov-files=coverage\.xml,coverage\/lcov\.info$/m);
});

test("rejects malformed generic coverage paths before artifact retention or Codecov upload", () => {
  const cases = [
    "",
    "   ",
    "coverage.xml\n\ncoverage/lcov.info",
    "coverage/*.xml",
    "coverage.xml,coverage/lcov.info",
    "/tmp/coverage.xml",
    "./coverage.xml",
    "coverage/../coverage.xml",
    "coverage//lcov.info",
    "coverage/./lcov.info",
    "coverage\\lcov.info",
    "coverage.xml\rcoverage/lcov.info",
    "coverage.xml\ncoverage.xml",
    "!coverage.xml",
    " !coverage.xml",
    "\t!coverage.xml",
    "!coverage.xml ",
  ];
  for (const coverageFiles of cases) {
    assert.ok(validateCoverageFiles(coverageFiles).issues.length > 0, JSON.stringify(coverageFiles));
    assert.notEqual(runInterfaceRuntime({ coverageFiles }).status, 0, JSON.stringify(coverageFiles));
  }
});

test("model and runtime reject directory-like generic coverage paths with the same contract error", () => {
  const invalid = "coverage/";
  const expected = "coverage-files entry 0 is not an explicit repository-relative path";
  assert.deepEqual(validateCoverageFiles(invalid).issues, [expected]);

  const runtime = runInterfaceRuntime({ coverageFiles: invalid });
  assert.notEqual(runtime.status, 0);
  assert.equal(runtime.stderr.trim(), expected);

  const nearbyFile = "coverage/report.xml";
  assert.deepEqual(validateCoverageFiles(nearbyFile).issues, []);
  assert.equal(runInterfaceRuntime({ coverageFiles: nearbyFile }).status, 0);
});

test("accepts canonical literal paths containing non-leading exclamation marks", () => {
  const coverageFiles = "coverage/!literal.xml";
  assert.deepEqual(validateCoverageFiles(coverageFiles).issues, []);
  assert.equal(runInterfaceRuntime({ coverageFiles }).status, 0);

  const browserMapping = JSON.stringify([
    {
      project: "chromium",
      lcov: "coverage/e2e/!literal.lcov",
      artifacts: ["test-results/!literal"],
    },
  ]);
  assert.deepEqual(validateBrowserCoverageMapping(browserMapping).issues, []);
  assert.equal(runBrowserMappingRuntime(browserMapping).status, 0);
});

test("renders five isolated Graph Explorer browser uploads with retained project evidence", () => {
  const scenario = fixture("browser-ci.json");
  const ordinary = renderCiContract(REUSABLE_CI, scenario);
  const dependencyUpdate = renderCiContract(REUSABLE_CI, { ...scenario, actor: "dependabot[bot]" });
  assert.deepEqual(ordinary.issues, []);
  assert.deepEqual(dependencyUpdate.jobs, ordinary.jobs);
  assert.deepEqual(ordinary.browserUploads, [
    { project: "chromium", lcov: "coverage/e2e/chromium/lcov.info", flag: "e2e-chromium" },
    { project: "firefox", lcov: "coverage/e2e/firefox/lcov.info", flag: "e2e-firefox" },
    { project: "webkit", lcov: "coverage/e2e/webkit/lcov.info", flag: "e2e-webkit" },
    { project: "iphone", lcov: "coverage/e2e/iphone/lcov.info", flag: "e2e-iphone" },
    { project: "ipad", lcov: "coverage/e2e/ipad/lcov.info", flag: "e2e-ipad" },
  ]);
  const expectedLcov = ordinary.browserUploads.map(({ lcov }) => lcov);
  assert.deepEqual(ordinary.browserLcovPaths, expectedLcov);
  assert.equal(ordinary.browserArtifactPaths.length, 10);
  assert.equal(ordinary.retainedCoveragePaths.length, 18);
  for (const { lcov } of ordinary.browserUploads) {
    assert.ok(ordinary.retainedCoveragePaths.includes(lcov), `${lcov} must be retained before matrix upload`);
  }
  for (const path of ordinary.browserArtifactPaths) {
    assert.ok(ordinary.retainedCoveragePaths.includes(path), `${path} must be retained as failure evidence`);
  }
  assert.deepEqual(ordinary.codecovUploads, [
    {
      scope: "generic",
      files: ["coverage.xml", "explore/coverage/lcov.info", "coverage/e2e/lcov.info"],
      flags: "python,javascript,e2e,explorer",
      disableSearch: true,
    },
    ...ordinary.browserUploads.map(({ project, lcov, flag }) => ({
      scope: project,
      files: [lcov],
      flags: flag,
      disableSearch: true,
    })),
  ]);
  assert.ok(ordinary.jobs.some((job) => job.id === "browser-codecov"));

  const validateJob = parseWorkflowDefinition(REUSABLE_CI).jobs.find((job) => job.id === "validate");
  const retained = validateJob.steps.find((step) => step.name === "Retain coverage evidence");
  const browserJob = parseWorkflowDefinition(REUSABLE_CI).jobs.find((job) => job.id === "browser-codecov");
  const download = browserJob.steps.find((step) => step.name === "Download retained coverage evidence");
  const restore = browserJob.steps.find((step) => step.name === "Restore workspace-relative coverage evidence");
  const upload = browserJob.steps.find((step) => step.name === "Upload browser coverage to Codecov");
  assert.match(retained.raw, /name: \$\{\{ github\.event\.repository\.name \}\}-coverage-\$\{\{ github\.run_id \}\}/);
  assert.match(download.raw, /name: \$\{\{ github\.event\.repository\.name \}\}-coverage-\$\{\{ github\.run_id \}\}/);
  assert.match(restore.raw, /BROWSER_LCOV_PATH: \$\{\{ matrix\.upload\.lcov \}\}/);
  assert.match(restore.raw, /browser LCOV was not restored at its requested path/);
  assert.match(upload.raw, /^          files: \$\{\{ matrix\.upload\.lcov \}\}$/m);
  assert.match(upload.raw, /^          flags: e2e-\$\{\{ matrix\.upload\.project \}\}$/m);
  assert.match(upload.raw, /^          disable_search: true$/m);
  assert.doesNotMatch(upload.raw, /inputs\.coverage-(?:files|flags)/);
});

test("restoring every retained report cannot broaden an explicit Codecov upload", () => {
  const scenario = fixture("browser-ci.json");
  const rendered = renderCiContract(REUSABLE_CI, scenario);
  const directory = mkdtempSync(resolve(tmpdir(), "groovemap-codecov-isolation-"));
  const sourceWorkspace = resolve(directory, "source-workspace");
  const restoredWorkspace = resolve(directory, "restored-workspace");
  const runnerTemp = resolve(directory, "runner-temp");
  try {
    mkdirSync(sourceWorkspace, { recursive: true });
    mkdirSync(runnerTemp, { recursive: true });
    for (const retainedPath of rendered.retainedCoveragePaths) {
      const destination = resolve(sourceWorkspace, retainedPath);
      if (retainedPath.includes("test-results/") || retainedPath.includes("coverage/e2e/raw/")) {
        mkdirSync(destination, { recursive: true });
        writeFileSync(resolve(destination, "evidence.txt"), `${retainedPath}\n`);
      } else {
        mkdirSync(dirname(destination), { recursive: true });
        writeFileSync(destination, `${retainedPath}\n`);
      }
    }

    const staged = runWorkflowPythonStep("Stage workspace-relative coverage evidence", {
      GITHUB_OUTPUT: resolve(directory, "github-output"),
      GITHUB_WORKSPACE: sourceWorkspace,
      RETAINED_COVERAGE_PATHS_JSON: JSON.stringify(rendered.retainedCoveragePaths),
      RUNNER_TEMP: runnerTemp,
    });
    assert.equal(staged.status, 0, staged.stderr);
    const stagingRoot = resolve(runnerTemp, "groovemap-coverage-artifact");
    const downloadRoot = resolve(runnerTemp, "groovemap-coverage-download");
    mkdirSync(downloadRoot, { recursive: true });
    cpSync(resolve(stagingRoot, "manifest.json"), resolve(downloadRoot, "manifest.json"));
    cpSync(resolve(stagingRoot, "workspace"), resolve(downloadRoot, "workspace"), { recursive: true });
    mkdirSync(restoredWorkspace, { recursive: true });

    const restored = runWorkflowPythonStep("Restore workspace-relative coverage evidence", {
      BROWSER_LCOV_PATH: "coverage/e2e/chromium/lcov.info",
      GITHUB_WORKSPACE: restoredWorkspace,
      RUNNER_TEMP: runnerTemp,
    });
    assert.equal(restored.status, 0, restored.stderr);
    for (const retainedPath of rendered.retainedCoveragePaths) {
      assert.equal(existsSync(resolve(restoredWorkspace, retainedPath)), true, retainedPath);
    }

    assert.deepEqual(rendered.codecovUploads[0].files, [
      "coverage.xml",
      "explore/coverage/lcov.info",
      "coverage/e2e/lcov.info",
    ]);
    assert.equal(rendered.codecovUploads[0].disableSearch, true);
    for (const upload of rendered.codecovUploads.slice(1)) {
      assert.deepEqual(upload.files, [`coverage/e2e/${upload.scope}/lcov.info`]);
      assert.equal(upload.flags, `e2e-${upload.scope}`);
      assert.equal(upload.disableSearch, true);
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("nested-only artifact roundtrip restores the browser LCOV at its exact requested path", () => {
  const directory = mkdtempSync(resolve(tmpdir(), "groovemap-coverage-roundtrip-"));
  const sourceWorkspace = resolve(directory, "source-workspace");
  const restoredWorkspace = resolve(directory, "restored-workspace");
  const runnerTemp = resolve(directory, "runner-temp");
  const output = resolve(directory, "github-output");
  const retainedPaths = [
    "coverage/unit.xml",
    "coverage/e2e/chromium/lcov.info",
    "coverage/e2e/chromium/results",
  ];
  try {
    mkdirSync(resolve(sourceWorkspace, "coverage/e2e/chromium/results"), { recursive: true });
    writeFileSync(resolve(sourceWorkspace, "coverage/unit.xml"), "<coverage/>\n");
    writeFileSync(resolve(sourceWorkspace, "coverage/e2e/chromium/lcov.info"), "TN:\n");
    writeFileSync(resolve(sourceWorkspace, "coverage/e2e/chromium/results/trace.txt"), "trace\n");
    mkdirSync(runnerTemp, { recursive: true });

    const staged = runWorkflowPythonStep("Stage workspace-relative coverage evidence", {
      GITHUB_OUTPUT: output,
      GITHUB_WORKSPACE: sourceWorkspace,
      RETAINED_COVERAGE_PATHS_JSON: JSON.stringify(retainedPaths),
      RUNNER_TEMP: runnerTemp,
    });
    assert.equal(staged.status, 0, staged.stderr);
    const stagingRoot = resolve(runnerTemp, "groovemap-coverage-artifact");
    const manifest = JSON.parse(readFileSync(resolve(stagingRoot, "manifest.json"), "utf8"));
    assert.deepEqual(manifest.retained_paths, retainedPaths);
    assert.deepEqual(manifest.archived_paths, retainedPaths);

    const downloadRoot = resolve(runnerTemp, "groovemap-coverage-download");
    mkdirSync(downloadRoot, { recursive: true });
    // upload-artifact archives the contents of its single directory input, not that root itself.
    cpSync(resolve(stagingRoot, "manifest.json"), resolve(downloadRoot, "manifest.json"));
    cpSync(resolve(stagingRoot, "workspace"), resolve(downloadRoot, "workspace"), { recursive: true });
    mkdirSync(restoredWorkspace, { recursive: true });

    const restored = runWorkflowPythonStep("Restore workspace-relative coverage evidence", {
      BROWSER_LCOV_PATH: "coverage/e2e/chromium/lcov.info",
      GITHUB_WORKSPACE: restoredWorkspace,
      RUNNER_TEMP: runnerTemp,
    });
    assert.equal(restored.status, 0, restored.stderr);
    assert.equal(readFileSync(resolve(restoredWorkspace, "coverage/e2e/chromium/lcov.info"), "utf8"), "TN:\n");
    assert.equal(readFileSync(resolve(restoredWorkspace, "coverage/unit.xml"), "utf8"), "<coverage/>\n");
    assert.equal(
      readFileSync(resolve(restoredWorkspace, "coverage/e2e/chromium/results/trace.txt"), "utf8"),
      "trace\n",
    );
    assert.equal(existsSync(resolve(restoredWorkspace, "e2e/chromium/lcov.info")), false);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("coverage artifact staging and restore fail closed on symlink traversal and collisions", () => {
  const directory = mkdtempSync(resolve(tmpdir(), "groovemap-coverage-safety-"));
  const sourceWorkspace = resolve(directory, "source-workspace");
  const restoredWorkspace = resolve(directory, "restored-workspace");
  const runnerTemp = resolve(directory, "runner-temp");
  try {
    mkdirSync(resolve(sourceWorkspace, "coverage"), { recursive: true });
    mkdirSync(runnerTemp, { recursive: true });
    writeFileSync(resolve(directory, "outside.info"), "TN:\n");
    symlinkSync(resolve(directory, "outside.info"), resolve(sourceWorkspace, "coverage/lcov.info"));
    const unsafeStage = runWorkflowPythonStep("Stage workspace-relative coverage evidence", {
      GITHUB_OUTPUT: resolve(directory, "unsafe-output"),
      GITHUB_WORKSPACE: sourceWorkspace,
      RETAINED_COVERAGE_PATHS_JSON: JSON.stringify(["coverage/lcov.info"]),
      RUNNER_TEMP: runnerTemp,
    });
    assert.notEqual(unsafeStage.status, 0);
    assert.match(unsafeStage.stderr, /must not traverse symlinks/);

    rmSync(sourceWorkspace, { recursive: true, force: true });
    mkdirSync(resolve(sourceWorkspace, "coverage"), { recursive: true });
    writeFileSync(resolve(sourceWorkspace, "coverage/lcov.info"), "TN:\n");
    const safeStage = runWorkflowPythonStep("Stage workspace-relative coverage evidence", {
      GITHUB_OUTPUT: resolve(directory, "safe-output"),
      GITHUB_WORKSPACE: sourceWorkspace,
      RETAINED_COVERAGE_PATHS_JSON: JSON.stringify(["coverage/lcov.info"]),
      RUNNER_TEMP: runnerTemp,
    });
    assert.equal(safeStage.status, 0, safeStage.stderr);
    const stagingRoot = resolve(runnerTemp, "groovemap-coverage-artifact");
    const downloadRoot = resolve(runnerTemp, "groovemap-coverage-download");
    mkdirSync(downloadRoot, { recursive: true });
    cpSync(resolve(stagingRoot, "manifest.json"), resolve(downloadRoot, "manifest.json"));
    cpSync(resolve(stagingRoot, "workspace"), resolve(downloadRoot, "workspace"), { recursive: true });

    mkdirSync(resolve(restoredWorkspace, "coverage"), { recursive: true });
    const collision = runWorkflowPythonStep("Restore workspace-relative coverage evidence", {
      BROWSER_LCOV_PATH: "coverage/lcov.info",
      GITHUB_WORKSPACE: restoredWorkspace,
      RUNNER_TEMP: runnerTemp,
    });
    assert.notEqual(collision.status, 0);
    assert.match(collision.stderr, /collides with workspace path/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("keeps callers without browser coverage backward compatible", () => {
  for (const name of ["python-ci.json", "rust-ci.json", "node-ci.json", "container-ci.json"]) {
    const rendered = renderCiContract(REUSABLE_CI, fixture(name));
    assert.deepEqual(rendered.issues, [], name);
    assert.deepEqual(rendered.browserUploads, [], name);
    assert.deepEqual(rendered.browserArtifactPaths, [], name);
    assert.deepEqual(rendered.browserLcovPaths, [], name);
    assert.deepEqual(rendered.retainedCoveragePaths, rendered.coverageArtifactPaths, name);
    assert.ok(!rendered.jobs.some((job) => job.id === "browser-codecov"), name);
  }
});

test("rejects empty, malformed, globbed, and old multi-flag browser mappings", () => {
  const valid = JSON.parse(fixture("browser-ci.json").inputs["browser-coverage-mapping"]);
  const cases = [
    "[]",
    "not-json",
    JSON.stringify([{ ...valid[0], project: "chromium,firefox" }]),
    JSON.stringify([{ ...valid[0], project: "chromium\nfirefox" }]),
    JSON.stringify([{ ...valid[0], lcov: "coverage/e2e/*/lcov.info" }]),
    JSON.stringify([{ ...valid[0], lcov: "coverage/e2e/chromium/lcov.info\ncoverage/e2e/firefox/lcov.info" }]),
    JSON.stringify([{ ...valid[0], artifacts: ["test-results/**/*"] }]),
    JSON.stringify([{ ...valid[0], lcov: "!coverage/e2e/chromium/lcov.info" }]),
    JSON.stringify([{ ...valid[0], lcov: " !coverage/e2e/chromium/lcov.info" }]),
    JSON.stringify([{ ...valid[0], lcov: "!coverage/e2e/chromium/lcov.info " }]),
    JSON.stringify([{ ...valid[0], artifacts: ["!test-results/chromium"] }]),
    JSON.stringify([{ ...valid[0], artifacts: ["\t!test-results/chromium"] }]),
    JSON.stringify([{ ...valid[0], artifacts: ["!test-results/chromium "] }]),
    JSON.stringify([valid[0], { ...valid[0], project: "firefox" }]),
  ];
  for (const mapping of cases) {
    assert.ok(validateBrowserCoverageMapping(mapping).issues.length > 0, mapping);
    assert.notEqual(runBrowserMappingRuntime(mapping).status, 0, mapping);
  }
});

test("model and runtime reject trailing-slash browser artifact paths while accepting canonical paths", () => {
  const base = JSON.parse(fixture("browser-ci.json").inputs["browser-coverage-mapping"])[0];
  const invalid = JSON.stringify([{ ...base, artifacts: ["test-results/chromium/"] }]);
  const expected = "browser-coverage-mapping entry 0 has a non-explicit failure-artifact path";
  assert.deepEqual(validateBrowserCoverageMapping(invalid).issues, [expected]);

  const runtime = runBrowserMappingRuntime(invalid);
  assert.notEqual(runtime.status, 0);
  assert.equal(runtime.stderr.trim(), expected);

  const valid = JSON.stringify([{
    ...base,
    lcov: "coverage/e2e/chromium/lcov.info",
    artifacts: ["test-results/chromium"],
  }]);
  assert.deepEqual(validateBrowserCoverageMapping(valid).issues, []);
  assert.equal(runBrowserMappingRuntime(valid).status, 0);

  const directoryLikeLcov = JSON.stringify([{ ...base, lcov: "coverage/e2e/chromium/lcov.info/" }]);
  assert.deepEqual(validateBrowserCoverageMapping(directoryLikeLcov).issues, [
    "browser-coverage-mapping entry 0 needs one explicit LCOV file",
  ]);
  assert.equal(
    runBrowserMappingRuntime(directoryLikeLcov).stderr.trim(),
    "browser-coverage-mapping entry 0 needs one explicit LCOV file",
  );
});

test("runtime retains generic reports, all five mapped LCOVs, and mapped failure evidence", () => {
  const mapping = fixture("browser-ci.json").inputs["browser-coverage-mapping"];
  const result = runBrowserMappingRuntime(mapping);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.output, /browser-mapping-valid=true/);
  const retainedPaths = jsonOutput(result.output, "retained-coverage-paths-json");
  assert.deepEqual(retainedPaths.slice(0, 1), ["coverage.xml"]);
  for (const project of ["chromium", "firefox", "webkit", "iphone", "ipad"]) {
    assert.ok(retainedPaths.includes(`coverage/e2e/${project}/lcov.info`), `${project} LCOV must be retained`);
    assert.ok(retainedPaths.includes(`test-results/${project}`), `${project} test results must be retained`);
    assert.ok(retainedPaths.includes(`coverage/e2e/raw/${project}`), `${project} raw coverage must be retained`);
  }
  assert.equal(retainedPaths.length, 16);
});

test("retained-path JSON crosses the workflow output boundary when paths equal the former delimiter", () => {
  const browserMapping = JSON.stringify([{
    project: "chromium",
    lcov: "coverage/e2e/chromium/lcov.info",
    artifacts: ["RETAINED_COVERAGE_PATHS"],
  }]);
  const scenarios = [
    {
      name: "generic",
      coverageFiles: "RETAINED_COVERAGE_PATHS\ncoverage.xml",
      browserMapping: "",
    },
    {
      name: "browser",
      coverageFiles: "coverage.xml",
      browserMapping,
    },
  ];

  for (const scenario of scenarios) {
    const fixtureScenario = fixture("browser-ci.json");
    const rendered = renderCiContract(REUSABLE_CI, {
      ...fixtureScenario,
      inputs: {
        ...fixtureScenario.inputs,
        "browser-coverage-mapping": scenario.browserMapping,
        "coverage-files": scenario.coverageFiles,
      },
    });
    assert.deepEqual(rendered.issues, [], scenario.name);
    assert.ok(rendered.retainedCoveragePaths.includes("RETAINED_COVERAGE_PATHS"), scenario.name);

    const runtime = runInterfaceRuntime({
      browserMapping: scenario.browserMapping,
      coverageFiles: scenario.coverageFiles,
    });
    assert.equal(runtime.status, 0, runtime.stderr);
    assert.doesNotMatch(runtime.output, /<<RETAINED_COVERAGE_PATHS/);
    const retainedPaths = jsonOutput(runtime.output, "retained-coverage-paths-json");
    assert.deepEqual(retainedPaths, rendered.retainedCoveragePaths, scenario.name);

    const directory = mkdtempSync(resolve(tmpdir(), `groovemap-output-boundary-${scenario.name}-`));
    const workspace = resolve(directory, "workspace");
    const runnerTemp = resolve(directory, "runner-temp");
    try {
      mkdirSync(workspace, { recursive: true });
      mkdirSync(runnerTemp, { recursive: true });
      for (const retainedPath of retainedPaths) {
        const destination = resolve(workspace, retainedPath);
        mkdirSync(dirname(destination), { recursive: true });
        writeFileSync(destination, `${retainedPath}\n`);
      }
      const staged = runWorkflowPythonStep("Stage workspace-relative coverage evidence", {
        GITHUB_OUTPUT: resolve(directory, "github-output"),
        GITHUB_WORKSPACE: workspace,
        RETAINED_COVERAGE_PATHS_JSON: JSON.stringify(retainedPaths),
        RUNNER_TEMP: runnerTemp,
      });
      assert.equal(staged.status, 0, staged.stderr);
      const manifest = JSON.parse(
        readFileSync(resolve(runnerTemp, "groovemap-coverage-artifact/manifest.json"), "utf8"),
      );
      assert.deepEqual(manifest.retained_paths, rendered.retainedCoveragePaths, scenario.name);
      assert.ok(manifest.archived_paths.includes("RETAINED_COVERAGE_PATHS"), scenario.name);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }
});

test("runtime and model deduplicate overlap while preserving deterministic retained-path order", () => {
  const scenario = fixture("browser-ci.json");
  const firstLcov = "coverage/e2e/chromium/lcov.info";
  const coverageFiles = `coverage.xml\n${firstLcov}`;
  const rendered = renderCiContract(REUSABLE_CI, {
    ...scenario,
    inputs: { ...scenario.inputs, "coverage-files": coverageFiles },
  });
  const result = runInterfaceRuntime({
    browserMapping: scenario.inputs["browser-coverage-mapping"],
    coverageFiles,
  });
  assert.equal(result.status, 0, result.stderr);
  const runtimePaths = jsonOutput(result.output, "retained-coverage-paths-json");
  assert.deepEqual(runtimePaths, rendered.retainedCoveragePaths);
  assert.deepEqual(runtimePaths.slice(0, 4), [
    "coverage.xml",
    firstLcov,
    "test-results/chromium",
    "coverage/e2e/raw/chromium",
  ]);
  assert.equal(runtimePaths.filter((path) => path === firstLcov).length, 1);
  for (const { lcov } of rendered.browserUploads) assert.ok(runtimePaths.includes(lcov), lcov);
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

test("release artifact variants preserve default names and prevent multi-job collisions", () => {
  const scenario = fixture("container-release.json");
  const defaultRelease = renderReleaseContract(REUSABLE_RELEASE, scenario);
  assert.deepEqual(defaultRelease.issues, []);
  assert.equal(defaultRelease.artifactName, "fixture-container-v1.2.3");

  const primary = renderReleaseContract(REUSABLE_RELEASE, {
    ...scenario,
    expectedArtifactName: "fixture-container-v1.2.3-primary",
    inputs: { ...scenario.inputs, "artifact-variant": "primary" },
  });
  const performance = renderReleaseContract(REUSABLE_RELEASE, {
    ...scenario,
    expectedArtifactName: "fixture-container-v1.2.3-performance",
    inputs: { ...scenario.inputs, "artifact-variant": "performance" },
  });
  assert.deepEqual(primary.issues, []);
  assert.deepEqual(performance.issues, []);
  assert.notEqual(primary.artifactName, performance.artifactName);

  const defaultRuntime = runReleaseIdentityRuntime();
  const primaryRuntime = runReleaseIdentityRuntime({ artifactVariant: "primary" });
  const performanceRuntime = runReleaseIdentityRuntime({ artifactVariant: "performance" });
  assert.equal(defaultRuntime.status, 0, defaultRuntime.stderr);
  assert.equal(primaryRuntime.status, 0, primaryRuntime.stderr);
  assert.equal(performanceRuntime.status, 0, performanceRuntime.stderr);
  assert.match(defaultRuntime.output, /^artifact-name=fixture-container-v1\.2\.3$/m);
  assert.match(primaryRuntime.output, /^artifact-name=fixture-container-v1\.2\.3-primary$/m);
  assert.match(performanceRuntime.output, /^artifact-name=fixture-container-v1\.2\.3-performance$/m);
});

test("release artifact variants fail closed on unsafe or path-like suffixes", () => {
  const scenario = fixture("container-release.json");
  const invalidVariants = [
    " ",
    "Primary",
    "-primary",
    "primary-",
    "primary--performance",
    "primary_performance",
    "primary.performance",
    "primary/performance",
    "../primary",
    "primary\\performance",
  ];
  for (const artifactVariant of invalidVariants) {
    const rendered = renderReleaseContract(REUSABLE_RELEASE, {
      ...scenario,
      inputs: { ...scenario.inputs, "artifact-variant": artifactVariant },
    });
    assert.ok(
      rendered.issues.includes("artifact variant must be a lowercase hyphen-separated slug"),
      JSON.stringify(artifactVariant),
    );
    const runtime = runReleaseIdentityRuntime({ artifactVariant });
    assert.notEqual(runtime.status, 0, JSON.stringify(artifactVariant));
    assert.match(runtime.stdout, /artifact-variant must be a lowercase hyphen-separated slug/);
  }
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
    "if: always() && inputs.upload-codecov && steps.interface.outcome == 'success'",
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

test("rejects Codecov uploads that can discover reports beyond their validated explicit file list", () => {
  const genericSearchEnabled = REUSABLE_CI.replace(
    "files: ${{ steps.interface.outputs.codecov-files }}\n          flags: ${{ inputs.coverage-flags }}\n          disable_search: true",
    "files: ${{ steps.interface.outputs.codecov-files }}\n          flags: ${{ inputs.coverage-flags }}\n          disable_search: false",
  );
  const browserSearchEnabled = REUSABLE_CI.replace(
    "files: ${{ matrix.upload.lcov }}\n          flags: e2e-${{ matrix.upload.project }}\n          disable_search: true",
    "files: ${{ matrix.upload.lcov }}\n          flags: e2e-${{ matrix.upload.project }}\n          disable_search: false",
  );
  const implicitExtraUpload = REUSABLE_CI.replace(
    "  result:\n",
    "      - name: Upload discovered coverage to Codecov\n"
      + "        uses: codecov/codecov-action@fb8b3582c8e4def4969c97caa2f19720cb33a72f\n\n"
      + "  result:\n",
  );
  for (const source of [genericSearchEnabled, browserSearchEnabled, implicitExtraUpload]) {
    assert.notEqual(source, REUSABLE_CI);
    assert.ok(
      workflowContractIssues(".github/workflows/reusable-ci.yml", source).some(
        (issue) => issue.includes("explicit Codecov uploads") || issue.includes("disable_search: true"),
      ),
    );
  }

  const renderedGeneric = renderCiContract(genericSearchEnabled, fixture("browser-ci.json"));
  const renderedBrowsers = renderCiContract(browserSearchEnabled, fixture("browser-ci.json"));
  assert.equal(renderedGeneric.codecovUploads[0].disableSearch, false);
  assert.ok(renderedBrowsers.codecovUploads.slice(1).every((upload) => !upload.disableSearch));
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
      REUSABLE_RELEASE.replace("name: ${{ steps.identity.outputs.artifact-name }}", "name: synthetic-artifact"),
      "artifact identity",
    ],
    [
      REUSABLE_RELEASE.replace(
        '"${ARTIFACT_VARIANT}" =~ ^[a-z0-9]+(-[a-z0-9]+)*$',
        '"${ARTIFACT_VARIANT}" =~ .+',
      ),
      "artifact variant naming",
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

const BUILDKIT_CACHE_STEP_NAMES = [
  "Resolve BuildKit cache mounts",
  "Restore BuildKit cache mounts",
  "Inject BuildKit cache mounts",
];
const BUILDKIT_CACHE_MAPPING = JSON.stringify({
  "sccache-cache": "/root/.cache/sccache",
  "cargo-registry": "/usr/local/cargo/registry",
});

test("an unconfigured buildkit-cache-mounts leaves the release image build unchanged", () => {
  const scenario = fixture("container-release.json");
  const rendered = renderReleaseContract(REUSABLE_RELEASE, scenario);
  assert.deepEqual(rendered.issues, []);
  assert.equal(rendered.inputs["buildkit-cache-mounts"], "");
  assert.deepEqual(rendered.buildkitCacheMounts, []);
  assert.deepEqual(rendered.buildkitCachePaths, []);
  assert.equal(rendered.buildkitCacheKeyPrefix, "");
  for (const name of BUILDKIT_CACHE_STEP_NAMES) assert.ok(!rendered.steps.includes(name), name);
  assert.ok(rendered.steps.includes("Set up Docker Buildx"));
  assert.ok(rendered.steps.includes("Build and publish versioned image"));
  assert.ok(rendered.steps.includes("Attest published image"));
});

test("configured buildkit-cache-mounts inject and extract every named cache mount", () => {
  const scenario = fixture("container-release.json");
  const rendered = renderReleaseContract(REUSABLE_RELEASE, {
    ...scenario,
    inputs: { ...scenario.inputs, "buildkit-cache-mounts": BUILDKIT_CACHE_MAPPING },
  });
  assert.deepEqual(rendered.issues, []);
  assert.deepEqual(rendered.buildkitCachePaths, [".buildkit-cache/cargo-registry", ".buildkit-cache/sccache-cache"]);
  assert.deepEqual(rendered.buildkitCacheMap, {
    ".buildkit-cache/cargo-registry": "/usr/local/cargo/registry",
    ".buildkit-cache/sccache-cache": "/root/.cache/sccache",
  });
  assert.equal(rendered.buildkitCacheKeyPrefix, "buildkit-mounts-cargo-registry-sccache-cache");
  for (const name of BUILDKIT_CACHE_STEP_NAMES) assert.ok(rendered.steps.includes(name), name);
  const buildIndex = rendered.steps.indexOf("Build and publish versioned image");
  for (const name of BUILDKIT_CACHE_STEP_NAMES) assert.ok(rendered.steps.indexOf(name) < buildIndex, name);
  assert.ok(rendered.steps.indexOf("Set up Docker Buildx") < rendered.steps.indexOf(BUILDKIT_CACHE_STEP_NAMES[0]));

  const definition = parseWorkflowDefinition(REUSABLE_RELEASE);
  const steps = definition.jobs.flatMap((job) => job.steps);
  const restore = steps.find((step) => step.name === "Restore BuildKit cache mounts");
  const inject = steps.find((step) => step.name === "Inject BuildKit cache mounts");
  assert.match(restore.uses, /^actions\/cache@[a-f0-9]{40}$/);
  assert.match(inject.uses, /^reproducible-containers\/buildkit-cache-dance@[a-f0-9]{40}$/);
  assert.equal(restore.with.path, "${{ steps.buildkit-cache.outputs.paths }}");
  assert.ok(restore.with.key.includes("hashFiles(inputs.dockerfile)"));
  assert.ok(restore.with.key.includes("steps.buildkit-cache.outputs.key-prefix"));
  assert.match(restore.raw, /restore-keys: \|\n\s+\$\{\{ steps\.buildkit-cache\.outputs\.key-prefix \}\}-/);
  assert.equal(inject.with.builder, "${{ steps.buildx.outputs.name }}");
  assert.equal(inject.with["cache-map"], "${{ steps.buildkit-cache.outputs.cache-map }}");
  assert.equal(inject.with["skip-extraction"], "${{ steps.buildkit-cache-restore.outputs.cache-hit }}");
});

test("buildkit-cache-mounts requires image publication and a well-formed mapping", () => {
  const scenario = fixture("container-release.json");
  const invalid = [
    ["not-json", "buildkit-cache-mounts must be valid JSON"],
    ["[]", "buildkit-cache-mounts must be a nonempty JSON object"],
    ["{}", "buildkit-cache-mounts must be a nonempty JSON object"],
    ['{"Sccache": "/root/.cache/sccache"}', "buildkit-cache-mounts id must be a lowercase slug: Sccache"],
    ['{"sccache": "root/.cache/sccache"}', "buildkit-cache-mounts target must be an absolute container path: sccache"],
    ['{"sccache": "/root/../etc"}', "buildkit-cache-mounts target must be an absolute container path: sccache"],
    ['{"sccache": 7}', "buildkit-cache-mounts target must be an absolute container path: sccache"],
  ];
  for (const [mapping, expected] of invalid) {
    const rendered = renderReleaseContract(REUSABLE_RELEASE, {
      ...scenario,
      inputs: { ...scenario.inputs, "buildkit-cache-mounts": mapping },
    });
    assert.ok(rendered.issues.includes(expected), mapping);
    assert.deepEqual(validateBuildkitCacheMounts(mapping).issues.slice(0, 1), [expected]);
  }

  const withoutImage = renderReleaseContract(REUSABLE_RELEASE, {
    ...scenario,
    expectedImageName: "fixture-container",
    inputs: { ...scenario.inputs, "publish-image": false, "image-variant": "", "buildkit-cache-mounts": BUILDKIT_CACHE_MAPPING },
  });
  assert.ok(withoutImage.issues.includes("buildkit-cache-mounts requires publish-image"));
  assert.deepEqual(validateBuildkitCacheMounts("").issues, []);
});

test("rejects a release that drops or ungates its BuildKit cache-mount wiring", () => {
  const scenario = fixture("container-release.json");
  const configured = { ...scenario, inputs: { ...scenario.inputs, "buildkit-cache-mounts": BUILDKIT_CACHE_MAPPING } };
  const cases = [
    [
      REUSABLE_RELEASE.replace("      - name: Inject BuildKit cache mounts", "      - name: Omit BuildKit injection"),
      "missing the BuildKit cache-mount step: Inject BuildKit cache mounts",
    ],
    [
      REUSABLE_RELEASE.replaceAll(
        "if: inputs.publish-image && inputs.buildkit-cache-mounts != ''",
        "if: inputs.publish-image",
      ),
      "must be gated on publish-image and a nonempty mapping",
    ],
    [
      REUSABLE_RELEASE.replace("uses: actions/cache@", "uses: groovemap-music/cache@"),
      "must be restored with a pinned actions/cache",
    ],
    [
      REUSABLE_RELEASE.replace("uses: reproducible-containers/buildkit-cache-dance@", "uses: groovemap-music/cache-dance@"),
      "must be injected with a pinned buildkit-cache-dance",
    ],
    [
      REUSABLE_RELEASE.replace("hashFiles(inputs.dockerfile)", "github.sha"),
      "key must derive from the caller's Dockerfile hash",
    ],
    [
      REUSABLE_RELEASE.replace(
        "          restore-keys: |\n            ${{ steps.buildkit-cache.outputs.key-prefix }}-\n",
        "",
      ),
      "restore must fall back to the mount-id key prefix",
    ],
    [
      REUSABLE_RELEASE.replace(
        "skip-extraction: ${{ steps.buildkit-cache-restore.outputs.cache-hit }}",
        "skip-extraction: true",
      ),
      "extraction must be skipped on an exact cache hit",
    ],
  ];
  for (const [source, expected] of cases) {
    assert.notEqual(source, REUSABLE_RELEASE, expected);
    assert.ok(renderReleaseContract(source, configured).issues.some((issue) => issue.includes(expected)), expected);
  }

  const ungated = REUSABLE_RELEASE.replaceAll(
    "if: inputs.publish-image && inputs.buildkit-cache-mounts != ''",
    "if: inputs.publish-image",
  );
  assert.ok(
    workflowContractIssues(".github/workflows/reusable-release.yml", ungated).some((issue) => issue.includes("must be gated")),
  );
  const dropped = REUSABLE_RELEASE.replaceAll("buildkit-cache-mounts", "removed-cache-mounts");
  assert.ok(
    workflowContractIssues(".github/workflows/reusable-release.yml", dropped).some((issue) => issue.includes("buildkit-cache-mounts:")),
  );
});

test("the inline BuildKit cache resolver emits caller-safe paths and fails closed", () => {
  const valid = runBuildkitCacheRuntime(BUILDKIT_CACHE_MAPPING);
  assert.equal(valid.status, 0, valid.stderr);
  assert.match(valid.output, /^paths<<GROOVEMAP_BUILDKIT_PATHS$/m);
  assert.match(valid.output, /^\.buildkit-cache\/cargo-registry$/m);
  assert.match(valid.output, /^\.buildkit-cache\/sccache-cache$/m);
  assert.match(valid.output, /^key-prefix=buildkit-mounts-cargo-registry-sccache-cache$/m);
  const map = JSON.parse(
    valid.output.match(/cache-map<<GROOVEMAP_BUILDKIT_MAP\n([\s\S]*?)\nGROOVEMAP_BUILDKIT_MAP/)[1],
  );
  assert.deepEqual(map, {
    ".buildkit-cache/cargo-registry": "/usr/local/cargo/registry",
    ".buildkit-cache/sccache-cache": "/root/.cache/sccache",
  });

  for (const mapping of ["not-json", "[]", "{}", '{"Sccache": "/root/.cache/sccache"}', '{"sccache": "relative"}']) {
    const runtime = runBuildkitCacheRuntime(mapping);
    assert.notEqual(runtime.status, 0, mapping);
    assert.match(runtime.stdout, /::error::buildkit-cache-mounts/);
  }
});

const CACHE_STEPS = [
  "Install the Rust compiler cache",
  "Wrap cargo with the Rust compiler cache",
  "Report Rust compiler cache statistics",
];

test("rust callers wrap cargo with the pinned compiler cache before locked installation", () => {
  const scenario = fixture("rust-ci.json");
  const rendered = renderCiContract(REUSABLE_CI, scenario);
  assert.deepEqual(rendered.issues, []);
  assert.equal(rendered.inputs["rust-compiler-cache"], "auto");
  assert.equal(rendered.inputs["sccache-gha-version"], "");

  const steps = rendered.jobs.flatMap((job) => job.steps);
  for (const step of CACHE_STEPS) assert.ok(steps.includes(step), step);
  assert.ok(steps.indexOf("Install the Rust compiler cache") > steps.indexOf("Set up pinned repository tools"));
  assert.ok(steps.indexOf("Wrap cargo with the Rust compiler cache") < steps.indexOf("Install locked dependencies"));
  assert.equal(rendered.jobs.find((job) => job.id === "validate").steps.at(-1), "Report Rust compiler cache statistics");

  const dependencyUpdate = renderCiContract(REUSABLE_CI, { ...scenario, actor: "dependabot[bot]" });
  assert.deepEqual(dependencyUpdate.jobs, rendered.jobs);
});

test("auto covers rust only, on adds mixed, and off disables every ecosystem", () => {
  const expectations = {
    "rust-ci.json": { auto: true, on: true, off: false },
    "python-ci.json": { auto: false, on: false, off: false },
    "node-ci.json": { auto: false, on: false, off: false },
    "browser-ci.json": { auto: false, on: true, off: false },
    "container-ci.json": { auto: false, on: true, off: false },
  };

  for (const [name, byMode] of Object.entries(expectations)) {
    const scenario = fixture(name);
    assert.ok(!Object.hasOwn(scenario.inputs, "rust-compiler-cache"), `${name} declares no cache mode`);
    for (const [mode, enabled] of Object.entries(byMode)) {
      const inputs = mode === "auto" ? scenario.inputs : { ...scenario.inputs, "rust-compiler-cache": mode };
      const rendered = renderCiContract(REUSABLE_CI, { ...scenario, inputs });
      assert.deepEqual(rendered.issues, [], `${name} ${mode}`);
      const steps = rendered.jobs.flatMap((job) => job.steps);
      for (const step of CACHE_STEPS) assert.equal(steps.includes(step), enabled, `${name} ${mode} ${step}`);
    }
  }
});

test("rejects a compiler cache mode outside auto, on, and off", () => {
  const scenario = fixture("rust-ci.json");
  for (const mode of ["", "true", "yes", "Auto", "enabled"]) {
    const rendered = renderCiContract(REUSABLE_CI, {
      ...scenario,
      inputs: { ...scenario.inputs, "rust-compiler-cache": mode },
    });
    assert.ok(rendered.issues.includes("rust-compiler-cache must be auto, on, or off"), mode);
  }

  const interfaceStep = parseWorkflowDefinition(REUSABLE_CI)
    .jobs.flatMap((job) => job.steps)
    .find((candidate) => candidate.name === "Validate interface and fail closed");
  assert.ok(interfaceStep.raw.includes("RUST_COMPILER_CACHE: ${{ inputs.rust-compiler-cache }}"));
  assert.ok(interfaceStep.raw.includes("auto|on|off) ;;"));
  assert.ok(interfaceStep.raw.includes("rust-compiler-cache must be auto, on, or off"));

  for (const mode of ["auto", "on", "off"]) {
    assert.deepEqual(renderCiContract(REUSABLE_CI, {
      ...scenario,
      inputs: { ...scenario.inputs, "rust-compiler-cache": mode },
    }).issues, [], mode);
  }
});

test("the compiler cache exports its wrapper, backend, and optional cache namespace", () => {
  const step = parseWorkflowDefinition(REUSABLE_CI)
    .jobs.flatMap((job) => job.steps)
    .find((candidate) => candidate.name === "Wrap cargo with the Rust compiler cache");
  assert.ok(step, "the compiler cache export step must be present");
  assert.ok(step.raw.includes('echo "RUSTC_WRAPPER=sccache"'));
  assert.ok(step.raw.includes('echo "SCCACHE_GHA_ENABLED=true"'));
  assert.ok(step.raw.includes("SCCACHE_GHA_VERSION: ${{ inputs.sccache-gha-version }}"));
  assert.ok(step.raw.includes('if [[ -n "${SCCACHE_GHA_VERSION}" ]]; then'));

  const install = parseWorkflowDefinition(REUSABLE_CI)
    .jobs.flatMap((job) => job.steps)
    .find((candidate) => candidate.name === "Install the Rust compiler cache");
  assert.match(install.uses, /^mozilla-actions\/sccache-action@[a-f0-9]{40}$/);
  assert.equal(validateActionPin(`        uses: ${install.uses} # v0.0.11`), null);
});

test("rejects an unpinned, unversioned, or ungated Rust compiler cache", () => {
  const unversioned = "        uses: mozilla-actions/sccache-action@fc920bf0ec8de6ee65d409111f7ec508035751ba";
  assert.match(validateActionPin(unversioned), /released version in a trailing comment/);
  assert.match(validateActionPin("        uses: mozilla-actions/sccache-action@v0.0.11 # v0.0.11"), /immutable digest/);
  assert.equal(validateActionPin("        uses: ./.github/actions/setup-tools"), null);

  const gate = "        if: (inputs.language == 'rust' && inputs.rust-compiler-cache != 'off')"
    + " || (inputs.language == 'mixed' && inputs.rust-compiler-cache == 'on')\n";
  const ungated = REUSABLE_CI.replace(`      - name: Install the Rust compiler cache\n${gate}`, "      - name: Install the Rust compiler cache\n");
  assert.notEqual(ungated, REUSABLE_CI);
  const issues = workflowContractIssues(".github/workflows/reusable-ci.yml", ungated);
  assert.ok(issues.some((issue) => issue.includes("Install the Rust compiler cache") && issue.includes("must run with")));

  const unreported = REUSABLE_CI.replace("          sccache --show-stats\n", "          true\n");
  assert.notEqual(unreported, REUSABLE_CI);
  assert.ok(
    workflowContractIssues(".github/workflows/reusable-ci.yml", unreported)
      .some((issue) => issue.includes("sccache --show-stats")),
  );
});

test("cache statistics survive a failed validation step", () => {
  const definition = parseWorkflowDefinition(REUSABLE_CI);
  const step = definition.jobs
    .flatMap((job) => job.steps)
    .find((candidate) => candidate.name === "Report Rust compiler cache statistics");
  assert.ok(step.condition.startsWith("always() &&"));
  assert.ok(step.raw.includes("command -v sccache"));
});

test("current repository satisfies the complete shared automation contract", () => {
  assert.deepEqual(validate(), []);
});

// --- file enumeration honours git's ignore rules (gm-automation-yoa.2) ---

test("the exposure scan skips a locally git-ignored directory but still reports an unignored match", () => {
  const excludePath = spawnSync("git", ["rev-parse", "--git-path", "info/exclude"], {
    cwd: ROOT,
    encoding: "utf8",
  }).stdout.trim();
  const originalExclude = readFileSync(excludePath, "utf8");
  const ignoredDir = resolve(ROOT, ".tmp-validate-ignored-check");
  const visibleDir = resolve(ROOT, ".tmp-validate-visible-check");
  const ignoredMarker = ["customer", "id=ignored-741"].join("_");
  const visibleMarker = ["customer", "id=visible-741"].join("_");
  try {
    mkdirSync(ignoredDir, { recursive: true });
    writeFileSync(resolve(ignoredDir, "note.txt"), ignoredMarker);
    writeFileSync(excludePath, `${originalExclude}\n/.tmp-validate-ignored-check/\n`);

    mkdirSync(visibleDir, { recursive: true });
    writeFileSync(resolve(visibleDir, "note.txt"), visibleMarker);

    const errors = validate();
    assert.ok(!errors.some((error) => error.includes(".tmp-validate-ignored-check")));
    assert.ok(
      errors.some((error) => error.includes(".tmp-validate-visible-check") && error.includes("customer-record")),
    );
  } finally {
    writeFileSync(excludePath, originalExclude);
    rmSync(ignoredDir, { recursive: true, force: true });
    rmSync(visibleDir, { recursive: true, force: true });
  }
});
