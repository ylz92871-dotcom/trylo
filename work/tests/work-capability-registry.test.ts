// Trylo Work — capability registry tests (M4-E, spec §6.7 /
// §10 M4-E / §14).
//
// These pin the product contract:
//   - only `stable` capabilities may be default starters;
//   - `not_exposed` capabilities never enter starters;
//   - default starter seeds are capability-neutral (never
//     "generate a document" or a hard-coded Office type);
//   - research / analyze / organize / deliver are present
//     as default starters (spec §8.3) AND honest: they seed
//     the stable workspace_task loop, not a fake research
//     engine.

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  WORK_CAPABILITIES,
  capabilityById,
  defaultStarters,
  exposedCapabilities,
  isExposed,
  isStable,
  validateWorkCapabilityRegistry,
} from "../src/work-capability-registry.js";

describe("WorkCapabilityRegistry: invariants", () => {
  it("has no validation violations", () => {
    assert.deepEqual(validateWorkCapabilityRegistry(), []);
  });

  it("ids are unique", () => {
    const ids = WORK_CAPABILITIES.map((c) => c.id);
    assert.equal(new Set(ids).size, ids.length);
  });

  it("every default starter is stable and has a seed", () => {
    for (const c of WORK_CAPABILITIES.filter((c) => c.defaultStarter)) {
      assert.equal(c.state, "stable", `starter ${c.id} must be stable`);
      assert.ok((c.starterSeed ?? "").length > 0, `starter ${c.id} seed`);
    }
  });

  it("not_exposed capabilities are never default starters", () => {
    for (const c of WORK_CAPABILITIES) {
      if (c.state === "not_exposed") {
        assert.equal(c.defaultStarter, false, c.id);
      }
    }
  });
});

describe("WorkCapabilityRegistry: default starters (spec §8.3)", () => {
  it("exposes exactly the four capability-neutral starters", () => {
    const starters = defaultStarters().map((c) => c.id).sort();
    assert.deepEqual(starters, [
      "data_analysis",
      "deliverable",
      "file_organization",
      "research_sources",
    ]);
  });

  it("starter seeds never hard-code an Office deliverable type", () => {
    const forbidden = /\b(docx|xlsx|pptx|document|spreadsheet|presentation|generate a document)\b/i;
    for (const c of defaultStarters()) {
      assert.doesNotMatch(c.starterSeed ?? "", forbidden, c.id);
    }
  });

  it("research starter does not claim a dedicated research engine", () => {
    const research = capabilityById("research_sources");
    assert.ok(research);
    // Capability-neutral: it seeds the workspace_task loop
    // and asks for linked sources only.
    assert.match(research.starterSeed ?? "", /Research/);
    assert.match(research.starterSeed ?? "", /linked sources/);
  });
});

describe("WorkCapabilityRegistry: exposure gating (spec §6.7 / §14)", () => {
  it("workspace_task is the stable base and not a starter", () => {
    const base = capabilityById("workspace_task");
    assert.ok(base);
    assert.equal(base.state, "stable");
    assert.equal(base.defaultStarter, false);
  });

  it("approval / input_request are experimental, not starters", () => {
    for (const id of ["approval", "input_request", "multi_artifact_followup"]) {
      const c = capabilityById(id);
      assert.ok(c, id);
      assert.equal(c.state, "experimental", id);
      assert.equal(c.defaultStarter, false, id);
    }
  });

  it("skills / mcp / browser_qa / scheduling / connectors are not_exposed", () => {
    for (const id of ["skills", "mcp", "browser_qa", "scheduling", "connectors"]) {
      const c = capabilityById(id);
      assert.ok(c, id);
      assert.equal(c.state, "not_exposed", id);
      assert.equal(c.defaultStarter, false, id);
      assert.equal(isExposed(id), false, id);
    }
  });

  it("default starters are exposed; not_exposed are not", () => {
    for (const c of defaultStarters()) assert.ok(isExposed(c.id));
    for (const c of exposedCapabilities()) assert.notEqual(c.state, "not_exposed");
  });

  it("no vendor ability is advertised as stable without a real entry", () => {
    // §14: "不要用新的 starter 文案假装接通研究、Skills、MCP 或
    // 连接器". Skills/MCP/browser QA/connectors stay not_exposed;
    // the four stable starters are all backed by the real
    // workspace_task loop.
    for (const id of ["skills", "mcp", "browser_qa", "scheduling", "connectors"]) {
      assert.equal(isStable(id), false, id);
    }
  });
});
