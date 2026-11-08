import {
  consumeApproval,
  type ApprovalConsumptionPort,
  type ApprovalGateFailure,
  type ApprovalGrantRef,
} from "../approval/gates.js";
import { err, ok, type Result } from "../contract/result.js";
import {
  isInstallableScope,
  validatePluginManifest,
  type PluginInstallScope,
  type PluginManifestFailure,
  type PluginOrigin,
} from "./manifest.js";

/**
 * WP16.1 plugin registry — install/enable/disable/update/uninstall as pure
 * policy over an explicit state value.
 *
 * Reused mechanics:
 * - legacy `pluginOperations` settings-first flow: resolve by identifier, then
 *   `local > project > user > managed` precedence; `SCOPE_PRECEDENCE`
 *   `{user:0, project:1, local:2}` for shadowing; uninstall only deletes the
 *   versioned cache + options + data dir when the last scope is gone and
 *   always clears loader caches.
 * - legacy non-in-place update: remote goes through versioned cache copy with
 *   an `alreadyUpToDate` short-circuit; never mutates the live install.
 * - Codex `core-plugins` marketplace versioning: installs are versioned,
 *   upgrades are explicit operations.
 *
 * Owner notes:
 * - Permission stays with WP03/WP18: every mutating entry consumes a grant
 *   through the injected `ApprovalConsumptionPort`. Absent port/token is a
 *   terminal refusal, never a silent allow.
 * - Uninstall never just deletes a UI row: it returns the exact
 *   `reclaimedResources` (connections, cache keys, data dir) the caller must
 *   release. Load failure never half-registers: validation runs before the
 *   state value is extended.
 */

export type PluginRecord = {
  readonly pluginId: string;
  readonly marketplace?: string;
  readonly scope: PluginInstallScope;
  readonly version: string;
  readonly origin: PluginOrigin;
  readonly enabled: boolean;
  readonly installPath?: string;
  readonly inlineDir?: string;
};

export type PluginRegistryState = {
  readonly records: ReadonlyArray<PluginRecord>;
  readonly generation: number;
};

export type ReclaimedResources = {
  readonly connections: ReadonlyArray<string>;
  readonly cacheKeys: ReadonlyArray<string>;
  readonly dataDir: string | undefined;
};

export type PluginRegistryFailure =
  | ApprovalGateFailure
  | PluginManifestFailure
  | "scope_not_installable"
  | "already_installed"
  | "not_installed"
  | "already_up_to_date"
  | "version_downgrade";

export const EMPTY_PLUGIN_REGISTRY: PluginRegistryState = { records: [], generation: 0 };

export type PluginMutationRequest = {
  readonly approvalPort?: ApprovalConsumptionPort;
  readonly token?: ApprovalGrantRef;
  readonly now: string;
  readonly candidateId: string;
};

function mutationGate(request: PluginMutationRequest, action: "install" | "uninstall" | "update" | "toggle"): {
  readonly gate: Promise<Result<{ readonly grantId: string }, ApprovalGateFailure>>;
  readonly packageVersionId: string;
} {
  const packageVersionId = `plugin:${request.candidateId}:${action}`;
  const gate = consumeApproval(request.approvalPort, {
    action: action === "install" ? "acquire" : action === "update" ? "modify" : "modify",
    candidateId: request.candidateId,
    packageVersionId,
    scope: "plugin",
    now: request.now,
    ...(request.token === undefined ? {} : { token: request.token }),
  });

  return { gate, packageVersionId };
}

const SCOPE_RANK: Readonly<Record<PluginInstallScope, number>> = {
  user: 0,
  project: 1,
  local: 2,
  managed: 3,
};

/** Most-specific-scope-wins, mirroring legacy `local>project>user>managed`. */
export function resolvePlugin(
  state: PluginRegistryState,
  pluginId: string,
): PluginRecord | undefined {
  let best: PluginRecord | undefined;

  for (const record of state.records) {
    if (record.pluginId !== pluginId) {
      continue;
    }
    if (best === undefined || SCOPE_RANK[record.scope] > SCOPE_RANK[best.scope]) {
      best = record;
    }
  }

  return best;
}

export function listEnabledPlugins(state: PluginRegistryState): ReadonlyArray<PluginRecord> {
  return state.records.filter((record) => record.enabled);
}

export async function installPlugin(
  state: PluginRegistryState,
  request: PluginMutationRequest & {
    readonly pluginId: string;
    readonly marketplace?: string;
    readonly scope: PluginInstallScope;
    readonly version: string;
    readonly origin: PluginOrigin;
    readonly installPath?: string;
    readonly inlineDir?: string;
    readonly skills?: readonly string[];
    readonly mcpServers?: readonly string[];
    readonly agents?: readonly string[];
    readonly commands?: readonly string[];
    readonly outputStyles?: readonly string[];
  },
): Promise<Result<{ readonly state: PluginRegistryState; readonly record: PluginRecord }, PluginRegistryFailure>> {
  const { gate } = mutationGate(request, "install");
  const approved = await gate;
  if (!approved.ok) {
    return approved;
  }

  // Gate order is who → what-operation → what-payload: approval, then scope
  // (managed can never install, whatever the payload), then the manifest.
  if (!isInstallableScope(request.scope)) {
    return err("scope_not_installable", `scope ${request.scope} cannot install; managed is update-only`);
  }

  // The manifest gate sits on this door, not beside it: nothing enters the
  // registry without passing id/version/traversal/bundle validation first,
  // so uninstall can never derive a traversal dataDir from a stored id.
  const manifest = validatePluginManifest({
    pluginId: request.pluginId,
    version: request.version,
    ...(request.marketplace === undefined ? {} : { marketplace: request.marketplace }),
    ...(request.skills === undefined ? {} : { skills: request.skills }),
    ...(request.mcpServers === undefined ? {} : { mcpServers: request.mcpServers }),
    ...(request.agents === undefined ? {} : { agents: request.agents }),
    ...(request.commands === undefined ? {} : { commands: request.commands }),
    ...(request.outputStyles === undefined ? {} : { outputStyles: request.outputStyles }),
  });
  if (!manifest.ok) {
    return manifest;
  }

  const duplicate = state.records.some(
    (record) => record.pluginId === request.pluginId && record.scope === request.scope,
  );
  if (duplicate) {
    return err("already_installed", `${request.pluginId} is already installed at scope ${request.scope}`);
  }

  const record: PluginRecord = {
    pluginId: request.pluginId,
    ...(request.marketplace === undefined ? {} : { marketplace: request.marketplace }),
    scope: request.scope,
    version: request.version,
    origin: request.origin,
    enabled: true,
    ...(request.installPath === undefined ? {} : { installPath: request.installPath }),
    ...(request.inlineDir === undefined ? {} : { inlineDir: request.inlineDir }),
  };

  return ok({
    state: { records: [...state.records, record], generation: state.generation + 1 },
    record,
  });
}

export async function uninstallPlugin(
  state: PluginRegistryState,
  request: PluginMutationRequest & { readonly pluginId: string; readonly scope: PluginInstallScope },
): Promise<Result<{ readonly state: PluginRegistryState; readonly reclaimed: ReclaimedResources }, PluginRegistryFailure>> {
  const { gate } = mutationGate(request, "uninstall");
  const approved = await gate;
  if (!approved.ok) {
    return approved;
  }

  const index = state.records.findIndex(
    (record) => record.pluginId === request.pluginId && record.scope === request.scope,
  );
  if (index < 0) {
    return err("not_installed", `${request.pluginId} is not installed at scope ${request.scope}`);
  }

  const target = state.records[index];
  if (target === undefined) {
    return err("not_installed", `${request.pluginId} is not installed at scope ${request.scope}`);
  }

  const remaining = state.records.filter((_, at) => at !== index);
  const lastScopeGone = !remaining.some((record) => record.pluginId === request.pluginId);
  const reclaimed: ReclaimedResources = {
    connections: [`mcp:${request.pluginId}`],
    cacheKeys: [
      `commands:${request.pluginId}`,
      `agents:${request.pluginId}`,
      `skills:${request.pluginId}`,
      `styles:${request.pluginId}`,
    ],
    dataDir: lastScopeGone ? `plugins/${request.pluginId}` : undefined,
  };

  return ok({ state: { records: remaining, generation: state.generation + 1 }, reclaimed });
}

export async function setPluginEnabled(
  state: PluginRegistryState,
  request: PluginMutationRequest & {
    readonly pluginId: string;
    readonly scope: PluginInstallScope;
    readonly enabled: boolean;
  },
): Promise<Result<{ readonly state: PluginRegistryState; readonly record: PluginRecord }, PluginRegistryFailure>> {
  const { gate } = mutationGate(request, "toggle");
  const approved = await gate;
  if (!approved.ok) {
    return approved;
  }

  const index = state.records.findIndex(
    (record) => record.pluginId === request.pluginId && record.scope === request.scope,
  );
  if (index < 0) {
    return err("not_installed", `${request.pluginId} is not installed at scope ${request.scope}`);
  }

  const target = state.records[index];
  if (target === undefined) {
    return err("not_installed", `${request.pluginId} is not installed at scope ${request.scope}`);
  }

  const updated: PluginRecord = { ...target, enabled: request.enabled };
  const records = state.records.map((record, at) => (at === index ? updated : record));

  return ok({ state: { records, generation: state.generation + 1 }, record: updated });
}

function compareVersionSegment(left: string, right: string): number {
  const leftNumeric = /^\d+$/.test(left);
  const rightNumeric = /^\d+$/.test(right);
  if (leftNumeric && rightNumeric) {
    const leftValue = Number(left);
    const rightValue = Number(right);
    if (leftValue < rightValue) {
      return -1;
    }

    if (leftValue > rightValue) {
      return 1;
    }

    return 0;
  }

  if (left < right) {
    return -1;
  }

  if (left > right) {
    return 1;
  }

  return 0;
}

function compareVersions(left: string, right: string): number {
  if (left === right) {
    return 0;
  }

  const leftParts = left.split(".");
  const rightParts = right.split(".");
  const width = Math.max(leftParts.length, rightParts.length);

  for (let index = 0; index < width; index += 1) {
    const order = compareVersionSegment(leftParts[index] ?? "", rightParts[index] ?? "");
    if (order !== 0) {
      return order;
    }
  }

  return 0;
}

export async function updatePlugin(
  state: PluginRegistryState,
  request: PluginMutationRequest & {
    readonly pluginId: string;
    readonly scope: PluginInstallScope;
    readonly version: string;
  },
): Promise<Result<{ readonly state: PluginRegistryState; readonly record: PluginRecord }, PluginRegistryFailure>> {
  const { gate } = mutationGate(request, "update");
  const approved = await gate;
  if (!approved.ok) {
    return approved;
  }

  const index = state.records.findIndex(
    (record) => record.pluginId === request.pluginId && record.scope === request.scope,
  );
  if (index < 0) {
    return err("not_installed", `${request.pluginId} is not installed at scope ${request.scope}`);
  }

  const target = state.records[index];
  if (target === undefined) {
    return err("not_installed", `${request.pluginId} is not installed at scope ${request.scope}`);
  }

  const order = compareVersions(target.version, request.version);
  if (order === 0) {
    return err("already_up_to_date", `${request.pluginId} is already at ${request.version}`);
  }

  if (order > 0) {
    return err("version_downgrade", `${request.pluginId} refuses downgrade ${target.version} -> ${request.version}`);
  }

  const updated: PluginRecord = { ...target, version: request.version };
  const records = state.records.map((record, at) => (at === index ? updated : record));

  return ok({ state: { records, generation: state.generation + 1 }, record: updated });
}
