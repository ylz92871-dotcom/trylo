import assert from "node:assert/strict";
import test from "node:test";
import type { ResolvedSettings } from "../ports/settings.js";
import { publicSettingsView } from "./view.js";

/**
 * The render boundary. The schema already refuses secrets, so they cannot be in
 * a legitimately-resolved config; these tests pin both the happy path (every key
 * carries its layer, endpoint survives, keys are sorted) and the defence-in-depth
 * guarantee (even a hand-smuggled secret/MCP key is dropped and never serialized).
 */

test("every surviving key carries value and layer, sorted", () => {
  const resolved: ResolvedSettings = {
    model: { value: "m", layer: "user" },
    provider: { value: "fixture", layer: "packaged_default" },
    endpoint: { value: "https://e.test", layer: "system" },
  };
  const view = publicSettingsView(resolved);

  assert.deepEqual(Object.keys(view), ["endpoint", "model", "provider"]);
  assert.deepEqual(view["model"], { value: "m", layer: "user" });
  assert.deepEqual(view["endpoint"], { value: "https://e.test", layer: "system" });
});

test("endpoint is renderable (a URL, not a credential)", () => {
  const view = publicSettingsView({ endpoint: { value: "https://e.test", layer: "user" } });
  assert.equal(view["endpoint"]?.value, "https://e.test");
});

test("defence in depth: a smuggled secret key is dropped from the view (adversarial #10)", () => {
  // Constructed by hand to simulate a future refactor that let a forbidden key
  // into the resolved map. The view must still refuse to render it.
  const resolved = {
    model: { value: "m", layer: "user" },
    apiKey: { value: "sk-FAKE-not-a-real-key", layer: "user" },
    clientSecret: { value: "FAKE", layer: "project" },
    mcpServers: { value: { fs: {} }, layer: "project" },
  } as unknown as ResolvedSettings;
  const view = publicSettingsView(resolved);

  assert.deepEqual(Object.keys(view), ["model"]);
  const serialized = JSON.stringify(view);

  assert.equal(serialized.includes("sk-FAKE-not-a-real-key"), false);
  assert.equal(serialized.includes("apiKey"), false);
  assert.equal(serialized.includes("mcpServers"), false);
});

test("an empty resolved config renders an empty view", () => {
  assert.deepEqual(publicSettingsView({}), {});
});
