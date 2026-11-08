import assert from "node:assert/strict";
import { test } from "node:test";
import { emptyUsage } from "../../ports/provider.js";
import type { SessionPort } from "../../ports/session.js";
import type { Envelope } from "../../protocol/envelope.js";
import { isCliRunResult, type CliUsageAccounting } from "../../protocol/cli-stream.js";
import { projectRunResult } from "./projection.js";
import { projectEnvelopeSequence } from "./stream-projection.js";
import { persistTurn } from "./session-record.js";
import { createTurnRecorder } from "./turn-recorder.js";
import { resolveConnectionSettings } from "./connection-settings.js";
import { parseArgs } from "./args.js";
import type { CliContext } from "./context.js";

const usage = { inputTokens: 12, outputTokens: 3, totalTokens: 15 };
const receipt = { purpose: "compaction_summary" as const, outcome: "completed" as const, usageStatus: "reported" as const,
  usage: { ...emptyUsage(), ...usage } };
const accounting: CliUsageAccounting = { mainUsage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
  auxiliaryUsage: usage, auxiliaryRequests: [receipt], auxiliaryUsageStatus: "reported", costUsd: 15 };
const meta = { sessionId: "s", turnId: "t", providerId: "fixture", model: "local", iterations: 0, durationMs: 0 };
const terminal = { status: "completed" as const, finishReason: "stop" };

test("parent accounting is additive in the final CLI projection and old callers keep the old shape", () => {
  const old = projectRunResult([], usage, meta, terminal);
  assert.equal(Object.hasOwn(old, "auxiliaryRequests"), false);
  assert.equal(isCliRunResult(old), true);
  const result = projectRunResult([], usage, { ...meta, accounting }, terminal);
  assert.deepEqual(result.auxiliaryRequests, [receipt]);
  assert.deepEqual(result.mainUsage, accounting.mainUsage);
  assert.equal(result.costUsd, 15);
  assert.equal(isCliRunResult(result), true);
});

test("optional accounting fields are validated rather than trusted from a decoded stream", () => {
  const base = projectRunResult([], usage, meta, terminal);
  for (const extra of [{ auxiliaryRequests: "not-an-array" }, { auxiliaryUsageStatus: "fabricated" },
    { costUsd: -1 }, { auxiliaryRequests: [{ ...receipt, usageStatus: "missing" }] },
    { auxiliaryRequests: [{ ...receipt, usage: undefined }] }]) assert.equal(isCliRunResult({ ...base, ...extra }), false);
});

test("known successful summary receipts never become warnings or compaction failures", () => {
  const envelope: Envelope = { protocolVersion: "0.0", eventId: "usage", sequence: 1, timestamp: "2026-11-08T00:00:00Z",
    kind: "observation", producerId: "fixture", producerSequence: 1,
    payload: { component: "auxiliary_usage", operation: "summary_request", ...receipt } };
  assert.deepEqual(projectEnvelopeSequence([envelope]), []);
});

for (const mode of ["legacy", "live"] as const) test(`parent usage breakdown survives the ${mode} terminal writer`, async () => {
  const records: Parameters<SessionPort["append"]>[0][] = [];
  const session: SessionPort = { async start() { throw new Error("unused"); }, async attach() { throw new Error("unused"); },
    async read() { throw new Error("unused"); }, async readRecords() { throw new Error("unused"); }, async release() {},
    async repairTornTail() { throw new Error("unused"); },

    async append(record) {
      records.push(record);
      return { ok: true, sequence: records.length - 1 };
    } };

  if (mode === "legacy") await persistTurn(session, { ...meta, newTranscript: [], envelopes: [], issuedKeys: [], committedKeys: [],
    terminalReason: "completed", finishReason: "stop", usage, accounting, startedAt: "now", finishedAt: "now", clock: () => "now" });
  else {
    const recorder = createTurnRecorder({ session, sessionId: "s", turnId: "t", now: () => 0 });
    assert.ok(recorder);
    await recorder.finish({ status: "completed", finishReason: "stop", usage, accounting });
  }

  const stored = records.find(record => record.type === "terminal")?.payload;

  assert.deepEqual(stored?.["usage"], usage);
  assert.deepEqual(stored?.["accounting"], accounting);
});

test("the existing CLI money-budget owner refuses missing pricing before provider or session work", () => {
  const parsed = parseArgs(["run", "--max-budget-usd", "1", "task"]);

  assert.equal(parsed.kind, "run");

  if (parsed.kind !== "run") throw new Error("fixture parse failed");

  for (const configuration of [undefined, JSON.stringify({ inputPricePerMTok: 1 })]) {
    const ctx: CliContext = { env: {}, homeDir: "/fixture-home", cwd: "/fixture-workspace", nodeVersion: "fixture", stdinIsTty: false,
      readFile: file => file.endsWith("config.json") ? configuration : undefined,
      isDirectory: () => false, readDir: () => [], writeFile: () => { throw new Error("No writes before pricing validation"); },
      async readStdin() { return ""; }, async readLine() { return undefined; }, async readSecret() { throw new Error("No credential resolution"); },
      stdout: () => {}, stderr: () => {}, now: () => 0, newId: () => { throw new Error("No session identity before pricing validation"); } };
    const result = resolveConnectionSettings(ctx, parsed.options);

    assert.ok("exitCode" in result);
    assert.equal(result.exitCode, 2);
    assert.match(result.message, /needs pricing/);
  }
});
