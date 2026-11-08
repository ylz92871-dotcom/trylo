import path from "node:path";
import type { SettingsFailure } from "../ports/settings.js";
import type { FileBackedLayer } from "./layers.js";

/**
 * Where each file-backed layer lives, and which file wins inside one directory.
 *
 * Pure path logic plus an injected-existence probe; no filesystem calls of its
 * own, so the escape guard and the candidate ordering are testable without
 * touching a real home directory.
 *
 * Two ideas are copied from the survey (D6 §4.1 / §10.7):
 *
 *  - **Same-directory candidates, first existing wins** — opencode probes
 *    `["opencode.jsonc","opencode.json","config.json"]` in order and takes the
 *    first that exists. This package does *not* invent jsonc, so each layer's
 *    candidate list is currently length one (`config.json`); the ordered-probe
 *    mechanism is still here, and still tested, so adding a second candidate
 *    later is a one-line change with known semantics.
 *  - **Project must stay inside the workspace** — a project config is trusted
 *    because it lives in the tree the user opened. If the resolved candidate
 *    escapes that root, it is not a project config and is refused.
 */

export const SYSTEM_CONFIG_RELATIVE = "config.json";
/**
 * The user layer's file, relative to the **profile root**.
 *
 * It used to be `.trylo/config.json` relative to the OS home, which is the same
 * path only as long as the profile root *is* `<home>/.trylo`. The moment a
 profile root is overridable (`TRYLO_HOME`), spelling it that way splits the
 * profile: credentials and sessions follow the override and the config file does
 * not, so one `TRYLO_HOME` leaves a machine with two halves of a profile.
 * `session-paths.ts::tryloHome` is the one formula, and the caller resolves it.
 */
export const USER_CONFIG_RELATIVE = "config.json";
export const PROJECT_CONFIG_RELATIVE = path.join(".trylo", "config.json");

export type DiscoverInput = {
  readonly systemDir?: string | undefined;
  readonly homeDir: string;
  readonly workspaceDir: string;
};

export type FileLayerPlan = {
  readonly layer: FileBackedLayer;
  /** Ordered; the first existing file is used and the rest ignored. */
  readonly candidates: ReadonlyArray<string>;
};

export type DiscoveryResult =
  | { readonly ok: true; readonly plans: ReadonlyArray<FileLayerPlan> }
  | SettingsFailure;

/**
 * Containment predicate. True when `candidate` resolves to a path strictly inside
 * `root`. Resolving both sides first means a `..` segment in either input cannot
 * fool the check, and an absolute candidate outside the root is caught.
 */
export function isPathWithinRoot(root: string, candidate: string): boolean {
  const resolvedRoot = path.resolve(root);
  const resolvedCandidate = path.resolve(candidate);
  const rel = path.relative(resolvedRoot, resolvedCandidate);
  // rel === "" means candidate === root (not inside it); a leading ".." or an
  // absolute rel means it escaped.
  return rel.length > 0 && !rel.startsWith("..") && !path.isAbsolute(rel);
}

/**
 * Build the per-layer candidate plans, lowest precedence first
 * (system → user → project). A missing `systemDir` simply omits the system plan;
 * that is "no system layer here", not an error.
 */
export function discoverSettingsPaths(input: DiscoverInput): DiscoveryResult {
  const plans: FileLayerPlan[] = [];

  if (input.systemDir !== undefined) {
    plans.push({
      layer: "system",
      candidates: [path.join(input.systemDir, SYSTEM_CONFIG_RELATIVE)],
    });
  }

  plans.push({
    layer: "user",
    candidates: [path.join(input.homeDir, USER_CONFIG_RELATIVE)],
  });

  const projectCandidate = path.join(input.workspaceDir, PROJECT_CONFIG_RELATIVE);
  if (!isPathWithinRoot(input.workspaceDir, projectCandidate)) {
    return {
      ok: false,
      code: "project_path_escape",
      detail: `project config ${projectCandidate} resolves outside workspace ${input.workspaceDir}`,
    };
  }

  plans.push({ layer: "project", candidates: [projectCandidate] });

  return { ok: true, plans };
}

/**
 * Return the first candidate that exists (per the injected `readFile`), together
 * with its text, or `undefined` when none do. Reading during the probe is fine:
 * the loader needs the bytes anyway, and there is at most one hit per layer.
 */
export function selectCandidate(
  candidates: ReadonlyArray<string>,
  readFile: (absolutePath: string) => string | undefined,
): { readonly path: string; readonly raw: string } | undefined {
  for (const candidate of candidates) {
    const raw = readFile(candidate);
    if (raw !== undefined) {
      return { path: candidate, raw };
    }
  }
  return undefined;
}
