import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { PACKAGED_DEFAULTS } from "../../settings/schema.js";
import { SETTINGS_LAYERS, layerPrecedence } from "../../settings/layers.js";
import type { SettingsEntry } from "../../ports/settings.js";
import { loadConfig } from "./config-load.js";

/**
 * The five-layer canary (WP A 波 §2.7; was the four/five-layer defaults canary).
 *
 * The old version pinned two default sets against each other, which only made
 * sense while the CLI carried its own. After the switch the CLI has *no* second
 * default set — so the canary now pins the thing that actually matters: every
 * packaged default reaches a real load, at the bottom of the five-layer order,
 * and no file under `surface/cli` declares a competing default set.
 *
 * It is a canary, not a contract test: it is meant to be the first thing to fail
 * if someone reintroduces a parallel config engine.
 */

const CLI_DIR = path.join(process.cwd(), "src", "internal", "surface", "cli");

/** No files at any layer, no flags: everything must come from `packaged_default`. */
const bareIo = {
  readFile: () => undefined,
  profileDir: "/home/nobody/.trylo",
  cwd: "/workspace/nothing",
};

test("every packaged default resolves at the packaged_default layer", () => {
  const loaded = loadConfig(bareIo, {});

  assert.equal(loaded.ok, true, JSON.stringify(loaded));

  if (!loaded.ok) {
    return;
  }

  for (const key of Object.keys(PACKAGED_DEFAULTS)) {
    const entry: SettingsEntry | undefined = loaded.resolved[key];
    assert.notEqual(entry, undefined, `${key} did not resolve at all`);
    assert.equal(entry?.layer, "packaged_default", `${key} resolved from ${entry?.layer}`);
    assert.deepEqual(entry?.value, PACKAGED_DEFAULTS[key], `${key} value drifted`);
  }
});

test("the five layers are exactly the settings package's order, with the documented precedence", () => {
  assert.deepEqual([...SETTINGS_LAYERS], [
    "packaged_default",
    "system",
    "user",
    "project",
    "cli_flag",
  ]);
  assert.deepEqual(
    SETTINGS_LAYERS.map(layerPrecedence),
    [0, 10, 20, 30, 40],
    "the sparse scale is what lets a layer be inserted without renumbering",
  );
});

test("the CLI declares no second packaged default set", () => {
  // A canary against a regression, not a style rule: the moment `surface/cli`
  // grows its own defaults, the two engines can disagree again.
  const offenders: string[] = [];

  for (const name of ["config-load.ts", "commands.ts", "run-settings.ts", "doctor.ts"]) {
    const text = readFileSync(path.join(CLI_DIR, name), "utf8");
    if (/PACKAGED_DEFAULTS|DEFAULT_CONFIG|DEFAULT_VALUES/.test(text)) {
      offenders.push(name);
    }
  }

  assert.deepEqual(offenders, []);
});

test("a load with no files still reports every non-cli layer it looked at", () => {
  const loaded = loadConfig(bareIo, {});

  assert.equal(loaded.ok, true);

  if (!loaded.ok) {
    return;
  }

  const byLayer = new Map(loaded.sources.map((source) => [source.layer, source.status]));

  assert.equal(byLayer.get("packaged_default"), "packaged");
  assert.equal(byLayer.get("user"), "missing");
  assert.equal(byLayer.get("project"), "missing");
  assert.equal(byLayer.get("cli_flag"), "loaded");
});
