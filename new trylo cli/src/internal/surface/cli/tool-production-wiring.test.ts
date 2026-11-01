import assert from "node:assert/strict";
import test from "node:test";
import { productionToolsForTurn } from "./tool-production-wiring.js";

test("learning-off and non-tool modes, plus tools none, never read a production path or authority store", async () => {
  const ctx = { get env(): never { throw new Error("profile must not be read"); }, get homeDir(): never { throw new Error("profile must not be read"); },
    now: () => 0, newId: () => "test", stderr: () => {} };
  for (const learning of [undefined, "user", "method"] as const) {
    assert.equal(await productionToolsForTurn(ctx, { ...(learning === undefined ? {} : { learning }), workspaceId: "test", sessionId: "test" }), undefined);
  }
  assert.equal(await productionToolsForTurn(ctx, { learning: "all", toolSelection: [], workspaceId: "test", sessionId: "test" }), undefined);
});
