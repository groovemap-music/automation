import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const MIT_SHA256 = "38b811191c91cc9577669a398064070bfed40c462bd084b789de409144f1b129";
const ALLOWED_EXTERNAL_HOSTS = new Set(["github.com", "groovemap.music"]);
const REQUIRED_FILES = [
  ".github/CODEOWNERS",
  ".github/dependabot.yml",
  ".github/workflows/ci.yml",
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
  "docs/validation.md",
  "scripts/validate.mjs",
  "scripts/validate.test.mjs",
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
  const workflows = workflowPaths.map((path) => readFileSync(path, "utf8")).join("\n");
  for (const path of workflowPaths) {
    const content = readFileSync(path, "utf8");
    for (const match of content.matchAll(/^\s*(?:-\s*)?uses:\s*([^\s#]+)/gm)) {
      const issue = validateActionReference(match[1]);
      if (issue) errors.push(`${relative(ROOT, path)}: ${issue}`);
    }
  }

  const ci = readFileSync(resolve(ROOT, ".github/workflows/ci.yml"), "utf8");
  if (!ci.includes("permissions:\n  contents: read")) errors.push(".github/workflows/ci.yml: read-only contents permission is required");
  if (ci.includes("secrets.") || ci.includes("secrets: inherit")) errors.push(".github/workflows/ci.yml: foundation validation must not use secrets");

  const dependabot = readFileSync(resolve(ROOT, ".github/dependabot.yml"), "utf8");
  const ecosystems = detectEcosystems(ROOT, files, workflows);
  for (const ecosystem of ecosystems) {
    if (!dependabot.includes(`package-ecosystem: ${ecosystem}`)) errors.push(`.github/dependabot.yml: missing ${ecosystem} ecosystem`);
  }
  if (!dependabot.includes("labels: [dependencies, github-actions]")) {
    errors.push(".github/dependabot.yml: use the OpenTofu-managed dependencies and github-actions labels");
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
