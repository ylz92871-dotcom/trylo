import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer, type Server, type ServerResponse } from "node:http";
import os from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

/**
 * `--subagent` 的挂载证据（黑盒进程 + 本地 mock openai-compatible 端点）。
 *
 * `e2e-subagent-run.test.ts` 证明的是 fixture-subagent 专用 provider 的全链路；
 * 本文件证明的是**普通 provider 的 opt-in**：同一个 mock 端点在两条臂里发出同样
 * 的 `delegate_subagent` 工具调用，唯一的变量是旗标——
 *
 *  - 带 `--subagent`：请求的工具表里有 `delegate_subagent`，调用真的调度了子代理
 *    （子代理自己发出第二次 provider 请求），会话日志落下 `subagent_spawn`/`subagent_end`；
 *  - 不带：工具表里没有它，调用作为 unknown_tool 回给模型，日志零子代理痕迹。
 *
 * 挂载与否在这里是**请求体里的可观察事实**（mock 端点捕获 `tools` 字段），不是
 * 从退出码推断的。
 *
 * 红例：在未接线的代码上，正臂因工具表缺少 `delegate_subagent` 且日志无
 * subagent 信封而红（`--subagent` 本身曾是 unknown option，退出码 2）。
 */

const cli = fileURLToPath(new URL("./main.js", import.meta.url));

type CapturedRequest = {
  readonly toolNames: ReadonlyArray<string>;
  readonly messages: ReadonlyArray<{ readonly role: string; readonly content?: string }>;
};

type Endpoint = {
  readonly url: string;
  readonly requests: CapturedRequest[];
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

/** The one scripted move: ask for delegate_subagent. Everything after stops. */
function delegateFrames(): ReadonlyArray<unknown> {
  return [
    {
      choices: [
        {
          delta: {
            tool_calls: [
              {
                index: 0,
                id: "call-delegate-1",
                function: {
                  name: "delegate_subagent",
                  arguments: JSON.stringify({
                    taskName: "inspect_workspace",
                    prompt: "look at package.json and report the package name",
                  }),
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
  return [
    { choices: [{ delta: { content: text }, finish_reason: "stop" }], usage: USAGE },
  ];
}

function startEndpoint(): Promise<Endpoint> {
  const requests: CapturedRequest[] = [];
  const server: Server = createServer((req, res) => {
    let body = "";

    req.setEncoding("utf8");
    req.on("data", (chunk: string) => {
      body += chunk;
    });
    req.on("end", () => {
      let toolNames: ReadonlyArray<string> = [];
      let messages: CapturedRequest["messages"] = [];

      try {
        const parsed = JSON.parse(body) as {
          tools?: ReadonlyArray<{ readonly function?: { readonly name?: string } }>;
          messages?: CapturedRequest["messages"];
        };
        toolNames = (parsed.tools ?? []).map((tool) => tool.function?.name ?? "");
        messages = parsed.messages ?? [];
      } catch {
        // An unparsable body is recorded as an empty request; the assertions
        // below then fail on the missing tool call rather than on a crash here.
      }

      requests.push({ toolNames, messages });

      if (requests.length === 1) {
        sse(res, delegateFrames());
        return;
      }

      sse(res, stopFrames("done"));
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
  writeFileSync(join(workspace, "package.json"), JSON.stringify({ name: "sa-mount-fixture" }), "utf8");

  return { workspace, home, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

type RunResult = {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
};

/**
 * Asynchronous on purpose: the mock provider lives in this process, and a
 * synchronous spawn would block the event loop that has to answer it.
 */
function run(fx: Fixture, endpoint: string, args: readonly string[]): Promise<RunResult> {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    TRYLO_HOME: fx.home,
    TRYLO_API_KEY: "sk-sa-mount-fixture",
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

type Envelope = { readonly kind: string; readonly payload: Record<string, unknown> };

function journalEnvelopes(homeDir: string): ReadonlyArray<Envelope> {
  const sessionsDir = join(homeDir, "sessions");

  if (!readdirSync(homeDir).includes("sessions")) {
    return [];
  }

  const envelopes: Envelope[] = [];
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
          record?: { type?: string; payload?: { envelope?: Envelope } };
        };
        const envelope = parsed.record?.payload?.envelope;
        if (parsed.record?.type === "envelope" && envelope !== undefined) {
          envelopes.push(envelope);
        }
      }
    }
  };

  walk(sessionsDir);

  return envelopes;
}

test("with --subagent, an ordinary provider run mounts and really runs delegate_subagent", async () => {
  const fx = fixture("trylo-sa-mount-on-");
  const endpoint = await startEndpoint();

  try {
    const result = await run(fx, endpoint.url, [
      "run",
      "inspect the workspace with a subagent",
      "--subagent",
      "--session",
      "ses-sa-mount-on",
    ]);

    assert.equal(result.status, 0, result.stderr);

    // The mount is a fact in the request body, not an inference from exit 0.
    assert.ok(endpoint.requests.length >= 1, "the mock endpoint was never called");
    const first = endpoint.requests[0]!;

    assert.ok(
      first.toolNames.includes("delegate_subagent"),
      `tool table must carry delegate_subagent, got: ${first.toolNames.join(", ")}`,
    );

    assert.match(result.stdout, /delegate_subagent/);

    // The subagent runs against the same provider: its own request is the
    // evidence that a real delegation happened, not just a mounted schema.
    assert.ok(endpoint.requests.length >= 2, "the subagent never reached the provider");

    const envelopes = journalEnvelopes(fx.home);
    const spawns = envelopes.filter((entry) => entry.kind === "subagent_spawn");
    const ends = envelopes.filter((entry) => entry.kind === "subagent_end");

    assert.equal(spawns.length, 1, "exactly one subagent_spawn in the journal");
    assert.equal(ends.length, 1, "exactly one subagent_end in the journal");
    assert.equal(ends[0]!.payload["status"], "completed");
  } finally {
    await endpoint.close();
    fx.cleanup();
  }
});

test("without --subagent, the same delegate call finds no tool and leaves zero subagent traces", async () => {
  const fx = fixture("trylo-sa-mount-off-");
  const endpoint = await startEndpoint();

  try {
    const result = await run(fx, endpoint.url, [
      "run",
      "inspect the workspace with a subagent",
      "--session",
      "ses-sa-mount-off",
    ]);

    assert.equal(result.status, 0, result.stderr);

    const first = endpoint.requests[0]!;

    assert.equal(
      first.toolNames.includes("delegate_subagent"),
      false,
      `tool table must not carry delegate_subagent, got: ${first.toolNames.join(", ")}`,
    );

    const envelopes = journalEnvelopes(fx.home);
    const subagentEnvelopes = envelopes.filter(
      (entry) => entry.kind === "subagent_spawn" || entry.kind === "subagent_end",
    );

    assert.equal(subagentEnvelopes.length, 0, "a default run leaves zero subagent envelopes");
  } finally {
    await endpoint.close();
    fx.cleanup();
  }
});
