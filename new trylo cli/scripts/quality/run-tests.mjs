import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import {
  discoverRunnableTests,
  isStaleDistTest,
  listDistTestFiles,
} from "./discover-tests.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const srcRoot = join(root, "src");
const distRoot = join(root, "dist");
const win = process.platform === "win32";

function run(command, args) {
  const exe = win && command === "npm" ? "npm.cmd" : command;
  const result = spawnSync(exe, args, {
    cwd: root,
    stdio: "inherit",
        shell: win && command === "npm",
    encoding: "utf8",
  });
  if (result.error) {
    console.error(result.error.message);
    return 1;
  }

  return result.status === null ? 1 : result.status;
}

const cleanCode = run(process.execPath, [join(root, "scripts", "quality", "clean-dist.mjs")]);
if (cleanCode !== 0) {
  process.exit(cleanCode);
}

const buildCode = run("npm", ["run", "build"]);
if (buildCode !== 0) {
  process.exit(buildCode);
}

const args = process.argv.slice(2);
let layer = "hermetic";

for (const arg of args) {
  if (arg.startsWith("--layer=")) {
    layer = arg.slice("--layer=".length);
  } else if (arg === "--platform") {
    layer = "platform";
  } else if (arg === "--real") {
    layer = "real";
  } else if (arg === "--all") {
    layer = "all";
  } else if (arg === "--hermetic") {
    layer = "hermetic";
  }
}

const runnable = discoverRunnableTests(srcRoot, distRoot, layer);
const missing = runnable.filter((item) => !existsSync(item.distFile));
if (missing.length > 0) {
  console.error("FAIL test-discovery: compiled test missing");
  for (const item of missing) {
    console.error(relative(root, item.srcFile).replaceAll("\\", "/"));
  }
  process.exit(1);
}

const stale = listDistTestFiles(distRoot).filter((file) =>
  isStaleDistTest(file, srcRoot, distRoot),
);
if (stale.length > 0) {
  console.error("FAIL test-discovery: stale dist tests would have been executed by old glob");
  for (const file of stale) {
    console.error(relative(root, file).replaceAll("\\", "/"));
  }
  process.exit(1);
}

const distFiles = runnable.map((item) => item.distFile);
const extra =
  layer === "hermetic" || layer === "all"
    ? [join(root, "scripts", "quality", "stale-artifact.test.mjs")]
    : [];
const all = [...distFiles, ...extra];

console.log(`TEST-DISCOVERY (layer=${layer})`);

console.log(`count=${all.length}`);

for (const file of all) {
  console.log(relative(root, file).replaceAll("\\", "/"));
}

mkdirSync(join(root, "dist"), { recursive: true });

const tapPath = join(root, "dist", `tests${layer === "hermetic" ? "" : `-${layer}`}.tap`);
// The whole suite is spawned in chunks, not as one `node --test <all files>`
// command: 400+ file arguments exceed the Windows command-line limit and
// spawnSync fails with ENAMETOOLONG before a single test runs. Each chunk gets
// its own TAP file; the merge below concatenates them so the downstream name
// parsing (which only matches `ok N - <name>` lines) sees the same tapPath
// contract as before.
const CHUNK_SIZE = 40;
// Suites spawn their own CLI processes. Bound file concurrency so startup load
// cannot consume those tests' unchanged behavior deadlines on Windows.
const TEST_CONCURRENCY = 4;
const chunkTapFiles = [];
let chunkFailures = 0;

for (let start = 0; start < all.length; start += CHUNK_SIZE) {
  const chunk = all.slice(start, start + CHUNK_SIZE);
  const chunkTap = join(root, "dist", `tests${layer === "hermetic" ? "" : `-${layer}`}-chunk${start / CHUNK_SIZE}.tap`);
  const testCode = spawnSync(
    process.execPath,
    [
      "--test",
      `--test-concurrency=${TEST_CONCURRENCY}`,
      "--test-reporter",
      "spec",
      "--test-reporter-destination",
      "stdout",
      "--test-reporter",
      "tap",
      "--test-reporter-destination",
      chunkTap,
      ...chunk,
    ],
    {
      cwd: root,
      stdio: "inherit",
      encoding: "utf8",
    },
  );
  if (testCode.error) {
    console.error(testCode.error.message);
    process.exit(1);
  }

  if (testCode.status !== 0) {
    chunkFailures += 1;
  }

  chunkTapFiles.push(chunkTap);
}

// A failing test makes its chunk's process exit nonzero but the remaining
// chunks still run (the old single-process run had the same property: a red
// test never hid the rest of the suite). The final exit is red if any chunk was.
writeFileSync(tapPath, chunkTapFiles.map((file) => readFileSync(file, "utf8")).join("\n"));

for (const file of chunkTapFiles) {
  rmSync(file);
}

const testCode = { status: chunkFailures === 0 ? 0 : 1 };
const names = [];

if (existsSync(tapPath)) {
  for (const line of readFileSync(tapPath, "utf8").split(/\r?\n/)) {
    const match = /^(?:not )?ok \d+ - (.+)$/.exec(line);
    if (match?.[1] !== undefined) {
      names.push(match[1]);
    }
  }
}

names.sort((a, b) => a.localeCompare(b));

console.log(`TEST-NAMES count=${names.length}`);

const discoveryData = {
  layer,
  count: all.length,
  files: all.map((file) => relative(root, file).replaceAll("\\", "/")),
  testCount: names.length,
  names,
};

writeFileSync(
  join(root, "dist", `test-discovery${layer === "hermetic" ? "" : `-${layer}`}.json`),
  `${JSON.stringify(discoveryData, null, 2)}\n`,
);

if (layer === "hermetic") {
  writeFileSync(
    join(root, "dist", "test-discovery.json"),
    `${JSON.stringify(discoveryData, null, 2)}\n`,
  );
}

if (names.length === 0) {
  console.error("FAIL test-discovery: no TAP test names captured");
  process.exit(1);
}

process.exit(testCode.status === null ? 1 : testCode.status);
