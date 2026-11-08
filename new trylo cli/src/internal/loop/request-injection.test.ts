import assert from "node:assert/strict";
import test from "node:test";
import type { ProviderMessage } from "../ports/provider.js";
import type { ToolBinding, ToolPort } from "../ports/tools.js";
import { buildRequest, toolListMessage, withInjectedSlot } from "./request.js";
import { createCompactionLedger } from "./compact-boundary.js";

/**
 * 注入接缝的**恒等性**（P05 工具学习规格 §11 #11「关学习零可观察差异」）。
 *
 * TP-1 往这个函数里加了第二个槽（工具学习的自报提示），而它原来是「一个槽的一行
 * 三元」。所以必须钉住的是：**没槽的时候行为一个字都没变**——返回的不是等价的
 * 数组，而是**同一个数组对象**。这不是洁癖，是 I1 得以成立的方式：`messages`
 * 一旦被复制，下游任何按引用比对的判断都会与开工前不同。
 *
 * 三个槽位组合（无 / 只有方法 / 只有自报 / 两个都有）逐个钉住，顺序也钉住——
 * 两个子系统各自独立，谁先谁后是设计而不是巧合。
 */

const base: readonly ProviderMessage[] = [
  { role: "system", content: "you are trylo" },
  { role: "user", content: "hello" },
];

const method = { role: "system", content: "teaching slot" } as const;
const gap = { role: "system", content: "please self-report" } as const;

test("P1 两个槽都缺席 → 返回同一个数组对象（不是副本）", () => {
  assert.equal(withInjectedSlot(base, undefined), base);
  assert.equal(withInjectedSlot(base, undefined, undefined), base);
});

test("P2 只带方法槽 → 与旧的两参行为逐字相同", () => {
  assert.deepEqual(withInjectedSlot(base, method), [...base, method]);
});

test("P3 只带自报槽 → 也能注入（工具学习不依赖方法子系统在场）", () => {
  assert.deepEqual(withInjectedSlot(base, undefined, gap), [...base, gap]);
});

test("P4 两个都在 → 方法槽在前、自报槽在后，顺序固定", () => {
  assert.deepEqual(withInjectedSlot(base, method, gap), [...base, method, gap]);
});

test("P5 注入不改原数组：base 一个元素都不多", () => {
  const before = base.length;
  withInjectedSlot(base, method, gap);
  assert.equal(base.length, before);
});

function binding(name: string, needsApproval: boolean): ToolBinding {
  return {
    name,
    description: `${name} tool`,
    sideEffect: needsApproval ? "external" : "read_only",
    parameters: { type: "object" },
    needsApproval,
    timeoutMs: 1_000,
    outputLimits: { maxBytes: 1024, maxLines: 50 },
  };
}

function portOf(bindings: ReadonlyArray<ToolBinding>): ToolPort {
  return {
    snapshot: () => [...bindings],
    execute: async () => ({ outcome: "cancelled" }),
    cancel: async () => {},
  };
}

function throwingPort(): ToolPort {
  return {
    snapshot: () => {
      throw new Error("catalog unreadable");
    },
    execute: async () => ({ outcome: "cancelled" }),
    cancel: async () => {},
  };
}

test("D7: the tool list names the mounted table and marks approval", () => {
  const message = toolListMessage(portOf([binding("read_file", false), binding("run_shell", true)]));
  assert.notEqual(message, undefined);
  assert.equal(message?.role, "system");
  assert.match(message?.content ?? "", /read_file/);
  assert.match(message?.content ?? "", /run_shell \(needs approval\)/);
  assert.match(message?.content ?? "", /refused/);
});

test("D7: an unreadable catalog means no list segment, never a crash", () => {
  assert.equal(toolListMessage(throwingPort()), undefined);
  assert.equal(toolListMessage(portOf([])), undefined);
});

test("D7: the list rides with the seed, ahead of the conversation and the slots", () => {
  const view = {
    attemptId: "att-1",
    model: "m",
    tools: portOf([binding("echo", false)]),
    prompt: { seedMessages: base, transcript: [], ledger: createCompactionLedger() },
  };
  const plain = buildRequest(view);

  assert.equal(plain.messages.length, base.length + 1);
  assert.deepEqual(plain.messages.slice(0, base.length), base);
  const listed = plain.messages[base.length];

  assert.equal(listed?.role, "system");
  assert.match(listed?.content ?? "", /Available tools this run/);
  const taught = buildRequest({ ...view, slot: method });

  assert.deepEqual(taught.messages[taught.messages.length - 1], method);
  assert.equal(taught.messages.length, plain.messages.length + 1);
});

/**
 * WP18.3 (C74/L67): caller system prompts and response schemas ride the
 * request. Absent both, the request is byte-identical to the un-wired path
 * (the case above); present, the seeds change exactly once and the schema
 * travels untouched for the adapter to send.
 */
test("WP18: replace swaps the seeds, append extends them, schema is carried", () => {
  const seeds = [{ role: "system" as const, content: "you are trylo" }];
  const view = {
    attemptId: "att-1",
    model: "m",
    tools: portOf([]),
    prompt: {
      seedMessages: seeds,
      transcript: [{ kind: "user" as const, sequence: 0, text: "hello" }],
      ledger: createCompactionLedger(),
    },
  };
  const plain = buildRequest(view);

  assert.equal(plain.responseSchema, undefined);
  assert.equal(plain.systemPrompt, undefined);
  assert.deepEqual(plain.messages, [...seeds, { role: "user", content: "hello" }]);
  const replaced = buildRequest({ ...view, systemPrompt: { mode: "replace", text: "you are a tester" } });

  assert.deepEqual(replaced.messages, [
    { role: "system", content: "you are a tester" },
    { role: "user", content: "hello" },
  ]);
  assert.deepEqual(replaced.systemPrompt, { mode: "replace", text: "you are a tester" });
  const appended = buildRequest({ ...view, systemPrompt: { mode: "append", text: "be brief" } });

  assert.deepEqual(appended.messages, [
    { role: "system", content: "you are trylo" },
    { role: "system", content: "be brief" },
    { role: "user", content: "hello" },
  ]);
  const schematized = buildRequest({ ...view, responseSchema: { type: "object" } });

  assert.deepEqual(schematized.responseSchema, { type: "object" });
  assert.deepEqual(schematized.messages, plain.messages);
});
