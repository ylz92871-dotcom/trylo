import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createWorkspaceTools } from "./index.js";
import { LSP_TOOL } from "./lsp-names.js";
import { LanguageServerPool, type LspServerConfig } from "../language-server/registry.js";
import type { LanguageServerPort, LspQueryResult } from "../../ports/language-server.js";
import type { ToolSandbox } from "../../ports/tools.js";

/**
 * Is the tool reachable from the production entry?
 *
 * A tool that exists, compiles, and passes its own unit tests is still dead code
 * if nothing mounts it. These assertions are about the wiring — `createWorkspaceTools`
 * is what a session actually holds — and they cut both ways: present when a caller
 * supplies servers, and *absent* when they do not, because a catalog that lists a
 * tool nobody configured is a promise the run cannot keep.
 */

const ROOT = "D:/w";

function stubPort(query?: (operation: string) => LspQueryResult): LanguageServerPort {
  return {
    serverName: "stub",
    workspaceRoot: ROOT,
    ensureStarted: async () => ({ ok: true }),
    openDocument: async () => ({ ok: true }),
    query: async (q) =>
      query === undefined
        ? { ok: true, operation: q.operation, answer: { status: "hover", markdown: "from the real path" }, truncated: false }
        : query(q.operation),
    isRunning: () => true,
    close: async () => undefined,
  };
}

const servers: ReadonlyArray<LspServerConfig> = [
  { serverName: "ts", command: "tsserver", args: [], extensions: ["ts"] },
];

function pool(port: LanguageServerPort): LanguageServerPool {
  return new LanguageServerPool({
    servers,
    deps: { authorize: async () => ({ ok: true }), hostEnv: {}, log: () => undefined },
    createServer: () => port,
  });
}

const sandbox: ToolSandbox = {
  policy: {
    mode: "workspace_write",
    network: "restricted",
    workspaceRoot: ROOT,
    maxWriteBytes: 1024,
    allowAbsoluteExecutable: false,
  },
  evaluate: () => ({ ok: true }),
};

const signal = new AbortController().signal;

describe("lsp_navigate in the production catalog", () => {
  it("is absent when no language servers are configured", () => {
    // The cost contract's central promise: a plain run must not advertise, let
    // alone start, a language server.
    const tools = createWorkspaceTools({ workspaceRoot: ROOT, sandbox });
    const names = tools.snapshot().map((binding) => binding.name);
    assert.equal(names.includes(LSP_TOOL), false);
  });

  it("is mounted when a caller supplies servers", () => {
    const tools = createWorkspaceTools({ workspaceRoot: ROOT, sandbox, languageServers: pool(stubPort()) });
    const names = tools.snapshot().map((binding) => binding.name);
    assert.equal(names.includes(LSP_TOOL), true);
  });

  it("answers a call that arrives through the mounted catalog", async () => {
    // The end-to-end shape: session -> catalog -> tool -> server -> visible
    // result. Anything short of this is a part with no product.
    const tools = createWorkspaceTools({ workspaceRoot: ROOT, sandbox, languageServers: pool(stubPort()) });
    const outcome = await tools.execute(
      { toolCallId: "nav-1", name: LSP_TOOL, arguments: { operation: "hover", path: "src/a.ts", line: 0, character: 0 } },
      signal,
    );

    assert.equal(outcome.outcome, "result");

    if (outcome.outcome !== "result") return;

    assert.equal(outcome.output, "from the real path");
  });

  it("leaves the read-only tools working beside it", () => {
    // Mounting navigation must not cost the file tools their place.
    const tools = createWorkspaceTools({ workspaceRoot: ROOT, sandbox, languageServers: pool(stubPort()) });
    const names = tools.snapshot().map((binding) => binding.name);
    for (const expected of ["read_file", "list_files", "search_text", "glob_files", "find_files"]) {
      assert.equal(names.includes(expected), true, `${expected} disappeared`);
    }
  });

  it("declares the navigation tool read-only and unapproved", () => {
    const tools = createWorkspaceTools({ workspaceRoot: ROOT, sandbox, languageServers: pool(stubPort()) });
    const binding = tools.snapshot().find((entry) => entry.name === LSP_TOOL);
    assert.equal(binding?.sideEffect, "read_only");
    assert.equal(binding?.needsApproval, false);
    // A server start is slow; the read-only tools' 10s would cut the handshake off.
    assert.equal((binding?.timeoutMs ?? 0) > 10_000, true);
  });

  it("passes a failure through instead of answering for the server", async () => {
    const tools = createWorkspaceTools({
      workspaceRoot: ROOT,
      sandbox,
      languageServers: pool(stubPort(() => ({ ok: false, code: "lsp_start_failed", message: "tsserver is not installed" }))),
    });
    const outcome = await tools.execute(
      { toolCallId: "nav-2", name: LSP_TOOL, arguments: { operation: "definition", path: "src/a.ts", line: 1, character: 0 } },
      signal,
    );

    assert.equal(outcome.outcome, "error");

    if (outcome.outcome !== "error") return;

    // The message a person needs: what to install, not "no results".
    assert.match(outcome.message, /not installed/);
  });

  it("still refuses a call for an unmounted tool when servers are absent", async () => {
    const tools = createWorkspaceTools({ workspaceRoot: ROOT, sandbox });
    const outcome = await tools.execute({ toolCallId: "nav-3", name: LSP_TOOL, arguments: {} }, signal);
    // Without the mount it falls through to the read-only dispatcher, which
    // refuses unknown names. A model asking for a tool that is not there gets
    // told so rather than getting a plausible-looking empty answer.
    assert.equal(outcome.outcome, "error");
  });

  it("cancels through the catalog without reaching the server", async () => {
    const controller = new AbortController();

    controller.abort();
    const tools = createWorkspaceTools({ workspaceRoot: ROOT, sandbox, languageServers: pool(stubPort()) });
    const outcome = await tools.execute(
      { toolCallId: "nav-4", name: LSP_TOOL, arguments: { operation: "hover", path: "src/a.ts" } },
      controller.signal,
    );

    assert.equal(outcome.outcome, "cancelled");
    await tools.cancel("nav-4");
  });
});
