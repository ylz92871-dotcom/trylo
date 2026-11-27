// A frozen production candidate, never an incremental rebuild of shared dist.
import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import ts from "typescript";
import { copyWindowsClosure } from "../sandbox-closure.mjs";
import { PTY_DIST_SUBDIR } from "../pty/copy-pty-vendor.mjs";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const workspaceRoot = path.resolve(packageRoot, "..");
const require = createRequire(import.meta.url);
const VENDOR_REL = "internal/adapters/sandbox/vendor/sandbox-runtime";
const HELP = "node scripts/skill-learning/build-candidate.mjs --out <new absolute directory inside workspace>\nCreates <out>/dist/cmd/trylo/main.js, a frozen source manifest, strict tsc evidence and verified native helpers. Does not run the full test gate.";

function sha(bytes) { return createHash("sha256").update(bytes).digest("hex"); }

function json(file, value) { writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", flag: "wx" }); }

function relative(root, file) { return path.relative(root, file).replaceAll("\\", "/"); }

function inside(root, target) {
  const suffix = path.relative(root, target);
  return suffix !== "" && suffix !== ".." && !suffix.startsWith(`..${path.sep}`) && !path.isAbsolute(suffix);
}

function outputFor(argv) {
  if (argv.length !== 2 || argv[0] !== "--out" || !path.isAbsolute(argv[1])) throw new Error("candidate_requires_absolute_new_output");

  const output = path.resolve(argv[1]);
  if (!inside(workspaceRoot, output)) throw new Error("candidate_output_outside_workspace");

  if (relative(workspaceRoot, output).split("/").some(part => [".git", "node_modules", ".pnpm-store", ".codex", ".agents"].includes(part.toLowerCase()))) throw new Error("candidate_output_in_protected_tree");

  for (const input of ["src", "scripts", "dist", "vendor-bin"]) {
    const root = path.join(packageRoot, input);
    if (output === root || inside(root, output)) throw new Error("candidate_output_in_shared_input_or_dist");
  }

  if (existsSync(output)) throw new Error("candidate_output_already_exists");

  let ancestor = path.dirname(output);

  while (!existsSync(ancestor)) ancestor = path.dirname(ancestor);

  const actualWorkspace = realpathSync(workspaceRoot), actualAncestor = realpathSync(ancestor);
  if (actualAncestor !== actualWorkspace && !inside(actualWorkspace, actualAncestor)) throw new Error("candidate_output_ancestor_escapes_workspace");

  mkdirSync(path.dirname(output), { recursive: true });
  mkdirSync(output); // Exclusive new leaf. No deletion, overwrite or reuse path exists.

  return output;
}

function filesUnder(root) {
  const found = [];

  function visit(directory) {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) throw new Error(`candidate_source_link_requires_review:${relative(root, file)}`);
      if (entry.isDirectory()) visit(file);
      else if (entry.isFile()) found.push(file);
      else throw new Error(`candidate_source_not_regular:${relative(root, file)}`);
    }
  }

  visit(root);

  return found.sort();
}

function freezeSource(output) {
  const evidenceRoot = path.join(output, "build-evidence"), frozenRoot = path.join(evidenceRoot, "source");
  const sourceRoot = path.join(packageRoot, "src"), frozenSrc = path.join(frozenRoot, "src");

  mkdirSync(frozenSrc, { recursive: true });
  // Retain copied bytes in memory until the live-tree verification finishes.
  // Writing thousands of files during that interval would unnecessarily widen
  // the window in which unrelated work can invalidate a capture.
  const readProduction = () => filesUnder(sourceRoot).filter(file => !/\.test\.(?:ts|js)$/.test(file))
    .map(file => {
      const bytes = readFileSync(file);
      return { file, bytes, sha256: sha(bytes) };
    });
  let captured = readProduction(), stable = false;
  const rounds = [];

  for (let round = 1; round <= 6; round += 1) {
    const current = readProduction(), expected = new Map(captured.map(row => [row.file, row.sha256]));
    const currentHashes = new Map(current.map(row => [row.file, row.sha256]));
    const changes = current.filter(row => expected.get(row.file) !== row.sha256)
      .map(row => ({ path: relative(packageRoot, row.file), before: expected.get(row.file) ?? null, after: row.sha256 }));

    for (const previous of captured) if (!currentHashes.has(previous.file)) changes.push({ path: relative(packageRoot, previous.file), before: previous.sha256, after: null });

    rounds.push({ round, files: current.length, changes });

    if (changes.length === 0) {
      stable = true;
      break;
    }

    captured = current;
    console.error(`candidate: capture round ${round} changed ${changes.map(row => row.path).join(",")}`);
  }

  json(path.join(evidenceRoot, "capture-rounds.json"), { schemaVersion: 1, maxRounds: 6, stable, rounds });

  if (!stable) throw new Error(`candidate_source_changed_during_capture:${rounds.at(-1).changes.map(row => row.path).join(",")}`);

  const rows = captured.map(({ file, bytes, sha256 }) => ({ path: relative(packageRoot, file), bytes: bytes.length, sha256 }));

  console.error(`candidate: production bytes captured (${captured.length} files); later source edits are isolated`);

  for (const { file, bytes } of captured) {
    const destination = path.join(frozenRoot, relative(packageRoot, file));
    mkdirSync(path.dirname(destination), { recursive: true });
    writeFileSync(destination, bytes, { flag: "wx" });
  }

  const ptyProvenance = JSON.parse(readFileSync(path.join(packageRoot, "vendor-bin/pty/PROVENANCE.json"), "utf8"));
  const platformArch = `${process.platform === "win32" ? "win" : process.platform}-${process.arch}`;
  const ptyArtifact = ptyProvenance.artifacts?.[`trylo-pty-${platformArch}`];
  if (!ptyArtifact || !inside(packageRoot, path.resolve(packageRoot, ptyArtifact.path))) throw new Error("candidate_pty_artifact_unavailable");

  for (const name of ["tsconfig.json", "package.json", "package-lock.json", "scripts/skill-learning/build-candidate.mjs",
    "scripts/sandbox-closure.mjs", "scripts/pty/copy-pty-vendor.mjs", "scripts/copy-vendor.mjs", "vendor-bin/pty/PROVENANCE.json",
    "vendor-bin/pty/src/main.rs", "vendor-bin/pty/Cargo.toml", "vendor-bin/pty/Cargo.lock", ptyArtifact.path,
    "vendor-bin/srt-win-x64.exe", "vendor-bin/srt-win-arm64.exe"]) {
    const bytes = readFileSync(path.join(packageRoot, name));
    mkdirSync(path.dirname(path.join(frozenRoot, name)), { recursive: true });
    writeFileSync(path.join(frozenRoot, name), bytes, { flag: "wx" });
    rows.push({ path: name, bytes: bytes.length, sha256: sha(bytes) });
  }

  const base = JSON.parse(readFileSync(path.join(frozenRoot, "tsconfig.json"), "utf8"));
  if (base.extends !== undefined) throw new Error("candidate_base_extends_requires_snapshot_support");

  if (base.compilerOptions?.strict !== true || base.compilerOptions?.noEmitOnError !== true) throw new Error("candidate_strict_base_required");

  const ptyBytes = readFileSync(path.join(frozenRoot, "vendor-bin/pty/PROVENANCE.json"));

  writeFileSync(path.join(evidenceRoot, "pty-provenance.json"), ptyBytes, { flag: "wx" });
  const ptySource = readFileSync(path.join(frozenRoot, ptyProvenance.source.path));
  if (ptySource.length !== ptyProvenance.source.bytes || sha(ptySource) !== ptyProvenance.source.sha256) throw new Error("candidate_pty_source_provenance_mismatch");

  const sourceHash = sha(JSON.stringify(rows));

  json(path.join(evidenceRoot, "source-manifest.json"), { schemaVersion: 1, sourceHash, excluded: ["**/*.test.ts", "**/*.test.js"], files: rows });
  const config = path.join(evidenceRoot, "tsconfig.candidate.json");

  json(config, { extends: "./source/tsconfig.json", compilerOptions: { rootDir: frozenSrc, outDir: path.join(output, "dist") },
    include: ["./source/src/**/*.ts"], exclude: ["./source/src/**/*.test.ts"] });

  return { evidenceRoot, frozenRoot, frozenSrc, config, sourceHash, sourceFiles: rows.length };
}

function dependenciesFor(output, frozen) {
  const original = path.join(packageRoot, "node_modules");
  if (!existsSync(original)) throw new Error("candidate_dependencies_missing");

  symlinkSync(realpathSync(original), path.join(output, "node_modules"), process.platform === "win32" ? "junction" : "dir");
  const lock = JSON.parse(readFileSync(path.join(frozen.frozenRoot, "package-lock.json"), "utf8"));
  const packages = [];

  for (const [name, entry] of Object.entries(lock.packages ?? {})) {
    if (!name.startsWith("node_modules/")) continue;
    const file = path.resolve(packageRoot, name, "package.json");
    if (!inside(original, file)) throw new Error("candidate_dependency_path_invalid");
    const bytes = readFileSync(file), installed = JSON.parse(bytes);
    if (installed.version !== entry.version) throw new Error(`candidate_dependency_version_mismatch:${name}`);
    packages.push({ path: name, name: installed.name, version: installed.version, packageJsonSha256: sha(bytes), integrity: entry.integrity ?? null });
  }

  json(path.join(frozen.evidenceRoot, "dependency-manifest.json"), { schemaVersion: 1, mode: "junction_to_existing_audited_dependencies",
    target: realpathSync(original), lockSha256: sha(readFileSync(path.join(frozen.frozenRoot, "package-lock.json"))), packages });
  const pkg = JSON.parse(readFileSync(path.join(frozen.frozenRoot, "package.json"), "utf8"));

  json(path.join(output, "package.json"), { name: `${pkg.name}-candidate`, version: pkg.version, private: true, type: "module",
    engines: pkg.engines, dependencies: pkg.dependencies, bin: { trylo: "dist/cmd/trylo/main.js" } });
}

function compile(output, frozen) {
  const result = spawnSync(process.execPath, [require.resolve("typescript/bin/tsc"), "--pretty", "false", "-p", frozen.config],
    { cwd: output, encoding: "utf8", windowsHide: true, timeout: 240_000, maxBuffer: 16 * 1024 * 1024 });

  writeFileSync(path.join(frozen.evidenceRoot, "tsc.stdout.log"), result.stdout ?? "", { flag: "wx" });
  writeFileSync(path.join(frozen.evidenceRoot, "tsc.stderr.log"), result.stderr ?? "", { flag: "wx" });
  const status = { schemaVersion: 1, exitCode: result.status, signal: result.signal, errorCode: result.error?.code,
    compilerVersion: ts.version, strict: true, noEmitOnError: true, config: frozen.config };

  json(path.join(frozen.evidenceRoot, "tsc-result.json"), status);

  if (result.status !== 0 || result.error) throw new Error("candidate_production_typecheck_failed");

  const testFiles = filesUnder(path.join(output, "dist")).filter(file => /\.test\.(?:js|d\.ts)$/.test(file));
  if (testFiles.length > 0) throw new Error("candidate_test_entered_production_closure");
}

function stageVerified(source, destination, metadata, label, rows) {
  if (!metadata || typeof metadata.sha256 !== "string" || !Number.isSafeInteger(metadata.bytes)) throw new Error(`candidate_provenance_invalid:${label}`);

  const bytes = readFileSync(source);
  if (bytes.length !== metadata.bytes || sha(bytes) !== metadata.sha256) throw new Error(`candidate_helper_provenance_mismatch:${label}`);

  mkdirSync(path.dirname(destination), { recursive: true });
  writeFileSync(destination, bytes, { flag: "wx" });

  if (sha(readFileSync(destination)) !== metadata.sha256) throw new Error(`candidate_helper_copy_mismatch:${label}`);

  rows.push({ name: label, path: destination, bytes: bytes.length, sha256: metadata.sha256 });
}

function stageHelpers(output, frozen) {
  const dist = path.join(output, "dist"), source = path.join(frozen.frozenSrc, VENDOR_REL), destination = path.join(dist, VENDOR_REL);
  const sandbox = JSON.parse(readFileSync(path.join(source, "PROVENANCE.json"), "utf8"));
  const moduleCount = copyWindowsClosure(source, destination); // Existing reviewed static dependency walker.
  const binaries = [];

  for (const arch of ["x64", "arm64"]) stageVerified(path.join(frozen.frozenRoot, `vendor-bin/srt-win-${arch}.exe`),
    path.join(destination, `srt-win/${arch}/srt-win.exe`), sandbox.artifacts?.[`srt-win-${arch}`], `srt-win-${arch}`, binaries);

  const pty = JSON.parse(readFileSync(path.join(frozen.evidenceRoot, "pty-provenance.json"), "utf8"));
  const platformArch = `${process.platform === "win32" ? "win" : process.platform}-${process.arch}`;
  const entry = pty.artifacts?.[`trylo-pty-${platformArch}`];
  if (!entry || !inside(packageRoot, path.resolve(packageRoot, entry.path))) throw new Error("candidate_pty_artifact_unavailable");

  stageVerified(path.join(frozen.frozenRoot, entry.path), path.join(dist, PTY_DIST_SUBDIR, platformArch, "trylo-pty.exe"), entry, `trylo-pty-${platformArch}`, binaries);
  const staged = filesUnder(destination).map(file => ({ path: relative(dist, file), bytes: lstatSync(file).size, sha256: sha(readFileSync(file)) }));

  for (const row of staged.filter(item => !item.path.includes("/srt-win/"))) {
    if (sha(readFileSync(path.join(frozen.frozenSrc, row.path))) !== row.sha256) throw new Error(`candidate_vendor_closure_mismatch:${row.path}`);
  }

  const bridge = ["internal/adapters/sandbox/windows/windows-stdin-host.js", "internal/adapters/sandbox/windows/windows-stdin-client.js",
    "internal/adapters/sandbox/windows/windows-stdin-protocol.js", "internal/adapters/process-session/process-tree.js"].map(name => {
    const bytes = readFileSync(path.join(dist, name));
    return { path: name, bytes: bytes.length, sha256: sha(bytes) };
  });

  json(path.join(frozen.evidenceRoot, "helper-manifest.json"), { schemaVersion: 1, sandboxVersion: sandbox.version, sandboxModuleCount: moduleCount,
    sandboxClosure: staged, ptyVersion: pty.helper?.version, ptyProtocolVersion: pty.helper?.protocolVersion, binaries, compiledStdinBridge: bridge });
}

function smoke(output, frozen) {
  const entrypoint = path.join(output, "dist/cmd/trylo/main.js");
  const smokeRoot = path.join(frozen.evidenceRoot, "smoke-workspace");

  mkdirSync(smokeRoot);
  const results = [];

  for (const [name, args] of [["help", ["--help"]], ["skills-list", ["skills", "list", "--json"]]]) {
    const result = spawnSync(process.execPath, [entrypoint, ...args], { cwd: smokeRoot, encoding: "utf8", windowsHide: true,
      env: { ...process.env, TRYLO_HOME: path.join(frozen.evidenceRoot, "smoke-home") }, timeout: 30_000, maxBuffer: 1_048_576 });

    writeFileSync(path.join(frozen.evidenceRoot, `${name}.stdout.log`), result.stdout ?? "", { flag: "wx" });
    writeFileSync(path.join(frozen.evidenceRoot, `${name}.stderr.log`), result.stderr ?? "", { flag: "wx" });

    if (result.status !== 0 || result.error) throw new Error(`candidate_smoke_failed:${name}`);

    if (name === "skills-list") {
      const value = JSON.parse(result.stdout);
      if (value.schemaVersion !== 1 || value.ok !== true || !Array.isArray(value.skills) || value.skills.length !== 0) throw new Error("candidate_skills_list_contract_failed");
    } else if (!result.stdout?.includes("skills")) throw new Error("candidate_help_missing_skills");

    results.push({ name, exitCode: result.status, stdoutSha256: sha(result.stdout ?? ""), stderrSha256: sha(result.stderr ?? "") });
  }

  json(path.join(frozen.evidenceRoot, "smoke-results.json"), { schemaVersion: 1, entrypoint, results });

  return entrypoint;
}

function run() {
  const argv = process.argv.slice(2);
  if (argv.length === 1 && argv[0] === "--help") {
    console.log(HELP);
    return;
  }

  let output, frozen;

  try {
    output = outputFor(argv);
    console.error("candidate: capturing production source");
    frozen = freezeSource(output);
    console.error(`candidate: frozen source ${frozen.sourceHash}`);
    dependenciesFor(output, frozen);
    compile(output, frozen);
    console.error("candidate: strict production typecheck passed");
    stageHelpers(output, frozen);
    console.error("candidate: helper provenance and closure verified");
    const entrypoint = smoke(output, frozen);
    const manifest = { schemaVersion: 1, status: "ready", sourceHash: frozen.sourceHash, sourceFiles: frozen.sourceFiles,
      createdAt: new Date().toISOString(), nodeVersion: process.version, platform: process.platform, architecture: process.arch,
      entrypoint, productionTypecheck: "passed", fullRepositoryTests: "not_run", dependencies: "existing_junction_requires_unchanged_dependency_tree" };

    json(path.join(output, "candidate-manifest.json"), manifest);
    console.log(JSON.stringify({ ...manifest, output, sourceManifest: path.join(frozen.evidenceRoot, "source-manifest.json") }));
  } catch (error) {
    const reason = error instanceof Error ? error.message : "candidate_build_failed";
    if (output) json(path.join(output, "candidate-failure.json"), { schemaVersion: 1, status: "failed", reason,
      ...(frozen ? { sourceHash: frozen.sourceHash, sourceManifest: path.join(frozen.evidenceRoot, "source-manifest.json") } : {}) });
    console.error(JSON.stringify({ status: "failed", reason, output }));
    process.exitCode = 1;
  }
}

run();
