import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createLspTools } from "./lsp-tools.js";
import { LSP_TOOL } from "./lsp-names.js";
import { LanguageServerPool, type LspServerConfig } from "../language-server/registry.js";
import type { LanguageServerPort, LspFailure, LspQueryResult } from "../../ports/language-server.js";
import type { ToolCallRequest } from "../../ports/tools.js";
import type { JsonObject } from "../../protocol/envelope.js";

const WORKSPACE = "/w";

function call(args: JsonObject): ToolCallRequest {
  return { toolCallId: `t-${Object.keys(args).join("-")}`, name: LSP_TOOL, arguments: args };
}

const signal = new AbortController().signal;

/** A stand-in for a real server, so the tool's own decisions are under test. */
function stubPort(overrides: Partial<LanguageServerPort> = {}): LanguageServerPort {
  return {
    serverName: "stub",
    workspaceRoot: WORKSPACE,
    ensureStarted: async () => ({ ok: true }),
    openDocument: async () => ({ ok: true }),
    query: async (): Promise<LspQueryResult> => ({ ok: true, operation: "hover", answer: { status: "hover", markdown: "hi" }, truncated: false }),
    isRunning: () => true,
    close: async () => undefined,
    ...overrides,
  };
}

function poolWith(port: LanguageServerPort, servers: ReadonlyArray<LspServerConfig> = [{ serverName: "stub", command: "stub", args: [], extensions: ["ts"] }]): LanguageServerPool {
  return new LanguageServerPool({
    servers,
    deps: { authorize: async () => ({ ok: true }), hostEnv: {}, log: () => undefined },
    createServer: () => port,
  });
}

const deps = {
  workspaceRoot: WORKSPACE,
  readDocument: async () => "export const x = 1;",
};

describe("lsp_navigate tool", () => {
  it("advertises itself with the closed operation set", () => {
    const snapshot = createLspTools(poolWith(stubPort()), deps).snapshot();

    assert.equal(snapshot.length, 1);
    const binding = snapshot[0];

    assert.equal(binding?.name, LSP_TOOL);
    assert.equal(binding?.sideEffect, "read_only");
    const operations = (binding?.parameters as { properties?: { operation?: { enum?: string[] } } }).properties?.operation?.enum;

    assert.deepEqual(operations, ["definition", "references", "hover", "document_symbols", "implementation", "call_hierarchy"]);
  });

  it("hands the document to the server before asking about it", async () => {
    // Without this, a real server answers "nothing here" about a file it was
    // never shown — a confident wrong answer rather than an error.
    const seen: string[] = [];
    const tools = createLspTools(poolWith(stubPort({
      openDocument: async (doc) => {
        seen.push(doc.path);
        return { ok: true };
      },
    })), deps);
    const outcome = await tools.execute(call({ operation: "hover", path: "src/a.ts", line: 0, character: 0 }), signal);

    assert.equal(outcome.outcome, "result");
    assert.deepEqual(seen, ["src/a.ts"]);
  });

  it("sends the language id the server expects, not a bare extension", async () => {
    let languageId = "";
    const tools = createLspTools(poolWith(stubPort({
      openDocument: async (doc) => {
        languageId = doc.languageId;
        return { ok: true };
      },
    }), [{ serverName: "stub", command: "stub", args: [], extensions: ["ts", "tsx"] }]), deps);

    await tools.execute(call({ operation: "hover", path: "src/a.tsx" }), signal);
    // `typescriptreact`, not `tsx` and not `typescript`: sending the wrong id is
    // how a server ends up parsing TSX as plain TypeScript and choking on JSX.
    assert.equal(languageId, "typescriptreact");
  });

  it("reports an empty answer as found:false rather than as a failure", async () => {
    const tools = createLspTools(poolWith(stubPort({
      query: async (q) => ({ ok: true, operation: q.operation, answer: { status: "empty" }, truncated: false }),
    })), deps);
    const outcome = await tools.execute(call({ operation: "definition", path: "src/a.ts", line: 3 }), signal);

    assert.equal(outcome.outcome, "result");

    if (outcome.outcome !== "result") return;

    assert.equal(outcome.value["found"], false);
    // The distinction the whole tool exists for.
    assert.notEqual(outcome.value["found"], undefined);
  });

  it("reports a typed failure instead of an empty answer when the server is gone", async () => {
    // The failure this prevents: a dead server looks like a project with no
    // symbols, and the model says so with confidence.
    const tools = createLspTools(poolWith(stubPort({
      query: async (): Promise<LspQueryResult> => ({ ok: false, code: "lsp_server_exited", message: "exited" }),
    })), deps);
    const outcome = await tools.execute(call({ operation: "definition", path: "src/a.ts" }), signal);

    assert.equal(outcome.outcome, "error");

    if (outcome.outcome !== "error") return;

    assert.equal(outcome.code, "lsp_server_exited");
  });

  it("refuses an operation outside the closed set", async () => {
    const tools = createLspTools(poolWith(stubPort()), deps);
    const outcome = await tools.execute(call({ operation: "rename", path: "src/a.ts" }), signal);
    assert.equal(outcome.outcome, "error");
    if (outcome.outcome !== "error") return;
    assert.equal(outcome.code, "invalid_arguments");
  });

  it("refuses a negative position rather than clamping it to the file start", async () => {
    const tools = createLspTools(poolWith(stubPort()), deps);
    const outcome = await tools.execute(call({ operation: "hover", path: "src/a.ts", line: -3 }), signal);
    assert.equal(outcome.outcome, "error");
  });

  it("defaults a missing position to the start of the file", async () => {
    let askedAt = -1;
    const tools = createLspTools(poolWith(stubPort({
      query: async (q) => {
        askedAt = q.line;
        return { ok: true, operation: q.operation, answer: { status: "hover", markdown: "x" }, truncated: false };
      },
    })), deps);

    await tools.execute(call({ operation: "hover", path: "src/a.ts" }), signal);
    assert.equal(askedAt, 0);
  });

  it("refuses a file with no language server rather than guessing one", async () => {
    const tools = createLspTools(poolWith(stubPort(), [{ serverName: "stub", command: "stub", args: [], extensions: ["py"] }]), deps);
    const outcome = await tools.execute(call({ operation: "hover", path: "src/a.ts" }), signal);
    assert.equal(outcome.outcome, "error");
    if (outcome.outcome !== "error") return;
    assert.equal(outcome.code, "lsp_not_configured");
  });

  it("renders locations so the model can act on them without composing paths", async () => {
    const tools = createLspTools(poolWith(stubPort({
      query: async (q) => ({
        ok: true,
        operation: q.operation,
        answer: { status: "answered", locations: [{ path: "src/b.ts", line: 41, character: 2 }] },
        truncated: false,
      }),
    })), deps);
    const outcome = await tools.execute(call({ operation: "definition", path: "src/a.ts" }), signal);

    assert.equal(outcome.outcome, "result");

    if (outcome.outcome !== "result") return;

    const locations = outcome.value["locations"] as ReadonlyArray<{ readable?: string }>;

    assert.equal(locations[0]?.readable, "src/b.ts:42");
    assert.equal(outcome.output, "src/b.ts:42");
  });

  it("rejects a call for another tool instead of answering it", async () => {
    const tools = createLspTools(poolWith(stubPort()), deps);
    const outcome = await tools.execute({ toolCallId: "x", name: "read_file", arguments: {} }, signal);
    assert.equal(outcome.outcome, "error");
    if (outcome.outcome !== "error") return;
    assert.equal(outcome.code, "unknown_tool");
  });

  it("returns cancelled, not a failure, when the turn is interrupted", async () => {
    const controller = new AbortController();
    controller.abort();
    const tools = createLspTools(poolWith(stubPort()), deps);
    const outcome = await tools.execute(call({ operation: "hover", path: "src/a.ts" }), controller.signal);
    assert.equal(outcome.outcome, "cancelled");
  });

  it("does not consult the file system for a file with no known language", async () => {
    // Nothing to show a server, so nothing should be read; a read would be a
    // pointless cost on a path the server will refuse anyway.
    let reads = 0;
    const tools = createLspTools(poolWith(stubPort()), {
      workspaceRoot: WORKSPACE,
      readDocument: async () => {
        reads += 1;
        return "x";
      },
    });

    await tools.execute(call({ operation: "hover", path: "src/a.unknownext" }), signal);
    assert.equal(reads, 0);
  });
});

describe("LanguageServerPool", () => {
  const config: LspServerConfig = { serverName: "ts", command: "tsserver", args: [], extensions: ["ts", "tsx"] };

  it("reuses one connection per server and project", async () => {
    let created = 0;
    const pool = new LanguageServerPool({
      servers: [config],
      deps: { authorize: async () => ({ ok: true }), hostEnv: {}, log: () => undefined },
      createServer: () => {
        created += 1;
        return stubPort();
      },
    });

    await pool.connectionFor(WORKSPACE, "src/a.ts");
    await pool.connectionFor(WORKSPACE, "src/b.ts");
    assert.equal(created, 1);
    await pool.closeAll();
  });

  it("keeps two projects apart", async () => {
    // A language server's index is per-project; sharing one would answer about
    // the wrong tree while looking entirely healthy.
    let created = 0;
    const pool = new LanguageServerPool({
      servers: [config],
      deps: { authorize: async () => ({ ok: true }), hostEnv: {}, log: () => undefined },
      createServer: () => {
        created += 1;
        return stubPort();
      },
    });

    await pool.connectionFor("/w", "src/a.ts");
    await pool.connectionFor("/other", "src/a.ts");
    assert.equal(created, 2);
    await pool.closeAll();
  });

  it("refuses rather than picking when two servers claim one extension", async () => {
    const pool = new LanguageServerPool({
      servers: [config, { serverName: "other", command: "x", args: [], extensions: ["ts"] }],
      deps: { authorize: async () => ({ ok: true }), hostEnv: {}, log: () => undefined },
    });
    const outcome = await pool.connectionFor(WORKSPACE, "src/a.ts");

    assert.equal(outcome.ok, false);

    if (outcome.ok) return;

    assert.equal(outcome.code, "lsp_not_configured");
    assert.match(outcome.message, /claim \.ts/);
  });

  it("refuses to exceed the server ceiling", async () => {
    const pool = new LanguageServerPool({
      servers: [config],
      limits: { requestTimeoutMs: 1000, maxConcurrentRequests: 1, maxMessageBytes: 1024, maxLocationsPerAnswer: 10, maxServers: 1, idleTtlMs: 1000 },
      deps: { authorize: async () => ({ ok: true }), hostEnv: {}, log: () => undefined },
      createServer: () => stubPort(),
    });

    await pool.connectionFor("/w", "a.ts");
    const second = await pool.connectionFor("/other", "a.ts");

    assert.equal(second.ok, false);

    if (second.ok) return;

    assert.equal(second.code, "lsp_limit_exceeded");
    await pool.closeAll();
  });

  it("releases every server even when one refuses to close", async () => {
    // Teardown must not strand the others as child processes.
    const pool = new LanguageServerPool({
      servers: [config],
      deps: { authorize: async () => ({ ok: true }), hostEnv: {}, log: () => undefined },
      createServer: () => stubPort({
        close: async () => {
          throw new Error("refuses");
        },
      }),
    });

    await pool.connectionFor("/w", "a.ts");
    await pool.connectionFor("/other", "a.ts");
    await pool.closeAll();
    assert.deepEqual(pool.running(), []);
  });

  it("never reads the process environment on the pool's own", async () => {
    // The gate forbids an ambient `process.env` in adapter code. This asserts the
    // consequence rather than the scan: the only environment the pool can hand
    // a server is the one it was given, so a server that found no PATH is a
    // configuration mistake somebody can actually see.
    const pool = new LanguageServerPool({
      servers: [config],
      deps: { authorize: async () => ({ ok: true }), hostEnv: { PATH: "/usr/bin" }, log: () => undefined },
      createServer: () => stubPort(),
    });
    const resolved = pool.resolveForFile("a.ts");

    assert.equal(resolved.ok, true);

    if (!resolved.ok) return;

    // The spec carries the program, not an environment: the host environment is
    // a property of the connection, applied where the process is spawned.
    assert.equal("hostEnv" in resolved.spec, false);
    await pool.closeAll();
  });
});

export type { LspFailure };
