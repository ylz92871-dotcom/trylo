// Stage the vendored PTY sidecar into the build output.
//
// # Why this exists
//
// `tsc` only emits from `src/**/*.ts`, and the quality gate (step 9,
// scripts/quality/verify.mjs) fails any build tree containing a
// `.exe`/`.dll`/`.bin` or any file over 1 MB, scanning `src` with no exemption
// mechanism. So the binary cannot live in `src`: it is kept in
// `vendor-bin/pty/<platform>-<arch>/` and laid down here, after typecheck, at
// the path the loader resolves relative to its own compiled location.
//
// This is the same arrangement `scripts/copy-vendor.mjs` uses for the sandbox
// runtime, and it is deliberately a separate module rather than a branch inside
// that one. That file belongs to WP04 and its staging is verified against a
// PROVENANCE it owns; folding a second, unrelated artifact into it would make
// one package's rollback able to remove another's helper.
//
// # What it guarantees
//
// The SHA-256 of every staged binary is checked against PROVENANCE.json before
// it is copied, so a truncated or tampered helper fails the build loudly rather
// than shipping. Nothing here invents a path at runtime: the loader and this
// script agree on `dist/internal/vendor/pty/<platform>-<arch>/trylo-pty.exe`,
// and the test suite asserts the two agree.
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// `scripts/pty/` sits two levels under the package root.
const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

const PROVENANCE_PATH = join(root, "vendor-bin", "pty", "PROVENANCE.json");

/**
 * Where the artifact is written, relative to `dist`.
 *
 * An earlier version claimed a test kept this and `pty-loader.ts`'s copy of the
 * path in step. No such test existed: the loader is TypeScript under `src` and
 * this is a build script outside it, so nothing could import the constant across
 * that boundary, and the comment described a mechanism that was not there. The
 * honest arrangement is a test that reads this file and compares — see
 * `pty-loader.test.ts`, "agrees with the copy script about where the artifact goes".
 */
export const PTY_DIST_SUBDIR = "internal/vendor/pty";

/** What Node reports as its platform, mapped onto the artifact directory name. */
function currentArtifactDir() {
  const platform = process.platform === "win32" ? "win" : process.platform;
  return `${platform}-${process.arch}`;
}

function sha256Of(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

/** A copied Low label would cap every terminal child, even a normal shell. */
function prepareWindowsPtyCopy(executable) {
  if (process.platform !== "win32") return;

  const systemRoot = process.env.SystemRoot ?? process.env.SYSTEMROOT;
  if (!systemRoot) throw new Error("copy-pty-vendor: Windows SystemRoot is missing");

  const system = join(systemRoot, "System32");
  const level = execFileSync(join(system, "WindowsPowerShell", "v1.0", "powershell.exe"), [
    "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File",
    fileURLToPath(new URL("./read-pty-integrity.ps1", import.meta.url)), "-ExecutablePath", executable,
  ], { encoding: "utf8", windowsHide: true }).trim();
  if (!/^\d+$/.test(level)) throw new Error("copy-pty-vendor: invalid executable integrity response");

  const normalIntegrity = 8192;

  // An already-prepared helper must remain read-only during a rebuild. In
  // particular, a restricted builder cannot rewrite a verified High copy.
  if (Number(level) >= normalIntegrity) return;

  const groups = execFileSync(join(system, "whoami.exe"), ["/groups", "/fo", "csv"], {
    encoding: "utf8", windowsHide: true,
  });
  const rid = Number(groups.match(/S-1-16-([0-9]+)/)?.[1]);
  if (!(rid >= normalIntegrity)) throw new Error("copy-pty-vendor: build host must run at normal user integrity or higher to prepare a Low helper");

  // Preserve the authority already held by this build host. This labels only
  // the verified output copy; it never requests elevation or changes its DACL.
  execFileSync(join(system, "icacls.exe"), [executable, "/setintegritylevel", rid >= 12288 ? "H" : "M"], {
    windowsHide: true, stdio: "pipe",
  });
}

export function stagePtySidecar({ log = () => {}, outputDir = join(root, "dist") } = {}) {
  if (!existsSync(PROVENANCE_PATH)) {
    throw new Error(`copy-pty-vendor: missing ${PROVENANCE_PATH}`);
  }

  const provenance = JSON.parse(readFileSync(PROVENANCE_PATH, "utf8"));
  const artifacts = provenance.artifacts ?? {};
  const wanted = currentArtifactDir();
  const entry = artifacts[`trylo-pty-${wanted}`];

  if (entry === undefined) {
    // Listing what *is* built turns "PTY does not work here" into "PTY is not
    // built for this platform, and here are the ones that are" — which is a
    // support question the reader can answer, rather than a mystery.
    const built = Object.keys(artifacts);
    throw new Error(
      `copy-pty-vendor: no PTY sidecar artifact for ${wanted}. ` +
        `Built artifacts: ${built.length === 0 ? "(none)" : built.join(", ")}. ` +
        `Build one with: cargo build --release --offline (in vendor-bin/pty), then record it in PROVENANCE.json.`,
    );
  }

  const from = join(root, entry.path);
  if (!existsSync(from)) {
    throw new Error(`copy-pty-vendor: PROVENANCE.json points at a missing file ${entry.path}`);
  }

  const bytes = readFileSync(from);
  const got = sha256Of(bytes);
  if (got !== entry.sha256) {
    throw new Error(
      `copy-pty-vendor: ${entry.path} sha256 ${got} does not match PROVENANCE.json (${entry.sha256})`,
    );
  }

  if (bytes.byteLength !== entry.bytes) {
    throw new Error(
      `copy-pty-vendor: ${entry.path} is ${bytes.byteLength} bytes, PROVENANCE.json says ${entry.bytes}`,
    );
  }

  const dest = join(resolve(outputDir), PTY_DIST_SUBDIR, wanted, "trylo-pty.exe");

  mkdirSync(dirname(dest), { recursive: true });
  const existing = existsSync(dest) ? readFileSync(dest) : undefined;
  if (existing === undefined || existing.byteLength !== entry.bytes || sha256Of(existing) !== entry.sha256) {
    copyFileSync(from, dest);
  }

  prepareWindowsPtyCopy(dest);

  log(
    `copy-pty-vendor: staged trylo-pty ${provenance.helper.version} ` +
      `(protocol ${provenance.helper.protocolVersion}) for ${wanted} into dist (sha256 verified)`,
  );

  return { platformArch: wanted, protocolVersion: provenance.helper.protocolVersion };
}

// Run directly (npm run build) rather than only when imported. Compared by
// resolved path: comparing `import.meta.url` text to `process.argv[1]` breaks
// on Windows, where the same file arrives once as a `file:///D:/…` URL and once
// as a backslash path.
const invokedDirectly =
  process.argv[1] !== undefined &&
  fileURLToPath(import.meta.url) === join(process.argv[1]);

if (invokedDirectly) {
  const outputDir = process.argv.find(value => value.startsWith("--out-dir="))?.slice(10);
  stagePtySidecar({ ...(outputDir === undefined ? {} : { outputDir }), log: (message) => console.log(message) });
}
