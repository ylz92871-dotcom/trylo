import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

function frame(event: string, payload: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`;
}

test("the real CLI opts into Responses summaries only for declared reasoning", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "trylo-summary-process-"));
  const profile = join(root, "profile");
  const workspace = join(root, "workspace");

  mkdirSync(profile);
  mkdirSync(workspace);
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const bodies: Record<string, unknown>[] = [];
  let summaryDelivery = "delta";
  const server = createServer((request, response) => {
    let raw = "";

    request.on("data", chunk => { raw += String(chunk); });
    request.on("end", () => {
      const body = JSON.parse(raw) as Record<string, unknown>;

      bodies.push(body);
      const summaryText = "Inspect the public fixture.";
      const summaryItem = { type: "reasoning", id: "rs-1", summary: [{ type: "summary_text", text: summaryText }] };
      const summaryFrames = summaryDelivery === "delta"
        ? frame("response.reasoning_summary_text.delta", { output_index: 0, delta: summaryText })
        : summaryDelivery === "text.done" ? frame("response.reasoning_summary_text.done", { output_index: 0, summary_index: 0, text: summaryText })
          : summaryDelivery === "part.done" ? frame("response.reasoning_summary_part.done", { output_index: 0, summary_index: 0, part: summaryItem.summary[0] }) : "";

      response.writeHead(200, { "Content-Type": "text/event-stream" });
      response.end(
        (body["reasoning"] === undefined ? "" :
          summaryFrames + frame("response.output_item.done", { output_index: 0,
            item: summaryDelivery === "item.done" ? summaryItem : { type: "reasoning", id: "rs-1" } })) +
        frame("response.output_text.delta", { output_index: 1, delta: "Done." }) +
        frame("response.output_item.done", { output_index: 1, item: { type: "message", id: "msg-1" } }) +
        frame("response.completed", { response: { status: "completed" } }),
      );
    });
  });

  t.after(() => server.close());
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();

  assert.ok(address !== null && typeof address !== "string");
  const cli = fileURLToPath(new URL("./main.js", import.meta.url));

  for (const [declaredReasoning, delivery] of [[true, "delta"], [true, "text.done"], [true, "part.done"], [true, "item.done"], [false, "delta"]] as const) {
    summaryDelivery = delivery;
    writeFileSync(join(profile, "providers.json"), JSON.stringify({
      version: 1,
      selected: "lab",
      providers: [{ id: "lab", kind: "openai-responses", endpoint: `http://127.0.0.1:${address.port}/v1/responses`, model: "m", reasoning: declaredReasoning }],
    }));
    const child = spawn(process.execPath, [cli, "run", "--workspace", workspace, "--format", "stream-json", "hello"], {
      env: { ...process.env, TRYLO_HOME: profile, TRYLO_API_KEY: "public-test-key", TRYLO_OPENAI_API_KEY: "public-test-key" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";

    child.stdout.setEncoding("utf8");
    child.stdout.on("data", chunk => { output += chunk; });
    child.stderr.resume();
    const timer = setTimeout(() => child.kill(), 60_000);
    const code = await new Promise<number | null>((resolve, reject) => {
      child.on("error", reject);
      child.on("close", resolve);
    }).finally(() => clearTimeout(timer));

    assert.equal(code, 0);
    const events = output.trim().split("\n").map(line => JSON.parse(line) as Record<string, unknown>);

    assert.equal(events.filter(event => event["type"] === "run_result").length, 1);

    if (declaredReasoning) {
      assert.deepEqual(bodies.at(-1)?.["reasoning"], { summary: "auto" });
      assert.equal(events.filter(event => event["type"] === "reasoning_delta").map(event => event["text"]).join(""), "Inspect the public fixture.");
      const end = events.findIndex(event => event["type"] === "reasoning_end");
      const text = events.findIndex(event => event["type"] === "message_start");
      assert.ok(end >= 0 && end < text);
    } else {
      assert.equal(Object.hasOwn(bodies.at(-1) ?? {}, "reasoning"), false);
      assert.equal(events.some(event => event["type"] === "reasoning_delta"), false);
    }
  }
});
