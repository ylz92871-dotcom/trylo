import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { withRuntimeRegistry } from "../../../../../adapters/mcp-registry/runtime-overlay.js";
import { qualifyMcpToolName } from "../../../../../mcp/names.js";
import { createHermesNodeClient, type HermesToolProfile } from "./client.js";
import { hermesProfileRegistry } from "./mcp-profile.js";

test("the real worker normal skill profile coexists with the original full legacy registry entry", async t => {
  const storageRoot = await mkdtemp(path.join(os.tmpdir(), "trylo-normal-namespace-"));
  let sequence = 0;
  const client = createHermesNodeClient({ nodeBinary: process.execPath,
    env: { ...process.env, HERMES_PYTHON: process.execPath }, storageRoot, nextId: () => `namespace-${++sequence}` });

  t.after(async () => {
    client.close();
    await rm(storageRoot, { recursive: true, force: true });
  });
  // The real worker builds the profile and native data location. This contract
  // does not start a Python server, model or the legacy service itself.
  const normal = await client.profile("normal");

  assert.equal(normal.name, "trylo-hermes-skills");
  assert.deepEqual(normal.allowedTools, ["mcp__trylo-hermes-skills__skills_list", "mcp__trylo-hermes-skills__skill_view"]);

  for (const tool of ["skills_list", "skill_view"]) {
    const qualified = qualifyMcpToolName(normal.name, tool);
    assert.equal(qualified.ok, true);
    if (qualified.ok) assert.ok(normal.allowedTools.includes(qualified.value));
  }

  const legacyProfile: HermesToolProfile = { name: "trylo-hermes-capabilities", command: "synthetic-legacy-python",
    args: ["synthetic-full-capabilities-server.py"], env: { HERMES_HOME: "synthetic-existing-home" },
    allowedTools: ["mcp__trylo-hermes-capabilities__memory_snapshot", "mcp__trylo-hermes-capabilities__session_search",
      "mcp__trylo-hermes-capabilities__learning_pending_list"] };
  const legacy = hermesProfileRegistry(legacyProfile);
  const original = await legacy.resolve(legacyProfile.name);
  const combined = withRuntimeRegistry(legacy, hermesProfileRegistry(normal), "overlay");

  assert.deepEqual(await combined.names(), { ok: true, value: ["trylo-hermes-capabilities", "trylo-hermes-skills"] });
  assert.deepEqual(await combined.resolve(legacyProfile.name), original, "retain the original full service entry instead of shadowing by id");
  const internal = await combined.resolve(normal.name);

  assert.equal(internal.ok, true);

  if (internal.ok) {
    assert.equal(internal.value.entry.name, normal.name);
    assert.deepEqual(internal.value.entry.args, normal.args);
    assert.equal(internal.value.entry.env.HERMES_HOME, normal.env.HERMES_HOME);
  }

  const listing = await combined.list();

  assert.equal(listing.ok, true);

  if (listing.ok) {
    assert.deepEqual(listing.value.servers.map(entry => entry.name), [legacyProfile.name, normal.name]);
    assert.equal(listing.value.servers.find(entry => entry.name === legacyProfile.name)?.command, legacyProfile.command);
  }

  const learning = await client.profile("learning");

  assert.equal(learning.name, "trylo-hermes-learning");
  assert.ok(learning.allowedTools.length > normal.allowedTools.length);
  assert.ok(learning.allowedTools.every(name => name.startsWith("mcp__trylo-hermes-learning__")));
});
