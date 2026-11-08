import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server, type ServerResponse } from "node:http";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { createMethodBoardWriter } from "./board-writer.js";
import type { MethodCard } from "../domain/contracts.js";
import { nicheOf } from "../domain/niche.js";
import type { CommitCardInput } from "../port.js";
import { methodBoardRoot } from "../../../../../surface/cli/learning-sink.js";

/**
 * ME0-4 / 外审 P1-5：整条交付面（`cmd/trylo/main.js`）**跨进程**把一次真实上场与
 * 它的帮助反馈落到盘上，换一个 OS 进程只从磁盘就能读回来、且不串配（验收 F11）。
 *
 * 与 `method-restart.test.ts` 的分工：那一条把跨进程切口放在**持久/恢复层**（生产
 * `wirePorts` + 脚本化 in-process provider），因为仓里没有一个离线 fixture provider
 * 会吐 `trylo-method-feedback` 围栏（`ME0-STATE.md` 偏离条 D-3）。外审指出这不能直接
 * 计作 F11 全过——真正的 CLI 交付面（argv → 组装 → provider 适配器 → 板）从没被这条
 * 链穿过一次。本条补上那一次。
 *
 * 它不碰禁改的 provider 适配器（WP §4）：它**用**那个真的 `openai-compatible`
 * 适配器，把它指向一个本机 `node:http` SSE 端点，端点回的正文里带着一个合法反馈
 * 围栏。于是模型这一侧是脚本化的（离线 CI 没有真 provider），但从 `main.js` 往下的
 * 每一件东西——参数解析、组合根、真板、真写口、真 sink、真适配器——都是生产的。
 *
 * 卡是**预置**进板的（用生产写口 `createMethodBoardWriter.commitCard`，写到 CLI 即将
 * 读的那个 `boardRoot`），而不是靠脚本让模型现场交卡：抽卡/放权那半条链已由
 * `learning-activation.test.ts` 与 `method-restart.test.ts` 覆盖，P1-5 要钉的是**上场
 * + 反馈**能不能穿过 CLI 落到盘上并可恢复。预置卡 `appliesWhen.tools=["read_file"]`
 * 且不带 `failureFamily`；脚本端点按真实目录情境查询、实际展示、采用、读取后反馈。
 *
 * 「重启」是真的换一个 OS 进程：`spawnSync` 拉起一个独立 node 子进程，只 import 编译
 * 后的 `createBoardReader`、只读那同一个目录、把恢复出来的 `fieldings` / `feedbacks`
 * 打回来。内存不共享 ⇒ 子进程读到的每个字段都只能来自磁盘。
 */

const cli = fileURLToPath(new URL("../../../../../../cmd/trylo/main.js", import.meta.url));

/** 小的 provider 用量：这一条不触发压缩，ceiling 由 config 给一个大值。 */
const USAGE = { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 };

const PRESET_VERSION_ID = "ver:cli-preset";

/** 收尾拍的正文：一句用户可见的话，加一个合法的 `trylo-method-feedback` 围栏。 */
const ANSWER =
  "All done.\n\n```trylo-method-feedback\n" +
  '{"items":[{"ref":"m1","helped":true}]}\n' +
  "```";

function presetCard(): MethodCard {
  return {
    schemaVersion: 1,
    hint: "keep every write inside the workspace root",
    // 真实工作区目录（无 sandbox）恒含 read_file；不带 failureFamily，拍一即适用。
    appliesWhen: { tools: ["read_file"] },
    labels: ["containment"],
    family: "containment",
    lineage: { createdFrom: { turnId: "seed", beat: 1, reason: "containment" } },
  };
}

function presetCommit(): CommitCardInput {
  const card = presetCard();
  return {
    card,
    nicheId: nicheOf(card),
    versionId: PRESET_VERSION_ID,
    proposalId: "prop:cli-preset",
    evidenceId: "ev:cli-preset",
    writeId: "cli-preset",
    sample: "read_file:path_outside_workspace",
    observedAt: "2026-09-16T00:00:00.000Z",
  };
}

function sse(res: ServerResponse, frames: readonly unknown[]): void {
  res.writeHead(200, { "content-type": "text/event-stream" });
  for (const frame of frames) {
    res.write(`data: ${JSON.stringify(frame)}\n\n`);
  }
  res.write("data: [DONE]\n\n");
  res.end();
}

type Endpoint = {
  readonly url: string;
  readonly phases: readonly string[];
  readonly close: () => Promise<void>;
};

type WireMessage = { readonly role: string; readonly content?: string;
  readonly tool_calls?: readonly { readonly function?: { readonly name?: string } }[] };

type WireRequest = { readonly messages: readonly WireMessage[];
  readonly tools?: readonly { readonly function?: { readonly name?: string } }[] };

/** Script only the model side; catalog, real fielding, adoption and read_file
 * still cross the production CLI, tool execution and persistent Board. */
function startEndpoint(): Promise<Endpoint> {
  const phases: string[] = [];
  const tool = (res: ServerResponse, name: string, args: Readonly<Record<string, unknown>>, phase: string) => {
    phases.push(phase);
    sse(res, [{ choices: [{ delta: { tool_calls: [{ index: 0, id: `fixture-${phase}`, type: "function",
      function: { name, arguments: JSON.stringify(args) } }] }, finish_reason: "tool_calls" }], usage: USAGE }]);
  };
  const server: Server = createServer((req, res) => {
    let body = "";
    req.setEncoding("utf8");
    req.on("data", (chunk: string) => { body += chunk; });
    req.on("end", () => {
      try {
        const request = JSON.parse(body) as WireRequest;
        if (!request.tools?.some(item => item.function?.name === "method_context")) {
          phases.push("off");
          sse(res, [{ choices: [{ delta: { content: ANSWER }, finish_reason: "stop" }], usage: USAGE }]);
          return;
        }

        const text = request.messages.map(item => item.content ?? "").join("\n");
        const outputs = request.messages.filter(item => item.role === "tool").flatMap(item => {
          try { return [JSON.parse(item.content ?? "") as Record<string, unknown>]; }
          catch { return []; } // Plain read_file output is not a context-tool result.
        });
        const context = [...outputs].reverse().find(item => item.status === "context_ready");
        if (context === undefined) {
          const line = text.split("\n").find(item => item.startsWith('{"versionId":'));
          assert.ok(line, "the first request must provide the actual catalog");
          const catalog = JSON.parse(line) as { predicate: { all: { feature: string; value: string }[] } };
          tool(res, "method_context", { operation: "context", opportunityId: "package-summary", situation: "Inspect project package within workspace",
            features: Object.fromEntries(catalog.predicate.all.map(item => [item.feature, item.value])) }, "context");
          return;
        }

        const selected = context.selected as { versionId: string; scopeId: string }[];
        assert.ok(selected[0]);

        if (!outputs.some(item => item.status === "recorded" && item.action === "adopt")) {
          assert.match(text, /\[method slot\]/, "context alone is not actual method delivery");
          tool(res, "method_context", { operation: "adopt", versionId: selected[0].versionId, scopeId: selected[0].scopeId,
            reason: "Apply workspace containment before inspecting the package" }, "adopt");
          return;
        }

        const read = request.messages.some(item => item.tool_calls?.some(call => call.function?.name === "read_file"));
        if (!read) {
          tool(res, "read_file", { path: "package.json" }, "read");
          return;
        }

        assert.match(request.messages.filter(item => item.role === "tool").at(-1)?.content ?? "", /cli-fixture/,
          "the final feedback follows actual successful file observation");
        phases.push("feedback");
        sse(res, [{ choices: [{ delta: { content: ANSWER }, finish_reason: "stop" }], usage: USAGE }]);
      } catch (error) {
        res.writeHead(500);
        res.end(String(error));
      }
    });
  });

  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address !== null ? address.port : 0;

      resolve({
        url: `http://127.0.0.1:${port}/v1/chat/completions`,
        phases,
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
  readonly env: Readonly<Record<string, string>>;
  readonly boardRoot: string;
  readonly cleanup: () => void;
};

function fixture(): Fixture {
  const root = mkdtempSync(path.join(os.tmpdir(), "trylo-method-cli-"));
  const workspace = path.join(root, "workspace");
  const home = path.join(root, "home");

  mkdirSync(workspace, { recursive: true });
  mkdirSync(home, { recursive: true });
  mkdirSync(path.join(workspace, ".trylo"), { recursive: true });
  writeFileSync(path.join(workspace, "package.json"), JSON.stringify({ name: "cli-fixture" }), "utf8");
  writeFileSync(
    path.join(workspace, ".trylo", "config.json"),
    JSON.stringify({
      provider: "openai-compatible",
      model: "cli-model",
      contextTokenLimit: 100000,
      // Four scripted requests need headroom before the budget's report-only
      // final request removes business tools and their method applicability.
      maxIterations: 8,
    }),
    "utf8",
  );
  const env = { TRYLO_HOME: home };

  return {
    workspace,
    home,
    env,
    boardRoot: methodBoardRoot(home, env),
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

type RunResult = {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
};

/** Tool results legitimately describe the feedback protocol. Only assistant
 * deltas/final text are the user-answer surface from which the block is stripped. */
function answerText(stdout: string): string {
  return stdout.split(/\r?\n/).filter(Boolean).flatMap(line => {
    const event = JSON.parse(line) as { type: string; text?: string; lastMessage?: string };
    return event.type === "message_delta" ? [event.text ?? ""] : event.type === "run_result" ? [event.lastMessage ?? ""] : [];
  }).join("");
}

/**
 * 异步 spawn：假 provider 端点活在本进程里，同步 spawn 会阻塞那个必须回应它的事件循环。
 */
function run(fx: Fixture, endpoint: string, sessionId = "ses-cli"): Promise<RunResult> {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    TRYLO_HOME: fx.home,
    TRYLO_API_KEY: "sk-cli-fixture",
  };
  const argv = [
    cli,
    "run",
    "please summarize the project",
    "--learning=method",
    "--session",
    sessionId,
    "--provider",
    "openai-compatible",
    "--endpoint",
    endpoint,
    "--model",
    "cli-model",
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

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.on("close", (status) => resolve({ status, stdout, stderr }));
  });
}

type ProbeFielding = {
  readonly exposureId: string;
  readonly versionId: string;
  readonly requestId: string;
  readonly turnId: string;
  readonly beat: number;
};

type ProbeFeedback = {
  readonly exposureId?: string;
  readonly versionId: string;
  readonly turnId: string;
  readonly helped: boolean;
  readonly observation?: { readonly adoption: string };
};

type ProbeResult = {
  readonly ok: boolean;
  readonly fieldings: ReadonlyArray<ProbeFielding>;
  readonly feedbacks: ReadonlyArray<ProbeFeedback>;
};

/** 独立子进程只 import 编译后的读口、只读传进来的目录，把恢复出来的账打回来。 */
const PROBE_SOURCE = [
  "const { createBoardReader } = await import(process.env.PROBE_READER);",
  "const loaded = await createBoardReader(process.env.PROBE_ROOT).load();",
  "const state = loaded.ok ? loaded.state : undefined;",
  "process.stdout.write(JSON.stringify({",
  "  ok: loaded.ok,",
  "  fieldings: state ? state.fieldings : [],",
  "  feedbacks: state ? state.feedbacks : [],",
  "}));",
].join("\n");

function probeRestart(boardRoot: string): ProbeResult {
  const readerUrl = new URL(
    "../../../../../adapters/learning-store/file-event-store.js",
    import.meta.url,
  ).href;
  const child = spawnSync(process.execPath, ["--input-type=module", "-e", PROBE_SOURCE], {
    env: { ...process.env, PROBE_READER: readerUrl, PROBE_ROOT: boardRoot },
    encoding: "utf8",
  });

  assert.equal(child.status, 0, `restart probe failed: ${child.stderr}`);

  return JSON.parse(child.stdout) as ProbeResult;
}

test("P1-5/F11: the real CLI fields a card and records its feedback, recoverable across a process restart", async () => {
  const endpoint = await startEndpoint();
  const fx = fixture();

  try {
    // 预置一张卡到 CLI 即将读的那个板根：用生产写口，走真的 reducer 与落盘。
    const committed = await createMethodBoardWriter(fx.boardRoot).commitCard(presetCommit());

    assert.equal(committed.ok, true, `preset card must archive: ${JSON.stringify(committed)}`);

    const result = await run(fx, endpoint.url);

    assert.equal(result.status, 0, `${result.stderr}\n${result.stdout}`);

    // 上场与反馈都落进了那本持久账（durable log 是证据）。
    const log = readFileSync(path.join(fx.boardRoot, "board-events.ndjson"), "utf8");

    assert.equal(log.includes("method_fielding_recorded"), true, "a real send through the CLI must field");
    assert.equal(log.includes("method_feedback_recorded"), true, `a completed answer must record feedback; phases=${endpoint.phases.join(",")}`);

    // 用户可见的正文穿过了 CLI；反馈围栏是执行侧身份，不进用户输出。
    assert.equal(result.stdout.includes("All done."), true, "the visible answer reaches the user");
    assert.equal(answerText(result.stdout).includes("trylo-method-feedback"), false, "the actual answer surface strips feedback");

    // 换一个 OS 进程，只从磁盘把账读回来。
    const recovered = probeRestart(fx.boardRoot);

    assert.equal(recovered.ok, true, "the archive must reload cleanly in a fresh process");
    assert.equal(recovered.fieldings.length, 3, "adopt/read/final planning requests each actually field the selected method");
    assert.equal(recovered.feedbacks.length, 1, "exactly one feedback survives the restart");

    const feedback = recovered.feedbacks[0];
    const fielding = recovered.fieldings.find(item => item.exposureId === feedback?.exposureId);

    assert.notEqual(fielding, undefined);
    assert.notEqual(feedback, undefined);

    if (fielding === undefined || feedback === undefined) {
      return;
    }

    // 不串配：反馈对回的正是那一次真实展示的 exposure、同一个版本、同一轮。
    assert.equal(feedback.exposureId, fielding.exposureId, "feedback must carry the fielding's exposure id");
    assert.equal(fielding.versionId, PRESET_VERSION_ID, "the fielded version is the preset card");
    assert.equal(feedback.versionId, PRESET_VERSION_ID, "feedback points at the fielded version");
    assert.equal(feedback.turnId, fielding.turnId);
    assert.equal(fielding.requestId.length > 0, true, "the attempt id survives as the request detail");
    // bool 如实恢复：模型说的是 helped:true，穿过 CLI 与重启之后还是 true。
    assert.equal(feedback.helped, true);
    assert.equal(feedback.observation?.adoption, "adopted", "recovered learning evidence requires actual adoption");
    assert.deepEqual(endpoint.phases, ["context", "adopt", "read", "feedback"]);
  } finally {
    await endpoint.close();
    fx.cleanup();
  }
});

test("opted-in CLI runs persist feedback-driven layers across independent processes", async () => {
  const endpoint = await startEndpoint();
  const fx = fixture();

  try {
    assert.equal((await createMethodBoardWriter(fx.boardRoot).commitCard(presetCommit())).ok, true);

    for (let turn = 1; turn <= 8; turn += 1) {
      const result = await run(fx, endpoint.url, `ses-lifecycle-${turn}`);

      assert.equal(result.status, 0, `${result.stderr}\n${result.stdout}`);
      assert.equal(answerText(result.stdout).includes("trylo-method-feedback"), false, "feedback is never user answer text");
      const archive = await createMethodBoardWriter(fx.boardRoot).load();

      assert.ok(archive.ok);
      const variant = archive.variants[0];

      assert.equal(variant?.layer, turn < 3 ? "working" : "middle", "eight adopted reports remain below A and have no snapshot-bound M");
      assert.equal(variant?.ledger.fieldedCount, turn);
      assert.equal(variant?.ledger.helpedCount, turn);
    }

    const recovered = probeRestart(fx.boardRoot);

    assert.equal(recovered.fieldings.length, 24);
    assert.equal(recovered.feedbacks.length, 8);
  } finally {
    await endpoint.close();
    fx.cleanup();
  }
});

test("P1-5/F12: the same run with learning off builds no board and fields nothing", async () => {
  const endpoint = await startEndpoint();
  const fx = fixture();

  try {
    // 关学习：不预置卡、不传 --learning。CLI 不应构造板，也就没有上场可记。
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      TRYLO_HOME: fx.home,
      TRYLO_API_KEY: "sk-cli-fixture",
    };
    const argv = [
      cli,
      "run",
      "please summarize the project",
      "--session",
      "ses-cli-off",
      "--provider",
      "openai-compatible",
      "--endpoint",
      endpoint.url,
      "--model",
      "cli-model",
      "--format",
      "stream-json",
    ];
    const result = await new Promise<RunResult>((resolve) => {
      const child = spawn(process.execPath, argv, { cwd: fx.workspace, env, stdio: ["ignore", "pipe", "pipe"] });
      let stdout = "";
      let stderr = "";

      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => {
        stdout += chunk;
      });
      child.stderr.on("data", (chunk: string) => {
        stderr += chunk;
      });
      child.on("close", (status) => resolve({ status, stdout, stderr }));
    });

    assert.equal(result.status, 0, `${result.stderr}\n${result.stdout}`);
    assert.equal(existsSync(fx.boardRoot), false, "learning off must not create a board root through the CLI");
    assert.equal(answerText(result.stdout).includes("trylo-method-feedback"), true, "without a fielded method the unknown fence stays user-visible");
  } finally {
    await endpoint.close();
    fx.cleanup();
  }
});
