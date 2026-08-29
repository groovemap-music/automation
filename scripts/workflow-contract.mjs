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
      steps.push({
        name: stepMatch[1].trim(),
        condition: raw.match(/^        if:\s*(.+)$/m)?.[1]?.trim() ?? "",
        uses: raw.match(/^        uses:\s*([^\s#]+)/m)?.[1] ?? "",
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

function inputConditionApplies(condition, inputs) {
  for (const comparison of condition.matchAll(/inputs\.([A-Za-z0-9_-]+)\s*(==|!=)\s*''/g)) {
    const blank = inputs[comparison[1]] === "" || inputs[comparison[1]] === undefined;
    if (comparison[2] === "==" ? !blank : blank) return false;
  }
  for (const reference of condition.matchAll(/(?:^|&&|\|\|)\s*inputs\.([A-Za-z0-9_-]+)(?=\s*(?:&&|\|\||$))/g)) {
    if (!inputs[reference[1]]) return false;
  }
  return true;
}

function conditionApplies(condition, inputs, actor) {
  if (!condition || condition === "always()") return true;
  return actorConditionApplies(condition, actor) && inputConditionApplies(condition, inputs);
}

export function renderCiContract(content, scenario) {
  const definition = parseWorkflowDefinition(content);
  const call = validateWorkflowCall(definition, scenario.inputs);
  const actor = scenario.actor ?? "synthetic-developer";
  const issues = [...call.issues];

  if (!new Set(["python", "rust", "node", "mixed"]).has(call.inputs.language)) {
    issues.push("language must be python, rust, node, or mixed");
  }
  if (call.inputs["requires-private-library"]) {
    if (!/^[0-9a-f]{40}$/.test(call.inputs["private-library-revision"] ?? "")) {
      issues.push("private-library revision must be a full lowercase commit SHA");
    }
  }
  if (call.inputs["e2e-command"] && !call.inputs["e2e-post-command"]) {
    issues.push("E2E post-processing is required when E2E is enabled");
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
  return { issues, inputs: call.inputs, jobs };
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
  const variant = call.inputs["image-variant"] ?? "";
  const imageName = variant ? `${repositoryName}-${variant}` : repositoryName;
  const artifactName = `${repositoryName}-${tag}`;

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
  if (!retainedStep.includes("name: ${{ inputs.repository-name }}-${{ github.ref_name }}")) {
    issues.push("release workflow is missing repository-derived artifact naming");
  }
  if (!metadataStep.includes("${{ steps.identity.outputs.image-name }}")) {
    issues.push("release workflow is missing the validated image identity");
  }

  if (scenario.eventName !== "push" || !/^refs\/tags\/v[0-9]/.test(scenario.ref ?? "")) {
    issues.push("release publication requires a pushed version tag");
  }
  if (repositoryName !== scenario.actualRepositoryName) issues.push("repository name drift detected");
  if (!/^[0-9a-f]{40}$/.test(scenario.revision ?? "")) issues.push("image revision must be a full lowercase commit SHA");
  if (scenario.expectedImageName && scenario.expectedImageName !== imageName) issues.push("repository/image name drift detected");
  if (scenario.expectedArtifactName && scenario.expectedArtifactName !== artifactName) {
    issues.push("repository/artifact name drift detected");
  }

  const evidence = releaseEvidence(definition, call.inputs["publish-image"] === true);
  const requiredEvidence = ["checksums", "legal-notices", "sbom", "artifact-provenance"];
  if (call.inputs["publish-image"] === true) requiredEvidence.push("image-sbom-provenance", "image-registry-attestation");
  for (const item of requiredEvidence) {
    if (!evidence.has(item)) issues.push(`missing release evidence: ${item}`);
  }

  return { issues, inputs: call.inputs, artifactName, imageName, evidence: [...evidence].sort() };
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
