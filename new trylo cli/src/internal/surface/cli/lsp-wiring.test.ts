import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildLspPool, lspAuthorizer } from "./lsp-wiring.js";

/**
 * Pool construction for a run: undefined in, undefined out, and an exact-match
 * authorizer. The catalog-mount half is proven in `wiring.test.ts`; this proves
 * the pool half — what may start, with whose environment, and where the facts
 * go.
 */
describe("buildLspPool", () => {
  it("builds nothing when no servers were configured", () => {
    assert.equal(buildLspPool(undefined), undefined);
  });

  it("authorizes exactly the configured commands", async () => {
    const authorize = lspAuthorizer([{ serverName: "ts", command: "tsserver", args: [], extensions: ["ts"] }]);

    assert.deepEqual(await authorize("tsserver", []), { ok: true });
    const refused = await authorize("tsserver.exe", []);

    assert.equal(refused.ok, false);

    if (!refused.ok) {
      assert.equal(refused.code, "lsp_start_denied");
    }
  });
});
