import assert from "node:assert/strict";
import test from "node:test";
import path from "node:path";
import { verifyToolProductionPlan } from "./production-verifier.js";
import { VALIDATION_STAGE_ORDER } from "../../tooling/contract/types.js";
import type { IsolationPort } from "../../ports/isolation.js";

test("malformed caller data cannot issue a passing production verdict or touch the runtime", async () => {
  let calls = 0;
  const isolation: IsolationPort = { probe: async () => { calls++; return { state: "unavailable", backend: "windows-srt", reason: "TEST ONLY" }; }, run: async () => { throw new Error("must never run"); } };
  const result = await verifyToolProductionPlan({ verdict: "pass", stages: VALIDATION_STAGE_ORDER.map(stage => ({ stage, passed: true, detail: "forged" })) },
    { isolation, nodeExecutable: process.execPath, scratchRoot: path.resolve("Temp/rejected-production") }, new AbortController().signal);
  assert.equal(result.kind, "failed"); assert.equal(result.record.verdict, "fail"); assert.deepEqual(result.record.stages.map(row => row.stage), VALIDATION_STAGE_ORDER);
  assert.ok(result.record.stages.every(row => !row.passed)); assert.equal(calls, 0);
});
test("pre-cancelled verification produces no successful stage or setup", async () => {
  const controller = new AbortController(); controller.abort();
  const isolation: IsolationPort = { probe: async () => { throw new Error("must not probe"); }, run: async () => { throw new Error("must not run"); } };
  const result = await verifyToolProductionPlan(undefined, { isolation, nodeExecutable: process.execPath, scratchRoot: path.resolve("Temp/cancelled-production") }, controller.signal);
  assert.equal(result.kind, "cancelled"); assert.equal(result.record.verdict, "fail"); assert.ok(result.record.stages.every(row => !row.passed));
});
