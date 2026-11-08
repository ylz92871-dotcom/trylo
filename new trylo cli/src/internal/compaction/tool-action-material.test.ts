import assert from "node:assert/strict";
import { test } from "node:test";
import type { JsonObject } from "../protocol/envelope.js";
import type { TranscriptItem } from "../protocol/transcript.js";
import { createModelSummarizer } from "../surface/cli/compact-model-summarizer.js";
import { summarizeTranscript, transcriptLines, validateSummary } from "./summary.js";

function action(name: string, args: JsonObject): TranscriptItem[] {
  return [
    { kind: "user", sequence: 0, text: "Continue from the recorded action and its actual result." },
    { kind: "tool_call", sequence: 1, toolCallId: "action-1", name, arguments: args },
    { kind: "tool_result", sequence: 2, toolCallId: "action-1", name, output: "", outcome: "succeeded", truncated: false },
  ];
}

async function modelMaterial(items: TranscriptItem[]): Promise<string> {
  let material = "";
  const summarize = createModelSummarizer({ model: "local-only", provider: { async *stream(request) {
    material = request.messages.map(message => message.content).join("\n");
    assert.deepEqual(request.tools, []);
    yield { type: "text_delta", blockId: "summary", text: "The recorded action completed with no stdout." };
    yield { type: "finish", reason: "stop", rawReason: "stop", requiresFollowUp: false };
  } } });

  await summarize(items);

  return material;
}

test("model-summary material retains the executed shell variant and relative cwd when stdout is empty", async () => {
  const items = action("run_shell", { command: "node scripts/check.mjs --variant amber-729",
    argv: ["node", "scripts/check.mjs", "--variant", "amber-729"], cwd: "packages/worker" });
  const material = await modelMaterial(items);
  for (const fact of ["run_shell", "action-1", "node scripts/check.mjs", "--variant", "amber-729", "packages/worker"])
    assert.ok(material.includes(fact), `the model author must receive the public action fact ${fact}`);
});

test("model-summary material keeps a write's action, source and complete public content", async () => {
  const content = "public prefix\n".repeat(600) + "UNIQUE_PUBLIC_BODY_IN_MIDDLE" + "\npublic suffix".repeat(600);
  const items = action("write_file", { content, action: "replace", path: "notes/current.txt" });
  const material = await modelMaterial(items);

  assert.ok(material.includes("UNIQUE_PUBLIC_BODY_IN_MIDDLE"));
  assert.ok(material.includes("notes/current.txt"));
  assert.ok(material.includes("replace"));
  assert.ok(material.includes(JSON.stringify(content)), "public content is not fitted to the extractive line allowance");
});

test("extractive action evidence remains bounded while showing action and relative source before a large body", () => {
  const items = action("write_file", { content: "public body ".repeat(1_000), action: "replace", path: "notes/current.txt" });
  const summary = summarizeTranscript(items);

  assert.ok(summary.includes("tool_call write_file action-1"));
  assert.ok(summary.includes("notes/current.txt"));
  assert.ok(summary.includes("replace"));
  assert.ok(summary.includes("..."));
  assert.ok(summary.length <= 4_000);
  assert.equal(validateSummary(summary).ok, true);
});

test("public action material excludes structured credentials, environment and hidden reasoning", async () => {
  const items = action("run_shell", {
    command: "node worker.mjs --variant public-copper", cwd: "packages/worker",
    env: { RELEASE_KEY: "private-env-value" }, headers: { Authorization: "private-header-value" },
    credentials: { user: "private-credential-user" }, password: "private-password-value",
    token: "private-token-value", cookie: "private-cookie-value", api_key: "private-api-value",
    nested: { auth: { bearer: "private-nested-auth" } }, note: "password=private-string-value",
  });

  items.push({ kind: "assistant_reasoning", sequence: 3, blockId: "private", text: "PRIVATE_HIDDEN_REASONING", redacted: false });

  for (const material of [transcriptLines(items).join("\n"), await modelMaterial(items), summarizeTranscript(items)]) {
    assert.ok(material.includes("public-copper"));
    assert.doesNotMatch(material, /private-(?:env|header|credential|password|token|cookie|api|nested|string)-/);
    assert.doesNotMatch(material, /PRIVATE_HIDDEN_REASONING|assistant_reasoning/);
  }

  assert.equal(validateSummary(summarizeTranscript(items)).ok, true);
  assert.equal(validateSummary("password=private-unapproved-value").ok, false);
});

test("public argument fields containing ordinary token and author words are retained without mutation", () => {
  const args: JsonObject = { author: "Ada", tokenBudget: 3_000, token_count: 42, tokenizer: "public-basic",
    nested: { action: "public-renew", enabled: true, value: null } };
  const before = JSON.stringify(args);
  const material = transcriptLines(action("public_action", args)).join("\n");

  for (const fact of ["Ada", "tokenBudget", "3000", "token_count", "42", "public-basic", "public-renew"])
    assert.ok(material.includes(fact), `ordinary public argument ${fact} must remain available`);

  assert.equal(JSON.stringify(args), before);
});

test("structured argv credential values are redacted without dropping ordinary public options", () => {
  const items = action("run_shell", { argv: ["node", "worker.mjs", "--variant", "public-onyx",
    "--api-key", "private-argv-key", "--token", "private-argv-token"], cwd: "packages/worker" });
  for (const material of [transcriptLines(items).join("\n"), summarizeTranscript(items)]) {
    assert.ok(material.includes("public-onyx"));
    assert.doesNotMatch(material, /private-argv-/);
  }
});
