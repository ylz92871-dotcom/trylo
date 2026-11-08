import assert from "node:assert/strict";
import test from "node:test";
import type { ProviderEvent } from "../../ports/provider.js";
import { translateBody } from "./openai-stream.js";

const frame = (value: unknown): string => `data: ${JSON.stringify(value)}\n\n`;
const answer = frame({ choices: [{ delta: { content: "answer" }, finish_reason: "stop" }] });
const usage = frame({ choices: [], usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 } });
const done = "data: [DONE]\n\n";

function body(text: string, end: "eof" | "error" | "open" = "eof"): ReadableStream<Uint8Array> {
  let sent = false;
  return new ReadableStream({ pull(controller) {
    if (!sent) {
      sent = true;
      controller.enqueue(new TextEncoder().encode(text));
    }
    else if (end === "eof") controller.close();
    else if (end === "error") controller.error(new Error("unit transport interrupted"));
  } });
}

async function collect(text: string, observeReturn?: true, end: "eof" | "error" | "open" = "eof", signal = new AbortController().signal) {
  const events: ProviderEvent[] = [];
  for await (const event of translateBody(body(text, end), signal, observeReturn)) events.push(event);
  return events;
}

const returned = (events: readonly ProviderEvent[]) => events.find(event => event.type === "finish")?.returnObservation;

test("opted-in OpenAI clean DONE or EOF reports actual usage without changing ordinary events", async () => {
  for (const suffix of [done, ""]) {
    const observed = await collect(answer + usage + suffix, true);
    assert.deepEqual(returned(observed), { schemaVersion: 1, reportedTotalTokens: 5 });
    const ordinary = await collect(answer + usage + suffix);
    assert.equal(returned(ordinary), undefined);
    assert.deepEqual(observed.map(event => event.type === "finish" ? { ...event, returnObservation: undefined } : event),
      ordinary.map(event => event.type === "finish" ? { ...event, returnObservation: undefined } : event));
  }
});

test("accounting gaps, invalid tools, missing usage and non-successful finishes cannot witness recovery", async () => {
  const invalidTool = frame({ choices: [{ delta: { tool_calls: [{ index: 0, id: "bad", function: { name: "read", arguments: "{" } }] }, finish_reason: "tool_calls" }] });
  for (const text of [answer + done, answer + frame({ usage: {} }) + done,
    "data: malformed\n\n" + answer + usage + done, answer + "data: malformed\n\n" + usage + done,
    frame("unrecognized") + answer + usage + done, answer + frame({ choices: [42] }) + usage + done, invalidTool + usage + done,
    frame({ choices: [{ delta: { content: "cut" }, finish_reason: "length" }] }) + usage + done,
    answer + usage + "data: unfinished"]) {
    assert.equal(returned(await collect(text, true)), undefined);
  }
});

test("catch-held finish, abort and existing finish-tail timeout never carry clean-return evidence", async () => {
  const interrupted = await collect(answer + usage, true, "error");

  assert.equal(interrupted.some(event => event.type === "error"), true);
  assert.equal(returned(interrupted), undefined, "normal PA may stop at this held finish before seeing its following error");
  const cancel = new AbortController();

  cancel.abort();
  assert.equal(returned(await collect(answer + usage + done, true, "eof", cancel.signal)), undefined);
  const timedOut = await collect(answer + usage, true, "open");

  assert.equal(timedOut.some(event => event.type === "warning" && event.code === "stream_finish_tail_timeout"), true);
  assert.equal(returned(timedOut), undefined);
});
