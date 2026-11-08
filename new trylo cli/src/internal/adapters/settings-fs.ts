import {
  PACKAGED_DEFAULTS,
} from "../settings/schema.js";
import { discoverSettingsPaths, selectCandidate, PROJECT_CONFIG_RELATIVE } from "../settings/discover.js";
import { resolveSettings, type LayerContribution } from "../settings/merge.js";
import { parseLayerContent, validateCliFlag } from "../settings/parse.js";
import { publicSettingsView } from "../settings/view.js";
import type { SettingsLayer } from "../settings/layers.js";
import path from "node:path";
import type {
  ResolvedSettings,
  SettingsFailure,
  SettingsIo,
  SettingsLoadRequest,
  SettingsPort,
  SettingsPublicView,
  SettingsResult,
  SettingsValues,
} from "../ports/settings.js";

/**
 * The filesystem settings loader: wires discovery, parsing, merging and the
 * public view together over an injected `readFile`.
 *
 * Load-only and boundary-honest:
 *
 *  - It never writes a file. There is no `set`/`save` here by design (D6 §10.7
 *    is about reading the five layers; writing back is a separate decision).
 *  - It never touches a real home directory on its own — `homeDir`,
 *    `workspaceDir` and `systemDir` come from the request and `readFile` is
 *    injected, so tests run hermetically.
 *  - **Fail-closed across layers.** The first invalid present layer ends the
 *    whole load with that layer's failure. A missing layer contributes nothing
 *    and the load proceeds. This is the difference the spec draws between
 *    "missing" (fine) and "invalid" (stop): a broken file is never downgraded to
 *    "not configured", because that would let a half-read config masquerade as a
 *    valid one.
 *
 * There is exactly **one** load implementation here ({@link loadSettingsDetailed}).
 * {@link createSettingsLoader} is the port-shaped view of it and adds no second
 * merge path, so `config show`, `doctor` and any other consumer cannot disagree
 * about precedence.
 */

/** What happened to one layer during a load. `loaded` covers `cli_flag` too. */
export type SettingsSourceStatus = "packaged" | "loaded" | "missing" | "invalid";

export type SettingsSourceRecord = {
  readonly layer: SettingsLayer;
  readonly path?: string;
  readonly status: SettingsSourceStatus;
  readonly detail?: string;
};

/**
 * A failure that knows *which layer and which file* it came from. The port's
 * {@link SettingsFailure} deliberately carries only `code` + `detail`, so this
 * richer shape is adapter-level and additive: nothing that implements or consumes
 * the port has to change to get it.
 */
export type SettingsDetailedFailure = {
  readonly ok: false;
  readonly code: SettingsFailure["code"];
  readonly layer: SettingsLayer;
  readonly path?: string;
  readonly detail: string;
};

export type SettingsDetailedResult =
  | {
      readonly ok: true;
      readonly value: ResolvedSettings;
      readonly sources: ReadonlyArray<SettingsSourceRecord>;
    }
  | SettingsDetailedFailure;

function failure(
  code: SettingsFailure["code"],
  layer: SettingsLayer,
  detail: string,
  file?: string,
): SettingsDetailedFailure {
  return {
    ok: false,
    code,
    layer,
    ...(file === undefined ? {} : { path: file }),
    detail,
  };
}

function source(
  layer: SettingsLayer,
  status: SettingsSourceStatus,
  file?: string,
  detail?: string,
): SettingsSourceRecord {
  return {
    layer,
    ...(file === undefined ? {} : { path: file }),
    status,
    ...(detail === undefined ? {} : { detail }),
  };
}

/**
 * Resolve all five layers and report what each of them contributed.
 *
 * The `sources` list is what makes `config show --json` able to answer "why is
 * this value what it is" per key, and it is produced by the *same* walk that
 * produced the values — not by a second pass that could disagree with it.
 */
export function loadSettingsDetailed(
  io: SettingsIo,
  request: SettingsLoadRequest,
  packaged: SettingsValues = PACKAGED_DEFAULTS,
): SettingsDetailedResult {
  const discovery = discoverSettingsPaths(request);
  if (!discovery.ok) {
    return failure(
      discovery.code,
      "project",
      discovery.detail,
      path.join(request.workspaceDir, PROJECT_CONFIG_RELATIVE),
    );
  }

  const sources: SettingsSourceRecord[] = [source("packaged_default", "packaged")];
  const contributions: LayerContribution[] = [
    { layer: "packaged_default", values: packaged },
  ];

  for (const plan of discovery.plans) {
    const first = plan.candidates[0];
    let selected: { readonly path: string; readonly raw: string } | undefined;

    try {
      selected = selectCandidate(plan.candidates, io.readFile);
    } catch {
      // A throw is "could not read" (permissions, I/O error), which is *not*
      // the same as "file absent". Surfacing it keeps a locked-down config from
      // being reported as an unconfigured one.
      return failure(
        "read_failed",
        plan.layer,
        `${plan.layer} config could not be read (${plan.candidates.join(", ")})`,
        first,
      );
    }

    if (selected === undefined) {
      sources.push(source(plan.layer, "missing", first));
      continue; // missing layer: contributes nothing
    }

    const parsed = parseLayerContent({ status: "present", raw: selected.raw }, selected.path);
    if (!parsed.ok) {
      sources.push(source(plan.layer, "invalid", selected.path, parsed.detail));
      return failure(parsed.code, plan.layer, parsed.detail, selected.path);
    }

    sources.push(source(plan.layer, "loaded", selected.path));
    contributions.push({ layer: plan.layer, values: parsed.values });
  }

  if (request.cliFlag !== undefined) {
    const parsedFlag = validateCliFlag(request.cliFlag);
    if (!parsedFlag.ok) {
      sources.push(source("cli_flag", "invalid", undefined, parsedFlag.detail));
      return failure(parsedFlag.code, "cli_flag", parsedFlag.detail);
    }

    sources.push(source("cli_flag", "loaded"));
    contributions.push({ layer: "cli_flag", values: parsedFlag.values });
  }

  return { ok: true, value: resolveSettings(contributions), sources };
}

export function createSettingsLoader(
  io: SettingsIo,
  packaged: SettingsValues = PACKAGED_DEFAULTS,
): SettingsPort {
  const load = (request: SettingsLoadRequest): SettingsResult<ResolvedSettings> => {
    const detailed = loadSettingsDetailed(io, request, packaged);
    return detailed.ok
      ? { ok: true, value: detailed.value }
      : { ok: false, code: detailed.code, detail: detailed.detail };
  };

  const publicView = (resolved: ResolvedSettings): SettingsPublicView =>
    publicSettingsView(resolved);

  return { load, publicView };
}
