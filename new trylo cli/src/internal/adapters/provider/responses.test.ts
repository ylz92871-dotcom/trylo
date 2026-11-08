import assert from "node:assert/strict";
import { createServer, type Server, type ServerResponse } from "node:http";
import test from "node:test";
import { buildResponsesBody, createResponsesProvider } from "./responses.js";
import type { ProviderEvent } from "../../ports/provider.js";

/**
 * WP18.2 (C68/C71) evidence: the Responses adapter against a real local HTTP
 * endpoint — body shape, retry boundary, auth refusal. The red half was the
 * missing adapter (no `/responses` request could be built at all).
 */

function frame(event: string, payload: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`;
}

function startEndpoint(respond: (hit: number, res: ServerResponse, body: string) => void): {
  readonly server: Server;
  readonly url: Promise<string>;
  readonly bodies: string[];
} {
  const bodies: string[] = [];
  let hits = 0;
  const server = createServer((request, response) => {
    let body = "";

    request.on("data", (chunk) => {
      body += String(chunk);
    });
    request.on("end", () => {
      hits += 1;
      bodies.push(body);
      respond(hits, response, body);
    });
  });
  const url = new Promise<string>((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      assert.ok(address !== null && typeof address !== "string");
      resolve(`http://127.0.0.1:${address.port}/v1/responses`);
    });
  });

  return { server, url, bodies };
}

function sseTextThenComplete(text: string): (res: ServerResponse) => void {
  return (res) => {
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    res.end(
      frame("response.output_text.delta", { output_index: 0, delta: text }) +
        frame("response.completed", {
          response: {
            status: "completed",
            usage: { input_tokens: 10, output_tokens: 2, total_tokens: 12 },
          },
        }) +
        "data: [DONE]\n\n",
    );
  };
}

async function collect(port: ReturnType<typeof createResponsesProvider>): Promise<ProviderEvent[]> {
  const events: ProviderEvent[] = [];
  const request = { attemptId: "att-1", model: "lab-7b", messages: [{ role: "user" as const, content: "hi" }], tools: [] };
  for await (const event of port.stream(request, new AbortController().signal)) {
    events.push(event);
  }
  return events;
}

test("a Responses endpoint streams text, usage and finish with the schema sent", async (t) => {
  const endpoint = startEndpoint((hit, res) => {
    assert.equal(hit, 1);
    sseTextThenComplete("hello")(res);
  });

  t.after(() => endpoint.server.close());
  const url = await endpoint.url;
  const port = createResponsesProvider({
    endpoint: url,
    model: "lab-7b",
    apiKey: "unit-key",
    sleep: async () => {},
  });
  const events = await collect(port);

  assert.equal(events[0]?.type, "stream_start");
  const sent = JSON.parse(endpoint.bodies[0] ?? "{}") as Record<string, unknown>;

  assert.equal(sent["model"], "lab-7b");
  assert.equal(sent["stream"], true);
  assert.ok(Array.isArray(sent["input"]));
  const finish = events.find((event) => event.type === "finish");

  assert.ok(finish !== undefined && finish.type === "finish" && finish.reason === "stop");
});

test("declared reasoning summaries are requested and survive the HTTP stream", async (t) => {
  const endpoint = startEndpoint((_hit, res, raw) => {
    const sent = JSON.parse(raw) as Record<string, unknown>;
    const reasoning = sent["reasoning"];

    res.writeHead(200, { "Content-Type": "text/event-stream" });
    res.end(
      (reasoning !== undefined
        ? frame("response.reasoning_summary_text.delta", { output_index: 0, delta: "Inspect the target file." }) +
          frame("response.output_item.done", { output_index: 0, item: { type: "reasoning", id: "rs-1" } })
        : "") +
      frame("response.output_text.delta", { output_index: 1, delta: "Done." }) +
      frame("response.completed", { response: { status: "completed" } }),
    );
  });

  t.after(() => endpoint.server.close());
  const config = {
    endpoint: await endpoint.url,
    model: "reasoning-model",
    apiKey: "unit-key",
    reasoningSummary: "auto" as const,
  };
  const events = await collect(createResponsesProvider(config));
  const sent = JSON.parse(endpoint.bodies[0] ?? "{}") as Record<string, unknown>;

  assert.deepEqual(sent["reasoning"], { summary: "auto" });
  assert.ok(events.some((event) => event.type === "reasoning_delta" && event.text === "Inspect the target file."));
  assert.ok(events.findIndex((event) => event.type === "reasoning_end") < events.findIndex((event) => event.type === "text_start"));
});

test("an undeclared Responses endpoint receives no reasoning options", () => {
  const body = buildResponsesBody(
    { endpoint: "https://x/v1/responses", model: "plain-model" },
    { attemptId: "a", model: "plain-model", messages: [], tools: [] },
  ) as Record<string, unknown>;
  assert.equal(Object.hasOwn(body, "reasoning"), false);
});

test("a 429 retries before headers and sends the structured format once", async (t) => {
  let hits = 0;
  const endpoint = startEndpoint((hit, res) => {
    hits = hit;

    if (hit === 1) {
      res.writeHead(429, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "busy" }));
      return;
    }

    sseTextThenComplete("recovered")(res);
  });

  t.after(() => endpoint.server.close());
  const url = await endpoint.url;
  const schema = { type: "object", properties: { a: { type: "string" } } };
  const port = createResponsesProvider({ endpoint: url, model: "m", apiKey: "k", sleep: async () => {} });
  const events: ProviderEvent[] = [];
  const request = {
    attemptId: "a",
    model: "m",
    messages: [],
    tools: [],
    responseSchema: schema,
  };

  for await (const event of port.stream(request, new AbortController().signal)) {
    events.push(event);
  }

  assert.equal(hits, 2);
  const sent = JSON.parse(endpoint.bodies[1] ?? "{}") as Record<string, unknown>;
  const text = sent["text"] as Record<string, unknown>;
  const format = (text["format"] ?? {}) as Record<string, unknown>;

  assert.equal(format["type"], "json_schema");
  assert.ok(events.some((event) => event.type === "finish"));
});

test("a 401 without a token manager is an auth refusal, not a retry", async (t) => {
  const endpoint = startEndpoint((_hit, res) => {
    res.writeHead(401, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "nope" }));
  });

  t.after(() => endpoint.server.close());
  const url = await endpoint.url;
  const port = createResponsesProvider({ endpoint: url, model: "m", apiKey: "k", sleep: async () => {} });
  const events = await collect(port);

  assert.equal(events.length, 1);
  assert.deepEqual(events[0], {
    type: "error",
    class: "auth",
    retryable: false,
    phase: "before_headers",
    message: "http_401",
  });
});

test("tool output and assistant calls map to Responses input items", () => {
  const body = buildResponsesBody(
    { endpoint: "https://x/v1/responses", model: "default" },
    {
      attemptId: "a",
      model: "",
      messages: [
        { role: "user", content: "go" },
        {
          role: "assistant",
          content: "",
          toolCalls: [{ toolCallId: "fc-1", name: "read_file", arguments: { path: "x" } }],
        },
        { role: "tool", content: "contents", toolCallId: "fc-1" },
      ],
      tools: [],
    },
  ) as Record<string, unknown>;
  const input = body["input"] as ReadonlyArray<Record<string, unknown>>;

  assert.deepEqual(input[1], {
    type: "function_call",
    call_id: "fc-1",
    name: "read_file",
    arguments: JSON.stringify({ path: "x" }),
  });
  assert.deepEqual(input[2], { type: "function_call_output", call_id: "fc-1", output: "contents" });
});
