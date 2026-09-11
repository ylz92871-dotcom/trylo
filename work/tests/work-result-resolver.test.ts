// Trylo Work — WorkResultResolver tests.
//
// 2026-08-29 (Work end-to-end workflow redesign spec §10.2,
// §10.3): the final-answer resolver must never fall back to
// the forbidden "任务已完成，未返回文本结论" placeholder and
// must never fabricate facts.

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import type { ConversationItem } from "../src/event-presenter.js";
import { type WorkRunIdentity, type WorkTurnProjection } from "../src/work-domain.js";
import {
  buildDeterministicFallback,
  isTrivialFinalText,
  isMissingFinalAnswer,
  resolveFinalAnswerText,
} from "../src/work-result-resolver.js";

describe("result protocol-noise rejection", () => {
  it("rejects an unexecuted tool-call envelope as a final answer", () => {
    assert.equal(
      isTrivialFinalText('<seed:tool_call><function name="files_list">{}</function>'),
      true,
    );
  });
});
import {
  createWorkTurnProjection,
  reduceWorkItem,
  reduceTaskStatus,
} from "../src/work-workflow-reducer.js";

function identity(over: Partial<WorkRunIdentity> = {}): WorkRunIdentity {
  return { taskId: "t1", runId: "r1", turnId: "u1", conversationId: "c1", intent: "task", ...over };
}

let seq = 0;
const next = () => ++seq;

function finalItem(text: string): ConversationItem {
  return {
    kind: "final",
    id: `final:r1`,
    at: 1,
    conversationId: "c1",
    text,
    taskId: "t1",
    runId: "r1",
    turnId: "u1",
  } as ConversationItem;
}

function artifactItem(p: string): ConversationItem {
  return {
    kind: "artifact",
    id: `artifact:r1:${p}`,
    at: 2,
    conversationId: "c1",
    filePath: p,
    taskId: "t1",
    runId: "r1",
    turnId: "u1",
  } as ConversationItem;
}

function toolItem(status: "running" | "done"): ConversationItem {
  const step = `st${next()}`;
  return {
    kind: "tool",
    id: `tool:r1:${step}`,
    at: 1,
    conversationId: "c1",
    tool: "read",
    summary: "读取 a.ts",
    status,
    toolCallId: step,
    taskId: "t1",
    runId: "r1",
    turnId: "u1",
  } as ConversationItem;
}

describe("resolveFinalAnswerText priority (spec §10.2)", () => {
  it("prefers a real final item over facts", () => {
    let p = createWorkTurnProjection(identity());
    p = reduceWorkItem(p, toolItem("done"));
    p = reduceWorkItem(p, finalItem("报告已生成，包含 3 个指标。"));
    p = reduceTaskStatus(p, "completed");
    const text = resolveFinalAnswerText(p);
    assert.equal(text, "报告已生成，包含 3 个指标。");
    assert.equal(isMissingFinalAnswer(p), false);
  });

  it("builds a deterministic summary when no assistant final exists", () => {
    const p = finalizedProjectionWithArtifact();
    const text = resolveFinalAnswerText(p);
    assert.ok(text.includes("report.md"), `expected artifact mention in "${text}"`);
    assert.ok(!text.includes("未返回文本结论"), "forbidden placeholder must never appear");
    assert.ok(!text.includes("通过"), "no verification was observed → must not claim 通过");
  });
});

describe("buildDeterministicFallback (spec §10.3)", () => {
  it("does not fabricate verification when none was observed", () => {
    let p = createWorkTurnProjection(identity());
    p = reduceWorkItem(p, toolItem("done"));
    p = reduceWorkItem(p, toolItem("done"));
    const text = buildDeterministicFallback(p);
    assert.ok(text.includes("读取 2 个文件"));
    assert.ok(text.includes("未观察到独立验证步骤"));
  });
});

describe("isMissingFinalAnswer (diagnostics code, spec §10.3)", () => {
  it("is true when nothing left a meaningful conclusion", () => {
    let p = createWorkTurnProjection(identity());
    p = reduceTaskStatus(p, "completed");
    assert.equal(isMissingFinalAnswer(p), true);
  });
});

function finalizedProjectionWithArtifact(): WorkTurnProjection {
  let p = createWorkTurnProjection(identity());
  p = reduceWorkItem(p, toolItem("done"));
  p = reduceWorkItem(p, artifactItem("D:/repo/.trylo/out/report.md"));
  return p;
}
