import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, sep } from "node:path";
import { hostProcessEnvironment } from "./executable.js";
import { SRT_WIN } from "./sandbox-vendor.js";
import { protectWindowsCacheTarget, type CacheTarget } from "./windows-helper-protection.js";

type HelperSource = { readonly path: string; readonly sha256: string };
type ProtectCache = (target: CacheTarget) => void;

function digest(bytes: Uint8Array): string { return createHash("sha256").update(bytes).digest("hex"); }

/** Native resolution also sees Windows reparse points that lstat can report as directories. */
function redirectedDirectory(directory: string): boolean {
  const expected = join(realpathSync.native(dirname(directory)), basename(directory));
  return lstatSync(directory).isSymbolicLink() || relative(expected, realpathSync.native(directory)) !== "";
}

/** A pinned executable outside writable/low-integrity workspaces; never a new download. */
export function cacheWindowsHelper(source: HelperSource, directory: string, protect: ProtectCache, writableRoots: readonly string[] = []): string {
  if (!/^[a-f0-9]{64}$/.test(source.sha256)) throw new Error("isolation_helper_invalid: missing pinned digest");
  const bytes = readFileSync(source.path);
  if (digest(bytes) !== source.sha256) throw new Error("isolation_helper_invalid: shipped helper digest differs from provenance");
  return cacheWindowsBytes(bytes, source.sha256, directory, `srt-win-${source.sha256}.exe`, protect, writableRoots);
}

/** Captured trusted code uses the same protection and integrity checks as the native helper. */
export function cacheWindowsBytes(bytes: Uint8Array, sha256: string, directory: string, name: string, protect: ProtectCache, writableRoots: readonly string[] = []): string {
  assertOutsideWriteRoots(directory, writableRoots);
  if (!/^[a-f0-9]{64}$/.test(sha256) || digest(bytes) !== sha256 || basename(name) !== name || name === "." || name === "..") {
    throw new Error("isolation_helper_invalid: invalid captured file or digest");
  }
  const directoryExists = existsSync(directory);
  if (directoryExists && (!lstatSync(directory).isDirectory() || redirectedDirectory(directory))) {
    throw new Error("isolation_helper_invalid: private cache is redirected");
  }
  mkdirSync(directory, { recursive: true });
  if (redirectedDirectory(directory)) throw new Error("isolation_helper_invalid: cache became redirected");
  protect({ kind: "directory", path: directory, state: directoryExists ? "existing" : "new" });
  const executable = join(directory, name);
  const executableExists = existsSync(executable);
  if (!executableExists) {
    try { writeFileSync(executable, bytes, { flag: "wx" }); }
    catch (error) {
      // Another host may have published the same pinned bytes. Every reader
      // still validates the complete file before granting read or executing it.
      if (!existsSync(executable)) throw error;
    }
  }
  const stat = lstatSync(executable);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || digest(readFileSync(executable)) !== sha256) {
    throw new Error("isolation_helper_invalid: private helper is linked, redirected, incomplete or modified");
  }
  protect({ kind: "executable", path: executable, state: executableExists ? "existing" : "new" });
  return executable;
}

function assertOutsideWriteRoots(directory: string, roots: readonly string[]): void {
  if (roots.length === 0) return;
  const canonical = existsSync(directory) ? realpathSync.native(directory) : join(realpathSync.native(dirname(directory)), basename(directory));
  for (const root of roots) {
    const path = relative(realpathSync.native(root), canonical);
    if (path === "" || (!isAbsolute(path) && path !== ".." && !path.startsWith(`..${sep}`))) {
      throw new Error("isolation_helper_invalid: trusted helper cache is inside a granted write root; use a narrower workspace");
    }
  }
}

function pinnedSource(): HelperSource {
  const provenance: unknown = JSON.parse(readFileSync(new URL("./vendor/sandbox-runtime/PROVENANCE.json", import.meta.url), "utf8"));
  if (typeof provenance !== "object" || provenance === null || !("artifacts" in provenance)) throw new Error("isolation_helper_invalid: malformed provenance");
  const artifacts = provenance.artifacts;
  const architecture = dirname(SRT_WIN).endsWith("arm64") ? "arm64" : "x64";
  if (typeof artifacts !== "object" || artifacts === null) throw new Error("isolation_helper_invalid: missing artifact map");
  const artifact: unknown = Reflect.get(artifacts, `srt-win-${architecture}`);
  if (typeof artifact !== "object" || artifact === null || !("sha256" in artifact) || typeof artifact.sha256 !== "string") throw new Error("isolation_helper_invalid: missing artifact digest");
  return { path: SRT_WIN, sha256: artifact.sha256 };
}

function cacheDirectory(env: Readonly<Record<string, string | undefined>>): string {
  const local = env["LOCALAPPDATA"];
  if (local === undefined || local.length === 0) throw new Error("isolation_helper_invalid: host LOCALAPPDATA is missing");
  return join(local, "trylo-cli-native");
}

/** Read-only selection for doctor: it never provisions a cache or changes ACLs. */
export function existingWindowsHelper(env = hostProcessEnvironment()): string {
  const source = pinnedSource();
  const directory = cacheDirectory(env);
  const candidate = join(directory, `srt-win-${source.sha256}.exe`);
  if (!existsSync(candidate)) return source.path;
  const stat = lstatSync(candidate);
  if (redirectedDirectory(directory) || !stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || digest(readFileSync(candidate)) !== source.sha256) throw new Error("isolation_helper_invalid: cached helper differs from provenance");
  return candidate;
}

/** Called only when an approved shell execution needs its trusted broker. */
export function prepareWindowsHelper(env = hostProcessEnvironment(), writableRoots: readonly string[] = []): string {
  return cacheWindowsHelper(pinnedSource(), cacheDirectory(env), target => protectWindowsCacheTarget(target, env), writableRoots);
}
