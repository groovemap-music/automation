function parseScalar(value) {
  const trimmed = value.trim().replace(/\s+#.*$/, "");
  if (trimmed === "true") return true;
  if (trimmed === "false") return false;
  if (trimmed === "\"\"" || trimmed === "''") return "";
  if (/^(["']).*\1$/.test(trimmed)) return trimmed.slice(1, -1);
  return trimmed;
}

function parseCallEntries(lines, section) {
  const entries = new Map();
  let activeSection = "";
  let current = null;

  for (const line of lines) {
    const sectionMatch = line.match(/^    (inputs|secrets):\s*$/);
    if (sectionMatch) {
      activeSection = sectionMatch[1];
      current = null;
      continue;
    }
    if (/^    \S/.test(line) && !/^      /.test(line)) {
      activeSection = "";
      current = null;
    }
    if (activeSection !== section) continue;

    const entryMatch = line.match(/^      ([A-Za-z0-9_-]+):\s*$/);
    if (entryMatch) {
      current = { name: entryMatch[1], required: false };
      entries.set(current.name, current);
      continue;
    }
    const propertyMatch = line.match(/^        (description|required|default|type):\s*(.*)$/);
    if (current && propertyMatch) current[propertyMatch[1]] = parseScalar(propertyMatch[2]);
  }
  return entries;
}

function parseJobs(content) {
  const jobs = [];
  const jobsStart = content.search(/^jobs:\s*$/m);
  if (jobsStart < 0) return jobs;
  const source = content.slice(jobsStart);
  const matches = [...source.matchAll(/^  ([A-Za-z0-9_-]+):\s*$/gm)];

  for (let index = 0; index < matches.length; index += 1) {
    const match = matches[index];
    const block = source.slice(match.index, matches[index + 1]?.index ?? source.length);
    const name = block.match(/^    name:\s*(.+)$/m)?.[1]?.trim() ?? match[1];
    const condition = block.match(/^    if:\s*(.+)$/m)?.[1]?.trim() ?? "";
    const needs = block.match(/^    needs:\s*(.+)$/m)?.[1]?.trim() ?? "";
    const steps = [];
    const stepMatches = [...block.matchAll(/^      - name:\s*(.+)$/gm)];
    for (let stepIndex = 0; stepIndex < stepMatches.length; stepIndex += 1) {
      const stepMatch = stepMatches[stepIndex];
      const raw = block.slice(stepMatch.index, stepMatches[stepIndex + 1]?.index ?? block.length);
      const withInputs = {};
      let inWith = false;
      for (const line of raw.split("\n")) {
        if (/^        with:\s*$/.test(line)) {
          inWith = true;
          continue;
        }
        if (inWith && /^        \S/.test(line) && !/^          /.test(line)) break;
        if (!inWith) continue;
        const input = line.match(/^          ([A-Za-z0-9_-]+):\s*(.*)$/);
        if (input) withInputs[input[1]] = parseScalar(input[2]);
      }
      steps.push({
        name: stepMatch[1].trim(),
        condition: raw.match(/^        if:\s*(.+)$/m)?.[1]?.trim() ?? "",
        uses: raw.match(/^        uses:\s*([^\s#]+)/m)?.[1] ?? "",
        with: withInputs,
        raw,
      });
    }
    jobs.push({ id: match[1], name, condition, needs, steps, raw: block });
  }
  return jobs;
}

export function parseWorkflowDefinition(content) {
  const lines = content.split("\n");
  const inputs = parseCallEntries(lines, "inputs");
  const secrets = parseCallEntries(lines, "secrets");
  const inputReferences = new Set([...content.matchAll(/\binputs\.([A-Za-z0-9_-]+)/g)].map((match) => match[1]));
  return { content, inputs, secrets, inputReferences, jobs: parseJobs(content) };
}

export function validateWorkflowSource(content) {
  const issues = [];
  const definition = parseWorkflowDefinition(content);
  if (/^\s*secrets:\s*inherit\s*(?:#.*)?$/m.test(content)) issues.push("unscoped secret inheritance is prohibited");
  for (const input of definition.inputReferences) {
    if (!definition.inputs.has(input)) issues.push(`workflow references undeclared input: ${input}`);
  }
  return issues;
}

export function validateWorkflowCall(definition, suppliedInputs) {
  const issues = [];
  const normalized = {};

  for (const name of Object.keys(suppliedInputs)) {
    if (!definition.inputs.has(name)) issues.push(`undeclared workflow input: ${name}`);
  }
  for (const name of definition.inputReferences) {
    if (!definition.inputs.has(name)) issues.push(`workflow references undeclared input: ${name}`);
  }

  for (const [name, declaration] of definition.inputs) {
    const supplied = Object.hasOwn(suppliedInputs, name);
    const value = supplied ? suppliedInputs[name] : declaration.default;
    normalized[name] = value;
    if (declaration.required && (!supplied || (typeof value === "string" && value.trim() === ""))) {
      issues.push(`required workflow input is missing or blank: ${name}`);
    }
    if (supplied && declaration.type === "boolean" && typeof value !== "boolean") {
      issues.push(`workflow input must be boolean: ${name}`);
    }
    if (supplied && declaration.type === "string" && typeof value !== "string") {
      issues.push(`workflow input must be string: ${name}`);
    }
  }

  return { issues, inputs: normalized };
}

function actorConditionApplies(condition, actor) {
  const unequal = condition.match(/github\.actor\s*!=\s*['"]([^'"]+)['"]/);
  if (unequal) return actor !== unequal[1];
  const equal = condition.match(/github\.actor\s*==\s*['"]([^'"]+)['"]/);
  if (equal) return actor === equal[1];
  return true;
}

function splitTopLevel(expression, operator) {
  const parts = [];
  let depth = 0;
  let start = 0;
  for (let index = 0; index < expression.length; index += 1) {
    const character = expression[index];
    if (character === "(") depth += 1;
    else if (character === ")") depth -= 1;
    else if (depth === 0 && expression.startsWith(operator, index)) {
      parts.push(expression.slice(start, index));
      index += operator.length - 1;
      start = index + 1;
    }
  }
  parts.push(expression.slice(start));
  return parts;
}

function isWrappedInParentheses(expression) {
  if (!expression.startsWith("(") || !expression.endsWith(")")) return false;
  let depth = 0;
  for (let index = 0; index < expression.length; index += 1) {
    if (expression[index] === "(") depth += 1;
    else if (expression[index] === ")") {
      depth -= 1;
      if (depth === 0) return index === expression.length - 1;
    }
  }
  return false;
}

// A leaf that names no workflow input (always(), steps.*, needs.*, github.*) stays neutral so
// input-driven rendering never depends on runtime-only context.
function inputLeafApplies(leaf, inputs) {
  if (!leaf.includes("inputs.")) return true;
  const comparison = leaf.match(/^inputs\.([A-Za-z0-9_-]+)\s*(==|!=)\s*'([^']*)'$/);
  if (comparison) {
    const value = inputs[comparison[1]];
    const matches = (value === undefined || value === null ? "" : String(value)) === comparison[3];
    return comparison[2] === "==" ? matches : !matches;
  }
  const reference = leaf.match(/^(!?)inputs\.([A-Za-z0-9_-]+)$/);
  if (reference) {
    const truthy = Boolean(inputs[reference[2]]);
    return reference[1] === "!" ? !truthy : truthy;
  }
  return true;
}

function inputConditionApplies(condition, inputs) {
  const expression = condition.trim();
  const disjuncts = splitTopLevel(expression, "||");
  if (disjuncts.length > 1) return disjuncts.some((part) => inputConditionApplies(part, inputs));
  const conjuncts = splitTopLevel(expression, "&&");
  if (conjuncts.length > 1) return conjuncts.every((part) => inputConditionApplies(part, inputs));
  if (isWrappedInParentheses(expression)) return inputConditionApplies(expression.slice(1, -1), inputs);
  return inputLeafApplies(expression, inputs);
}

function conditionApplies(condition, inputs, actor) {
  if (!condition || condition === "always()") return true;
  return actorConditionApplies(condition, actor) && inputConditionApplies(condition, inputs);
}

function isExplicitRelativePath(value, { lcov = false } = {}) {
  if (typeof value !== "string" || value === "" || value !== value.trim()) return false;
  if (
    /[\r\n,\\*?[\]{}]/.test(value)
    || value.startsWith("/")
    || value.startsWith("./")
    || value.startsWith("!")
    || value.endsWith("/")
  ) return false;
  if (value.split("/").includes("..")) return false;
  if (value === "." || value.split("/").includes(".") || value.includes("//")) return false;
  return !lcov || /\.(?:info|lcov)$/.test(value);
}

export function validateCoverageFiles(raw) {
  if (typeof raw !== "string") {
    return { issues: ["coverage-files must be a newline-separated string"], paths: [], codecovFiles: "" };
  }
  const paths = raw.split(/\r?\n/);
  if (paths.at(-1) === "") paths.pop();
  const issues = [];
  const seen = new Set();
  if (paths.length === 0) issues.push("coverage-files must contain at least one explicit path");
  for (const [index, path] of paths.entries()) {
    if (!isExplicitRelativePath(path)) {
      issues.push(`coverage-files entry ${index} is not an explicit repository-relative path`);
    } else if (seen.has(path)) {
      issues.push(`coverage-files contains duplicate path: ${path}`);
    } else {
      seen.add(path);
    }
  }
  return { issues, paths, codecovFiles: issues.length === 0 ? paths.join(",") : "" };
}

export function validateBrowserCoverageMapping(raw) {
  const issues = [];
  if (raw === "" || raw === undefined) {
    return { issues, uploads: [], artifactPaths: [], lcovPaths: [], retainedPaths: [] };
  }
  if (typeof raw !== "string") {
    return {
      issues: ["browser-coverage-mapping must be a JSON string"],
      uploads: [],
      artifactPaths: [],
      lcovPaths: [],
      retainedPaths: [],
    };
  }

  let mapping;
  try {
    mapping = JSON.parse(raw);
  } catch {
    return {
      issues: ["browser-coverage-mapping must be valid JSON"],
      uploads: [],
      artifactPaths: [],
      lcovPaths: [],
      retainedPaths: [],
    };
  }
  if (!Array.isArray(mapping) || mapping.length === 0) {
    return {
      issues: ["browser-coverage-mapping must be a nonempty JSON array"],
      uploads: [],
      artifactPaths: [],
      lcovPaths: [],
      retainedPaths: [],
    };
  }

  const projects = new Set();
  const lcovPaths = new Set();
  const artifactPaths = new Set();
  const uploads = [];
  const retainedPaths = [];
  const retainedPathSet = new Set();
  const retain = (path) => {
    if (!retainedPathSet.has(path)) {
      retainedPathSet.add(path);
      retainedPaths.push(path);
    }
  };
  for (const [index, entry] of mapping.entries()) {
    if (
      !entry
      || typeof entry !== "object"
      || Array.isArray(entry)
      || Object.keys(entry).sort().join("\0") !== ["artifacts", "lcov", "project"].join("\0")
    ) {
      issues.push(`browser-coverage-mapping entry ${index} must contain exactly project, lcov, and artifacts`);
      continue;
    }

    const { project, lcov, artifacts } = entry;
    if (typeof project !== "string" || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(project)) {
      issues.push(`browser-coverage-mapping entry ${index} has an invalid project flag`);
    } else if (projects.has(project)) {
      issues.push(`browser-coverage-mapping contains duplicate project: ${project}`);
    } else {
      projects.add(project);
    }
    if (!isExplicitRelativePath(lcov, { lcov: true })) {
      issues.push(`browser-coverage-mapping entry ${index} needs one explicit LCOV file`);
    } else if (lcovPaths.has(lcov)) {
      issues.push(`browser-coverage-mapping contains duplicate LCOV file: ${lcov}`);
    } else {
      lcovPaths.add(lcov);
      retain(lcov);
    }
    if (!Array.isArray(artifacts) || artifacts.length === 0) {
      issues.push(`browser-coverage-mapping entry ${index} needs failure-artifact paths`);
    } else {
      for (const artifact of artifacts) {
        if (!isExplicitRelativePath(artifact)) {
          issues.push(`browser-coverage-mapping entry ${index} has a non-explicit failure-artifact path`);
        } else if (artifactPaths.has(artifact)) {
          issues.push(`browser-coverage-mapping contains duplicate artifact path: ${artifact}`);
        } else {
          artifactPaths.add(artifact);
          retain(artifact);
        }
      }
    }
    uploads.push({ project, lcov, flag: `e2e-${project}` });
  }

  return {
    issues,
    uploads,
    artifactPaths: [...artifactPaths],
    lcovPaths: [...lcovPaths],
    retainedPaths,
  };
}

export function validateBuildkitCacheMounts(raw) {
  if (raw === "" || raw === undefined) return { issues: [], mounts: [], cacheMap: {}, paths: [], keyPrefix: "" };
  if (typeof raw !== "string") {
    return { issues: ["buildkit-cache-mounts must be a JSON string"], mounts: [], cacheMap: {}, paths: [], keyPrefix: "" };
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { issues: ["buildkit-cache-mounts must be valid JSON"], mounts: [], cacheMap: {}, paths: [], keyPrefix: "" };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed) || Object.keys(parsed).length === 0) {
    return {
      issues: ["buildkit-cache-mounts must be a nonempty JSON object"],
      mounts: [],
      cacheMap: {},
      paths: [],
      keyPrefix: "",
    };
  }

  const issues = [];
  const mounts = [];
  const cacheMap = {};
  const paths = [];
  for (const identifier of Object.keys(parsed).sort()) {
    const target = parsed[identifier];
    if (!/^[a-z0-9]+(?:[._-][a-z0-9]+)*$/.test(identifier)) {
      issues.push(`buildkit-cache-mounts id must be a lowercase slug: ${identifier}`);
      continue;
    }
    if (typeof target !== "string" || !target.startsWith("/") || target.split("/").includes("..") || target.trim() !== target) {
      issues.push(`buildkit-cache-mounts target must be an absolute container path: ${identifier}`);
      continue;
    }
    const path = `.buildkit-cache/${identifier}`;
    mounts.push({ id: identifier, target, path });
    cacheMap[path] = target;
    paths.push(path);
  }

  const keyPrefix = issues.length === 0 ? `buildkit-mounts-${Object.keys(parsed).sort().join("-")}` : "";
  return { issues, mounts, cacheMap, paths, keyPrefix };
}

export function renderCiContract(content, scenario) {
  const definition = parseWorkflowDefinition(content);
  const call = validateWorkflowCall(definition, scenario.inputs);
  const actor = scenario.actor ?? "synthetic-developer";
  const issues = [...call.issues];

  if (!new Set(["python", "rust", "node", "mixed"]).has(call.inputs.language)) {
    issues.push("language must be python, rust, node, or mixed");
  }
  if (!new Set(["auto", "on", "off"]).has(call.inputs["rust-compiler-cache"])) {
    issues.push("rust-compiler-cache must be auto, on, or off");
  }
  if (call.inputs["requires-private-library"]) {
    if (!/^[0-9a-f]{40}$/.test(call.inputs["private-library-revision"] ?? "")) {
      issues.push("private-library revision must be a full lowercase commit SHA");
    }
  }
  if (call.inputs["e2e-command"] && !call.inputs["e2e-post-command"]) {
    issues.push("E2E post-processing is required when E2E is enabled");
  }
  const browserCoverage = validateBrowserCoverageMapping(call.inputs["browser-coverage-mapping"]);
  issues.push(...browserCoverage.issues);
  const genericCoverage = validateCoverageFiles(call.inputs["coverage-files"]);
  issues.push(...genericCoverage.issues);
  if (call.inputs["browser-coverage-mapping"] && !call.inputs["e2e-command"]) {
    issues.push("E2E command is required when browser coverage is configured");
  }

  const jobs = definition.jobs
    .filter((job) => conditionApplies(job.condition, call.inputs, actor))
    .map((job) => ({
      id: job.id,
      name: job.name,
      needs: job.needs,
      steps: job.steps
        .filter((step) => conditionApplies(step.condition, call.inputs, actor))
        .map((step) => step.name),
    }));
  const retainedCoveragePaths = [];
  const retainedCoveragePathSet = new Set();
  for (const path of [...genericCoverage.paths, ...browserCoverage.retainedPaths]) {
    if (!retainedCoveragePathSet.has(path)) {
      retainedCoveragePathSet.add(path);
      retainedCoveragePaths.push(path);
    }
  }
  const validateJob = definition.jobs.find((job) => job.id === "validate");
  const genericUploadStep = validateJob?.steps.find((step) => step.name === "Upload coverage to Codecov");
  const browserJob = definition.jobs.find((job) => job.id === "browser-codecov");
  const browserUploadStep = browserJob?.steps.find((step) => step.name === "Upload browser coverage to Codecov");
  const codecovUploads = [];
  if (call.inputs["upload-codecov"]) {
    codecovUploads.push({
      scope: "generic",
      files: genericCoverage.paths,
      flags: call.inputs["coverage-flags"],
      disableSearch: genericUploadStep?.with.disable_search === true,
    });
    for (const upload of browserCoverage.uploads) {
      codecovUploads.push({
        scope: upload.project,
        files: [upload.lcov],
        flags: upload.flag,
        disableSearch: browserUploadStep?.with.disable_search === true,
      });
    }
  }
  return {
    issues,
    inputs: call.inputs,
    jobs,
    browserUploads: browserCoverage.uploads,
    browserArtifactPaths: browserCoverage.artifactPaths,
    browserLcovPaths: browserCoverage.lcovPaths,
    coverageArtifactPaths: genericCoverage.paths,
    retainedCoveragePaths,
    codecovFiles: genericCoverage.codecovFiles,
    codecovUploads,
  };
}

function releaseEvidence(definition, publishImage) {
  const steps = definition.jobs.flatMap((job) => job.steps);
  const named = (name) => steps.find((step) => step.name === name);
  const verify = named("Verify checksums, notices, SBOM, and artifact set")?.raw ?? "";
  const retained = named("Retain repository-named release artifact")?.raw ?? "";
  const artifactAttestation = named("Attest release artifacts");
  const imageBuild = named("Build and publish versioned image")?.raw ?? "";
  const imageAttestation = named("Attest published image");
  const evidence = new Set();

  if (verify.includes("sha256sum --check") && retained.includes("inputs.checksums-path")) evidence.add("checksums");
  if (verify.includes("NOTICES_PATH") && retained.includes("inputs.notices-path")) evidence.add("legal-notices");
  if (verify.includes("SBOM_PATH") && retained.includes("inputs.sbom-path")) evidence.add("sbom");
  if (artifactAttestation?.uses.startsWith("actions/attest-build-provenance@")) evidence.add("artifact-provenance");
  if (publishImage && imageBuild.includes("provenance: mode=max") && imageBuild.includes("sbom: true")) {
    evidence.add("image-sbom-provenance");
  }
  if (publishImage && imageAttestation?.uses.startsWith("actions/attest-build-provenance@")) {
    evidence.add("image-registry-attestation");
  }
  return evidence;
}

const BUILDKIT_CACHE_STEPS = ["Resolve BuildKit cache mounts", "Restore BuildKit cache mounts", "Inject BuildKit cache mounts"];

function buildkitCacheIssues(steps, mounts) {
  const issues = [];
  const named = (name) => steps.find((step) => step.name === name);
  for (const name of BUILDKIT_CACHE_STEPS) {
    const step = named(name);
    if (!step) {
      issues.push(`release workflow is missing the BuildKit cache-mount step: ${name}`);
      continue;
    }
    if (!step.condition.includes("inputs.publish-image") || !step.condition.includes("inputs.buildkit-cache-mounts != ''")) {
      issues.push(`BuildKit cache-mount step must be gated on publish-image and a nonempty mapping: ${name}`);
    }
  }
  const restore = named("Restore BuildKit cache mounts");
  const inject = named("Inject BuildKit cache mounts");
  if (restore && !restore.uses.startsWith("actions/cache@")) {
    issues.push("BuildKit cache mounts must be restored with a pinned actions/cache");
  }
  if (restore && !`${restore.with.key ?? ""}`.includes("hashFiles(inputs.dockerfile)")) {
    issues.push("BuildKit cache-mount key must derive from the caller's Dockerfile hash");
  }
  if (restore && !/restore-keys:\s*\|\s*\n\s*\$\{\{ steps\.buildkit-cache\.outputs\.key-prefix \}\}-\s*$/m.test(restore.raw)) {
    issues.push("BuildKit cache-mount restore must fall back to the mount-id key prefix");
  }
  if (inject && !inject.uses.startsWith("reproducible-containers/buildkit-cache-dance@")) {
    issues.push("BuildKit cache mounts must be injected with a pinned buildkit-cache-dance");
  }
  if (inject && inject.with["cache-map"] !== "${{ steps.buildkit-cache.outputs.cache-map }}") {
    issues.push("BuildKit cache-mount injection must consume the resolved cache map");
  }
  if (inject && inject.with["skip-extraction"] !== "${{ steps.buildkit-cache-restore.outputs.cache-hit }}") {
    issues.push("BuildKit cache-mount extraction must be skipped on an exact cache hit");
  }
  if (mounts.length > 0 && !inject) issues.push("configured BuildKit cache mounts have no injection step");
  return issues;
}

export function renderReleaseContract(content, scenario) {
  const definition = parseWorkflowDefinition(content);
  const call = validateWorkflowCall(definition, scenario.inputs);
  const issues = [...call.issues];
  const steps = definition.jobs.flatMap((job) => job.steps);
  const identityStep = steps.find((step) => step.name === "Enforce version-tag trigger and repository identity")?.raw ?? "";
  const retainedStep = steps.find((step) => step.name === "Retain repository-named release artifact")?.raw ?? "";
  const metadataStep = steps.find((step) => step.name === "Generate version-only image metadata")?.raw ?? "";
  const repositoryName = call.inputs["repository-name"];
  const tag = scenario.ref?.replace(/^refs\/tags\//, "") ?? "";
  const imageVariant = call.inputs["image-variant"] ?? "";
  const artifactVariant = call.inputs["artifact-variant"] ?? "";
  const imageName = imageVariant ? `${repositoryName}-${imageVariant}` : repositoryName;
  const artifactName = `${repositoryName}-${tag}${artifactVariant ? `-${artifactVariant}` : ""}`;

  if (!identityStep.includes('"${EVENT_NAME}" != "push"') || !identityStep.includes("^refs/tags/v[0-9]")) {
    issues.push("release workflow is missing its pushed-version-tag guard");
  }
  if (!identityStep.includes('"${REPOSITORY_NAME}" != "${ACTUAL_REPOSITORY_NAME}"')) {
    issues.push("release workflow is missing its repository identity guard");
  }
  if (!identityStep.includes('"${REVISION}" =~ ^[0-9a-f]{40}$')) {
    issues.push("release workflow is missing its immutable image revision guard");
  }
  if (!identityStep.includes('image_name="${REPOSITORY_NAME}-${IMAGE_VARIANT}"')) {
    issues.push("release workflow is missing repository-derived image naming");
  }
  if (
    !identityStep.includes('"${ARTIFACT_VARIANT}" =~ ^[a-z0-9]+(-[a-z0-9]+)*$')
    || !identityStep.includes('artifact_name="${artifact_name}-${ARTIFACT_VARIANT}"')
  ) {
    issues.push("release workflow is missing validated artifact variant naming");
  }
  if (!retainedStep.includes("name: ${{ steps.identity.outputs.artifact-name }}")) {
    issues.push("release workflow is missing the validated artifact identity");
  }
  if (!metadataStep.includes("${{ steps.identity.outputs.image-name }}")) {
    issues.push("release workflow is missing the validated image identity");
  }

  if (scenario.eventName !== "push" || !/^refs\/tags\/v[0-9]/.test(scenario.ref ?? "")) {
    issues.push("release publication requires a pushed version tag");
  }
  if (repositoryName !== scenario.actualRepositoryName) issues.push("repository name drift detected");
  if (!/^[0-9a-f]{40}$/.test(scenario.revision ?? "")) issues.push("image revision must be a full lowercase commit SHA");
  if (artifactVariant !== "" && !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(artifactVariant)) {
    issues.push("artifact variant must be a lowercase hyphen-separated slug");
  }
  if (scenario.expectedImageName && scenario.expectedImageName !== imageName) issues.push("repository/image name drift detected");
  if (scenario.expectedArtifactName && scenario.expectedArtifactName !== artifactName) {
    issues.push("repository/artifact name drift detected");
  }

  const buildkit = validateBuildkitCacheMounts(call.inputs["buildkit-cache-mounts"]);
  issues.push(...buildkit.issues);
  issues.push(...buildkitCacheIssues(steps, buildkit.mounts));
  if (buildkit.mounts.length > 0 && call.inputs["publish-image"] !== true) {
    issues.push("buildkit-cache-mounts requires publish-image");
  }

  const evidence = releaseEvidence(definition, call.inputs["publish-image"] === true);
  const requiredEvidence = ["checksums", "legal-notices", "sbom", "artifact-provenance"];
  if (call.inputs["publish-image"] === true) requiredEvidence.push("image-sbom-provenance", "image-registry-attestation");
  for (const item of requiredEvidence) {
    if (!evidence.has(item)) issues.push(`missing release evidence: ${item}`);
  }

  const renderedSteps = steps
    .filter((step) => conditionApplies(step.condition, call.inputs, scenario.actor ?? "synthetic-developer"))
    .map((step) => step.name);

  return {
    issues,
    inputs: call.inputs,
    artifactName,
    imageName,
    evidence: [...evidence].sort(),
    steps: renderedSteps,
    buildkitCacheMounts: buildkit.mounts,
    buildkitCacheMap: buildkit.cacheMap,
    buildkitCachePaths: buildkit.paths,
    buildkitCacheKeyPrefix: buildkit.keyPrefix,
  };
}

export function validateDependabotLabels(content, expectedLabels) {
  const issues = [];
  const starts = [...content.matchAll(/^  - package-ecosystem:\s*([^\s#]+)/gm)];
  for (let index = 0; index < starts.length; index += 1) {
    const start = starts[index];
    const ecosystem = start[1];
    const block = content.slice(start.index, starts[index + 1]?.index ?? content.length);
    const labelLine = block.match(/^    labels:\s*\[([^\]]*)\]\s*$/m);
    if (!labelLine) {
      issues.push(`Dependabot ${ecosystem} labels must use the declared exact set`);
      continue;
    }
    const actual = labelLine[1].split(",").map((label) => label.trim().replace(/^['"]|['"]$/g, "")).filter(Boolean);
    const expected = [...expectedLabels];
    if (actual.length !== new Set(actual).size || actual.sort().join("\0") !== expected.sort().join("\0")) {
      issues.push(`Dependabot ${ecosystem} labels must be exactly: ${expectedLabels.join(", ")}`);
    }
  }
  return issues;
}
