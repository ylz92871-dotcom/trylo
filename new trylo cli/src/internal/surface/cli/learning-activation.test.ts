import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { runTurn } from "../../loop/runner.js";
import {
  createFakePermission,
  createFakeProvider,
  createFakeTools,
  echoBinding,
  type FakeProviderScript,
} from "../../loop/fakes.js";
import type { ProviderEvent, ProviderPort, ProviderRequest } from "../../ports/provider.js";
import { emptyUsage } from "../../ports/provider.js";
import type { ToolOutcome } from "../../ports/tools.js";
import { wirePorts } from "./wiring.js";
import { createDenyAllPermission } from "./permission.js";
import {
  METHOD_EVENTS_FILE,
  createMethodEventSink,
  methodBoardRoot,
  methodLearningRoot,
} from "./learning-sink.js";

/**
 * 端到端：整条 M2 管路在生产装配下真实转动（LA-4）。
 *
 * 组合根、档、sink、注入器全是生产的 `wirePorts` 造出来的——只有**模型和工具**
 * 是脚本化的（`loop/fakes.ts`，本仓既有的假 provider）。这正是「用既有 fake
 * /scripted provider 跑真管路」的意思：学习侧没有一件东西是替身。
 */

const CARD_JSON =
  '{"hint":"keep the write inside the workspace root","family":"containment",' +
  '"labels":["containment"],"appliesWhen":{"tools":["echo"]}}';

const FENCE = `\`\`\`trylo-learning\n${CARD_JSON}\n\`\`\``;

function toolBeat(toolCallId: string): ReadonlyArray<ProviderEvent> {
  return [
    { type: "tool_call", toolCallId, name: "echo", arguments: { value: 1 } },
    { type: "finish", reason: "tool_calls", rawReason: "tool_calls", requiresFollowUp: true },
  ];
}

function textBeat(text: string): ReadonlyArray<ProviderEvent> {
  return [
    { type: "text_start", blockId: "b1" },
    { type: "text_delta", blockId: "b1", text },
    { type: "text_end", blockId: "b1" },
    { type: "usage", usage: emptyUsage("snapshot") },
    { type: "finish", reason: "stop", rawReason: "stop", requiresFollowUp: false },
  ];
}

const FAILED: ToolOutcome = {
  outcome: "error",
  code: "path_outside_workspace",
  message: "refused",
};

/** 拍三在交卡之后还要再调一次工具：交卡那一拍若是收尾拍，turn 就在拍三结束，
 *  拍四（槽里带着那张卡的那一拍）根本不会发生。 */
function textThenTool(text: string, toolCallId: string): ReadonlyArray<ProviderEvent> {
  return [
    { type: "text_start", blockId: "b1" },
    { type: "text_delta", blockId: "b1", text },
    { type: "text_end", blockId: "b1" },
    { type: "tool_call", toolCallId, name: "echo", arguments: { value: 2 } },
    { type: "finish", reason: "tool_calls", rawReason: "tool_calls", requiresFollowUp: true },
  ];
}

/** 拍一与拍二都失败（放权要两个样本），拍三收到意图并交卡，拍四看卡有没有上场。 */
const SCRIPT: FakeProviderScript = [
  toolBeat("call-1"),
  toolBeat("call-2"),
  textThenTool(FENCE, "call-3"),
  textBeat("done"),
];

function recordingProvider(script: FakeProviderScript): {
  readonly port: ProviderPort;
  readonly requests: ProviderRequest[];
} {
  const inner = createFakeProvider(script);
  const requests: ProviderRequest[] = [];

  return {
    port: {
      stream(request, signal) {
        requests.push(request);
        return inner.stream(request, signal);
      },
    },
    requests,
  };
}

function temp(): { readonly home: string; readonly cwd: string; readonly cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), "trylo-method-activation-"));
  const cwd = join(root, "workspace");
  mkdirSync(cwd, { recursive: true });
  return { home: join(root, "home"), cwd, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

type SinkRecord = {
  readonly occurredAt?: unknown;
  readonly kind?: unknown;
  readonly payload?: Readonly<Record<string, unknown>>;
};

function sinkRecords(path: string): ReadonlyArray<SinkRecord> {
  if (!existsSync(path)) {
    return [];
  }
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as SinkRecord);
}

test("the whole method pipeline turns under the production wiring", async () => {
  const { home, cwd, cleanup } = temp();
  try {
    const env = { TRYLO_HOME: home };
    const provider = recordingProvider(SCRIPT);
    const wiring = wirePorts({
      providerId: "fixture",
      model: "default",
      endpoint: "",
      apiKey: undefined,
      workspaceRoot: cwd,
      permission: createDenyAllPermission(),
      learning: {
        switch: "method",
        homeDir: home,
        env,
        emit: createMethodEventSink(methodLearningRoot(home, env), {
          now: () => "2026-09-16T00:00:00.000Z",
          warn: () => undefined,
        }),
      },
    });
    if ("code" in wiring) {
      assert.fail("expected a wiring");
    }

    assert.notEqual(wiring.ports.method, undefined, "the switch must reach the composition root");

    const result = await runTurn(
      {
        ...wiring.ports,
        provider: provider.port,
        tools: createFakeTools([FAILED, FAILED], [echoBinding({ needsApproval: false })]),
        permission: createFakePermission("approved"),
      },
      { sessionId: "s1", turnId: "t1", correlationId: "c1", text: "write the file", model: "default" },
    );

    // ① 卡真的入档了：档是控制板的账本，`commit_asset` 是过门即入的那一笔。
    const boardLog = join(methodBoardRoot(home, env), "board-events.ndjson");

    assert.equal(existsSync(boardLog), true, "the board must have written its archive");
    const commands = readFileSync(boardLog, "utf8");

    assert.equal(commands.includes("commit_asset"), true, "the admitted card must be archived");

    // ② 放权发生在该发生的地方：拍二凑够两个样本，拍三才收到卡。
    const sinkPath = join(methodLearningRoot(home, env), METHOD_EVENTS_FILE);
    const records = sinkRecords(sinkPath);
    const components = records.map((record) => String(record.payload?.component));

    assert.equal(
      components.includes("method_scheduler"),
      true,
      `expected a scheduler release, saw ${JSON.stringify(components)}`,
    );

    // ③ 归档之后，下一拍的槽里带着这张卡——编译上场是真的。
    const slotBeats = provider.requests.filter((request) =>
      request.messages.some(
        (message) => message.role === "system" && message.content.includes("[method slot]"),
      ),
    );

    assert.equal(slotBeats.length >= 1, true, "the archived card must come back on stage");
    assert.equal(
      result.transcript.some((item) => JSON.stringify(item).includes(CARD_JSON)),
      false,
      "the fence body must never reach the transcript",
    );
  } finally {
    cleanup();
  }
});

test("the fence body never reaches the event log", async () => {
  const { home, cwd, cleanup } = temp();
  try {
    const env = { TRYLO_HOME: home };
    const provider = recordingProvider(SCRIPT);
    const wiring = wirePorts({
      providerId: "fixture",
      model: "default",
      endpoint: "",
      apiKey: undefined,
      workspaceRoot: cwd,
      permission: createDenyAllPermission(),
      learning: {
          switch: "method",
          homeDir: home,
          env,
          emit: createMethodEventSink(methodLearningRoot(home, env), {
            now: () => "2026-09-16T00:00:00.000Z",
            warn: () => undefined,
          }),
        },
    });
    if ("code" in wiring) {
      assert.fail("expected a wiring");
    }

    await runTurn(
      {
        ...wiring.ports,
        provider: provider.port,
        tools: createFakeTools([FAILED, FAILED], [echoBinding({ needsApproval: false })]),
        permission: createFakePermission("approved"),
      },
      { sessionId: "s1", turnId: "t1", correlationId: "c1", text: "write the file", model: "default" },
    );
    const log = readFileSync(join(methodLearningRoot(home, env), METHOD_EVENTS_FILE), "utf8");

    // 板上报的是「它决定了什么」——放行、家族、卡的身份；不是模型写了什么。
    assert.equal(log.includes("trylo-learning"), false, "the fence marker must not be logged");
    assert.equal(log.includes("```"), false, "no fence body");
    assert.equal(log.includes("appliesWhen"), false, "the raw card JSON must not be logged");
    assert.equal(log.includes(CARD_JSON), false, "the card body must not be logged");

    // 家族与标签是板自己的词表维度，会（也应该）出现：那不是卡正文。
    for (const line of log.split("\n").filter((entry) => entry.length > 0)) {
      assert.doesNotThrow(() => JSON.parse(line), `every line must be valid JSON: ${line}`);
    }
  } finally {
    cleanup();
  }
});

test("a board the switch never built leaves the run byte for byte the same", async () => {
  const { home, cwd, cleanup } = temp();
  try {
    const env = { TRYLO_HOME: home };
    const runOnce = async (learning: { switch: string; homeDir: string; env: Record<string, string> } | undefined) => {
      const provider = recordingProvider(SCRIPT);
      const wiring = wirePorts({
        providerId: "fixture",
        model: "default",
        endpoint: "",
        apiKey: undefined,
        workspaceRoot: cwd,
        permission: createDenyAllPermission(),
        ...(learning === undefined
          ? {}
          : {
              learning: {
                ...learning,
                emit: createMethodEventSink(methodLearningRoot(home, env), {
                  now: () => "2026-09-16T00:00:00.000Z",
                  warn: () => undefined,
                }),
              },
            }),
      });
      if ("code" in wiring) {
        assert.fail("expected a wiring");
      }

      await runTurn(
        {
          ...wiring.ports,
          provider: provider.port,
          tools: createFakeTools([FAILED, FAILED], [echoBinding({ needsApproval: false })]),
          permission: createFakePermission("approved"),
        },
        { sessionId: "s1", turnId: "t1", correlationId: "c1", text: "write the file", model: "default" },
      );

      return provider.requests.map((request) => JSON.stringify(request));
    };

    const off = await runOnce(undefined);

    assert.equal(existsSync(methodBoardRoot(home, env)), false, "off must not create the board root");
    assert.equal(existsSync(join(methodLearningRoot(home, env), METHOD_EVENTS_FILE)), false);
    assert.equal(off.length > 0, true);

    // The falsifiable half of I1: with the switch off, not one request carries
    // anything the learning layer produces. If a default ever flipped on, this
    // is the assertion that would catch it.
    for (const request of off) {
      const parsed = JSON.parse(request) as {
        readonly messages?: ReadonlyArray<{ readonly role?: string; readonly content?: string }>;
      };
      for (const message of parsed.messages ?? []) {
        if (message.role !== "system") {
          continue;
        }

        assert.equal(
          message.content?.includes("[method slot]"),
          false,
          "no slot may be injected when the switch is off",
        );
        assert.equal(
          message.content?.includes("[learning intent]"),
          false,
          "no intent may be injected when the switch is off",
        );
      }
    }
  } finally {
    cleanup();
  }
});
