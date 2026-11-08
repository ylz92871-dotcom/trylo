import assert from "node:assert/strict";
import test from "node:test";
import { createMemoryPermissionStore, type MemoryPermissionStore } from "../../adapters/permission-store/index.js";
import type { ApprovalConsumptionAction } from "../../ports/approval-consumption.js";
import { issuedGrantRef } from "../testing/fixtures.js";
import { isBuiltinPluginId, isInstallableScope, parsePluginId, validatePluginManifest } from "./manifest.js";
import type { PluginInstallScope, PluginOrigin } from "./manifest.js";
import {
  EMPTY_PLUGIN_REGISTRY,
  installPlugin,
  resolvePlugin,
  setPluginEnabled,
  uninstallPlugin,
  updatePlugin,
  type PluginRegistryState,
} from "./registry.js";

const NOW = "2026-10-06T00:00:00Z";
const CANDIDATE = "cand-wp16";

function operationAction(operation: "install" | "uninstall" | "update" | "toggle"): ApprovalConsumptionAction {
  if (operation === "install") {
    return "acquire";
  }
  return "modify";
}

async function freshGrant(
  permission: MemoryPermissionStore,
  operation: "install" | "uninstall" | "update" | "toggle",
) {
  return issuedGrantRef(permission, operationAction(operation), {
    candidateId: CANDIDATE,
    packageVersionId: `plugin:${CANDIDATE}:${operation}`,
    scope: "plugin",
  });
}

async function doInstall(
  permission: MemoryPermissionStore,
  state: PluginRegistryState,
  input: {
    pluginId: string;
    scope: PluginInstallScope;
    version: string;
    origin: PluginOrigin;
    skills?: readonly string[];
  },
) {
  return installPlugin(state, {
    approvalPort: permission,
    token: await freshGrant(permission, "install"),
    now: NOW,
    candidateId: CANDIDATE,
    skills: ["summarize"],
    ...input,
  });
}

async function doUninstall(
  permission: MemoryPermissionStore,
  state: PluginRegistryState,
  input: { pluginId: string; scope: PluginInstallScope },
) {
  return uninstallPlugin(state, {
    approvalPort: permission,
    token: await freshGrant(permission, "uninstall"),
    now: NOW,
    candidateId: CANDIDATE,
    ...input,
  });
}

async function doToggle(
  permission: MemoryPermissionStore,
  state: PluginRegistryState,
  input: { pluginId: string; scope: PluginInstallScope; enabled: boolean },
) {
  return setPluginEnabled(state, {
    approvalPort: permission,
    token: await freshGrant(permission, "toggle"),
    now: NOW,
    candidateId: CANDIDATE,
    ...input,
  });
}

async function doUpdate(
  permission: MemoryPermissionStore,
  state: PluginRegistryState,
  input: { pluginId: string; scope: PluginInstallScope; version: string },
) {
  return updatePlugin(state, {
    approvalPort: permission,
    token: await freshGrant(permission, "update"),
    now: NOW,
    candidateId: CANDIDATE,
    ...input,
  });
}

test("plugin id parses name[@marketplace] and refuses traversal", () => {
  const parsed = parsePluginId("pdf-pack@mkt");

  assert.equal(parsed.ok, true);

  if (parsed.ok) {
    assert.deepEqual(parsed.value, { name: "pdf-pack", marketplace: "mkt" });
  }

  assert.equal(parsePluginId("  ").ok, false);
  assert.equal(parsePluginId("../escape@mkt").ok, false);
  assert.equal(isBuiltinPluginId("helper@builtin"), true);
  assert.equal(isBuiltinPluginId("helper@mkt"), false);
  assert.equal(isInstallableScope("managed"), false);
  assert.equal(isInstallableScope("user"), true);
});

test("manifest refuses empty bundles; bundles are not loose registries", () => {
  const empty = validatePluginManifest({ pluginId: "pack@mkt", version: "1.0.0" });

  assert.equal(empty.ok, false);
  const full = validatePluginManifest({
    pluginId: "pack@mkt",
    version: "1.0.0",
    skills: ["summarize"],
  });

  assert.equal(full.ok, true);
});

test("install requires approval; managed scope cannot install", async () => {
  const denied = await installPlugin(EMPTY_PLUGIN_REGISTRY, {
    now: NOW,
    candidateId: CANDIDATE,
    pluginId: "pack@mkt",
    scope: "user",
    version: "1.0.0",
    origin: "marketplace",
  });

  assert.equal(denied.ok, false);

  const permission = createMemoryPermissionStore();
  const managed = await installPlugin(EMPTY_PLUGIN_REGISTRY, {
    approvalPort: permission,
    token: await freshGrant(permission, "install"),
    now: NOW,
    candidateId: CANDIDATE,
    pluginId: "pack@mkt",
    scope: "managed",
    version: "1.0.0",
    origin: "marketplace",
  });

  assert.equal(managed.ok, false);

  if (!managed.ok) {
    assert.equal(managed.code, "scope_not_installable");
  }
});

test("install resolves most-specific scope; uninstall reclaims resources", async () => {
  const permission = createMemoryPermissionStore();
  const first = await doInstall(permission, EMPTY_PLUGIN_REGISTRY, {
    pluginId: "pack@mkt",
    scope: "user",
    version: "1.0.0",
    origin: "marketplace",
  });

  assert.equal(first.ok, true);

  if (!first.ok) {
    return;
  }

  const second = await doInstall(permission, first.value.state, {
    pluginId: "pack@mkt",
    scope: "project",
    version: "1.0.0",
    origin: "marketplace",
  });

  assert.equal(second.ok, true);

  if (!second.ok) {
    return;
  }

  assert.equal(resolvePlugin(second.value.state, "pack@mkt")?.scope, "project");

  const removed = await doUninstall(permission, second.value.state, { pluginId: "pack@mkt", scope: "project" });

  assert.equal(removed.ok, true);

  if (!removed.ok) {
    return;
  }

  assert.deepEqual(removed.value.reclaimed.cacheKeys, [
    "commands:pack@mkt",
    "agents:pack@mkt",
    "skills:pack@mkt",
    "styles:pack@mkt",
  ]);
  assert.equal(removed.value.reclaimed.dataDir, undefined);

  const last = await doUninstall(permission, removed.value.state, { pluginId: "pack@mkt", scope: "user" });

  assert.equal(last.ok, true);

  if (last.ok) {
    assert.equal(last.value.reclaimed.dataDir, "plugins/pack@mkt");
  }
});

test("enable/disable and non-in-place update keep the generation moving", async () => {
  const permission = createMemoryPermissionStore();
  const installed = await doInstall(permission, EMPTY_PLUGIN_REGISTRY, {
    pluginId: "pack@mkt",
    scope: "user",
    version: "1.0.0",
    origin: "marketplace",
  });

  assert.equal(installed.ok, true);

  if (!installed.ok) {
    return;
  }

  const disabled = await doToggle(permission, installed.value.state, {
    pluginId: "pack@mkt",
    scope: "user",
    enabled: false,
  });

  assert.equal(disabled.ok, true);

  if (!disabled.ok) {
    return;
  }

  assert.equal(disabled.value.record.enabled, false);
  assert.equal(disabled.value.state.generation, installed.value.state.generation + 1);

  const same = await doUpdate(permission, disabled.value.state, {
    pluginId: "pack@mkt",
    scope: "user",
    version: "1.0.0",
  });

  assert.equal(same.ok, false);
  const down = await doUpdate(permission, disabled.value.state, {
    pluginId: "pack@mkt",
    scope: "user",
    version: "0.9.0",
  });

  assert.equal(down.ok, false);
  const up = await doUpdate(permission, disabled.value.state, {
    pluginId: "pack@mkt",
    scope: "user",
    version: "1.1.0",
  });

  assert.equal(up.ok, true);

  if (up.ok) {
    assert.equal(up.value.record.version, "1.1.0");
  }
});

test("BLOCK-1 install never bypasses manifest validation", async () => {
  const permission = createMemoryPermissionStore();

  async function rawInstall(input: {
    pluginId: string;
    marketplace?: string;
    version: string;
    skills?: readonly string[];
  }) {
    return installPlugin(EMPTY_PLUGIN_REGISTRY, {
      approvalPort: permission,
      token: await freshGrant(permission, "install"),
      now: NOW,
      candidateId: CANDIDATE,
      scope: "user",
      origin: "marketplace",
      ...input,
    });
  }

  const traversal = await rawInstall({ pluginId: "../../evil", version: "1.0.0", skills: ["s"] });

  assert.equal(traversal.ok, false);

  if (!traversal.ok) {
    assert.equal(traversal.code, "path_traversal");
  }

  const spaced = await rawInstall({ pluginId: "pack name", version: "1.0.0", skills: ["s"] });

  assert.equal(spaced.ok, false);

  if (!spaced.ok) {
    assert.equal(spaced.code, "invalid_plugin_id");
  }

  const emptyBundle = await rawInstall({ pluginId: "pack@mkt", version: "1.0.0" });

  assert.equal(emptyBundle.ok, false);

  if (!emptyBundle.ok) {
    assert.equal(emptyBundle.code, "empty_bundle");
  }

  const badMarketplace = await rawInstall({
    pluginId: "pack@mkt",
    marketplace: "../evil",
    version: "1.0.0",
    skills: ["s"],
  });

  assert.equal(badMarketplace.ok, false);

  if (!badMarketplace.ok) {
    assert.equal(badMarketplace.code, "path_traversal");
  }

  const duplicated = await rawInstall({ pluginId: "pack@mkt", version: "1.0.0", skills: ["s", "s"] });

  assert.equal(duplicated.ok, false);

  if (!duplicated.ok) {
    assert.equal(duplicated.code, "duplicate_contribution");
  }

  assert.deepEqual(EMPTY_PLUGIN_REGISTRY.records, []);
});

test("BLOCK-2 versions compare numerically per segment, not lexicographically", async () => {
  const permission = createMemoryPermissionStore();
  const installed = await doInstall(permission, EMPTY_PLUGIN_REGISTRY, {
    pluginId: "pack@mkt",
    scope: "user",
    version: "1.9.0",
    origin: "marketplace",
  });

  assert.equal(installed.ok, true);

  if (!installed.ok) {
    return;
  }

  const minorTen = await doUpdate(permission, installed.value.state, {
    pluginId: "pack@mkt",
    scope: "user",
    version: "1.10.0",
  });

  assert.equal(minorTen.ok, true);

  if (!minorTen.ok) {
    return;
  }

  const backDown = await doUpdate(permission, minorTen.value.state, {
    pluginId: "pack@mkt",
    scope: "user",
    version: "1.9.0",
  });

  assert.equal(backDown.ok, false);

  if (!backDown.ok) {
    assert.equal(backDown.code, "version_downgrade");
  }

  const majorTen = await doUpdate(permission, minorTen.value.state, {
    pluginId: "pack@mkt",
    scope: "user",
    version: "10.0.0",
  });

  assert.equal(majorTen.ok, true);
});
