import assert from "node:assert/strict";
import test from "node:test";
import { createStreamTranslator } from "./stream-projection.js";
import type { Envelope } from "../../protocol/envelope.js";

test("ordinary CLI stream retains the journal's actual route receipt for Desktop", () => {
  const envelope: Envelope = { protocolVersion: "0.0", eventId: "route-event", sequence: 1,
    timestamp: "2026-11-03T00:00:00.000Z", kind: "tool_result", producerId: "runtime", producerSequence: 1,
    payload: { name: "read_file", toolCallId: "read-1", status: "succeeded", output: "source", truncated: false,
      value: { routing: { executionId: "read-1", candidateIds: ["whole", "stream"],
        decision: { path: "whole", reason: "learned_policy", versionId: "route-v1" }, actualPath: "whole",
        outcome: "completed", bytesRead: 12, latencyMs: 3, diagnostics: [] } } } };
  const event = createStreamTranslator().push(envelope)[0];

  assert.deepEqual(event?.type === "tool_result" && "routing" in event ? event.routing : undefined, {
    schemaVersion: 1, decisionPoint: "read_file.strategy.v1", executionId: "read-1", candidateIds: ["whole", "stream"],
    selectedPath: "whole", actualPath: "whole", reason: "learned_policy", versionId: "route-v1", outcome: "completed",
    cost: { bytesRead: 12, latencyMs: 3 }, diagnostics: [] });
});
