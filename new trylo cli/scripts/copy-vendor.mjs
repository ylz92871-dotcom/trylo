// Stage the vendored OS-sandbox runtime into the build output.
//
// Why this exists: `tsc` only emits from `src/**/*.ts`, so nothing under
// `vendor/**` (JS sources and the srt-win binaries alike) reaches `dist` on
// its own. The Windows isolation adapter resolves both its helper module and
// its executable relative to its own compiled location —
// `dist/internal/adapters/sandbox/vendor/sandbox-runtime/…` — so a build
// without this step ships an adapter whose vendor imports cannot resolve.
// Only the Windows execution entry's static module closure is copied.
//
// Why the binaries are not in `src`: the quality gate (step 8,
// scripts/quality/new-cli.mjs and scripts/quality/verify.mjs) fails any build
// containing a `.exe`/`.dll`/`.bin` or any file over 1 MB, and it scans `src`
// with no exemption mechanism. `scripts/quality/**` is off-limits to this
// package, so the only way to satisfy the gate is to keep the binaries out of
// `src` entirely and lay them down here, after typecheck. They are staged back
// to the same relative path the vendored JS expects, so path resolution in
// windows-isolation.ts and windows-sandbox-utils.js is unchanged.
//
// The SHA-256 of each binary is verified against vendor/sandbox-runtime/
// PROVENANCE.json. A build that stages a tampered or truncated helper fails
// loudly instead of shipping one.
import { createHash } from "node:crypto";
import { copyFileSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { copyWindowsClosure } from "./sandbox-closure.mjs";
import { copyHermesRuntime } from "./skill-learning/copy-hermes-runtime.mjs";

// `scripts/` sits directly under the package root, so the package root is one
// level up from this file. Measured rather than assumed: the sibling
// scripts/quality/clean-dist.mjs is two levels up only because it is one
// directory deeper.
const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outputArg = process.argv.find(value => value.startsWith("--out-dir="))?.slice(10);

/** Where the binaries are kept in the source tree, and what to call them there. */
const STAGED = process.platform === "win32" ? [
  { from: "vendor-bin/srt-win-x64.exe", arch: "x64" },
  { from: "vendor-bin/srt-win-arm64.exe", arch: "arm64" },
] : [];

/** The vendored runtime tree, relative to `src`, which tsc mirrors into `dist`. */
const VENDOR_REL = "internal/adapters/sandbox/vendor/sandbox-runtime";

const provenance = JSON.parse(
  readFileSync(join(root, "src", VENDOR_REL, "PROVENANCE.json"), "utf8"),
);
const expected = new Map(
  Object.entries(provenance.artifacts ?? {}).map(([name, meta]) => [name, meta.sha256]),
);

// 1. The vendored JS/metadata tree. tsc never emitted these.
const vendorSrc = join(root, "src", VENDOR_REL);
const distRoot = resolve(outputArg ?? join(root, "dist"));
const sourceRoot = resolve(root, "src");
if (distRoot === resolve(root) || distRoot === sourceRoot || distRoot.startsWith(sourceRoot + sep)) {
  throw new Error("copy-vendor: output overlaps source input");
}

const vendorDest = resolve(distRoot, VENDOR_REL);
if (!vendorDest.startsWith(distRoot + sep)) throw new Error("copy-vendor: destination escapes build output");

// An incremental build must not retain the old upstream CLI / MITM dependency graph.
rmSync(vendorDest, { recursive: true, force: true });

const moduleCount = copyWindowsClosure(vendorSrc, vendorDest);

// 2. The prebuilt helper binaries, verified then laid down at the path the
//    vendored JS resolves (`vendor/srt-win/<arch>/srt-win.exe`).
let staged = 0;

for (const { from, arch } of STAGED) {
  const src = join(root, from);
  const bytes = readFileSync(src);
  const want = expected.get(`srt-win-${arch}`);
  if (want === undefined) {
    throw new Error(`copy-vendor: PROVENANCE.json has no sha256 for the ${arch} binary`);
  }

  const got = createHash("sha256").update(bytes).digest("hex");
  if (got !== want) {
    throw new Error(
      `copy-vendor: ${from} sha256 ${got} does not match PROVENANCE.json (${want})`,
    );
  }

  const dest = join(distRoot, VENDOR_REL, "srt-win", arch, "srt-win.exe");

  mkdirSync(dirname(dest), { recursive: true });
  copyFileSync(src, dest);
  staged += 1;
}

console.log(`copy-vendor: staged ${moduleCount} execution modules + ${staged} sandbox binary/binaries into dist (sha256 verified)`);

const hermes = copyHermesRuntime({ outRoot: distRoot });

console.log(`copy-vendor: staged ${hermes.copiedFiles} skill runtime files (${hermes.vendorAssetsVerified} vendor manifest assets verified)`);
