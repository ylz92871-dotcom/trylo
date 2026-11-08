import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer, type Server, type ServerResponse } from "node:http";
import os from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

/**
 * `--compact-summary=model` 的组合级合同（`cmd/trylo` 层，黑盒进程 + mock 端点）。
 *
 * compaction 的触发、落盘、读时过滤早已由 `resume-window.test.ts` 的 fixture 形状
 * 背书（长消息 + 小上限 + 一次工具调用 → 迭代间隙里压缩）。本文件只回答一个差距
 * 问题：**摘要文本是谁写的**——
 *
 *  - 显式 extractive：摘要器不调用模型，账里落下的是 extractive 摘要；
 *  - 带 `--compact-summary=model`：端点收到一个带 summarizer 标记的独立请求，
 *    账里 `compact` 记录的 summary 是**模型给的那句话**，下一个主请求携带
 *    `[compacted history w1] <模型摘要>`；
 *  - 闭集：`--compact-summary=bogus` 是用法错误（退出码 2），不是「读成缺省」。
 *
 * 红例：在未接线的代码上，第 2、3 条因 `unknown option --compact-summary`
 * （退出码 2）而红；第 1 条的「零 summarizer 请求」断言彼时无人能违反，由另两条
 * 背书接线本身。
 */

const cli = fileURLToPath(new URL("./main.js", import.meta.url));

/** Input remains verbatim after compaction; provider usage drives the gap. */
const LONG_TEXT = "x".repeat(2000);
const CEILING = 4096;

/** 模型摘要的固定回声；通过 validateSummary（无路径、无凭据形状、短）。 */
const MODEL_SUMMARY = "The session was compacting a long request about package metadata.";

type Captured = {
  readonly messages: ReadonlyArray<{ readonly role: string; readonly content: string }>;
};

type Endpoint = {
  readonly url: string;
  readonly requests: Captured[];
  readonly close: () => Promise<void>;
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

function toolCallFrames(): ReadonlyArray<unknown> {
  return [
    {
      choices: [
        {
          delta: {
            tool_calls: [
              {
                index: 0,
                id: "call-1",
                function: { name: "read_file", arguments: '{"path":"package.json"}' },
              },
            ],
          },
          finish_reason: null,
        },
      ],
    },
    { choices: [{ delta: {}, finish_reason: "tool_calls" }], usage: { ...USAGE, prompt_tokens: CEILING + 1000, total_tokens: CEILING + 1005 } },
  ];
}

const STOP_FRAMES: ReadonlyArray<unknown> = [
  { choices: [{ delta: { content: "done" }, finish_reason: "stop" }], usage: USAGE },
];

const SUMMARY_FRAMES: ReadonlyArray<unknown> = [
  { choices: [{ delta: { content: MODEL_SUMMARY }, finish_reason: "stop" }], usage: USAGE },
];

/**
 * summarizer 请求的判别：系统消息里带这个标记。生产侧的指令文本必须以它开头，
 * 否则本文件只是在断言一个巧合。（见 `compact-model-summarizer.ts`。）
 */
const SUMMARIZER_MARKER = "trylo compaction summarizer";

function isSummarizerRequest(captured: Captured): boolean {
  return captured.messages.some(
    (message) => message.role === "system" && message.content.includes(SUMMARIZER_MARKER),
  );
}

function startEndpoint(): Promise<Endpoint> {
  const requests: Captured[] = [];
  let mainHits = 0;
  const server: Server = createServer((req, res) => {
    let body = "";

    req.setEncoding("utf8");
    req.on("data", (chunk: string) => {
      body += chunk;
    });
    req.on("end", () => {
      let messages: Captured["messages"] = [];

      try {
        const parsed = JSON.parse(body) as { messages?: Captured["messages"] };
        messages = parsed.messages ?? [];
      } catch {
        messages = [];
      }

      const captured = { messages };

      requests.push(captured);

      // 摘要请求走自己的分支（它没有"第一次要工具"的身份）；主请求第一次要工具，
      // 之后一律停。与 resume-window 的 fixture 同一触发形状。
      if (isSummarizerRequest(captured)) {
        sse(res, SUMMARY_FRAMES);
        return;
      }

      mainHits += 1;

      if (mainHits === 1) {
        sse(res, toolCallFrames());
        return;
      }

      sse(res, STOP_FRAMES);
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
  mkdirSync(join(workspace, ".trylo"), { recursive: true });
  writeFileSync(join(workspace, "package.json"), JSON.stringify({ name: "compact-fixture" }), "utf8");
  writeFileSync(
    join(workspace, ".trylo", "config.json"),
    JSON.stringify({
      provider: "openai-compatible",
      model: "compact-model",
      contextTokenLimit: CEILING,
      maxIterations: 4,
    }),
    "utf8",
  );

  return { workspace, home, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

type RunResult = {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
};

/** 异步 spawn：mock 端点活在本进程里，同步 spawn 会锁死要应答它的事件循环。 */
function run(fx: Fixture, endpoint: string, args: readonly string[]): Promise<RunResult> {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    TRYLO_HOME: fx.home,
    TRYLO_API_KEY: "sk-compact-fixture",
  };
  const argv = [
    cli,
    ...args,
    "--provider",
    "openai-compatible",
    "--endpoint",
    endpoint,
    "--format",
    "stream-json",
    "--tools=read_file",
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

type Row = {
  readonly sequence: number;
  readonly type: string;
  readonly payload: Record<string, unknown>;
};

function journalRows(root: string): ReadonlyArray<Row> {
  const rows: Row[] = [];
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

        const parsed = JSON.parse(text) as {
          sequence: number;
          record: { type: string; payload: Record<string, unknown> };
        };

        rows.push({ sequence: parsed.sequence, type: parsed.record.type, payload: parsed.record.payload });
      }
    }
  };

  walk(root);

  return rows.sort((left, right) => left.sequence - right.sequence);
}

test("with --compact-summary=model, the model authors the stored summary", async () => {
  const fx = fixture("trylo-compact-model-");
  const endpoint = await startEndpoint();

  try {
    const result = await run(fx, endpoint.url, [
      "run",
      LONG_TEXT,
      "--compact-summary",
      "model",
      "--session",
      "ses-compact-model",
    ]);

    assert.equal(result.status, 0, result.stderr);

    // 1. 有一个独立的、带 summarizer 标记的请求——摘要确实是模型写的，不是本地拼的。
    const summarizerRequests = endpoint.requests.filter(isSummarizerRequest);

    assert.equal(summarizerRequests.length, 1, "exactly one summarizer request");

    // 2. 账里的 compact 记录携带模型给的那句话。
    const compacts = journalRows(fx.home).filter((row) => row.type === "compact");

    assert.equal(compacts.length, 1, "one compact record in the journal");
    const window = compacts[0]!.payload as unknown as { readonly summary?: string };

    assert.equal(window.summary, MODEL_SUMMARY);

    // 3. 压缩之后的主请求带着窗口摘要，而不是被替换的原文。
    const mainAfter = endpoint.requests.filter((r) => !isSummarizerRequest(r)).slice(1);

    assert.ok(mainAfter.length >= 1, "no main request after the gap");
    const carried = mainAfter.map((r) => r.messages.map((m) => m.content).join("\n")).join("\n");

    assert.match(carried, /\[compacted history w1\]/);
    assert.match(carried, new RegExp(MODEL_SUMMARY.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  } finally {
    await endpoint.close();
    fx.cleanup();
  }
});

test("explicit extractive asks no model and stores the deterministic digest", async () => {
  const fx = fixture("trylo-compact-default-");
  const endpoint = await startEndpoint();

  try {
    const result = await run(fx, endpoint.url, ["run", LONG_TEXT, "--compact-summary", "extractive", "--session", "ses-compact-default"]);

    assert.equal(result.status, 0, result.stderr);

    // 显式 extractive 保留零模型摘要请求的选择。
    assert.equal(endpoint.requests.filter(isSummarizerRequest).length, 0);

    const compacts = journalRows(fx.home).filter((row) => row.type === "compact");

    assert.equal(compacts.length, 1, "compaction still happens by default");
    const window = compacts[0]!.payload as unknown as { readonly summary?: string };

    assert.notEqual(window.summary, MODEL_SUMMARY);
    // extractive 摘要的形状：逐条 `kind: 前缀` 行，长行以省略号收尾。
    assert.match(window.summary ?? "", /^user: /);
  } finally {
    await endpoint.close();
    fx.cleanup();
  }
});

test("--compact-summary is a closed set: an unknown value is a usage error", async () => {
  const fx = fixture("trylo-compact-bad-");
  const endpoint = await startEndpoint();

  try {
    const result = await run(fx, endpoint.url, [
      "run",
      "answer",
      "--compact-summary",
      "poetry",
      "--session",
      "ses-compact-bad",
    ]);

    assert.equal(result.status, 2, result.stderr);
    assert.match(result.stderr, /unknown --compact-summary value: poetry/);
    assert.match(result.stderr, /extractive, model/);
    assert.equal(result.stdout, "");
  } finally {
    await endpoint.close();
    fx.cleanup();
  }
});
