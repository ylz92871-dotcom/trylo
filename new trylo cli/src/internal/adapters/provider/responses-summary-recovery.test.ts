import assert from "node:assert/strict";
import test from "node:test";
import { createResponsesTranslator } from "./responses-translate.js";
import type { ProviderEvent } from "../../ports/provider.js";

function text(events: readonly ProviderEvent[]): string {
  return events.filter(event => event.type === "reasoning_delta").map(event => event.text).join("");
}

for (const family of ["text.done", "part.done", "item.done", "completed"] as const) {
  test(`public summary survives a ${family} snapshot without delta frames`, () => {
    const t = createResponsesTranslator();
    const part = { type: "summary_text", text: "先检查文件。" };
    const item = { type: "reasoning", id: "rs-1", summary: [part] };
    const events = family === "text.done" ? t.push("response.reasoning_summary_text.done", { output_index: 0, summary_index: 0, text: part.text })
      : family === "part.done" ? t.push("response.reasoning_summary_part.done", { output_index: 0, summary_index: 0, part })
        : family === "item.done" ? t.push("response.output_item.done", { output_index: 0, item })
          : t.push("response.completed", { response: { status: "completed", output: [item] } });

    assert.equal(text(events), part.text);
    assert.equal(events.filter(event => event.type === "reasoning_start").length, 1);
  });
}

test("summary snapshots append only an undelivered suffix and never replay a sealed item", () => {
  const t = createResponsesTranslator();
  const events = t.push("response.reasoning_summary_text.delta", { output_index: 0, summary_index: 0, delta: "先检查" });

  events.push(...t.push("response.reasoning_summary_text.done", { output_index: 0, summary_index: 0, text: "先检查文件。" }));
  events.push(...t.push("response.reasoning_summary_part.done", { output_index: 0, summary_index: 0, part: { type: "summary_text", text: "先检查文件。" } }));
  const done = { output_index: 0, item: { type: "reasoning", summary: [{ type: "summary_text", text: "先检查文件。" }] } };

  events.push(...t.push("response.output_item.done", done));
  events.push(...t.push("response.output_item.done", done));
  events.push(...t.push("response.completed", { response: { status: "completed", output: [done.item] } }));
  assert.equal(text(events), "先检查文件。");
  assert.equal(events.filter(event => event.type === "reasoning_end").length, 1);
});

test("separate summary parts remain readable without exposing encrypted or raw reasoning", () => {
  const t = createResponsesTranslator();
  const events = t.push("response.output_item.done", { output_index: 0, item: { type: "reasoning", encrypted_content: "PRIVATE",
    content: [{ type: "reasoning_text", text: "PRIVATE" }], summary: [
      { type: "summary_text", text: "检查输入。" }, { type: "summary_text", text: "核验结果。" },
    ] } });

  assert.equal(text(events), "检查输入。\n\n核验结果。");
  assert.equal(JSON.stringify(events).includes("PRIVATE"), false);
});
