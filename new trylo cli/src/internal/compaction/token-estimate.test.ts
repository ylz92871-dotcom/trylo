import assert from "node:assert/strict";
import { test } from "node:test";
import type { ProviderMessage, ProviderToolSpec } from "../ports/provider.js";
import {
  CHARS_PER_TOKEN,
  boundTextTokens,
  boundMessagesTextTokens,
  boundToolSpecsTextTokens,
  estimateMessageTokens,
  estimateMessagesTokens,
  estimateToolSpecsTokens,
} from "./token-estimate.js";
import { compactionWiring, estimatePromptTokens } from "../surface/cli/compaction-wiring.js";

/**
 * WP09.1 / C35 — the final-request token basis.
 *
 * The shipped estimator divided `message.content` characters by four and
 * stopped there. A final provider request is more than that: assistant turns
 * carry `toolCalls` (whose JSON arguments can dwarf the text), and the wire
 * carries the tool table itself. This file pins that textual basis per message
 * with the same four-bytes-per-token heuristic. Visual context usage is unknown
 * locally; base64 transport size must not be mistaken for visual tokens.
 *
 * Written against the unfixed estimator first (red evidence, WP09 交接记录);
 * the first group asserts through the wiring's `estimatePromptTokens` (the
 * name the loop reads), this second group pins the canonical module directly —
 * `estimateToolSpecsTokens` in particular, which has no other test path.
 */

test("a plain text message estimates as content characters over four", () => {
  const messages: ProviderMessage[] = [{ role: "user", content: "a".repeat(40) }];
  assert.equal(estimatePromptTokens(messages), Math.ceil(40 / CHARS_PER_TOKEN));
  assert.equal(estimatePromptTokens([]), 0);
});

test("tool call arguments count toward the message that carries them", () => {
  const argumentsText = JSON.stringify({ text: "b".repeat(4_000) });
  const withCall: ProviderMessage[] = [
    { role: "assistant", content: "", toolCalls: [{ toolCallId: "c1", name: "echo", arguments: JSON.parse(argumentsText) }] },
  ];
  const bare: ProviderMessage[] = [{ role: "assistant", content: "" }];
  const delta = estimatePromptTokens(withCall) - estimatePromptTokens(bare);

  // The arguments are real request payload: their JSON serialization must show
  // up in the estimate, not vanish behind an empty `content` string.
  assert.ok(
    delta >= Math.floor(argumentsText.length / CHARS_PER_TOKEN),
    `expected tool-call JSON to add at least ${Math.floor(argumentsText.length / CHARS_PER_TOKEN)} tokens, added ${delta}`,
  );
});

test("image transport payload does not alter the wiring's text-only lower basis", () => {
  const dataBase64 = "i".repeat(8_000);
  const withImage: ProviderMessage[] = [
    {
      role: "user",
      content: "look",
      attachments: [{ mediaType: "image/png", dataBase64, bytes: 6_000, detail: "original" }],
    },
  ];
  const bare: ProviderMessage[] = [{ role: "user", content: "look" }];
  const delta = estimatePromptTokens(withImage) - estimatePromptTokens(bare);

  assert.equal(delta, 0);
  assert.equal(estimatePromptTokens(withImage), Math.ceil(Buffer.byteLength("look", "utf8") / CHARS_PER_TOKEN));
});

test("per-message text rounding preserves each message's contribution", () => {
  // ceil applied per message: ten 1-char messages cost ten tokens, not three.
  const messages: ProviderMessage[] = Array.from({ length: 10 }, () => ({
    role: "user" as const,
    content: "x",
  }));
  assert.equal(estimatePromptTokens(messages), 10);
});

// ---------------------------------------------------------------------------
// The canonical module, directly (no wiring detour).
// ---------------------------------------------------------------------------

test("estimateMessageTokens counts content and call JSON without guessing visual usage", () => {
  const arguments_ = { text: "e".repeat(40) };
  const message: ProviderMessage = {
    role: "assistant",
    content: "abcd",
    toolCalls: [{ toolCallId: "c1", name: "echo", arguments: arguments_ }],
    attachments: [{ mediaType: "image/png", dataBase64: "i".repeat(80), bytes: 60, detail: "original" }],
  };
  // The call's identifiers count beside its argument JSON (outboundCallBytes).
  const expected = Math.ceil(
    (4 + "c1".length + "echo".length + JSON.stringify(arguments_).length) / CHARS_PER_TOKEN,
  );

  assert.equal(estimateMessageTokens(message), expected);
});

test("an unserializable call argument still counts the id and name", () => {
  const circular: { self?: unknown } = {};

  circular.self = circular;
  const message: ProviderMessage = {
    role: "assistant",
    content: "",
    toolCalls: [{ toolCallId: "c1", name: "echo", arguments: circular as never }],
  };

  // Monotonicity floor: the estimate is positive and at least the identifiers.
  assert.ok(estimateMessageTokens(message) >= Math.ceil(("c1echo".length) / CHARS_PER_TOKEN));
});

test("estimateMessagesTokens is the per-message sum", () => {
  const messages: ProviderMessage[] = [
    { role: "user", content: "a".repeat(7) },
    { role: "assistant", content: "b".repeat(7) },
  ];
  assert.equal(estimateMessagesTokens(messages), estimateMessageTokens(messages[0]!) + estimateMessageTokens(messages[1]!));
});

test("estimateToolSpecsTokens prices the tool table beside the messages", () => {
  const specs: ReadonlyArray<ProviderToolSpec> = [
    { name: "echo", description: "d".repeat(400), parameters: { type: "object", properties: { text: { type: "string" } } } },
  ];
  const expected = Math.ceil(("echo".length + 400 + JSON.stringify(specs[0]?.parameters).length) / CHARS_PER_TOKEN);
  assert.equal(estimateToolSpecsTokens(specs), expected);
  assert.equal(estimateToolSpecsTokens([]), 0);
});

test("non-ASCII user text is estimated in UTF-8 bytes, including surrogate pairs", () => {
  const content = "中文🙂".repeat(1_000);
  assert.equal(estimateMessageTokens({ role: "user", content }), Math.ceil(Buffer.byteLength(content, "utf8") / 4));
});

test("non-ASCII tool arguments and schema descriptions use the same byte rule", () => {
  const arguments_ = { text: "工具结果".repeat(1_000) };
  const call = { toolCallId: "c", name: "echo", arguments: arguments_ };
  assert.equal(estimateMessageTokens({ role: "assistant", content: "", toolCalls: [call] }),
    Math.ceil(Buffer.byteLength("cecho" + JSON.stringify(arguments_), "utf8") / 4));
  const spec = { name: "echo", description: "中文说明", parameters: { description: "输入参数" } };
  assert.equal(estimateToolSpecsTokens([spec]), Math.ceil(Buffer.byteLength(spec.name + spec.description + JSON.stringify(spec.parameters), "utf8") / 4));
});

test("cold request admission bounds byte-fallback text without guessing its character density", () => {
  const wiring = compactionWiring({ nowMs: 0 });
  const rare = String.fromCodePoint(0xf0137).repeat(1000);

  for (const content of ["plain ASCII payload", "中文段落", rare, "ascii中文" + rare]) {
    const messages: ProviderMessage[] = [{ role: "user", content }];
    assert.equal(wiring.estimatePromptTokens(messages), Buffer.byteLength(content, "utf8"));
    assert.equal(boundMessagesTextTokens(messages), Buffer.byteLength(content, "utf8"));
    assert.equal(estimateMessagesTokens(messages), Math.ceil(Buffer.byteLength(content, "utf8") / CHARS_PER_TOKEN),
      "the display estimate remains a labeled heuristic, separate from admission");
  }
});

test("text admission bounds the same original tool-call JSON and function table", () => {
  const originalArguments = { text: String.fromCodePoint(0xf0137).repeat(50) };
  const messages: ProviderMessage[] = [{ role: "assistant", content: "", toolCalls: [{
    toolCallId: "call", name: "echo", arguments: { text: "normalized" }, originalArguments,
  }] }];
  const spec = { name: "echo", description: "中文说明", parameters: { description: "输入参数" } };

  assert.equal(boundMessagesTextTokens(messages), Buffer.byteLength("callecho" + JSON.stringify(originalArguments), "utf8"));
  assert.equal(boundToolSpecsTextTokens([spec]), Buffer.byteLength(spec.name + spec.description + JSON.stringify(spec.parameters), "utf8"));
});

test("the byte-level bound covers Unicode normalization expansion without rewriting text", () => {
  const text = "\u0344\ufdfa";
  const original = text;

  for (const form of ["NFC", "NFD", "NFKC", "NFKD"] as const) {
    assert.ok(boundTextTokens(text) >= Buffer.byteLength(text.normalize(form), "utf8"));
  }

  assert.equal(text, original);
  assert.ok(boundTextTokens(text) > Buffer.byteLength(text, "utf8"));
});
