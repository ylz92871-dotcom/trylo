import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createNdjsonSessionStore } from "../../adapters/session-store/ndjson.js";
import { sessionContentAddress } from "../../integration/learning-content/sources/session-address.js";
import { isCentralUnreadNavigationMaterial } from "../../learning/central/runtime/material-role.js";
import { MAX_PAYLOAD_BYTES } from "../../protocol/envelope.js";
import { parseEnvelope } from "../../protocol/validate.js";
import type { CliContext } from "./context.js";
import { createCentralRuntimeMaterials } from "./central-runtime-materials.js";
import { createRuntimeSessionMaterials } from "./central-runtime-materials-session.js";
import { sessionPath } from "./session-paths.js";

const at = "2026-11-08T03:30:00.000Z", signal = new AbortController().signal;

function fixture(t: { after(fn: () => void): void }) {
  const root = mkdtempSync(path.join(os.tmpdir(), "trylo-session-source-failure-")), home = path.join(root, "profile");

  mkdirSync(home);
  t.after(() => { assert.equal(path.dirname(root), path.resolve(os.tmpdir()));
    assert.ok(path.basename(root).startsWith("trylo-session-source-failure-"));
  rmSync(root, { recursive: true, force: true }); });
  const ctx: CliContext = { cwd: path.join(root, "workspace"), homeDir: root, env: { TRYLO_HOME: home },
    nodeVersion: "test", stdinIsTty: false, now: () => Date.parse(at), newId: prefix => prefix,
    readFile: file => existsSync(file) ? readFileSync(file, "utf8") : undefined,
    isDirectory: file => existsSync(file) && statSync(file).isDirectory(),
    readDir: directory => existsSync(directory) ? readdirSync(directory).map(name => {
      const stat = statSync(path.join(directory, name));
      return { name, bytes: stat.size, modifiedAtMs: stat.mtimeMs }; }) : [],
    writeFile: () => false, stdout() {}, stderr() {}, readStdin: async () => "",
    readLine: async () => undefined, readSecret: async () => undefined };
  const workspaceId = "source-failure-workspace";
  const journal = async (sessionId: string, oversized = false) => {
    const store = createNdjsonSessionStore({ path: sessionPath(ctx.homeDir, ctx.env, sessionId) }), turnId = `turn-${sessionId}`;

    try {
      assert.ok((await store.start({ sessionId, createdAt: at, fingerprint: { schemaVersion: "1", workspaceId,
        providerId: "local", model: "source-regression", toolCatalogHash: "catalog" } })).ok);
      assert.ok((await store.append({ type: "turn_start", sessionId, turnId, at, payload: {} })).ok);
      assert.ok((await store.append({ type: "turn_input", sessionId, turnId, at, payload: { text: "HEALTHY_ORIGINAL_REQUIREMENT" } })).ok);

      if (oversized) {
        const envelope = { protocolVersion: "0.0", eventId: "oversized-result", sequence: 3, timestamp: at, sessionId, turnId,
          kind: "tool_result", producerId: "loop", producerSequence: 3,
          payload: { toolCallId: "real-public-tool", status: "succeeded", output: "PRIVATE_RESULT_MARKER".padEnd(MAX_PAYLOAD_BYTES + 4000, "x"), truncated: false } };
        assert.deepEqual(parseEnvelope(envelope), { ok: false, code: "payload_too_large" });
        assert.ok((await store.append({ type: "envelope", sessionId, turnId, at, payload: { envelope } })).ok);
      }
    } finally { await store.release(); }

    return { filename: sessionPath(ctx.homeDir, ctx.env, sessionId), address: sessionContentAddress({ sessionId, journalSequence: 2 }) };
  };

  return { ctx, workspaceId, enabled: () => true, journal };
}

test("one invalid public envelope is visible as unavailable navigation while healthy sessions remain readable", async t => {
  const f = fixture(t), bad = await f.journal("bad-public", true), good = await f.journal("healthy");
  const original = readFileSync(bad.filename), source = createCentralRuntimeMaterials(f);
  const snapshot = await source.snapshot(f.ctx.cwd, signal);

  assert.ok(JSON.stringify(snapshot.materials).includes("HEALTHY_ORIGINAL_REQUIREMENT"));
  const diagnostic = snapshot.materials.find(material => material.text.includes('"status":"unavailable"'));

  assert.ok(diagnostic, "automatic discovery reports the rejected original instead of silently dropping it");
  assert.equal(isCentralUnreadNavigationMaterial(diagnostic), true);
  assert.deepEqual(diagnostic.sourceRefs, [], "the diagnostic delivers no original source body");
  const failure = JSON.parse(diagnostic.text);

  assert.equal(failure.sessionId, "bad-public");
  assert.equal(failure.journalSequence, 3);
  assert.equal(failure.reason, "content_source_envelope_invalid");
  assert.equal(failure.validationCode, "payload_too_large");
  assert.equal(JSON.stringify(snapshot).includes("PRIVATE_RESULT_MARKER"), false);
  const failurePage = await source.pageReader.read(diagnostic.ref, signal, 0, 4096);
  assert.ok(failurePage.ok);
  assert.equal(failurePage.value.text, diagnostic.text, "the advertised diagnostic remains readable as navigation");
  const read = await createRuntimeSessionMaterials(f).reader.readMaterial(bad.address, signal);

  assert.deepEqual(read, { ok: false, reason: "content_source_envelope_invalid" });
  const page = await source.pageReader.read(good.address, signal, 0, 4096);
  assert.ok(page.ok);
  assert.equal(page.value.text, "HEALTHY_ORIGINAL_REQUIREMENT");
  const later = await source.snapshot(f.ctx.cwd, signal, { subjects: [], sourceRefs: [diagnostic.ref] });

  assert.equal(later.materials.some(material => material.ref === diagnostic.ref), false, "an unchanged diagnostic does not keep waking the central loop");
  assert.deepEqual(readFileSync(bad.filename), original, "original invalid records are retained byte for byte");
  const cancelled = new AbortController();
  cancelled.abort();
  await assert.rejects(source.snapshot(f.ctx.cwd, cancelled.signal), /cancelled/u);
});
