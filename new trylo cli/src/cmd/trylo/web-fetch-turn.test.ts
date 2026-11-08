import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer, type Server, type ServerResponse } from "node:http";
import os from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

/**
 * `--allow-web` 的挂载与审批证据（黑盒进程 + 两个本地服务器：mock provider、
 * 被抓取页面）。
 *
 * 三条臂共享同一个脚本 —— 第一轮永远发出一个 `web_fetch` 工具调用，第二轮停
 * 下 —— 唯一的变量是旗标：
 *
 *  - `--allow-web --allow-tools web_fetch`：工具表里有 `web_fetch`，页面服务器
 *    真的被请求了一次，抓取文本回到模型输出里；
 *  - 只带 `--allow-web`：非交互默认 `ask=never`，调用在审批门前被拒 —— 页面
 *    服务器一个字节都没收到，这是「external 的闸是审批而不是沙箱放权」的证据；
 *  - 两者都不带：工具表里没有它，调用以 unknown 回给模型，页面服务器同样零请求
 *    （R1：absent 即从未听说过）。
 *
 * 红例：在接线前的代码上，`--allow-web` 是 unknown option，第一条臂退出码 2。
 */

const cli = fileURLToPath(new URL("./main.js", import.meta.url));

const PAGE_MARK = "Hello from the web_fetch fixture page.";
const PAGE_HTML = [
  "<!DOCTYPE html><html><head><title>fixture</title>",
  "<style>body{color:red}</style><script>alert('never rendered')</script>",
  "</head><body><h1>Heading</h1><p>",
  PAGE_MARK,
  "</p></body></html>",
].join("");

type CapturedRequest = {
  readonly toolNames: ReadonlyArray<string>;
};

function sse(res: ServerResponse, frames: readonly unknown[]): void {
  res.writeHead(200, { "content-type": "text/event-stream" });
  for (const frame of frames) {
    res.write(`data: ${JSON.stringify(frame)}\n\n`);
  }
  res.write("data: [DONE]\n\n");
  res.end();
}

const USAGE = { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 };

function fetchFrames(pageUrl: string): ReadonlyArray<unknown> {
  return [
    {
      choices: [
        {
          delta: {
            tool_calls: [
              {
                index: 0,
                id: "call-web-1",
                function: {
                  name: "web_fetch",
                  arguments: JSON.stringify({ url: pageUrl }),
                },
              },
            ],
          },
          finish_reason: null,
        },
      ],
    },
    { choices: [{ delta: {}, finish_reason: "tool_calls" }], usage: USAGE },
  ];
}

function stopFrames(text: string): ReadonlyArray<unknown> {
  return [{ choices: [{ delta: { content: text }, finish_reason: "stop" }], usage: USAGE }];
}

type Endpoint = {
  readonly url: string;
  readonly requests: CapturedRequest[];
  readonly close: () => Promise<void>;
};

function startProvider(pageUrl: string): Promise<Endpoint> {
  const requests: CapturedRequest[] = [];
  const server: Server = createServer((req, res) => {
    let body = "";

    req.setEncoding("utf8");
    req.on("data", (chunk: string) => {
      body += chunk;
    });
    req.on("end", () => {
      let toolNames: ReadonlyArray<string> = [];

      try {
        const parsed = JSON.parse(body) as {
          tools?: ReadonlyArray<{ readonly function?: { readonly name?: string } }>;
        };
        toolNames = (parsed.tools ?? []).map((tool) => tool.function?.name ?? "");
      } catch {
        // An unparsable body is recorded as an empty request; the assertions
        // then fail on the missing tool name rather than on a crash here.
      }

      requests.push({ toolNames });
      sse(res, requests.length === 1 ? fetchFrames(pageUrl) : stopFrames("understood"));
    });
  });

  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address !== null ? address.port : 0;

      resolve({
        url: `http://127.0.0.1:${port}/v1/chat/completions`,
        requests,
        close: () =>
          new Promise<void>((done) => {
            server.close(() => done());
          }),
      });
    });
  });
}

type PageServer = {
  readonly url: string;
  readonly hits: () => number;
  readonly close: () => Promise<void>;
};

function startPage(): Promise<PageServer> {
  let hits = 0;
  const server: Server = createServer((_req, res) => {
    hits += 1;
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(PAGE_HTML);
  });

  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address !== null ? address.port : 0;

      resolve({
        url: `http://127.0.0.1:${port}/page`,
        hits: () => hits,
        close: () =>
          new Promise<void>((done) => {
            server.close(() => done());
          }),
      });
    });
  });
}

type Fixture = {
  readonly workspace: string;
  readonly home: string;
  readonly cleanup: () => void;
};

function fixture(prefix: string): Fixture {
  const root = mkdtempSync(join(os.tmpdir(), prefix));
  const workspace = join(root, "workspace");
  const home = join(root, "home");

  mkdirSync(workspace, { recursive: true });
  mkdirSync(home, { recursive: true });
  writeFileSync(join(workspace, "package.json"), JSON.stringify({ name: "web-mount-fixture" }), "utf8");

  return { workspace, home, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

type RunResult = {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
};

/**
 * Asynchronous on purpose: both mock servers live in this process, and a
 * synchronous spawn would block the event loop that has to answer them.
 */
function run(fx: Fixture, endpoint: string, args: readonly string[]): Promise<RunResult> {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    TRYLO_HOME: fx.home,
    TRYLO_API_KEY: "sk-web-mount-fixture",
  };
  const argv = [
    cli,
    ...args,
    "--provider",
    "openai-compatible",
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
    child.on("close", (status) => {
      resolve({ status, stdout, stderr });
    });
  });
}

type JournalRecord = { readonly type?: string; readonly payload?: Record<string, unknown> };

/**
 * The session journal is the authoritative echo: a successful tool's text
 * travels in the `tool_result` *transcript item*, while the stdout stream
 * projects the envelope (which carries `value`, not the tool's prose). Assert
 * where the fact actually lives.
 */
function journalRecords(homeDir: string): ReadonlyArray<JournalRecord> {
  const sessionsDir = join(homeDir, "sessions");

  if (!readdirSync(homeDir).includes("sessions")) {
    return [];
  }

  const records: JournalRecord[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) {
        walk(full);
        continue;
      }

      for (const line of readFileSync(full, "utf8").split("\n")) {
        const text = line.trim();
        if (text.length === 0) {
          continue;
        }

        const parsed = JSON.parse(text) as { record?: JournalRecord };
        if (parsed.record !== undefined) {
          records.push(parsed.record);
        }
      }
    }
  };

  walk(sessionsDir);

  return records;
}

function toolResultOutputs(records: ReadonlyArray<JournalRecord>): ReadonlyArray<string> {
  return records
    .filter((record) => record.type === "transcript_item")
    .map((record) => record.payload ?? {})
    .filter((payload) => payload["kind"] === "tool_result")
    .map((payload) => String(payload["output"] ?? ""));
}

test("with --allow-web and an approval, web_fetch is in the catalog and really fetches", async () => {
  const fx = fixture("trylo-web-on-");
  const page = await startPage();
  const endpoint = await startProvider(page.url);

  try {
    const result = await run(fx, endpoint.url, [
      "run",
      "fetch the fixture page",
      "--allow-web",
      "--allow-tools",
      "web_fetch",
      "--session",
      "ses-web-on",
    ]);

    assert.equal(result.status, 0, result.stderr);

    // The mount is a fact in the request body, not an inference from exit 0.
    assert.ok(endpoint.requests.length >= 1, "the mock provider was never called");
    const first = endpoint.requests[0]!;

    assert.ok(
      first.toolNames.includes("web_fetch"),
      `tool table must carry web_fetch, got: ${first.toolNames.join(", ")}`,
    );

    assert.equal(page.hits(), 1, "the page must be fetched exactly once");
    const outputs = toolResultOutputs(journalRecords(fx.home));

    assert.equal(outputs.length, 1, "exactly one tool_result in the journal");
    assert.ok(outputs[0]!.includes(PAGE_MARK), `journal echo was: ${outputs[0]}`);
    // Stripped, not shipped raw: the markup and the script never traveled.
    assert.equal(outputs[0]!.includes("<h1>"), false);
    assert.equal(outputs[0]!.includes("alert("), false);
  } finally {
    await endpoint.close();
    await page.close();
    fx.cleanup();
  }
});

test("with --allow-web but no approval, a non-interactive run denies the fetch before touching the network", async () => {
  const fx = fixture("trylo-web-unapproved-");
  const page = await startPage();
  const endpoint = await startProvider(page.url);

  try {
    const result = await run(fx, endpoint.url, [
      "run",
      "fetch the fixture page",
      "--allow-web",
      "--session",
      "ses-web-unapproved",
    ]);

    // 非交互默认 `ask=never`：审批门直接拒 —— 拒绝让运行失败，这正是
    // 「external 的闸是人而不是旗标」的形状（与 write_file 被拒同一合同）。
    assert.equal(result.status, 1, result.stderr);

    const first = endpoint.requests[0]!;

    assert.ok(first.toolNames.includes("web_fetch"), "the tool is mounted by the flag alone");
    assert.match(result.stdout, /permission_denied|"denied"/);
    assert.equal(page.hits(), 0, "a denied call must not reach the network");
  } finally {
    await endpoint.close();
    await page.close();
    fx.cleanup();
  }
});

test("without --allow-web, web_fetch is not in the catalog and the page is never touched", async () => {
  const fx = fixture("trylo-web-off-");
  const page = await startPage();
  const endpoint = await startProvider(page.url);

  try {
    const result = await run(fx, endpoint.url, [
      "run",
      "fetch the fixture page",
      "--session",
      "ses-web-off",
    ]);

    assert.equal(result.status, 0, result.stderr);

    const first = endpoint.requests[0]!;

    assert.equal(
      first.toolNames.includes("web_fetch"),
      false,
      `tool table must not carry web_fetch, got: ${first.toolNames.join(", ")}`,
    );
    assert.equal(page.hits(), 0, "an unmounted tool must never reach the network");
    // The hallucinated call meets the same `unknown_tool` refusal any unplanned
    // name meets — R1: a flag-off run behaves as if web never existed.
    const outputs = toolResultOutputs(journalRecords(fx.home));

    assert.equal(outputs.length, 1);
    assert.match(outputs[0]!, /unknown_tool|web_fetch/);
  } finally {
    await endpoint.close();
    await page.close();
    fx.cleanup();
  }
});
