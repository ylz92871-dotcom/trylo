import assert from "node:assert/strict";
import { test } from "node:test";
import { translateBody } from "./openai-stream.js";

test("an unstarted stream never acquires an HTTP reader", async () => {
  const body = new ReadableStream<Uint8Array>();
  const stream = translateBody(body, new AbortController().signal);
  assert.equal(body.locked, false);
  await stream.return(undefined);
  assert.equal(body.locked, false);
});

test("a short reasoning network chunk is delivered without waiting for 128 characters or EOF", async () => {
  let body!: ReadableStreamDefaultController<Uint8Array>;
  const source = new ReadableStream<Uint8Array>({
    start(controller) {
      body = controller;
    },
  });

  body.enqueue(
    new TextEncoder().encode(
      'data: {"choices":[{"delta":{"reasoning_content":"first"},"finish_reason":null}]}\n\n',
    ),
  );
  const stream = translateBody(source, new AbortController().signal);

  assert.equal((await stream.next()).value?.type, "reasoning_start");
  let delivered = false;
  const next = stream.next().then((value) => {
    delivered = true;
    return value;
  });

  try {
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(
      delivered,
      true,
      "short received reasoning must not stay in the coalescer",
    );
    assert.deepEqual((await next).value, {
      type: "reasoning_delta",
      blockId: "reasoning-0",
      text: "first",
      redacted: false,
    });
  } finally {
    body.close();
    await next;
    await stream.return(undefined);
  }
});

test("returning after a timed flush cancels the outstanding network read", async () => {
  let body!: ReadableStreamDefaultController<Uint8Array>;
  let cancelled = false;
  const source = new ReadableStream<Uint8Array>({
    start(controller) {
      body = controller;
    },
    cancel() {
      cancelled = true;
    },
  });
  const send = (text: string): void =>
    body.enqueue(
      new TextEncoder().encode(
        "data: " +
          JSON.stringify({
            choices: [{ delta: { content: text }, finish_reason: null }],
          }) +
          "\n\n",
      ),
    );
  const stream = translateBody(source, new AbortController().signal);

  send("first");
  await stream.next();
  await stream.next();
  send(" tail");
  const delta = (await stream.next()).value;

  assert.equal(delta?.type, "text_delta");

  if (delta?.type === "text_delta") assert.equal(delta.text, " tail");

  await stream.return(undefined);
  assert.equal(cancelled, true);
  assert.equal(source.locked, false);
});

test("later reasoning is flushed while the provider is paused below the character threshold", async () => {
  let body!: ReadableStreamDefaultController<Uint8Array>;
  const source = new ReadableStream<Uint8Array>({
    start(controller) {
      body = controller;
    },
  });
  const frame = (text: string): Uint8Array =>
    new TextEncoder().encode(
      "data: " +
        JSON.stringify({
          choices: [
            { delta: { reasoning_content: text }, finish_reason: null },
          ],
        }) +
        "\n\n",
    );

  body.enqueue(frame("first"));
  const stream = translateBody(source, new AbortController().signal);

  await stream.next();
  await stream.next();
  body.enqueue(frame(" second"));
  const next = stream.next();
  let timeout: ReturnType<typeof setTimeout> | undefined;

  try {
    const received = await Promise.race([
      next.then((result) => result.value),
      new Promise<undefined>((resolve) => {
        timeout = setTimeout(() => resolve(undefined), 250);
      }),
    ]);

    assert.equal(
      received?.type,
      "reasoning_delta",
      "received reasoning must flush without another upstream event or EOF",
    );

    if (received?.type === "reasoning_delta")
      assert.equal(received.text, " second");
  } finally {
    clearTimeout(timeout);
    body.close();
    await next;
    await stream.return(undefined);
  }
});
