import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { hasReferenceDependency, hasReferenceImport } from "./reference-isolation.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const win = process.platform === "win32";
const skipDirs = new Set([".git", "node_modules", "dist", "open"]);
const secretRe = [
  /AKIA[0-9A-Z]{16}/,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /ghp_[A-Za-z0-9]{36}/,
];
const importRe = /(?:from\s+|import\s*\(\s*)['"]([^'"]+)['"]/g;
let failed = false;

function fail(step, detail) {
  failed = true;
  console.error(`FAIL ${step}`);
  if (detail) {
    console.error(detail);
  }
}

function pass(step, detail) {
  console.log(`PASS ${step}${detail ? ` ${detail}` : ""}`);
}

function run(command, args) {
  const usesWindowsNpm = win && command === "npm";
  const exe = usesWindowsNpm ? process.env.ComSpec ?? "cmd.exe" : command;
  const commandArgs = usesWindowsNpm ? ["/d", "/s", "/c", "npm.cmd", ...args] : args;
  const result = spawnSync(exe, commandArgs, {
    cwd: root,
    stdio: "inherit",
    encoding: "utf8",
  });
  if (result.error) {
    console.error(result.error.message);
    return 1;
  }

  return result.status === null ? 1 : result.status;
}

function walkFiles(dir, acc = []) {
  if (!dir) {
    return acc;
  }

  let ents;

  try {
    ents = readdirSync(dir, { withFileTypes: true });
  } catch {
    return acc;
  }

  for (const ent of ents) {
    if (skipDirs.has(ent.name)) {
      continue;
    }

    const path = join(dir, ent.name);

    if (ent.isDirectory()) {
      walkFiles(path, acc);
    } else {
      acc.push(path);
    }
  }

  return acc;
}

function posix(path) {
  return relative(root, path).replaceAll("\\", "/");
}

const licenseCode = run(win ? "node.exe" : "node", [
  join(root, "scripts", "quality", "check-licenses.mjs"),
]);
if (licenseCode !== 0) {
  fail("5-license-fixtures", `exit ${licenseCode}`);
} else {
  pass("5-license-fixtures", "filename assert");
}

const loopDir = join(root, "src", "internal", "loop");
const hits = [];

for (const file of walkFiles(loopDir).filter((path) => path.endsWith(".ts"))) {
  const text = readFileSync(file, "utf8");
  for (const match of text.matchAll(importRe)) {
    const spec = match[1] ?? "";
    const parts = spec.split(/[\\/]/);
    if (parts.includes("adapters") || parts.includes("knowledge")) {
      hits.push(`${posix(file)}: ${spec}`);
    }
  }
}

if (hits.length > 0) {
  fail("4-loop-imports", hits.join("\n"));
} else {
  pass("4-loop-imports");
}

const srcHits = [];

for (const file of walkFiles(join(root, "src")).filter((path) => path.endsWith(".ts"))) {
  const text = readFileSync(file, "utf8");
  if (hasReferenceImport(text)) {
    srcHits.push(posix(file));
  }
}

if (hasReferenceDependency(readFileSync(join(root, "package.json"), "utf8"))) {
  srcHits.push("package.json");
}

if (srcHits.length > 0) {
  fail("isolation", srcHits.join("\n"));
} else {
  pass("isolation", "external research/archive and Desktop legacy compatibility remain excluded");
}

const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const deps = { ...pkg.dependencies, ...pkg.devDependencies };

pass("6-inventory", JSON.stringify(deps));

const problems = [];

for (const file of walkFiles(join(root, "src"))) {
  const st = statSync(file);
  if (st.size > 1_000_000) {
    problems.push(`large:${posix(file)}`);
  }

  if ([".exe", ".dll", ".bin"].includes(file.slice(file.lastIndexOf(".")).toLowerCase())) {
    problems.push(`binary:${posix(file)}`);
  }

  if ([".ts", ".json", ".md"].some((ext) => file.endsWith(ext))) {
    const text = readFileSync(file, "utf8");
    if (secretRe.some((re) => re.test(text))) {
      problems.push(`secret:${posix(file)}`);
    }
  }
}

if (problems.length > 0) {
  fail("8-secret-large", problems.join("\n"));
} else {
  pass("8-secret-large");
}

const nested = walkFiles(join(root, "src")).some((path) => path.includes("node_modules"));
if (nested) {
  fail("9-generated", "node_modules inside src");
} else {
  pass("9-generated");
}

const docs = [
  join(root, "docs", "02-分期工程产出", "P00-工程地基与质量门禁", "2026-09-12-N1-STATE.md"),
  join(root, "docs", "02-分期工程产出", "P00-工程地基与质量门禁", "ADR-0001-官方发行拓扑与核心工具链许可.md"),
];
const missing = docs.filter((path) => {
  try {
    statSync(path);
    return false;
  } catch {
    return true;
  }
});
if (missing.length > 0) {
  fail("10-docs", missing.map(posix).join(","));
} else {
  pass("10-docs");
}

const formatCode = run(win ? "node.exe" : "node", [
  join(root, "scripts", "quality", "format-check.mjs"),
]);
if (formatCode !== 0) {
  fail("1-format", `exit ${formatCode}`);
} else {
  pass("1-format");
}

const buildCode = run("npm", ["run", "build"]);
if (buildCode !== 0) {
  fail("2-tsc", `exit ${buildCode}`);
} else {
  pass("2-tsc");
}

const testCode = run("npm", ["test"]);
if (testCode !== 0) {
  fail("3-npm-test", `exit ${testCode}`);
} else {
  pass("3-npm-test");
}

if (failed) {
  process.exit(1);
}
