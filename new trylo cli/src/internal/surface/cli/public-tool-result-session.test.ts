import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { createNdjsonSessionStore } from "../../adapters/session-store/ndjson.js";
import { readSessionContent, sessionContentAddress } from "../../integration/learning-content/sources/session.js";
import { sessionContentRecordView } from "../../integration/learning-content/sources/session-decode.js";
import { sessionContentLocators, SessionContentEnvelopeError } from "../../integration/learning-content/sources/session-address.js";
import { createFakePermission, emptyProfileLoader } from "../../loop/fakes.js";
import { runTurn } from "../../loop/runner.js";
import { parseEnvelope } from "../../protocol/validate.js";
import { projectEnvelopeSequence } from "./stream-projection.js";
import { testScratchPath } from "../../testing/scratch.js";

const combinedOutput = `HEAD-ORIGINAL\n${"x".repeat(20000)}MIDDLE-MUST-REACH-NEXT-REQUEST${"y".repeat(20032)}\nTAIL-RESULT`;

for (const fixture of [
  { name: "a value already larger than one physical frame", value: { path: "original.ts", content: '汉😀"\\\n'.repeat(12000), valid: true }, output: "A separate complete output with a real tail" },
  { name: "a value and output that fit separately but exceed one frame together", value: { path: "wide-reference.txt", content: combinedOutput, truncated: false }, output: combinedOutput },
]) test(`${fixture.name} reaches the next request and the actual stream and native source readers intact`, async t => {
  const root = mkdtempSync(testScratchPath("trylo-public-result-transport-"));

  t.after(() => { assert.equal(path.dirname(root), testScratchPath());
    assert.ok(path.basename(root).startsWith("trylo-public-result-transport-"));
  rmSync(root, { recursive: true, force: true }); });
  const sessionId = "transport-source", turnId = "turn-source", signal = new AbortController().signal;
  const { value, output } = fixture;
  let requests = 0;
  const result = await runTurn({ profile: emptyProfileLoader(), permission: createFakePermission("approved"),
    tools: { snapshot: () => [{ name: "read_file", description: "read", parameters: { type: "object", properties: {} },
      sideEffect: "read_only", needsApproval: false, timeoutMs: 1000, outputLimits: { maxBytes: 65536, maxLines: 1000 } }],
      execute: async () => ({ outcome: "result", value, output, truncated: false }), cancel: async () => {} },
    provider: { async *stream(request) {
      if (requests++ === 0) {
        yield { type: "tool_call", toolCallId: "oversized-value", name: "read_file", arguments: {} };
        yield { type: "finish", reason: "tool_calls", rawReason: "tool_calls", requiresFollowUp: true };
      } else {
        assert.equal(request.messages.find(message => message.role === "tool")?.content, output,
          "the complete middle is model-visible before any later sibling call can recover it");
        yield { type: "finish", reason: "stop", rawReason: "stop", requiresFollowUp: false };
      }
    } } }, { sessionId, turnId, correlationId: "transport", text: "Read the source" });

  assert.equal(result.state.terminalReason, "completed");
  assert.equal(requests, 2);
  assert.equal(result.envelopes.every(envelope => parseEnvelope(envelope).ok), true, "every physical frame obeys the unchanged protocol size limit");
  const shown = projectEnvelopeSequence(result.envelopes).filter(event => event.type === "tool_result");

  assert.equal(shown.length, 1);
  assert.equal(shown[0]!.output, output);
  assert.equal(shown[0]!.truncated, false);
  const store = createNdjsonSessionStore({ path: path.join(root, "source.ndjson") }), at = "2026-11-08T04:00:00.000Z";

  try {
    assert.ok((await store.start({ sessionId, createdAt: at, fingerprint: { schemaVersion: "1", workspaceId: "transport-workspace",
      providerId: "local", model: "transport-contract", toolCatalogHash: "catalog" } })).ok);
    assert.ok((await store.append({ type: "turn_start", sessionId, turnId, at, payload: {} })).ok);
    assert.ok((await store.append({ type: "turn_input", sessionId, turnId, at, payload: { text: "Read the source" } })).ok);

    for (const envelope of result.envelopes) assert.ok((await store.append({ type: "envelope", sessionId, turnId, at, payload: { envelope } })).ok);

    const finalIndex = result.envelopes.findIndex(envelope => envelope.kind === "tool_result");
    assert.ok(finalIndex >= 0);
    const address = sessionContentAddress({ sessionId, journalSequence: finalIndex + 3 });
    const read = await readSessionContent({ session: store, sessionId, turnId, scope: root, subsystem: "method", enabled: () => true }, signal);
    assert.ok(read.ok);
    let text = "", start = 0;

    while (true) {
      const page = await read.value.source.readMaterial(address, signal, start, 4096);
      assert.ok(page.ok);
      text += page.value.text;
      start = page.value.end;
      if (start === page.value.totalChars) break;
    }

    const body = JSON.parse(text);
    assert.equal(body.representation, "reassembled_public_tool_result");
    assert.deepEqual(body.payload.value, value);
    assert.equal(body.payload.output, output);
    assert.equal(body.payload.truncated, false);
    const records = await store.readRecords();
    assert.ok(records.ok);
    const fragmentRows = records.view.records.filter(row => {
      if (row.type !== "envelope") return false;
      const parsed = parseEnvelope(row.payload.envelope);
      return parsed.ok && parsed.envelope.kind === "observation" && parsed.envelope.payload.component === "tool_result_transport";
    });

    assert.ok(fragmentRows.length > 1);

    for (const row of fragmentRows) {
      assert.equal(sessionContentRecordView(row, root), undefined, "transport fragments are not independent evidence");
      assert.equal((await read.value.source.readMaterial(sessionContentAddress({ sessionId, journalSequence: row.sequence }), signal)).ok, false);
    }

    const wrongTurn = { ...records.view, records: records.view.records.map(row => row.sequence === fragmentRows[0]!.sequence
      ? { ...row, turnId: "different-original-turn" } : row) };

    assert.throws(() => sessionContentLocators(wrongTurn, sessionId), error => error instanceof SessionContentEnvelopeError
      && error.validationCode === "public_tool_result_binding", "automatic discovery receives the same typed unavailable-source signal");
    const rejected = await readSessionContent({ session: { readRecords: async () => ({ ok: true, view: wrongTurn }) },
      sessionId, turnId, scope: root, subsystem: "method", enabled: () => true }, signal);

    assert.equal(rejected.ok, false, "a fragment must also match its native journal turn, not just another envelope's claimed identity");
  } finally { await store.release(); }
});
