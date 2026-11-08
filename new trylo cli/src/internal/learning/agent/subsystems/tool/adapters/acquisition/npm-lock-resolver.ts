import { access, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type { JsonObject } from "../../../../../../protocol/envelope.js";
import type { NpmInstallTarget } from "../../../../../../tooling/contract/npm-tree.js";
import { isJsonValue, recordOf } from "../../domain/evolution/parse.js";
import { validNpmName, exactNpmVersion } from "./npm-tree-resolution.js";
import { planNpmLockedTree } from "./npm-tree-plan.js";
import type { HttpTransport } from "./transport.js";
import { openNpmMetadataRegistry } from "./npm-registry-proxy.js";
import { checkQuarantineAncestors } from "./quarantine-files.js";
import { executeNpmResolverProcess } from "./npm-resolver-process.js";
import type { NpmRegistryDiagnostic } from "./npm-registry-metadata.js";

export type NpmResolutionHost = { readonly nodeExecutable: string; readonly npmCli: string; readonly scratchRoot: string;
  readonly systemRoot?: string };

/** Resolve with the user's existing npm in a private project; never install into the user's workspace. */
export async function resolveNpmLearningLock(input: { readonly scope: string; readonly name: string; readonly version: string;
  readonly target: NpmInstallTarget; readonly signal: AbortSignal; readonly transport: HttpTransport; readonly host: NpmResolutionHost }) {
  if (!validNpmName(input.name) || !exactNpmVersion(input.version)) return failure("invalid_npm_candidate");

  if (input.signal.aborted) return failure("cancelled");

  let directory: string | undefined;
  let registry: Awaited<ReturnType<typeof openNpmMetadataRegistry>> | undefined;
  let cleanup: "safe" | "retained" = "safe";

  try {
    const { host } = input;

    if (![host.nodeExecutable, host.npmCli, host.scratchRoot].every(value => path.isAbsolute(value))) return failure("npm_resolver_unavailable");

    await checkQuarantineAncestors(host.scratchRoot);
    await mkdir(host.scratchRoot, { recursive: true });
    directory = await mkdtemp(path.join(host.scratchRoot, "resolve-"));
    await writeFile(path.join(directory, "package.json"), JSON.stringify({ name: "trylo-tool-acquisition", private: true, version: "1.0.0",
      dependencies: { [input.name]: input.version } }));
    await writeFile(path.join(directory, "user.npmrc"), "");
    await writeFile(path.join(directory, "global.npmrc"), "");
    registry = await openNpmMetadataRegistry(input.transport, input.signal, { name: input.name, version: input.version });
    cleanup = "retained";
    const execution = await executeNpmResolverProcess({ executable: host.nodeExecutable, args: [host.npmCli, "install", "--package-lock-only", "--ignore-scripts", "--ignore-extension", "--no-audit", "--no-fund", "--no-update-notifier",
      "--lockfile-version=3", "--install-strategy=hoisted", "--fetch-retries=0", `--registry=${registry.url}`,
      `--userconfig=${path.join(directory, "user.npmrc")}`, `--globalconfig=${path.join(directory, "global.npmrc")}`,
      `--cache=${path.join(directory, "cache")}`], cwd: directory, signal: input.signal,
      env: { HOME: directory, USERPROFILE: directory, TEMP: directory, TMP: directory,
        ...(host.systemRoot === undefined ? {} : { SystemRoot: host.systemRoot }) } });
    if (!execution.ok) {
      cleanup = execution.cleanup;
      const diagnostics = registry.diagnostics();
      const unsupported = diagnostics.find(row => row.stage === "selected_archive_semantics");
      const selected = diagnostics.find(row => row.packageName === input.name && row.version === input.version);
      const code = execution.code !== "npm_resolution_failed" ? execution.code
        : unsupported?.code ?? (diagnostics.some(row => row.stage === "metadata_fetch") ? "npm_registry_metadata_unavailable" : selected?.code ?? execution.code);

      return { ...failure(code, diagnostics),
        ...(cleanup === "retained" ? { retainedScratchDirectory: directory } : {}) };
    }

    cleanup = "safe";

    if (input.signal.aborted) return failure("cancelled");

    const content = await readFile(path.join(directory, "package-lock.json"), "utf8");
    if (Buffer.byteLength(content) > 2 * 1024 * 1024) return failure("npm_lock_limit");

    const lock: unknown = JSON.parse(content);
    if (!recordOf(lock) || !isJsonValue(lock)) return failure("invalid_npm_lock");

    const unsupported = registry.unsupportedLock(lock);
    if (unsupported !== undefined) return failure(unsupported.code, "binding" in unsupported
      ? [{ packageName: unsupported.binding.packageName, version: unsupported.binding.version, stage: "selected_archive_semantics", code: unsupported.code }] : registry.diagnostics());

    const planned = planNpmLockedTree({ ...input, lock });

    return planned.ok ? { ok: true as const, lock: lock as JsonObject, tree: planned.tree } : planned;
  } catch {
    return { ...failure(cleanup === "retained" ? "npm_resolver_stop_unconfirmed" : input.signal.aborted ? "cancelled" : "npm_resolution_failed", registry?.diagnostics()),
      ...(cleanup === "retained" && directory !== undefined ? { retainedScratchDirectory: directory } : {}) };
  }
  finally {
    await registry?.close();
    if (directory !== undefined && cleanup === "safe") {
      // Cleanup is best effort only after a confirmed close or before launch. Never replace the typed acquisition result.
      try { await removeResolutionDirectory(input.host.scratchRoot, directory); }
      catch { /* The checked task-owned scratch remains inspectable; no unverified target is removed. */ }
    }
  }
}

export async function locateNpmCli(nodeExecutable: string, searchPath: string): Promise<string | undefined> {
  for (const directory of new Set([path.dirname(nodeExecutable), ...searchPath.split(path.delimiter).filter(Boolean)])) {
    const candidate = path.resolve(directory, "node_modules/npm/bin/npm-cli.js");
    try {
      await access(candidate);
      return candidate;
    }
    catch { /* This installation does not contain npm; inspect the next explicit PATH entry. */ }
  }
  return undefined;
}

async function removeResolutionDirectory(root: string, directory: string) {
  const owned = path.resolve(root), name = path.basename(directory);
  if (path.dirname(path.resolve(directory)) !== owned || !/^resolve-[A-Za-z0-9]{6}$/.test(name)
    || path.relative(await realpath(owned), await realpath(directory)) !== name) throw new Error("npm_resolution_cleanup_refused");
  await rm(directory, { recursive: true, force: true, maxRetries: 2 });
}

function failure(code: string, diagnostics: readonly NpmRegistryDiagnostic[] = []) {
  return { ok: false as const, code, message: "the selected npm package could not resolve a supported runtime closure",
    ...(diagnostics.length === 0 ? {} : { diagnostics }) };
}
