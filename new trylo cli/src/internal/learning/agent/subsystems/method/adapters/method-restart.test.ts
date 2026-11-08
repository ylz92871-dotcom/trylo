import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  createFakePermission,
  createFakeProvider,
  createFakeTools,
  echoBinding,
  type FakeProviderScript,
} from "../../../../../loop/fakes.js";
import { runTurn, type RunTurnResult } from "../../../../../loop/runner.js";
import type { ProviderEvent, ProviderPort, ProviderRequest } from "../../../../../ports/provider.js";
import { emptyUsage } from "../../../../../ports/provider.js";
import type { ToolOutcome } from "../../../../../ports/tools.js";
import {
  createMethodEventSink,
  methodBoardRoot,
  methodLearningRoot,
  METHOD_EVENTS_FILE,
} from "../../../../../surface/cli/learning-sink.js";
import { wirePorts } from "../../../../../surface/cli/wiring.js";

/**
 * ME0-4：真实上场与反馈事实链**跨进程**可恢复（验收 F11 / F12 / F13）。
 *
 * 这里跑的是生产装配——`wirePorts` 造出来的真板、真写口、真 sink、真注入器，
 * 落盘到一棵真的临时家目录树（`learning-activation.test.ts` 的同一套路）。只有
 * **模型与工具**是脚本化的（`loop/fakes.ts`），因为离线 CI 没有真 provider，而
 * 学习侧没有一件东西是替身。
 *
 * 「重启」是真的换一个 OS 进程：父进程把上场与反馈写进 `board-events.ndjson` 之后，
 * `spawnSync` 拉起一个**独立的 node 子进程**，它只 import 编译后的 `createBoardReader`、
 * 只读那同一个目录、把恢复出来的 `fieldings` / `feedbacks` 打回来。内存不共享，所以
 * 子进程读到的每一个字段都只能来自磁盘——这正是 F11「进程重启可恢复且不串配」要的牙。
 *
 * 为什么不经 `cmd/trylo/main.js`：ME0-4 的反馈一步要求模型在回答里写一个
 * `trylo-method-feedback` 块，而 WP §4 把 provider adapter 列为禁改面，仓里没有任何
 * 一个离线 fixture provider 会吐这个块。于是跨进程边界落在**持久/恢复层**（F11 真正
 * 点名的那一层），管路上游仍用生产 `wirePorts`。详见 `ME0-STATE.md` 偏离条 D-3。
 *
 * 整条 CLI 交付面（`main.js run` → 生产 `openai-compatible` 适配器 → 本机 SSE 端点吐
 * 反馈围栏 → 板）的跨进程闭环由**同目录的 `method-cli.test.ts`** 覆盖（外审 P1-5 收口，
 * 见 `ME0-STATE.md` §11 D-3 收口）。本文件继续负责失败/取消/重复递送等脚本化分支。
 */

const NOW_MS = 1_760_000_000_000;

const CARD_JSON =
  '{"hint":"keep the write inside the workspace root","family":"containment",' +
  '"labels":["containment"],"appliesWhen":{"tools":["echo"]}}';

/** 入档围栏（`trylo-learning`）：模型在拍三把这张卡交上来。 */
const LEARNING_FENCE = `\`\`\`trylo-learning\n${CARD_JSON}\n\`\`\``;

/** 反馈围栏（`trylo-method-feedback`）：模型在收尾拍里自报哪张卡帮上了忙。 */
const FEEDBACK_FENCE = "trylo-method-feedback";

function feedbackFenced(json: string): string {
  return `\`\`\`${FEEDBACK_FENCE}\n${json}\n\`\`\``;
}

const FAILED: ToolOutcome = {
  outcome: "error",
  code: "path_outside_workspace",
  message: "refused",
};

const STREAM_START: ProviderEvent = {
  type: "stream_start",
  providerId: "fake",
  model: "fake-model",
  warnings: [],
};

function toolBeat(toolCallId: string): ReadonlyArray<ProviderEvent> {
  return [
    { type: "tool_call", toolCallId, name: "echo", arguments: { value: 1 } },
    { type: "finish", reason: "tool_calls", rawReason: "tool_calls", requiresFollowUp: true },
  ];
}

/** 拍三：交卡那一拍若收尾，turn 就停了，带槽的拍四根本不会发生——所以再调一次工具。 */
function textThenTool(text: string, toolCallId: string): ReadonlyArray<ProviderEvent> {
  return [
    { type: "text_start", blockId: "b1" },
    { type: "text_delta", blockId: "b1", text },
    { type: "text_end", blockId: "b1" },
    { type: "tool_call", toolCallId, name: "echo", arguments: { value: 2 } },
    { type: "finish", reason: "tool_calls", rawReason: "tool_calls", requiresFollowUp: true },
  ];
}

/** 收尾拍：真的发出去了（`stream_start`），写一个合法反馈块，然后正常 `finish`。 */
function startedFeedbackBeat(answer: string): ReadonlyArray<ProviderEvent> {
  return [
    STREAM_START,
    { type: "text_start", blockId: "b1" },
    { type: "text_delta", blockId: "b1", text: answer },
    { type: "text_end", blockId: "b1" },
    { type: "usage", usage: emptyUsage("snapshot") },
    { type: "finish", reason: "stop", rawReason: "stop", requiresFollowUp: false },
  ];
}

/** start 前就出错：没有 `stream_start`，模型从没接受这个请求（F02）。 */
const BEFORE_START_ERROR: ReadonlyArray<ProviderEvent> = [
  { type: "error", class: "network", retryable: false, phase: "before_headers", message: "no route" },
];

/** 拍一拍二都失败（放权要两个样本），拍三收到意图并交卡，拍四带着槽上场并自报反馈。 */
const ADMIT_THEN_FEEDBACK: FakeProviderScript = [
  toolBeat("call-1"),
  toolBeat("call-2"),
  textThenTool(LEARNING_FENCE, "call-3"),
  startedFeedbackBeat(`All done.\n\n${feedbackFenced('{"items":[{"ref":"m1","helped":true}]}')}`),
];

/** 同样入档，但上场拍在 `stream_start` 之前就失败：卡进了档，上场与反馈都不该落。 */
const ADMIT_THEN_PRE_START_FAILURE: FakeProviderScript = [
  toolBeat("call-1"),
  toolBeat("call-2"),
  textThenTool(LEARNING_FENCE, "call-3"),
  BEFORE_START_ERROR,
];

type Fixture = {
  readonly home: string;
  readonly cwd: string;
  readonly env: Readonly<Record<string, string>>;
  readonly cleanup: () => void;
};

function fixture(label: string): Fixture {
  const root = mkdtempSync(path.join(os.tmpdir(), `trylo-me0-restart-${label}-`));
  const cwd = path.join(root, "workspace");
  const home = path.join(root, "home");
  mkdirSync(cwd, { recursive: true });
  mkdirSync(home, { recursive: true });
  return { home, cwd, env: { TRYLO_HOME: home }, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

type RunOptions = {
  readonly fx: Fixture;
  readonly script: FakeProviderScript;
  /** 缺席 = 关学习：组合根拿不到端口，连板都不构造（F12 的「关」那一面）。 */
  readonly learning?: boolean;
};

type RunOutcome = {
  readonly result: RunTurnResult;
  readonly requests: ReadonlyArray<ProviderRequest>;
  readonly boardRoot: string;
};

/** 在生产装配下跑一轮：真板落盘到 `fx.home`，只有 provider/tools 是脚本化的。 */
async function runPipeline(options: RunOptions): Promise<RunOutcome> {
  const { fx, script } = options;
  const boardRoot = methodBoardRoot(fx.home, fx.env);
  const wiring = wirePorts({
    providerId: "fixture",
    model: "default",
    endpoint: "",
    apiKey: undefined,
    workspaceRoot: fx.cwd,
    permission: createFakePermission("approved"),
    nowMs: NOW_MS,
    ...(options.learning === true
      ? {
          learning: {
            switch: "method",
            homeDir: fx.home,
            env: fx.env,
            emit: createMethodEventSink(methodLearningRoot(fx.home, fx.env), {
              now: () => new Date(NOW_MS).toISOString(),
              warn: () => undefined,
            }),
          },
        }
      : {}),
  });
  if ("code" in wiring) {
    assert.fail(`expected a wiring, got ${wiring.code}`);
  }

  const inner = createFakeProvider(script);
  const requests: ProviderRequest[] = [];
  const provider: ProviderPort = {
    stream(request, signal) {
      requests.push(request);
      return inner.stream(request, signal);
    },
  };

  const result = await runTurn(
    {
      ...wiring.ports,
      provider,
      tools: createFakeTools([FAILED, FAILED], [echoBinding({ needsApproval: false })]),
      permission: createFakePermission("approved"),
    },
    {
      sessionId: "ses-restart",
      turnId: "trn-restart",
      correlationId: "cor-restart",
      text: "write the file",
      model: "default",
    },
  );

  return { result, requests, boardRoot };
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
};

type ProbeResult = {
  readonly ok: boolean;
  readonly fieldings: ReadonlyArray<ProbeFielding>;
  readonly feedbacks: ReadonlyArray<ProbeFeedback>;
};

/**
 * 子进程只读两件事：编译后的 `createBoardReader`（用相对本测试文件的 URL 定位，于是
 * 共享 dist 与隔离 dist 都能跑），和父进程传进来的那个目录。它打印恢复出来的账，
 * 父进程据此断言。内存不共享 ⇒ 读到的只能来自磁盘 ⇒ 这是一次真的重启。
 */
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

test("ME0-4/F11: a fielding and its feedback survive a real process restart, paired by exposure", async () => {
  const fx = fixture("positive");
  try {
    const { result, boardRoot } = await runPipeline({ fx, script: ADMIT_THEN_FEEDBACK, learning: true });

    assert.equal(result.state.terminalReason, "completed", result.state.terminalReason);

    // 卡真的入档了，且上场与反馈都落到了同一本持久账上。
    const log = readFileSync(path.join(boardRoot, "board-events.ndjson"), "utf8");

    assert.equal(log.includes("commit_asset"), true, "the preset card must be archived");
    assert.equal(log.includes("method_fielding_recorded"), true, "a real send must field");
    assert.equal(log.includes("method_feedback_recorded"), true, "a completed answer must record feedback");

    // 换一个 OS 进程，只从磁盘把账读回来。
    const recovered = probeRestart(boardRoot);

    assert.equal(recovered.ok, true, "the archive must reload cleanly in a fresh process");
    assert.equal(recovered.fieldings.length, 1, "exactly one fielding survives the restart");
    assert.equal(recovered.feedbacks.length, 1, "exactly one feedback survives the restart");

    const fielding = recovered.fieldings[0];
    const feedback = recovered.feedbacks[0];

    assert.notEqual(fielding, undefined);
    assert.notEqual(feedback, undefined);

    if (fielding === undefined || feedback === undefined) {
      return;
    }

    // 不串配：反馈对回的正是那一次真实展示的 exposure、同一个版本、同一轮。
    assert.equal(feedback.exposureId, fielding.exposureId, "feedback must carry the fielding's exposure id");
    assert.equal(feedback.versionId, fielding.versionId, "feedback must point at the fielded version");
    assert.equal(feedback.turnId, fielding.turnId);
    assert.equal(fielding.requestId.length > 0, true, "the attempt id survives as the request detail");
    // bool 如实恢复：模型说的是 helped:true，重启之后还是 true，不是被丢成 unknown。
    assert.equal(feedback.helped, true);
  } finally {
    fx.cleanup();
  }
});

test("ME0-4/F13: neither the receipt nor the feedback block reaches the recoverable transcript", async () => {
  const fx = fixture("transcript");
  try {
    const { result } = await runPipeline({ fx, script: ADMIT_THEN_FEEDBACK, learning: true });
    const transcript = JSON.stringify(result.transcript);

    // 反馈块被剥掉了：围栏名、bool 词、卡正文都不在可恢复对话正文里。
    assert.equal(transcript.includes(FEEDBACK_FENCE), false, "the feedback fence must not be recoverable");
    assert.equal(transcript.includes('"helped"'), false, "the feedback payload must not be recoverable");
    assert.equal(transcript.includes(CARD_JSON), false, "the card body must not be recoverable");
    // receipt 是执行侧身份，从不进 provider 请求，也就从不进 transcript。
    assert.equal(transcript.includes("proposalId"), false, "receipts are execution-side only");
    // 用户看到的正文还在，只是少了那个块。
    const visible = result.transcript
      .filter((item) => item.kind === "assistant_text")
      .map((item) => (item.kind === "assistant_text" ? item.text : ""))
      .join("");

    assert.equal(visible.includes("All done."), true);
    assert.equal(visible.includes(FEEDBACK_FENCE), false);
  } finally {
    fx.cleanup();
  }
});

test("ME0-4/F02: a failure before stream_start fields nothing and feeds nothing, even with a card archived", async () => {
  const fx = fixture("prestart");
  try {
    const { result, boardRoot } = await runPipeline({
      fx,
      script: ADMIT_THEN_PRE_START_FAILURE,
      learning: true,
    });

    // 任务按原错误结束，不被学习记账改写。
    assert.equal(result.state.terminalReason, "failed", result.state.terminalReason);

    const log = readFileSync(path.join(boardRoot, "board-events.ndjson"), "utf8");

    assert.equal(log.includes("commit_asset"), true, "the card still archived before the failing beat");
    // start 前失败 = 模型从没接受这个请求 = 没有一次真实展示可记。
    assert.equal(log.includes("method_fielding_recorded"), false, "no fielding before stream_start");
    assert.equal(log.includes("method_feedback_recorded"), false, "no feedback without a fielding");

    const recovered = probeRestart(boardRoot);

    assert.equal(recovered.fieldings.length, 0);
    assert.equal(recovered.feedbacks.length, 0);
  } finally {
    fx.cleanup();
  }
});

test("ME0-4/F12: with no card the slot is empty, so a feedback fence fields nothing and stays visible", async () => {
  const fx = fixture("nocard");
  try {
    const answer = `Done.\n\n${feedbackFenced('{"items":[{"ref":"m1","helped":true}]}')}`;
    const { result, boardRoot } = await runPipeline({
      fx,
      script: [startedFeedbackBeat(answer)],
      learning: true,
    });
    // 没有卡 = 没有 receipt = 不装反馈剥离器：那段围栏就是普通正文，逐字可见。
    const visible = result.transcript
      .filter((item) => item.kind === "assistant_text")
      .map((item) => (item.kind === "assistant_text" ? item.text : ""))
      .join("");

    assert.equal(visible.includes(FEEDBACK_FENCE), true, "an unfielded fence is ordinary visible text");

    const recovered = probeRestart(boardRoot);

    assert.equal(recovered.fieldings.length, 0, "no card means nothing fielded");
    assert.equal(recovered.feedbacks.length, 0, "no fielding means nothing to attribute feedback to");
  } finally {
    fx.cleanup();
  }
});

test("ME0-4/F12: learning off builds no board and leaves the provider requests byte-identical", async () => {
  const fx = fixture("off");
  try {
    const answer = `Done.\n\n${feedbackFenced('{"items":[{"ref":"m1","helped":true}]}')}`;
    const script: FakeProviderScript = [startedFeedbackBeat(answer)];

    const off = await runPipeline({ fx, script });
    const onNoCard = await runPipeline({ fx, script, learning: true });

    // 关学习：板根本没构造，家目录那棵树下没有 board 目录。
    assert.equal(existsSync(off.boardRoot), false, "learning off must not create a board root");
    // 零差异：开着但空档与关着，发给 provider 的请求逐字节相同，调用数也相同。
    assert.deepEqual(
      onNoCard.requests.map((request) => JSON.stringify(request)),
      off.requests.map((request) => JSON.stringify(request)),
      "an empty slot must not change a single provider request byte",
    );
    assert.equal(onNoCard.requests.length, off.requests.length, "learning adds no provider call");
  } finally {
    fx.cleanup();
  }
});

/** 板自己的可观察性日志（`method-events.ndjson`）：一行一事件，载荷是平的。 */
type MethodEvent = {
  readonly kind: string;
  readonly payload: Readonly<Record<string, unknown>>;
};

function readMethodEvents(
  home: string,
  env: Readonly<Record<string, string>>,
): ReadonlyArray<MethodEvent> {
  const file = path.join(methodLearningRoot(home, env), METHOD_EVENTS_FILE);
  if (!existsSync(file)) {
    return [];
  }

  return readFileSync(file, "utf8")
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as MethodEvent);
}

/**
 * ME0-4/P1-4：一次**真实文件系统错误**在执行环里只降级、不失败用户任务。
 *
 * 与上面几条同一套生产装配（`wirePorts` 造的真板、真写口、真 sink），跑的也是真的
 * `runTurn`，只有 provider/tools 是脚本化的。区别在于档的根目录被换成一个**普通
 * 文件**——这是一次真实的 IO 故障，不是注入缝：
 *
 *  - 读这一侧：文件不存在 ⇒ `readFile` 报 ENOENT ⇒ 板把它读成空档（合法，不是降级），
 *    于是板照常构造、照常放权；
 *  - 写这一侧：拍三模型交上那张卡，`commitCard` 走到 `createFileBoardStore` 的
 *    `mkdirSync(boardRoot)`，而 boardRoot 是个文件 ⇒ 抛 EEXIST。
 *
 * P1-4 之前，这个 EEXIST 会一路冒出 `withBoardWriter` → 写口 → `commitAdmitted` →
 * `observe` → `runTurn`，把**用户的任务**一起炸掉。P1-4 之后，适配器边界在建/锁这一
 * 阶段就把它收成类型化的 `board_unavailable`（确定未写），板据此 fail-closed 上报一条
 * degraded 观察，这一轮照常结算。下面三条断言正是验收要的：主任务照常完成、恰好一条
 * 可观察降级、坏路径一个字节都没被改写（不盲目重试、不绕过）。
 */
test("ME0-4/P1-4: a real filesystem fault under the board degrades once and the turn still settles", async () => {
  const fx = fixture("iodegrade");
  try {
    const boardRoot = methodBoardRoot(fx.home, fx.env);
    const sentinel = "the board root is a plain file, not a directory";

    mkdirSync(path.dirname(boardRoot), { recursive: true });
    writeFileSync(boardRoot, sentinel, "utf8");

    const { result } = await runPipeline({ fx, script: ADMIT_THEN_FEEDBACK, learning: true });

    // 主任务照常结算：学习存储坏了，用户这一轮仍然正常完成，不被学习记账拖垮。
    assert.equal(result.state.terminalReason, "completed", result.state.terminalReason);

    // 恰好一条可观察降级，落在板自己的事件日志里，且归因到档（method_archive）。
    const degraded = readMethodEvents(fx.home, fx.env).filter(
      (event) => event.payload.degraded === true && event.payload.component === "method_archive",
    );

    assert.equal(degraded.length, 1, "exactly one archive degradation is observable");
    assert.equal(typeof degraded[0]?.payload.reason, "string");

    // fail-closed：那个坏路径一个字节都没被改写——没有盲目重试，也没有绕过去硬写。
    assert.equal(readFileSync(boardRoot, "utf8"), sentinel);
  } finally {
    fx.cleanup();
  }
});
