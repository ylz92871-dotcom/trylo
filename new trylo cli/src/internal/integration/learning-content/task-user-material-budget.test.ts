import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createNdjsonSessionStore } from "../../adapters/session-store/ndjson.js";
import { contentHashOf } from "../../learning/control/hash.js";
import { createNormalTaskContentRuntime } from "./task-runtime.js";
import { createStagedContentSession } from "./staged.js";
import { sessionContentRecordRef } from "./sources/session.js";

test("normal user material chunks by transport cost before the 32k text limit and retains exact incomplete requirement pages", async () => {
  const root = await mkdtemp(join(tmpdir(), "trylo-user-material-budget-"));
  const session = createNdjsonSessionStore({ path: join(root, "session.ndjson") });
  const at = "2026-11-04T22:00:00Z", signal = new AbortController().signal;

  try {
    assert.ok((await session.start({ sessionId: "user-budget-session", createdAt: at, fingerprint: {
      schemaVersion: "1", providerId: "local-contract", model: "local-contract", toolCatalogHash: "catalog", workspaceId: "repo:user-budget" } })).ok);
    for (const [length, filler] of [[26000, "x"], [32000, "x"], [20000, '"']] as const) {
      const turnId = `original-${length}`, head = `FIRST ${length}: preserve the original user requirement.\n`;
      const tail = `\nFINAL ${length}: inspect the final original condition.`;
      const text = head + filler.repeat(length - head.length - tail.length) + tail;
      const appended = await session.append({ type: "transcript_item", sessionId: "user-budget-session", turnId, at,
        payload: { kind: "user", sequence: 0, text } });
      assert.ok(appended.ok);
      const runtime = createNormalTaskContentRuntime({ boardRoot: join(root, "board"), scope: "repo:user-budget", domain: "tool",
        session, sessionId: "user-budget-session", turnId, enabled: () => true, now: () => Date.parse(at) });
      const prepared = await runtime.prepare({}, signal);
      assert.ok(prepared.ok, JSON.stringify({ length, filler, prepared }));
      const rawRef = sessionContentRecordRef("user-budget-session", appended.sequence), packet = prepared.value.packet;
      const first = packet.records.find(row => row.ref === `${rawRef}:chunk:0`);
      assert.ok(first);
      assert.ok(first.text.startsWith(head));
      assert.equal(packet.requirements.length, 1);
      assert.ok(packet.requirements[0]?.answerRequirement.includes("incomplete"));
      assert.ok(prepared.value.coverage.session.omitted.length > 0);
      assert.equal(packet.answers.length, 0);
      const context = JSON.parse(packet.materials.find(row => row.id === first.ref)!.context) as {
        originalRef: string; totalChars: number; sourceHash: string; pagingAvailable: boolean;
      };

      assert.equal(context.originalRef, rawRef);
      assert.equal(context.totalChars, length);
      assert.equal(context.sourceHash, contentHashOf(text));
      assert.equal(context.pagingAvailable, true);
      const stages = createStagedContentSession({ runtime, enabled: () => true });
      const begin = await stages.begin({ maximumPromptChars: 100000 }, signal);

      assert.equal(begin.status, "apply_known");
      if (begin.status !== "apply_known") throw new Error("budget_user_stage_failed");

      const page = await stages.readMaterial({ stageRef: begin.stageRef, evidenceRef: rawRef,
        start: text.length - tail.length, maximumChars: 256 }, signal);

      assert.ok(page.ok, JSON.stringify(page));
      assert.equal(page.record.text, tail);
      assert.ok("source" in page);
      assert.equal(page.source.sourceHash, contentHashOf(text));
      assert.ok("next" in page && page.next);
      const raw = await session.readRecords();
      assert.ok(raw.ok);
      assert.equal(raw.view.records[appended.sequence]?.payload.text, text);
    }
  } finally {
    await session.release();
    await rm(root, { recursive: true, force: true });
  }
});
