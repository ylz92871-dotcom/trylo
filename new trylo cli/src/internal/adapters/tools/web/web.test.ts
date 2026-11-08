import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createWorkspaceSandbox } from "../../sandbox/index.js";
import { composeSandbox } from "../../mcp-runtime/mount.js";
import { createWorkspaceTools } from "../index.js";
import type { ToolCallRequest, ToolOutcome } from "../../../ports/tools.js";
import type { JsonObject } from "../../../protocol/envelope.js";
import { WEB_FETCH_TOOL } from "./names.js";
import { createWebTools } from "./index.js";
import { planWebFetch } from "./plan.js";

/**
 * `web_fetch`：网络工具的入口合同，全部在本地服务器上验证。
 *
 * 三条层层把关的事实，每条都是可观察的而不是声明的：
 *
 *  - **计划先于socket**：URL 由 `plan.ts` 的纯函数在 `fetch` 之前把关，
 *    `file:`、空串、裸词直接变成 `invalid_arguments` /
 *    `unsupported_scheme` —— 测试用「服务器零命中」证明这一点；沙箱侧的准入
 *    是**挂载作用域**的（MCP 同型的 admit-set），旗标缺席时默认沙箱逐字不变；
 *  - **有界读取**：响应体在字节上限处被拒绝而不是被悄悄截断，二进制内容被拒
 *    ——一个把 ZIP 当文本吐给模型的抓取工具比没有更糟；
 *  - **HTML 变散文**：script/style 整块消失、标签变空白，页面里埋的
 *    `alert(...)` 不会出现在输出里。
 */

type PageServer = {
  readonly base: string;
  readonly hits: () => number;
  readonly close: () => Promise<void>;
};

function startPageServer(): Promise<PageServer> {
  let hits = 0;
  const server: Server = createServer((req, res) => {
    hits += 1;
    const path = new URL(req.url ?? "/", "http://127.0.0.1").pathname;
    if (path === "/error") {
      res.writeHead(500, { "content-type": "text/plain" });
      res.end("boom");
      return;
    }

    if (path === "/binary") {
      res.writeHead(200, { "content-type": "application/zip" });
      res.end(Buffer.alloc(1024, 7));
      return;
    }

    if (path === "/huge") {
      res.writeHead(200, { "content-type": "text/plain" });
      res.end("x".repeat(1_100_000));
      return;
    }

    if (path === "/json") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ answer: 42 }));
      return;
    }

    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(
      [
        "<!DOCTYPE html><html><head><title>t</title>",
        "<style>h1{color:red}</style>",
        "<script>var secret='alert should not travel';</script>",
        "</head><body><h1>Fetched &amp; clean</h1>",
        "<p>The quick brown fox.</p></body></html>",
      ].join(""),
    );
  });

  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address !== null ? address.port : 0;

      resolve({
        base: `http://127.0.0.1:${port}`,
        hits: () => hits,
        close: () =>
          new Promise<void>((done) => {
            server.close(() => done());
          }),
      });
    });
  });
}

function webCall(args: JsonObject, name = WEB_FETCH_TOOL): ToolCallRequest {
  return { toolCallId: "web-1", name, arguments: args };
}

function freshSignal(): AbortSignal {
  return new AbortController().signal;
}

test("the binding is external, needs approval, and is never mounted by default", async () => {
  const port = createWebTools();
  const binding = port.snapshot().find((entry) => entry.name === WEB_FETCH_TOOL);

  assert.ok(binding !== undefined);
  assert.equal(binding.sideEffect, "external");
  assert.equal(binding.needsApproval, true);

  const root = mkdtempSync(join(os.tmpdir(), "trylo-web-catalog-"));

  try {
    const without = createWorkspaceTools({ workspaceRoot: root, sandbox: createWorkspaceSandbox({ workspaceRoot: root }) });

    assert.equal(
      without
        .snapshot()
        .map((entry) => entry.name)
        .includes(WEB_FETCH_TOOL),
      false,
      "no flag, no web_fetch in the catalog (R1)",
    );
    const withWeb = createWorkspaceTools({
      workspaceRoot: root,
      sandbox: createWorkspaceSandbox({ workspaceRoot: root }),
      allowWeb: true,
    });

    assert.equal(
      withWeb
        .snapshot()
        .map((entry) => entry.name)
        .includes(WEB_FETCH_TOOL),
      true,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("bad urls are refused by the plan before any socket opens", async () => {
  const server = await startPageServer();
  try {
    const port = createWebTools();
    const misses: ReadonlyArray<JsonObject> = [
      {},
      { url: "" },
      { url: "not-a-url" },
      { url: "file:///etc/passwd" },
      { url: "ftp://example.com/pub" },
    ];

    for (const args of misses) {
      const outcome = await port.execute(webCall(args), freshSignal());

      assert.equal(outcome.outcome, "error", JSON.stringify(args));
      const error = outcome as { code: string };

      assert.ok(
        error.code === "invalid_arguments" || error.code === "unsupported_scheme",
        JSON.stringify({ args, code: error.code }),
      );
    }

    assert.equal(server.hits(), 0, "a refused url must never reach the network");
  } finally {
    await server.close();
  }
});

test("sandbox admission of web_fetch is mount-scoped, not a global planner branch", () => {
  const root = mkdtempSync(join(os.tmpdir(), "trylo-web-sandbox-"));
  try {
    const sandbox = createWorkspaceSandbox({ workspaceRoot: root });
    // Flag absent: even a perfectly good URL meets the old `unknown_tool`
    // refusal — the planner has no web branch, so nothing about a default
    // run's sandbox changed (R1).
    const off = sandbox.evaluate(webCall({ url: "https://example.com/page" }));

    assert.equal(off.ok, false);

    if (!off.ok) {
      assert.equal(off.code, "unknown_tool", JSON.stringify(off));
    }

    // Mounted: the composite admits the *name*; the URL is still checked by
    // the same pure plan the tool re-runs before any socket opens.
    const mounted = composeSandbox(sandbox, new Set([WEB_FETCH_TOOL]));

    assert.equal(mounted.evaluate(webCall({ url: "https://example.com/page" })).ok, true);
    const stillRefused = mounted.evaluate(webCall({ url: "https://x.test" }, "made_up_tool"));

    assert.equal(stillRefused.ok, false, "an unmounted name is still refused");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("planWebFetch normalizes a good url and keeps its host", () => {
  const planned = planWebFetch(webCall({ url: "https://Example.COM/a/../b" }), { canExtract: false });
  assert.equal(planned.ok, true);
  if (planned.ok) {
    assert.equal(planned.plan.host, "example.com");
    assert.equal(planned.plan.url.endsWith("/b"), true);
  }
});

test("an html page comes back as prose: scripts gone, entities decoded", async () => {
  const server = await startPageServer();
  try {
    const port = createWebTools();
    const outcome = (await port.execute(webCall({ url: `${server.base}/page` }), freshSignal())) as Extract<
      ToolOutcome,
      { outcome: "result" }
    >;

    assert.equal(outcome.outcome, "result");
    assert.match(outcome.output, /Fetched & clean/);
    assert.match(outcome.output, /The quick brown fox\./);
    assert.equal(outcome.output.includes("<h1>"), false);
    assert.equal(outcome.output.includes("alert should not travel"), false);
    assert.equal(outcome.output.includes("color:red"), false);
    assert.equal(outcome.value["status"], 200);
    assert.equal(outcome.value["url"], `${server.base}/page`);
  } finally {
    await server.close();
  }
});

test("json passes through untouched", async () => {
  const server = await startPageServer();
  try {
    const port = createWebTools();
    const outcome = (await port.execute(webCall({ url: `${server.base}/json` }), freshSignal())) as Extract<
      ToolOutcome,
      { outcome: "result" }
    >;

    assert.equal(outcome.outcome, "result");
    assert.equal(outcome.output, '{"answer":42}');
  } finally {
    await server.close();
  }
});

test("server errors, binary bodies and oversized pages each get their own refusal code", async () => {
  const server = await startPageServer();
  try {
    const port = createWebTools();
    const cases: ReadonlyArray<readonly [string, string]> = [
      ["/error", "http_status"],
      ["/binary", "unsupported_content"],
      ["/huge", "response_too_large"],
    ];

    for (const [path, code] of cases) {
      const outcome = await port.execute(webCall({ url: `${server.base}${path}` }), freshSignal());
      assert.equal(outcome.outcome, "error", path);
      assert.equal((outcome as { code: string }).code, code, path);
    }
  } finally {
    await server.close();
  }
});

test("an unreachable host is fetch_failed, not a crash", async () => {
  const port = createWebTools();
  const outcome = await port.execute(webCall({ url: "http://127.0.0.1:1/nothing" }), freshSignal());
  assert.equal(outcome.outcome, "error");
  assert.equal((outcome as { code: string }).code, "fetch_failed");
});

test("a foreign tool name on the web port answers unknown, never a silent no-op", async () => {
  const port = createWebTools();
  const outcome = await port.execute(webCall({}, "todo_write"), freshSignal());
  assert.equal(outcome.outcome, "unknown");
});
