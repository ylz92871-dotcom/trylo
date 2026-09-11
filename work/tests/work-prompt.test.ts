import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  buildWorkChatMessage,
  buildWorkspaceTaskPrompt,
  buildWorkTaskFollowUp,
  formatWorkMessage,
  looksLikeTaskIntent,
  type WorkAttachmentDescriptor,
} from "../src/work-prompt.js";

describe("buildWorkspaceTaskPrompt: capability-neutral contract", () => {
  const prompt = buildWorkspaceTaskPrompt("D:/repo", "Summarize Q3 revenue");

  it("embeds the workspace root and user request", () => {
    assert.match(prompt, /D:[\\/]repo/);
    assert.ok(prompt.includes("Summarize Q3 revenue"));
  });

  it("never forces a document type", () => {
    assert.doesNotMatch(prompt, /Generate a document/i);
    assert.doesNotMatch(prompt, /\b(docx|xlsx|pptx)\b/i);
  });

  it("keeps file output conditional and allows pure-answer tasks", () => {
    assert.match(prompt, /if the task requires/i);
    assert.match(prompt, /otherwise\s+just answer in the conversation/i);
  });

  it("normalizes trailing slashes on the root", () => {
    assert.match(buildWorkspaceTaskPrompt("D:/repo\\", "x"), /D:[\\/]repo/);
  });

  it("carries the path-hygiene rule on first and follow-up turns", () => {
    assert.match(prompt, /NEVER prepend the root/i);
    assert.match(buildWorkTaskFollowUp({ userText: "continue" }), /NEVER prepend the root/i);
  });
});

describe("buildWorkChatMessage: conversation wrapper", () => {
  it("marks conversation intent and forbids tools or writes", () => {
    const out = buildWorkChatMessage({ userText: "你好" });
    assert.match(out, /<trylo_conversation>/);
    assert.match(out, /CONVERSATION message, not a work order/);
    assert.match(out, /Do not use any tools\./i);
    assert.match(out, /Do not read workspace files/i);
    assert.match(out, /Do not create any files/i);
    assert.ok(out.includes("你好"));
  });

  it("permits reading staged attachments only when attachments exist", () => {
    const descriptor: WorkAttachmentDescriptor = {
      id: "attachment_m1_abc123",
      name: "需求.docx",
      relativePath: ".trylo/attachments/conv-a/attachment_m1_abc123/需求.docx",
      mediaType: "application/msword",
      size: 10,
    };
    assert.doesNotMatch(buildWorkChatMessage({ userText: "hi" }), /The ONLY exception/);
    const withFile = buildWorkChatMessage({ userText: "这个文件写的什么", attachments: [descriptor] });
    assert.match(withFile, /The ONLY exception: you MAY read/);
    assert.match(withFile, /Do not create any files/i);
  });
});

describe("buildWorkTaskFollowUp: explicit task follow-up wrapper", () => {
  it("marks the message as a work order", () => {
    const out = buildWorkTaskFollowUp({ userText: "把教案整理成表格" });
    assert.match(out, /<trylo_task>/);
    assert.match(out, /WORK ORDER for the current task/);
    assert.ok(out.includes("把教案整理成表格"));
  });
});

describe("looksLikeTaskIntent: renderer-side suggestion heuristic", () => {
  it("never matches greetings or plain chat", () => {
    assert.equal(looksLikeTaskIntent("你好"), false);
    assert.equal(looksLikeTaskIntent("在吗"), false);
    assert.equal(looksLikeTaskIntent("hi"), false);
    assert.equal(looksLikeTaskIntent("这个好用吗"), false);
  });

  it("matches clear work orders in Chinese and English", () => {
    assert.equal(looksLikeTaskIntent("帮我把这个学期的教案整理成表格"), true);
    assert.equal(looksLikeTaskIntent("生成一份实验课备课材料清单"), true);
    assert.equal(
      looksLikeTaskIntent("你帮我读一下变色小魔术最新的那个PPT，然后出一个教案给我就行"),
      true,
    );
    assert.equal(looksLikeTaskIntent("please generate a summary report"), true);
  });

  it("rejects over-long or over-short input", () => {
    assert.equal(looksLikeTaskIntent("做"), false);
    assert.equal(looksLikeTaskIntent(`${"很".repeat(600)}帮我整理`), false);
  });
});

describe("Trylo Work prompt identity", () => {
  it("brands conversation, first task and follow-up task prompts as Trylo Work", () => {
    const prompts = [
      buildWorkChatMessage({ userText: "你好" }),
      buildWorkspaceTaskPrompt("D:/workspace", "制作报告"),
      buildWorkTaskFollowUp({ userText: "继续" }),
    ];

    for (const prompt of prompts) {
      assert.match(prompt, /You are Trylo Work/);
      assert.match(prompt, /Identify yourself only as Trylo Work or Trylo/);
    }
  });

  it("requires file tasks to surface each delivered path in the final answer", () => {
    const prompts = [
      buildWorkspaceTaskPrompt("D:/workspace", "制作报告"),
      buildWorkTaskFollowUp({ userText: "继续" }),
    ];
    for (const prompt of prompts) {
      assert.match(prompt, /final answer MUST name every delivered file/);
      assert.match(prompt, /exact workspace-relative path under \.trylo\/out\//);
    }
  });
});

describe("formatWorkMessage: shared attachment projection", () => {
  const descriptor: WorkAttachmentDescriptor = {
    id: "attachment_m1_abc123",
    name: "需求.docx",
    relativePath: ".trylo/attachments/work-conv1/attachment_m1_abc123/需求.docx",
    mediaType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    size: 128430,
  };

  it("returns userText verbatim when there are no attachments", () => {
    assert.equal(formatWorkMessage({ userText: "hello" }), "hello");
    assert.equal(formatWorkMessage({ userText: "hello", attachments: [] }), "hello");
  });

  it("emits a stable attachment block with every descriptor field", () => {
    const out = formatWorkMessage({ userText: "summarize", attachments: [descriptor] });
    assert.ok(out.startsWith("summarize\n\n<trylo_attachments>\n"));
    assert.ok(out.endsWith("\n</trylo_attachments>"));
    assert.match(out, /- id: attachment_m1_abc123/);
    assert.match(out, /  name: 需求\.docx/);
    assert.match(out, /  path: \.trylo\/attachments\/work-conv1\/attachment_m1_abc123\/需求\.docx/);
    assert.match(out, /  media_type: application\/vnd\.openxmlformats-officedocument\.wordprocessingml\.document/);
    assert.match(out, /  size: 128430/);
  });

  it("keeps user text separate and preserves descriptor order", () => {
    const second: WorkAttachmentDescriptor = {
      id: "attachment_m2_def456",
      name: "data.xlsx",
      relativePath: ".trylo/attachments/work-conv1/attachment_m2_def456/data.xlsx",
      mediaType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      size: 42,
    };
    const out = formatWorkMessage({ userText: "user intent", attachments: [descriptor, second] });
    assert.equal(out.split("\n\n")[0], "user intent");
    assert.ok(out.indexOf(descriptor.id) < out.indexOf(second.id));
  });
});

describe("initial task and follow-up share the same formatter", () => {
  const descriptor: WorkAttachmentDescriptor = {
    id: "attachment_m1_abc123",
    name: "report.pdf",
    relativePath: ".trylo/attachments/conv-a/attachment_m1_abc123/report.pdf",
    mediaType: "application/pdf",
    size: 999,
  };

  it("embeds the identical staged attachment block", () => {
    const prompt = buildWorkspaceTaskPrompt("D:/repo", "analyze", [descriptor]);
    const formatted = formatWorkMessage({ userText: "analyze", attachments: [descriptor] });
    const block = formatted.slice(formatted.indexOf("<trylo_attachments>"));
    assert.ok(prompt.includes(block));
  });

  it("never carries an absolute external path and stays capability-neutral", () => {
    const prompt = buildWorkspaceTaskPrompt("D:/repo", "analyze", [descriptor]);
    assert.doesNotMatch(prompt, /[A-Za-z]:[\\/]Users/);
    assert.ok(prompt.includes(descriptor.relativePath));
    assert.doesNotMatch(prompt, /Generate a document/i);
  });
});
