import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createNdjsonSessionStore } from "../../adapters/session-store/ndjson.js";
import { createTurnRecorder } from "./turn-recorder.js";

const fingerprint = { schemaVersion: "1", workspaceId: "w", providerId: "fixture", model: "m", toolCatalogHash: "h" };

test("long reasoning remains durable without quadratic journal growth", async () => {
  const root = mkdtempSync(join(tmpdir(), "trylo-partial-cost-"));
  const path = join(root, "s.ndjson");
  const store = createNdjsonSessionStore({ path });
  try {
    await store.start({ sessionId: "s", createdAt: "1970-01-01T00:00:00Z", fingerprint });
    const recorder = createTurnRecorder({ session: store, sessionId: "s", turnId: "t", now: () => 0 })!;
    let text = "";
    for (let index = 0; index < 256; index += 1) {
      text += "思考中的片段。".repeat(16);
      assert.deepEqual(await recorder.progress.preserve?.([
        { kind: "assistant_reasoning", blockId: "r", text, redacted: false },
        { kind: "assistant_text", blockId: "unchanged", text: "constant" },
      ]), { ok: true });
    }
    // A fresh reader, not the writer's in-memory projection, must recover the cut.
    const reader = createNdjsonSessionStore({ path });
    const recovered = await reader.read();
    assert.equal(recovered.ok, true);
    if (!recovered.ok) return;
    assert.equal(recovered.session.partials.find(p => p.blockId === "r")?.text, text);
    assert.equal(recovered.session.transcript.length, 0);
    const bytes = statSync(path).size;
    assert.ok(bytes < Buffer.byteLength(text) * 4 + 200_000, `journal grew to ${bytes} bytes for ${Buffer.byteLength(text)} received bytes`);
  } finally {
    await store.release();
    rmSync(root, { recursive: true, force: true });
  }
});

test("redaction changes reset a partial instead of appending secret suffixes", async () => {
  const root = mkdtempSync(join(tmpdir(), "trylo-partial-secret-"));
  const path = join(root, "s.ndjson");
  const store = createNdjsonSessionStore({ path });
  try {
    await store.start({ sessionId: "s", createdAt: "1970-01-01T00:00:00Z", fingerprint });
    const recorder = createTurnRecorder({ session: store, sessionId: "s", turnId: "t", now: () => 0 })!;
    for (const text of ["prefix sk-", "prefix sk-abcdef1234567890", "prefix sk-abcdef1234567890 done", "prefix sk-abcdef1234567890 done!"]) {
      assert.deepEqual(await recorder.progress.preserve?.([{ kind: "assistant_text", blockId: "b", text }]), { ok: true });
    }
    const recovered = await store.read();
    assert.equal(recovered.ok, true);
    if (recovered.ok) assert.equal(recovered.session.partials[0]?.text, "prefix [secret] done!");
    assert.equal(readFileSync(path, "utf8").includes("abcdef1234567890"), false);
  } finally {
    await store.release();
    rmSync(root, { recursive: true, force: true });
  }
});
