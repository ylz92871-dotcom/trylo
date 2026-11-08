import assert from "node:assert/strict";
import { test } from "node:test";
import type { SummaryAuthorReport } from "../../ports/compaction.js";
import type { SessionPort, SessionRecord } from "../../ports/session.js";
import { createFakePermission, createFakeProvider, createFakeTools, emptyProfileLoader } from "../../loop/fakes.js";
import { executeCompaction } from "./compact-maintenance.js";
import { compactionWiring } from "./compaction-wiring.js";
import type { TurnHostInput } from "./host.js";
import type { Wiring } from "./wiring.js";

const BODY = "SUMMARY_TEXT_ONLY_BELONGS_IN_THE_DURABLE_WINDOW";

for (const scenario of ["model", "fallback", "append_failure"] as const) test(`manual compaction exposes its author after ${scenario}`, async () => {
  const records: SessionRecord[] = [
    { formatVersion: "1", sequence: 0, type: "transcript_item", sessionId: "manual-author", at: "1970-01-01T00:00:00Z",
      payload: { kind: "user", sequence: 0, text: "Continue the original work." } },
    { formatVersion: "1", sequence: 1, type: "transcript_item", sessionId: "manual-author", at: "1970-01-01T00:00:00Z",
      payload: { kind: "assistant_text", sequence: 1, blockId: "history", text: "Verified observation. ".repeat(1000) } },
  ];
  const report: SummaryAuthorReport = scenario === "model" ? { author: "model" }
    : { author: "extractive", reason: "provider_error" };
  const session: SessionPort = {
    async start() { throw new Error("unused"); }, async attach() { throw new Error("unused"); },
    async read() { throw new Error("unused"); }, async repairTornTail() { throw new Error("unused"); },
    async release() {},
    async readRecords() { return { ok: true, view: { records, tornTail: false } }; },

    async append(draft) {
      if (scenario === "append_failure") return { ok: false, code: "disk_full" };
      const sequence = records.length;
      records.push({ ...draft, sequence, formatVersion: "1" });
      return { ok: true, sequence };
    },
  };
  const output: string[] = [];
  const input: TurnHostInput = { text: "/compact", sessionId: "manual-author", turnId: "maintenance", correlationId: "test",
    workspaceRoot: ".", checkpointRoot: ".", workspaceId: "fixture", providerId: "fixture", model: "fixture", endpoint: "",
    apiKey: undefined, permission: createFakePermission("approved"), session, format: "stream-json", now: () => 0,
    sink: { stdout: line => output.push(line), stderr: () => {} } };
  const wiring: Wiring = { close: async () => {}, providerId: "fixture", model: "fixture", toolCatalogHash: "fixture",
    ports: { provider: createFakeProvider([]), tools: createFakeTools([], []), permission: input.permission, profile: emptyProfileLoader(),
      compaction: compactionWiring({ nowMs: 0, summarize: (_items, _previous, _signal, _transcript, reportSummary) => {
        reportSummary?.(report);
        return BODY;
      } }) } };
  const result = await executeCompaction(input, wiring);
  const events = output.flatMap(line => line.trim().split("\n").filter(Boolean).map(value => JSON.parse(value) as Record<string, unknown>));
  const compacts = events.filter(event => event.type === "compact");

  assert.equal(result.result.status, scenario === "append_failure" ? "failed" : "completed");
  assert.equal(compacts.length, 2);
  assert.equal(compacts[0]?.status, "started");
  assert.equal(compacts[0]?.summaryAuthor, undefined);
  assert.deepEqual(compacts[1]?.summaryAuthor, report);
  assert.equal(compacts[1]?.status, scenario === "append_failure" ? "failed" : "completed");
  assert.equal(JSON.stringify(compacts).includes(BODY), false);
  assert.equal(records.filter(record => record.type === "compact").length, scenario === "append_failure" ? 0 : 1);
});
