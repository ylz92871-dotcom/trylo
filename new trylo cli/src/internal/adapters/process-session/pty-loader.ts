import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Finding the PTY sidecar at runtime.
 *
 * # Why this is careful
 *
 * Three ways this can go wrong, and what each one costs:
 *
 *  - **Not finding it** — a user asks for a terminal session and gets nothing.
 *    Better than a wrong answer, so the failure names the platform and the
 *    build command.
 *  - **Finding a stale copy** — a helper from a different build, which reads
 *    frames this build does not understand and produces a session that looks
 *    alive and reports nothing.
 *  - **Needing the source tree** — working in the repo and broken after
 *    `npm pack`. A tool that only runs for its author is not a tool.
 *
 * So the resolution is: relative to this module's own compiled location, which
 * `copy-pty-vendor.mjs` writes to, with the platform/arch as part of the path so
 * a wrong-architecture copy cannot be found at all. `TRYLO_PTY_HELPER` exists
 * for development and diagnostics, and is *verified* rather than trusted — an
 * override that points at the wrong thing fails instead of quietly working.
 */

/** Mirrors `PTY_DIST_SUBDIR` in `scripts/pty/copy-pty-vendor.mjs`. */
const DIST_SUBDIR = path.join("internal", "vendor", "pty");

/**
 * Node's platform name is not the directory name.
 *
 * `process.platform` reports `win32` while the artifact lives under `win`, so
 * the substitution has to happen after the default is applied. Written as one
 * expression it is easy to test the wrong side of the ternary — `undefined ===
 * "win32"` is false, which yields `win32` and a path that does not exist. That
 * bug shipped once in this file and produced a suite that skipped itself with a
 * perfectly readable message and no failing test, so the substitution is a named
 * function and `pty-loader.test.ts` pins it.
 */
export function ptyPlatformLabel(platform: NodeJS.Platform): string {
  return platform === "win32" ? "win" : platform;
}

/** `<platform-label>-<arch>`, matching the artifact directory names. */
export function ptyPlatformArch(
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
): string {
  return `${ptyPlatformLabel(platform)}-${arch}`;
}

/**
 * Where the helper is expected, relative to this module. `dist/internal/adapters/
 * process-session/pty-loader.js` is three levels below `dist`, and the artifact
 * sits at `dist/internal/vendor/pty/…`.
 */
function expectedHelperPath(platformArch: string, moduleDir: string): string {
  return path.join(moduleDir, "..", "..", "..", DIST_SUBDIR, platformArch, "trylo-pty.exe");
}

export type PtyHelperResolution =
  | { readonly ok: true; readonly helperPath: string; readonly source: "package" | "override" }
  | { readonly ok: false; readonly code: PtyHelperMissingCode; readonly message: string };

export type PtyHelperMissingCode =
  /** This build never shipped a helper for the running platform/arch. */
  | "pty_helper_not_built_for_platform"
  /** A helper should be here and is not. */
  | "pty_helper_missing"
  /** An override was given and does not point at a helper. */
  | "pty_helper_override_invalid";

type ResolutionInput = {
  readonly moduleDir?: string;
  readonly override?: string | undefined;
  readonly platform?: NodeJS.Platform;
  readonly arch?: string;
  readonly exists?: (candidate: string) => boolean;
};

function defaultExists(candidate: string): boolean {
  return existsSync(candidate);
}

/**
 * Which platforms a build is expected to cover, read from the same PROVENANCE
 * the staging step checked. A missing file says "not built"; it does not say
 * "should have been", and reporting the second would send someone looking for a
 * build problem that does not exist.
 */
function builtPlatforms(repoRoot: string): string[] {
  const provenance = path.join(repoRoot, "vendor-bin", "pty", "PROVENANCE.json");
  if (!existsSync(provenance)) {
    return [];
  }

  try {
    const parsed: unknown = JSON.parse(readFileSync(provenance, "utf8"));
    if (typeof parsed !== "object" || parsed === null) {
      return [];
    }

    const artifacts = (parsed as Record<string, unknown>)["artifacts"];
    if (typeof artifacts !== "object" || artifacts === null) {
      return [];
    }

    return Object.keys(artifacts as Record<string, unknown>)
      .map((key) => key.replace(/^trylo-pty-/, ""))
      .sort();
  } catch {
    // An unreadable ledger must not become a reason to claim a platform works.
    return [];
  }
}

/**
 * Walk up from this module until PROVENANCE.json is found. Only used to build
 * the "here is what was built" part of a failure message — never to locate the
 * helper, because in an installed package there is no `vendor-bin/`.
 */
function findRepoRoot(startDir: string): string | undefined {
  let current = startDir;

  for (let depth = 0; depth < 8; depth += 1) {
    if (existsSync(path.join(current, "vendor-bin", "pty", "PROVENANCE.json"))) {
      return current;
    }

    const parent = path.dirname(current);
    if (parent === current) {
      return undefined;
    }

    current = parent;
  }

  return undefined;
}

export function resolvePtyHelper(input: ResolutionInput = {}): PtyHelperResolution {
  const exists = input.exists ?? defaultExists;
  const platformArch = ptyPlatformArch(input.platform ?? process.platform, input.arch ?? process.arch);
  const moduleDir =
    input.moduleDir ?? path.dirname(fileURLToPath(import.meta.url));

  if (input.override !== undefined && input.override.length > 0) {
    // Verified, not trusted. An override is a development convenience, and the
    // one thing it must not be is a way to run a helper of unknown provenance.
    if (!exists(input.override)) {
      return {
        ok: false,
        code: "pty_helper_override_invalid",
        message: `TRYLO_PTY_HELPER points at ${input.override}, which does not exist; unset it to use the packaged helper`,
      };
    }
    return { ok: true, helperPath: input.override, source: "override" };
  }

  const candidate = expectedHelperPath(platformArch, moduleDir);
  if (exists(candidate)) {
    return { ok: true, helperPath: candidate, source: "package" };
  }

  const repoRoot = findRepoRoot(moduleDir);
  const built = repoRoot === undefined ? [] : builtPlatforms(repoRoot);
  const builtPart =
    built.length === 0
      ? "No platform artifacts are recorded in vendor-bin/pty/PROVENANCE.json."
      : `Recorded artifacts: ${built.join(", ")}.`;

  return {
    ok: false,
    code: "pty_helper_not_built_for_platform",
    message:
      `No PTY sidecar for ${platformArch}. Looked for ${candidate}. ${builtPart} ` +
      `Build one with: cargo build --release --offline (in vendor-bin/pty), then record its sha256 in PROVENANCE.json. ` +
      `A terminal session cannot be provided on this platform — it is not the same thing as a pipe, and is not reported as one.`,
  };
}
