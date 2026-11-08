import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import type { ProviderRequest } from "../../ports/provider.js";
import type { SummaryAuthorReport } from "../../ports/compaction.js";
import type { TranscriptItem } from "../../protocol/transcript.js";
import { summarizeTranscript } from "../../compaction/summary.js";
import { testScratchPath } from "../../testing/scratch.js";
import { createFakePermission } from "../../loop/fakes.js";
import { compactionWiring } from "./compaction-wiring.js";
import { wirePorts } from "./wiring.js";
import { parseArgs } from "./args.js";
import { USAGE } from "./usage.js";

const ITEMS: readonly TranscriptItem[] = [{ kind: "user", sequence: 0, text: "Continue the original task with the latest correction." }];
const MODEL_TEXT = "Observed progress; follow the latest correction and continue the task.";

async function summary(mode?: "extractive" | "model", fail = false) {
  const scratch = testScratchPath(), root = mkdtempSync(path.join(scratch, "default-model-summary-"));
  const requests: ProviderRequest[] = [], reports: SummaryAuthorReport[] = [];
  const wiring = wirePorts({ providerId: "fixture", model: "local-fixture", endpoint: "", apiKey: undefined,
    workspaceRoot: root, permission: createFakePermission("approved"), nowMs: 0, contextTokenLimit: 65536,
    toolSelection: ["read_file"], ...(mode === undefined ? {} : { compactSummary: mode }),
    providerGuard: () => ({ async *stream(request) {
      requests.push(request);
      if (fail) {
        yield { type: "error", class: "network", retryable: false, phase: "before_headers", message: "local fixture" };
        return;
      }
      yield { type: "text_delta", blockId: "summary", text: MODEL_TEXT };
      yield { type: "finish", reason: "stop", rawReason: "stop", requiresFollowUp: false };
    } }) });

  try {
    assert.ok(!("code" in wiring));
    assert.ok(wiring.ports.compaction);
    const text = await wiring.ports.compaction.summarize(ITEMS, undefined, undefined, undefined, report => reports.push(report));
    return { text, requests, reports };
  } finally {
    if (!("code" in wiring)) await wiring.close();
    assert.equal(path.dirname(root), scratch);
    rmSync(root, { recursive: true, force: true });
  }
}

for (const mode of [undefined, "model"] as const) test(`CLI composition selects model summary for ${mode ?? "the omitted option"}`, async () => {
  const result = await summary(mode);
  assert.equal(result.requests.length, 1);
  assert.equal(result.text, MODEL_TEXT);
  assert.deepEqual(result.reports, [{ author: "model" }]);
  assert.equal(result.requests[0]?.maxOutputTokens, undefined);
});

test("explicit extractive summary retains the deterministic no-model path", async () => {
  const result = await summary("extractive");
  assert.equal(result.requests.length, 0);
  assert.equal(result.text, summarizeTranscript(ITEMS));
});

test("the default model author falls back to extractive on a real typed provider failure", async () => {
  const result = await summary(undefined, true);
  assert.equal(result.requests.length, 1);
  assert.equal(result.text, summarizeTranscript(ITEMS));
  assert.deepEqual(result.reports, [{ author: "extractive", reason: "provider_error" }]);
});

test("help states model default and retains the explicit extractive option", () => {
  const line = USAGE.split("\n").find(value => value.includes("--compact-summary"));
  assert.match(line ?? "", /extractive\|model/);
  assert.match(line ?? "", /default: model/);
});

test("parsing preserves omission and the explicit extractive choice for the composition owner", () => {
  const absent = parseArgs(["run", "task"]), explicit = parseArgs(["run", "--compact-summary", "extractive", "task"]);
  assert.equal(absent.kind, "run");
  assert.equal(explicit.kind, "run");
  if (absent.kind !== "run" || explicit.kind !== "run") throw new Error("fixture parse failed");
  assert.equal(absent.options.compactSummary, undefined);
  assert.equal(explicit.options.compactSummary, "extractive");
});

test("the provider-free compaction primitive keeps its extractive fallback", () => {
  assert.equal(compactionWiring({ nowMs: 0 }).summarize(ITEMS), summarizeTranscript(ITEMS));
});
