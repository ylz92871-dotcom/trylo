import { execFile } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { LoadedSkill, SkillCatalogPort, SkillDescriptor } from "../../../../../ports/skills.js";
import { contentHashOf } from "../../../../control/hash.js";

export type HermesExplicitProvided = {
  readonly origin: "hermes"; readonly requestedName: string; readonly name: string; readonly contentHash: string;
};

export type HermesExplicitSelection = {
  readonly names: readonly string[]; readonly localCatalog?: SkillCatalogPort; readonly signal?: AbortSignal;
};

export type HermesExplicitResult = {
  readonly ok: true; readonly catalog: SkillCatalogPort; readonly provided: readonly HermesExplicitProvided[];
} | { readonly ok: false; readonly code: string; readonly requestedName?: string };

type ReadSelected = (names: readonly string[], signal?: AbortSignal) => Promise<unknown>;

const FAILURE = "hermes_explicit_unavailable";
const FAILURE_CODES = new Set([FAILURE, "cancelled", "hermes_version_unavailable", "hermes_explicit_invalid",
  "hermes_explicit_not_available", "hermes_explicit_metadata_invalid", "hermes_explicit_content_limit",
  "hermes_explicit_timeout", "hermes_explicit_output_limit"]);
const MAX_NAMES = 32;

/** Per-turn Team overlay only. No independent discovery, asset writes, usage claims or permission grants. */
export function createHermesExplicitResolver(options: {
  readonly pythonBinary: string; readonly capabilitiesDir: string; readonly hermesHome: string;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly read?: ReadSelected; readonly scriptPath?: string; readonly timeoutMs?: number;
}) {
  const read = options.read ?? processReader(options);
  return {
    async resolveSelected(input: HermesExplicitSelection): Promise<HermesExplicitResult> {
      if (input.signal?.aborted) return { ok: false, code: "cancelled" };

      const names = [...new Set(input.names)];
      if (names.length > MAX_NAMES || names.some(name => typeof name !== "string" || !name.trim() || name.length > 512 || name.includes("\0"))) {
        return { ok: false, code: "hermes_explicit_invalid" };
      }

      const missing = names.filter(name => input.localCatalog?.load(name, undefined).kind !== "loaded");
      if (missing.length === 0) return { ok: true, catalog: overlayCatalog(input.localCatalog, new Map()), provided: [] };

      let result: unknown;

      try { result = await read(missing, input.signal); }
      catch { return { ok: false, code: input.signal?.aborted ? "cancelled" : FAILURE }; }

      if (input.signal?.aborted) return { ok: false, code: "cancelled" };

      if (!record(result) || result.success !== true || !Array.isArray(result.skills)) return failure(result, missing);

      const loaded = new Map<string, LoadedSkill>();
      const provided: HermesExplicitProvided[] = [];

      for (const value of result.skills) {
        const skill = nativeSkill(value);
        if (skill === undefined || !record(value) || typeof value.requestedName !== "string"
          || !missing.includes(value.requestedName) || loaded.has(value.requestedName)) return { ok: false, code: "hermes_explicit_metadata_invalid" };
        loaded.set(value.requestedName, skill);
        provided.push(Object.freeze({ origin: "hermes", requestedName: value.requestedName,
          name: skill.descriptor.name, contentHash: skill.descriptor.contentHash }));
      }

      if (missing.some(name => !loaded.has(name))) return { ok: false, code: "hermes_explicit_metadata_invalid" };

      return { ok: true, catalog: overlayCatalog(input.localCatalog, loaded), provided: Object.freeze(provided) };
    },
  };
}

function nativeSkill(value: unknown): LoadedSkill | undefined {
  if (!record(value) || typeof value.name !== "string" || !value.name.trim() || value.name.length > 512
    || typeof value.description !== "string" || typeof value.content !== "string" || value.content.length > 40_000
    || typeof value.body !== "string" || typeof value.skillRoot !== "string" || !path.isAbsolute(value.skillRoot)
    || typeof value.path !== "string" || !path.isAbsolute(value.path)
    || typeof value.userInvocable !== "boolean" || typeof value.disableModelInvocation !== "boolean" || typeof value.forkExecution !== "boolean"
    || value.whenToUse !== undefined && typeof value.whenToUse !== "string"
    || value.argumentHint !== undefined && typeof value.argumentHint !== "string") return undefined;

  const descriptor: SkillDescriptor = Object.freeze({ name: value.name, description: value.description, source: "additional",
    skillRoot: value.skillRoot, path: value.path, contentHash: contentHashOf(value.content), body: value.body,
    userInvocable: value.userInvocable, disableModelInvocation: value.disableModelInvocation, forkExecution: value.forkExecution,
    ...(typeof value.whenToUse === "string" ? { whenToUse: value.whenToUse } : {}),
    ...(typeof value.argumentHint === "string" ? { argumentHint: value.argumentHint } : {}) });

  return Object.freeze({ descriptor, content: value.content });
}

function overlayCatalog(local: SkillCatalogPort | undefined, native: ReadonlyMap<string, LoadedSkill>): SkillCatalogPort {
  const unique = new Map([...native.values()].map(skill => [skill.descriptor.name, skill.descriptor]));
  return Object.freeze({
    list: () => {
      const localList = local?.list() ?? [];
      const localNames = new Set(localList.map(skill => skill.name));
      return Object.freeze([...localList, ...unique.values()].filter((skill, index) => index < localList.length || !localNames.has(skill.name)));
    },
    load: (name: string, args: string | undefined) => {
      const existing = local?.load(name, args);
      if (existing?.kind === "loaded") return existing;
      const skill = native.get(name);
      return skill === undefined ? { kind: "unknown_skill" as const, name } : { kind: "loaded" as const, skill };
    },
  });
}

function failure(value: unknown, requested: readonly string[]): HermesExplicitResult {
  const code = record(value) && typeof value.code === "string" && FAILURE_CODES.has(value.code) ? value.code : FAILURE;
  return { ok: false, code, ...(record(value) && typeof value.requestedName === "string" && requested.includes(value.requestedName)
    ? { requestedName: value.requestedName } : {}) };
}

function processReader(options: {
  readonly pythonBinary: string; readonly capabilitiesDir: string; readonly hermesHome: string;
  readonly env: Readonly<Record<string, string | undefined>>; readonly scriptPath?: string; readonly timeoutMs?: number;
}): ReadSelected {
  const script = options.scriptPath ?? fileURLToPath(new URL("./native-explicit.py", import.meta.url));
  return (names, signal) => new Promise(resolve => {
    try {
      const child = execFile(options.pythonBinary, [script, "--capabilities-dir", options.capabilitiesDir], {
        env: { ...options.env, HERMES_HOME: options.hermesHome, PYTHONUTF8: "1", PYTHONIOENCODING: "utf-8" },
        windowsHide: true, encoding: "utf8", timeout: options.timeoutMs ?? 10_000, maxBuffer: 1024 * 1024,
        ...(signal === undefined ? {} : { signal }),
      }, (error, stdout) => {
        if (signal?.aborted) {
          resolve({ success: false, code: "cancelled" });
          return;
        }

        if (error !== null) {
          // Exit 1 may carry a typed native refusal; stderr is never exposed.
          if (typeof error.code === "number") {
            try {
              const result: unknown = JSON.parse(stdout);
              if (record(result) && result.success === false) {
              resolve(result);
              return;
            }
            }
            catch { /* A malformed process failure becomes the fixed boundary error below. */ }
          }

          resolve({ success: false, code: error.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER" ? "hermes_explicit_output_limit"
            : error.killed ? "hermes_explicit_timeout" : FAILURE });
          return;
        }

        try { resolve(JSON.parse(stdout)); }
        catch { resolve({ success: false, code: FAILURE }); }
      });

      child.stdin?.on("error", () => resolve({ success: false, code: FAILURE }));
      child.stdin?.end(JSON.stringify({ names }));
    } catch { resolve({ success: false, code: signal?.aborted ? "cancelled" : FAILURE }); }
  });
}

function record(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === "object" && !Array.isArray(value); }
