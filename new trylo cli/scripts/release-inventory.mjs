// Inventory the bytes and exact versions being shipped; no license decision is made here.
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const distRoot = resolve(process.argv.find(value => value.startsWith("--out-dir="))?.slice(10) ?? join(root, "dist"));

// tsc does not remove deleted source files from an existing dist tree.
for (const retired of [
  "internal/adapters/managed-work",
  "internal/domain/managed-work.js", "internal/domain/managed-work.d.ts",
  "internal/ports/managed-work.js", "internal/ports/managed-work.d.ts",
]) {
  if (existsSync(join(distRoot, retired))) {
    throw new Error(`release inventory: retired CoWork output remains (${retired}); clean dist and rebuild`);
  }
}

const read = path => JSON.parse(readFileSync(join(root, path), "utf8"));
const lock = read("package-lock.json");
const pkg = read("package.json");
const components = [];

for (const [path, entry] of Object.entries(lock.packages)) {
  if (!path.startsWith("node_modules/") || entry.dev === true) continue;
  const installed = read(`${path}/package.json`);
  if (installed.version !== entry.version) throw new Error(`release inventory: ${path} differs from lockfile`);
  components.push({ type: "library", name: installed.name, version: installed.version, purl: `pkg:npm/${installed.name.replace("/", "%2F")}@${installed.version}` });
}

const sandboxPath = "internal/adapters/sandbox/vendor/sandbox-runtime";
const sandbox = read(`src/${sandboxPath}/PROVENANCE.json`);
const pty = read("vendor-bin/pty/PROVENANCE.json");

for (const [name, source, provenance] of [
  ...Object.entries(sandbox.artifacts).map(([name, meta]) => [name, `${sandboxPath}/srt-win/${name.endsWith("arm64") ? "arm64" : "x64"}/srt-win.exe`, { ...meta, version: sandbox.version }]),
  ...Object.entries(pty.artifacts).map(([name, meta]) => [name, `internal/vendor/pty/${meta.platform === "win32" ? "win" : meta.platform}-${meta.arch}/trylo-pty.exe`, { ...meta, version: pty.helper.version }]),
]) {
  const sha256 = createHash("sha256").update(readFileSync(join(distRoot, source))).digest("hex");
  if (sha256 !== provenance.sha256) throw new Error(`release inventory: helper ${name} differs from provenance`);
  components.push({ type: "file", name, version: provenance.version, hashes: [{ alg: "SHA-256", content: sha256 }], properties: [{ name: "trylo:artifact-path", value: source }] });
}

components.push({ type: "library", name: sandbox.upstream, version: sandbox.version, properties: [{ name: "trylo:scope", value: "Windows execution static module closure; CA/MITM and upstream CLI are not shipped" }] });

components.sort((a, b) => a.name.localeCompare(b.name));

writeFileSync(join(distRoot, "sbom.json"), JSON.stringify({ bomFormat: "CycloneDX", specVersion: "1.5", version: 1, metadata: { component: { type: "application", name: pkg.name, version: pkg.version } }, components }, null, 2) + "\n");

writeFileSync(join(distRoot, "THIRD_PARTY_NOTICES.md"), "# Distributed component inventory\n\nExact installed versions and helper hashes are recorded in sbom.json. License checking is waived by the product owner. Existing upstream notices remain with the vendored modules.\n\n" + components.map(item => `- ${item.name}@${item.version}`).join("\n") + "\n");

console.log(`release-inventory: ${components.length} locked components and verified helper artifacts`);
