import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server, type ServerResponse } from "node:http";
import os from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

/**
 * WP20 的黑盒证据：一个真实进程，走真实旗标，看真实工具表与真实 journal。
 *
 * 这一层证明的是单元测试**证明不了**的东西 —— 接线：
 *
 *  - `web_search` 只在 provider 家族真的提供 hosted 搜索时出现在目录里。
 *    这条 arm 用 `openai-compatible`（一个**不**提供 hosted 搜索的家族），
 *    所以断言是「不在」而不是「在」。这一条是本包最重要的一条：它证明工具不是
 *    「挂载了但用不了」，而是真的没有它；
 *  - 同样两个 arm 换成 `openai-responses` 声明，`web_search` 就**在**目录里 ——
 *    证明准入集是从目录读出来的，而不是手写死的；
 *  - `memory_search` 在没有 `--learning`、也没有项目规则时**不在**目录里，
 *    加上一份项目规则文件之后**在**（R1：缺席即从未听说过）。
 *
 * 为什么这三件事必须上进程：目录组装、沙箱准入集和 `--learning` 的读盘判断都在
 * 组合根里，单元测试只能证明零件，不能证明它们被拼在一起。
 *
 * 红例：接线前 `web_search`/`memory_search` 这两个名字在整个仓库里不存在，三条
 * arm 全部因「名字缺失」而红。
 */

const cli = fileURLToPath(new URL("./main.js", import.meta.url));

const USAGE = { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 };
const CITATION = "https://example.test/source";

function sse(res: ServerResponse, frames: readonly unknown[]): void {
  res.writeHead(200, { "content-type": "text/event-stream" });
  for (const frame of frames) {
    res.write(`data: ${JSON.stringify(frame)}\n\n`);
  }
  res.write("data: [DONE]\n\n");
  res.end();
}

/** A chat-completions turn that calls nothing and answers immediately. */
function answerFrames(text: string): ReadonlyArray<unknown> {
  return [{ choices: [{ delta: { content: text }, finish_reason: "stop" }], usage: USAGE }];
}

type Endpoint = {
  readonly url: string;
  readonly toolNames: () => ReadonlyArray<ReadonlyArray<string>>;
  readonly close: () => Promise<void>;
};

function startProvider(wire: "chat" | "responses" = "chat"): Promise<Endpoint> {
  const seen: ReadonlyArray<string>[] = [];
  const server: Server = createServer((req, res) => {
    let body = "";
    req.setEncoding("utf8");
    req.on("data", (chunk: string) => {
      body += chunk;
    });
    req.on("end", () => {
      let names: ReadonlyArray<string> = [];
      try {
        // Two wire shapes, one per family: chat completions nests the name under
        // `function`, Responses puts it beside `type: "function"`. Reading only
        // the nested shape would report an empty catalog for every Responses run
        // and make a mounted `web_search` look absent.
        const parsed = JSON.parse(body) as {
          tools?: ReadonlyArray<{ readonly name?: string; readonly function?: { readonly name?: string } }>;
        };
        names = (parsed.tools ?? []).map((tool) => tool.function?.name ?? tool.name ?? "");
      } catch {
        // Recorded as an empty catalog: the assertion then fails on the missing
        // name rather than on a parse error hiding the real fact.
      }
      seen.push(names);
      if (wire === "responses") {
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.write('event: response.output_text.delta\ndata: {"output_index":0,"delta":"ok"}\n\n');
        res.end('event: response.completed\ndata: {"response":{"status":"completed","usage":{"input_tokens":10,"output_tokens":5,"total_tokens":15}}}\n\n');
      } else {
        sse(res, answerFrames("ok"));
      }
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address !== null ? address.port : 0;
      resolve({
        url: `http://127.0.0.1:${port}/v1/${wire === "responses" ? "responses" : "chat/completions"}`,
        toolNames: () => seen,
        close: () => new Promise<void>((done) => { server.close(() => done()); }),
      });
    });
  });
}

type Fixture = { readonly workspace: string; readonly home: string; readonly cleanup: () => void };

function fixture(prefix: string, withRuleFile: boolean): Fixture {
  const root = mkdtempSync(join(os.tmpdir(), prefix));
  const workspace = join(root, "workspace");
  const home = join(root, "home");
  mkdirSync(workspace, { recursive: true });
  mkdirSync(home, { recursive: true });
  writeFileSync(join(workspace, "package.json"), JSON.stringify({ name: "wp20-fixture" }), "utf8");
  if (withRuleFile) {
    writeFileSync(
      join(workspace, "AGENTS.md"),
      "# Workspace rules\n\nAlways run the quality gate before committing.\n",
      "utf8",
    );
  }
  return { workspace, home, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

function run(
  fx: Fixture,
  endpoint: string,
  args: readonly string[],
  providerId: string,
): Promise<{ status: number | null; stdout: string; stderr: string }> {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    TRYLO_HOME: fx.home,
    TRYLO_API_KEY: "sk-wp20-fixture",
  };
  const argv = [
    cli,
    ...args,
    // Named explicitly in every arm: without it the run resolves the `fixture`
    // provider, which never opens a socket — and an arm that asserts on a
    // request the fixture provider never makes would pass for the wrong reason.
    "--provider",
    providerId,
    "--endpoint",
    endpoint,
    "--model",
    "mock-model",
    "--format",
    "stream-json",
  ];
  return new Promise((resolve) => {
    const child = spawn(process.execPath, argv, {
      cwd: fx.workspace,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.on("close", (status) => resolve({ status, stdout, stderr }));
  });
}

/** A `providers.json` declaring one id with the given kind, so `--provider` can name it. */
function declareProvider(home: string, id: string, kind: string, endpoint: string): void {
  mkdirSync(join(home), { recursive: true });
  writeFileSync(
    join(home, "providers.json"),
    `${JSON.stringify(
      {
        version: 1,
        selected: id,
        providers: [
          {
            id,
            kind,
            endpoint,
            model: "mock-model",
            streaming: true,
            reasoning: false,
            tools: true,
            cancellation: true,
            auth: "api_key",
          },
        ],
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
}

test("an openai-compatible provider mounts web_fetch but never web_search", async () => {
  // The load-bearing arm. `openai-compatible` speaks chat completions and offers
  // no hosted search, so `web_search` must be absent from the catalog entirely —
  // not present and failing. A binding that exists with nothing behind it would
  // pass approval and then lie.
  const fx = fixture("trylo-wp20-compat-", false);
  const provider = await startProvider();
  try {
    const result = await run(fx, provider.url, ["run", "hi", "--allow-web"], "openai-compatible");
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(provider.toolNames()[0]?.includes("web_search"), false);
    assert.deepEqual(provider.toolNames()[0]?.includes("web_fetch"), true);
  } finally {
    await provider.close();
    fx.cleanup();
  }
});

test("an openai-responses provider mounts web_search, admitted because it is in the catalog", async () => {
  const fx = fixture("trylo-wp20-resp-", false);
  const provider = await startProvider("responses");
  try {
    declareProvider(fx.home, "responses-fixture", "openai-responses", provider.url);
    // The declared id, so the run is built from the `openai-responses` family.
    // Naming the built-in id instead would test the wrong provider entirely.
    const result = await run(fx, provider.url, ["run", "hi", "--allow-web"], "responses-fixture");
    assert.equal(result.status, 0, result.stderr);
    const terminal = result.stdout.trim().split("\n").map(line => JSON.parse(line)).find(event => event.type === "run_result");
    assert.equal(terminal?.lastMessage, "ok", "catalog acceptance must still deliver the actual Responses answer");
    const catalog = provider.toolNames()[0] ?? [];
    assert.equal(catalog.includes("web_search"), true, "a Responses provider does offer hosted search");
    assert.equal(catalog.includes("web_fetch"), true);
  } finally {
    await provider.close();
    fx.cleanup();
  }
});

test("memory tools are absent with no learning switch and no rules, and present once a rule file exists", async () => {
  // R1 for the memory line. The second half is what proves the tools are wired
  // to something real: a project rule file is a record the run actually holds.
  const bare = fixture("trylo-wp20-mem-off-", false);
  const provider = await startProvider();
  try {
    const off = await run(bare, provider.url, ["run", "hi", "--allow-web"], "openai-compatible");
    assert.equal(off.status, 0, off.stderr);
    assert.equal((provider.toolNames()[0] ?? []).includes("memory_search"), false);
  } finally {
    await provider.close();
    bare.cleanup();
  }

  const ruled = fixture("trylo-wp20-mem-on-", true);
  const second = await startProvider();
  try {
    const on = await run(ruled, second.url, ["run", "hi", "--allow-web"], "openai-compatible");
    assert.equal(on.status, 0, on.stderr);
    const catalog = second.toolNames()[0] ?? [];
    assert.equal(catalog.includes("memory_search"), true);
    assert.equal(catalog.includes("memory_read"), true);
  } finally {
    second.close();
    ruled.cleanup();
  }
});

test("no flag means no network tools at all, byte for byte as before", async () => {
  const fx = fixture("trylo-wp20-flagoff-", false);
  const provider = await startProvider();
  try {
    const result = await run(fx, provider.url, ["run", "hi"], "openai-compatible");
    assert.equal(result.status, 0, result.stderr);
    const catalog = provider.toolNames()[0] ?? [];
    assert.equal(catalog.includes("web_fetch"), false);
    assert.equal(catalog.includes("web_search"), false);
    assert.equal(catalog.includes("memory_search"), false);
  } finally {
    provider.close();
    fx.cleanup();
  }
});

test("a tool-free turn is really tool-free: the model is offered no web_search", async () => {
  // This arm used to read a session journal and early-return when none existed.
  // Two things were wrong with that, and both are why it is rewritten rather
  // than patched. First, an early return is a green test that asserted nothing —
  // the one outcome a guard must never produce. Second, `trylo run` writes no
  // session journal at all: a probe against the real CLI with `TRYLO_HOME`
  // pointed at an empty directory leaves that directory empty, so the guard was
  // hiding a file that never existed.
  //
  // What can be checked is the fact the arm was reaching for. The provider
  // records every catalog it was sent, so "nothing was called" is observable as
  // "no web tool was on offer" — which is the part this package owns.
  const fx = fixture("trylo-wp20-journal-", false);
  const provider = await startProvider();
  try {
    const result = await run(fx, provider.url, ["run", "hi"], "openai-compatible");
    assert.equal(result.status, 0);
    // The run really reached the provider, so every assertion below is a fact
    // about this run and not about a fixture that silently never started.
    assert.ok(provider.toolNames().length > 0, "the run never reached the provider");
    for (const catalog of provider.toolNames()) {
      assert.equal(catalog.includes("web_search"), false);
      assert.equal(catalog.includes("web_fetch"), false);
      assert.equal(catalog.some((name) => name.startsWith("memory_")), false);
    }
    void CITATION;
  } finally {
    provider.close();
    fx.cleanup();
  }
});
