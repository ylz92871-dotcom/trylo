import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { mock, test } from "node:test";
import { brokerRequest } from "./broker-client.js";
import { isAddress, snapshotRegistry } from "./broker-contract.js";
import { MCP_SEARCH } from "./discovery-provider.js";
import { openProgressiveMcpRuntime } from "./progressive.js";
import { testScratchPath } from "../../testing/scratch.js";

for (const [code, syscall, expected, expectedCode] of [
  ["ECONNREFUSED", "connect", "error", "mcp_broker_unavailable"],
  ["ECONNRESET", "read", "unknown", "mcp_broker_delivery_unknown"],
] as const) {
  test(`MCP search preserves trusted broker ${expected} delivery classification`, async () => {
    const root = await mkdtemp(join(testScratchPath(), "mcp-search-error-"));
    const registry = snapshotRegistry([{ name: "alpha", command: process.execPath, args: [], env: {}, transport: "stdio", enabled: true }]);
    const runtime = await openProgressiveMcpRuntime({ registry, cwd: process.cwd() }, { root, scope: "search-errors", policy: "ask" });
    const files = (await readdir(root)).filter(file => file.endsWith(".json"));
    assert.equal(files.length, 1, "this test must use its private HTTP broker, not turn-owned fallback");
    const address: unknown = JSON.parse(await readFile(join(root, files[0]!), "utf8"));
    assert.ok(isAddress(address));
    const failure = new TypeError("fetch failed", {
      cause: Object.assign(new Error("native transport error"), { code, syscall }),
    });
    const fetch = mock.method(globalThis, "fetch", async () => { throw failure; });
    try {
      const outcome = await runtime.tools.execute({ name: MCP_SEARCH, toolCallId: "search", arguments: { server: "alpha" } }, new AbortController().signal);
      assert.equal(outcome.outcome, expected);
      assert.ok("code" in outcome);
      assert.equal(outcome.code, expectedCode);
      assert.equal(fetch.mock.callCount(), 1, "discovery does not replay the failed request");
    } finally {
      fetch.mock.restore();
      await runtime.close();
      await brokerRequest(address, { method: "shutdown" });
      await rm(root, { recursive: true, force: true });
    }
  });
}
