import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { LanguageServerPool, mayStartCommand, type LspServerConfig } from "./registry.js";
import type { LanguageServerPort } from "../../ports/language-server.js";

/**
 * The start gate: only configured programs run, and the comparison is exact.
 * A looser rule (basename, prefix, PATH search) would let a neighbouring
 * program through, which `needsApproval: false` forbids — the model chooses
 * the question, never what executes.
 */
describe("pool limit enforcement", () => {
  it("truncates through a pooled connection", async () => {
    const locations = Array.from({ length: 12 }, (_, index) => ({
      path: `src/f${index}.ts`,
      line: index,
      character: 0,
    }));
    const port: LanguageServerPort = {
      serverName: "ts",
      workspaceRoot: "D:/w",
      ensureStarted: async () => ({ ok: true }),
      openDocument: async () => ({ ok: true }),
      query: async (q) => ({
        ok: true,
        operation: q.operation,
        answer: { status: "answered", locations },
        truncated: false,
      }),
      isRunning: () => true,
      close: async () => undefined,
    };
    const pool = new LanguageServerPool({
      servers: [{ serverName: "ts", command: "tsserver", args: [], extensions: ["ts"] }],
      deps: { authorize: async () => ({ ok: true }), hostEnv: {}, log: () => undefined },
      limits: { requestTimeoutMs: 1000, maxConcurrentRequests: 8, maxMessageBytes: 1_000_000, maxLocationsPerAnswer: 5, maxServers: 4, idleTtlMs: 300_000 },
      createServer: () => port,
    });
    const connected = await pool.connectionFor("D:/w", "src/a.ts");

    assert.equal(connected.ok, true);

    if (!connected.ok) return;

    const result = await connected.port.query(
      { operation: "references", path: "src/a.ts", line: 0, character: 0 },
      new AbortController().signal,
    );

    assert.equal(result.ok, true);

    if (!result.ok) return;

    // The pool wraps every connection in the limits decorator: ceilings
    // belong to the pool, not to each caller.
    assert.equal(result.truncated, true);

    if (result.answer.status !== "answered") return;

    assert.equal(result.answer.locations.length, 5);
    await pool.closeAll();
  });
});

describe("mayStartCommand", () => {
  const servers: ReadonlyArray<LspServerConfig> = [
    { serverName: "ts", command: "typescript-language-server", args: ["--stdio"], extensions: ["ts"] },
    { serverName: "py", command: "D:/tools/pylsp.exe", args: [], extensions: ["py"], enabled: false },
  ];

  it("allows exactly what the configuration named", () => {
    assert.equal(mayStartCommand(servers, "typescript-language-server"), true);
  });

  it("refuses neighbours, absolute variants, and disabled servers", () => {
    assert.equal(mayStartCommand(servers, "typescript-language-server.exe"), false);
    assert.equal(mayStartCommand(servers, "D:/tools/typescript-language-server"), false);
    assert.equal(mayStartCommand(servers, "D:/tools/pylsp.exe"), false);
    assert.equal(mayStartCommand(servers, "pylsp"), false);
    assert.equal(mayStartCommand(servers, ""), false);
  });
});
