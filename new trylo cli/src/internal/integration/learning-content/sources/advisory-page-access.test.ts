import assert from "node:assert/strict";
import test from "node:test";
import { emptyBoardState } from "../../../learning/control/state.js";
import { createCentralAdvisorySourceAccess } from "./advisory-access.js";

test("central page ancestry uses the ordinary session owner and preserves denial", async () => {
  const ref = 'session-address:{"journalSequence":3934,"sessionId":"original-business"}';
  const calls: unknown[][] = [];
  let readable = false;
  const access = () => createCentralAdvisorySourceAccess({ board: emptyBoardState(), scope: "original-scope", enabled: () => true,
    sessionSource: { async readMaterial(...args) {
      calls.push(args);
      return readable ? { ok: true as const, value: { ref, sessionId: "original-business", journalSequence: 3934,
        sourceHash: "a".repeat(64), start: args[2] ?? 0, end: (args[2] ?? 0) + 2, totalChars: 100,
        text: "ok", origin: "execution_result" as const, originalScope: "original-scope", sourceRecordType: "transcript_item" } }
        : { ok: false as const, reason: "content_material_scope" };
    } } });
  const advisory = { ref: "advisory:original", version: "publication:original", sourceRefs: [`central-page:7:${ref}`] };

  assert.equal((await access()(advisory, new AbortController().signal)).status, "denied");
  readable = true;
  assert.equal((await access()(advisory, new AbortController().signal)).status, "allowed");
  assert.ok(calls.every(call => call[0] === ref && call[2] === 7 && call[3] === 2));
});
