import assert from "node:assert/strict";
import { test } from "node:test";
import type { JsonObject } from "../../protocol/envelope.js";
import { projectAcp } from "./acp.js";
import { admit, type AdmittedEnvelope } from "./admit.js";
import { projectAgui } from "./agui.js";
import type { AcpFrame, AguiFrame } from "./frames.js";
import { createAguiState } from "./state.js";

/**
 * P6：脱敏与隐私。
 *
 * 规矩只有一条：**投影前过唯一一次脱敏**（`protocol/redact.ts` 的那一张规则表，
 * 由 `./admit.ts` 调用），投影器自己不做任何清洗。因此这一组用例除了断言
 * 「敏感内容不在帧里」，还断言「帧里的替换结果与那张表的产物**逐字相同**」——
 * 后者才是「没有第二套规则表」的证据。
 *
 * 关于 hidden reasoning 有两道闸，都必须测：
 * 1. 进场闸：字符串里的 secret / 绝对路径被替换（同一条规则表）；
 * 2. 投影闸：payload 未显式声明 `redacted === false` 的推理内容**整段不投影**
 *    （表里的 `onlyWhenFalse` 守卫，失败方向朝隐私一侧闭合）。
 */

const SECRET = "sk-abcdefgh12345678";
const POSIX_PATH = "/home/alice/.aws/credentials";
const WIN_PATH = "D:\\work\\keys\\prod.pem";

function rawEnvelope(kind: string, payload: JsonObject): unknown {
  return {
    protocolVersion: "0.0",
    eventId: `evt-${kind}-redaction`,
    sequence: 0,
    timestamp: "2026-09-15T00:00:00.000Z",
    kind,
    payload,
    producerId: "cli",
    producerSequence: 0,
  };
}

function admitOrFail(raw: unknown): AdmittedEnvelope {
  const result = admit(raw);
  if (!result.ok) {
    assert.fail(`应当通过校验，却返回 ${result.detail}`);
  }

  if (result.outcome !== "admitted") {
    assert.fail(`应当是已知 kind，却被忽略为 ${result.kind}`);
  }

  return result.admitted;
}

function acpFrame(raw: unknown): AcpFrame {
  const result = projectAcp(admitOrFail(raw));
  if (!result.ok) {
    assert.fail(`${result.code}: ${result.detail}`);
  }
  return result.frame;
}

function aguiFrame(raw: unknown): AguiFrame {
  const result = projectAgui(admitOrFail(raw), createAguiState());
  if (!result.ok) {
    assert.fail(`${result.code}: ${result.detail}`);
  }
  return result.frame;
}

function serialized(frame: AcpFrame | AguiFrame): string {
  return JSON.stringify(frame);
}

test("secret 不进 ACP / ag-ui 帧", () => {
  const raw = rawEnvelope("text", { text: `token is ${SECRET} ok`, role: "assistant" });
  const acp = acpFrame(raw);

  assert.equal(serialized(acp).includes(SECRET), false);
  assert.equal(serialized(acp).includes("[secret]"), true);
  const agui = aguiFrame(raw);

  assert.equal(serialized(agui).includes(SECRET), false);
  assert.equal(agui.body.delta, "token is [secret] ok");
});

test("绝对路径不进帧（POSIX 与 Windows 两种形态）", () => {
  const raw = rawEnvelope("tool_result", {
    toolCallId: "call-1",
    status: "succeeded",
    value: { posix: POSIX_PATH, windows: WIN_PATH },
  });
  const acp = acpFrame(raw);
  const text = serialized(acp);

  assert.equal(text.includes(POSIX_PATH), false);
  assert.equal(text.includes("prod.pem"), false);
  assert.equal(text.includes("[path]"), true);
});

test("frames 里出现的替换结果与唯一规则表逐字一致（没有第二套清洗）", () => {
  const raw = rawEnvelope("text", { text: `${SECRET} at ${POSIX_PATH}` });
  const admitted = admitOrFail(raw);
  const expected = admitted.envelope.payload.text;

  assert.equal(expected, "[secret] at [path]");
  const content = acpFrame(raw).body.content as JsonObject | undefined;

  assert.notEqual(content, undefined);

  if (content === undefined) {
    return;
  }

  assert.equal(content.text, expected);
  assert.equal(aguiFrame(raw).body.delta, expected);
});

test("error 与 CUSTOM 载荷里的 secret 同样被清（CUSTOM 不是脱敏后门）", () => {
  const errorFrame = acpFrame(rawEnvelope("error", { message: `upstream said ${SECRET}` }));

  assert.equal(serialized(errorFrame).includes(SECRET), false);
  assert.equal(serialized(errorFrame).includes("[secret]"), true);

  const customRaw = rawEnvelope("user_correction", { text: `use ${POSIX_PATH} instead` });
  const customAcp = acpFrame(customRaw);

  assert.equal(customAcp.disposition, "custom");
  assert.equal(serialized(customAcp).includes(POSIX_PATH), false);
  const customAgui = aguiFrame(customRaw);

  assert.equal(serialized(customAgui).includes(POSIX_PATH), false);
  assert.equal(serialized(customAgui).includes("[path]"), true);
});

test("未声明未脱敏的推理内容整段不投影", () => {
  const secretReasoning = `internal plan: ${SECRET} at ${POSIX_PATH}`;
  const declaredRedacted = acpFrame(rawEnvelope("thinking", { text: secretReasoning, redacted: true }));

  assert.equal(declaredRedacted.body.content, undefined, "redacted=true 时不得投影内容");

  const undeclared = acpFrame(rawEnvelope("thinking", { text: "plan without a flag" }));

  assert.equal(undeclared.body.content, undefined, "未声明 redacted=false 时不得投影内容");

  const aguiUndeclared = aguiFrame(rawEnvelope("thinking", { text: "plan without a flag" }));

  assert.equal(aguiUndeclared.body.delta, undefined);
});

test("显式声明未脱敏时推理内容才进帧，且仍然过脱敏", () => {
  const frame = acpFrame(
    rawEnvelope("thinking", { text: `see ${SECRET}`, redacted: false }),
  );
  const content = frame.body.content as JsonObject | undefined;

  assert.notEqual(content, undefined);

  if (content === undefined) {
    return;
  }

  assert.equal(content.type, "text");
  assert.equal(content.text, "see [secret]");
});

test("payload 里的 redacted 标记本身不进帧（不把内部标记当协议字段）", () => {
  const frame = aguiFrame(rawEnvelope("thinking", { text: "visible", redacted: false }));
  const keys = Object.keys(frame.body);
  assert.equal(keys.includes("redacted"), false);
  assert.equal(keys.includes("declaredRedacted"), false);
});

test("来源坐标不是秘密通道：它只带 id 与序号，不带 payload", () => {
  const frame = acpFrame(rawEnvelope("text", { text: SECRET }));
  assert.equal(JSON.stringify(frame.source).includes(SECRET), false);
  assert.deepEqual(Object.keys(frame.source).sort(), ["eventId", "kind", "sequence"]);
});
