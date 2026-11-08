import test from "node:test";
import assert from "node:assert/strict";
import { sha256Hex } from "../../learning/control/hash.js";
import { createCentralMaterialCapabilities, centralKnowledgeQueryRef, readCentralMaterialPageRef } from "./deliberation-material.js";

test("actual source pages retain coordinates/hash and bounded continuation does not pretend to read the entire source", async () => {
  const full = "contract premise 😀 changes after this page.\n".repeat(64), starts: number[] = [], budget = 1024;
  const capability = createCentralMaterialCapabilities({ scope: "project:central-material", enabled: () => true,

    resolvePage: async ({ ref, start, maximumChars }) => {
      starts.push(start);
      const end = Math.min(full.length, start + maximumChars);
      return { ok: true, value: { ref, originalRef: "source:contract", originalScope: "project:central-material",
        origin: "user_statement", start, end, totalChars: full.length, text: full.slice(start, end), sourceHash: sha256Hex(full),
        coordinate: { runId: "session:one", sequence: 7 }, owner: "session" } };
    } });
  const first = await capability.read(["source:contract"], budget, new AbortController().signal);
  const body = JSON.parse(first[0]!.text);

  assert.ok(first[0]!.text.length <= budget);
  assert.ok(body.end > 0 && body.end < budget);
  assert.equal(body.start, 0);
  assert.equal(body.text, full.slice(0, body.end));
  assert.equal(body.complete, false);
  assert.equal(body.originalRef, "source:contract");
  assert.equal(body.sourceHash, sha256Hex(full));
  assert.equal(body.totalChars, full.length);
  assert.deepEqual(body.coordinate, { runId: "session:one", sequence: 7 });
  assert.doesNotMatch(body.text, /[\ud800-\udbff]$/);
  assert.deepEqual(readCentralMaterialPageRef(body.nextRef), { ref: "source:contract", start: body.end });
  const second = await capability.read([body.nextRef], budget, new AbortController().signal), continued = JSON.parse(second[0]!.text);

  assert.ok(second[0]!.text.length <= budget);
  assert.equal(continued.start, body.end);
  assert.ok(continued.end > continued.start);
  assert.equal(continued.text, full.slice(continued.start, continued.end));
  assert.equal(continued.sourceHash, body.sourceHash);
  assert.equal(continued.totalChars, full.length);
  assert.notEqual(second[0]!.ref, first[0]!.ref);
  assert.deepEqual(readCentralMaterialPageRef(continued.nextRef), { ref: "source:contract", start: continued.end });
  assert.deepEqual(starts, [0, body.end]);
  await assert.rejects(capability.read(["source:contract"], 8, new AbortController().signal), /central_material_capacity/);
});

test("a read capability cannot cross original source scope or transmit a configured literal secret", async () => {
  for (const [scope, secret] of [["project:elsewhere", "safe"], ["project:central-material", "literal-private-credential"]]) {
    const capability = createCentralMaterialCapabilities({ scope: "project:central-material", enabled: () => true,
      secrets: ["literal-private-credential"], resolvePage: async () => ({ ok: true, value: { ref: "source:contract", originalRef: "source:contract",
        originalScope: scope!, origin: "user_statement", start: 0, end: secret!.length, totalChars: secret!.length, text: secret!,
        sourceHash: sha256Hex(secret!), coordinate: { runId: "session:one", sequence: 1 }, owner: "session" } }) });
    await assert.rejects(capability.read(["source:contract"], 100, new AbortController().signal), /source_mismatch|sensitive/);
  }
});

test("a semantic read can query related old knowledge by a bounded purpose without recasting it as source evidence", async () => {
  const purposes: string[] = [];
  const capability = createCentralMaterialCapabilities({ scope: "project:central-material", enabled: () => true,
    resolvePage: async () => ({ ok: false, reason: "content_material_missing" }),
    recall: async purpose => { purposes.push(purpose);
    return { ref: "knowledge:contract", kind: "knowledge",
      sourceRefs: ["original:knowledge"], text: "Known contract applies only when its explicit premise holds." }; } });
  const rows = await capability.read([centralKnowledgeQueryRef("contract premise")], 1000, new AbortController().signal);

  assert.deepEqual(purposes, ["contract premise"]);
  assert.equal(rows[0]?.kind, "knowledge");
  assert.match(rows[0]!.text, /only when/);
});
