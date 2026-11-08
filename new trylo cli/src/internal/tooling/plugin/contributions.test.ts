import assert from "node:assert/strict";
import test from "node:test";
import {
  aggregateContributions,
  findCommandInSnapshot,
  findSkillInSnapshot,
  pluginAgentName,
  pluginSkillToolName,
  pluginStyleName,
  snapshotCoversGeneration,
} from "./contributions.js";
import type { PluginRecord } from "./registry.js";

function record(overrides: Partial<PluginRecord> & Pick<PluginRecord, "pluginId" | "scope">): PluginRecord {
  return {
    version: "1.0.0",
    origin: "marketplace",
    enabled: true,
    ...overrides,
  };
}

test("snapshot freezes enabled contributions; registration is not consumption", () => {
  const enabled = [record({ pluginId: "pack@mkt", scope: "user" })];
  const snapshot = aggregateContributions({
    enabled,
    contributions: {
      "pack@mkt": {
        pluginId: "pack@mkt",
        commands: ["review"],
        skills: ["summarize"],
        agents: ["pack:review:planner"],
        outputStyles: ["pack:concise"],
      },
    },
    generation: 7,
    now: "2026-10-06T00:00:00Z",
  });

  assert.equal(snapshot.generation, 7);
  assert.equal(findSkillInSnapshot(snapshot, "summarize").ok, true);
  assert.equal(findCommandInSnapshot(snapshot, "missing").ok, false);
  assert.equal(pluginSkillToolName("pack@mkt", "summarize"), "pack@mkt:summarize");
  assert.equal(pluginAgentName("pack@mkt", "review", "planner"), "pack@mkt:review:planner");
  assert.equal(pluginStyleName("pack@mkt", "concise"), "pack@mkt:concise");
});

test("stale snapshots never cover a newer registry generation", () => {
  const snapshot = aggregateContributions({
    enabled: [],
    contributions: {},
    generation: 3,
    now: "2026-10-06T00:00:00Z",
  });

  assert.equal(snapshotCoversGeneration(snapshot, 3).ok, true);
  const stale = snapshotCoversGeneration(snapshot, 4);

  assert.equal(stale.ok, false);

  if (!stale.ok) {
    assert.equal(stale.code, "stale_snapshot");
  }
});

test("disabled plugins leave the snapshot instead of lingering", () => {
  const snapshot = aggregateContributions({
    enabled: [],
    contributions: {
      "pack@mkt": {
        pluginId: "pack@mkt",
        commands: ["review"],
        skills: ["summarize"],
        agents: [],
        outputStyles: [],
      },
    },
    generation: 8,
    now: "2026-10-06T00:00:00Z",
  });

  assert.equal(snapshot.contributions.length, 0);
  assert.equal(findSkillInSnapshot(snapshot, "summarize").ok, false);
});
