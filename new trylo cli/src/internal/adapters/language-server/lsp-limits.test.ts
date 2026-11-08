import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { PassThrough, Readable } from "node:stream";
import {
  createBoundedStdout,
  createIdleWatch,
  isLimitError,
  limitError,
  outboundByteLength,
  truncateAnswer,
  withQueryLimits,
} from "./lsp-limits.js";
import type { LspAnswer, LanguageServerPort, LspQueryResult } from "../../ports/language-server.js";
import { DEFAULT_LSP_LIMITS } from "../../ports/language-server.js";

function locations(count: number) {
  return Array.from({ length: count }, (_, index) => ({
    path: `src/f${index}.ts`,
    line: index,
    character: 0,
  }));
}

/**
 * The three limits WP12 declared but never enforced: how many locations one
 * answer may keep, how many bytes one message may carry, and how long an
 * unused connection may live. Each test below fails against the pre-fix code
 * for a different reason — the truncation was hardcoded `false`, the byte cap
 * was a comment, and idle connections lived until the process did.
 */
describe("truncateAnswer", () => {
  it("keeps the first locations and says so", () => {
    const answer: LspAnswer = { status: "answered", locations: locations(10) };
    const result = truncateAnswer(answer, 4);

    assert.equal(result.truncated, true);
    assert.equal(result.answer.status, "answered");

    if (result.answer.status !== "answered") return;

    assert.equal(result.answer.locations.length, 4);
    assert.equal(result.answer.locations[0]?.path, "src/f0.ts");
  });

  it("leaves a short answer alone and says nothing was cut", () => {
    const answer: LspAnswer = { status: "answered", locations: locations(3) };
    const result = truncateAnswer(answer, 4);
    assert.equal(result.truncated, false);
    assert.equal(result.answer, answer);
  });

  it("truncates symbol and call answers by the same rule", () => {
    const symbols = Array.from({ length: 6 }, (_, index) => ({ name: `s${index}`, kind: "fn" }));
    const calls = Array.from({ length: 6 }, (_, index) => ({
      name: `c${index}`,
      kind: "fn",
      location: { path: "a.ts", line: index, character: 0 },
    }));
    const symbolResult = truncateAnswer({ status: "symbols", symbols }, 2);

    assert.equal(symbolResult.truncated, true);

    if (symbolResult.answer.status !== "symbols") return;

    assert.equal(symbolResult.answer.symbols.length, 2);
    const callResult = truncateAnswer({ status: "calls", items: calls }, 2);

    assert.equal(callResult.truncated, true);
  });

  it("passes hover and empty through: the inbound byte cap is their guard", () => {
    const hover: LspAnswer = { status: "hover", markdown: "x".repeat(100) };
    assert.equal(truncateAnswer(hover, 1).truncated, false);
    assert.equal(truncateAnswer({ status: "empty" }, 0).truncated, false);
  });
});

describe("outboundByteLength", () => {
  it("measures serialised bytes, not characters", () => {
    // Three CJK characters: 9 UTF-8 bytes, 3 JS characters.
    assert.equal(outboundByteLength({ text: "中文文" }), 9 + '{"text":"'.length + '"}'.length);
  });

  it("returns undefined for values JSON cannot carry", () => {
    const circular: { readonly self?: unknown } = {};
    (circular as { self?: unknown }).self = circular;
    assert.equal(outboundByteLength(circular), undefined);
  });
});

describe("limitError", () => {
  it("carries a name the error mapper can recognise", () => {
    const error = limitError("too big");
    assert.equal(isLimitError(error), true);
    assert.equal(isLimitError(new Error("too big")), false);
  });
});

describe("createIdleWatch", () => {
  it("fires after silence and stays silent after dispose", async () => {
    let firings = 0;
    const watch = createIdleWatch(20, () => {
      firings += 1;
    });

    await new Promise((resolve) => setTimeout(resolve, 60));
    assert.equal(firings, 1);
    watch.dispose();
    await new Promise((resolve) => setTimeout(resolve, 60));
    assert.equal(firings, 1);
  });

  it("dispose cancels a pending timer", async () => {
    let firings = 0;
    const watch = createIdleWatch(40, () => {
      firings += 1;
    });

    watch.dispose();
    await new Promise((resolve) => setTimeout(resolve, 80));
    assert.equal(firings, 0);
  });

  it("dispose after firing cannot retract the firing", async () => {
    // Documents the corrected contract: dispose wins only before the callback
    // starts. Once onIdle has run, dispose is a no-op — callers that need
    // exactly-once teardown must make the close itself idempotent.
    let firings = 0;
    const watch = createIdleWatch(20, () => {
      firings += 1;
    });

    await new Promise((resolve) => setTimeout(resolve, 60));
    assert.equal(firings, 1);
    watch.dispose();
    await new Promise((resolve) => setTimeout(resolve, 40));
    assert.equal(firings, 1);
  });

  it("activity postpones the firing", async () => {
    let firings = 0;
    const watch = createIdleWatch(40, () => {
      firings += 1;
    });

    for (let round = 0; round < 3; round += 1) {
      await new Promise((resolve) => setTimeout(resolve, 20));
      watch.activity();
    }

    assert.equal(firings, 0);
    await new Promise((resolve) => setTimeout(resolve, 80));
    assert.equal(firings, 1);
    watch.dispose();
  });
});

describe("createBoundedStdout", () => {
  function frame(payload: string): Buffer {
    const body = Buffer.from(payload, "utf8");
    return Buffer.concat([Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, "utf8"), body]);
  }

  it("passes small messages through byte-identical", async () => {
    const source = new PassThrough();
    const bounded = createBoundedStdout(source, 1024);
    const received: Array<Buffer> = [];

    bounded.on("data", (chunk: Buffer) => received.push(chunk));
    const first = frame('{"a":1}');
    const second = frame('{"b":2}');

    source.write(Buffer.concat([first, second]));
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.deepEqual(Buffer.concat(received), Buffer.concat([first, second]));
    source.end();
  });

  it("destroys the stream when a message declares more than the cap", async () => {
    const source = new PassThrough();
    const bounded = createBoundedStdout(source, 16);
    const errors: Array<Error> = [];

    bounded.on("error", (error: Error) => errors.push(error));
    let closed = false;

    bounded.on("close", () => {
      closed = true;
    });
    // Declared 64 body bytes against a 16-byte cap; the body itself is short
    // because the guard must fire on the declaration, before allocation.
    source.write(Buffer.from("Content-Length: 64\r\n\r\n{}", "utf8"));
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(closed, true);
    assert.equal(errors.length, 1);
    assert.equal(isLimitError(errors[0]), true);
  });

  it("survives headers split across chunks", async () => {
    const source = new PassThrough();
    const bounded = createBoundedStdout(source, 1024);
    const received: Array<Buffer> = [];

    bounded.on("data", (chunk: Buffer) => received.push(chunk));
    const full = frame('{"split":true}');

    source.write(full.subarray(0, 10));
    await new Promise((resolve) => setTimeout(resolve, 10));
    source.write(full.subarray(10));
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.deepEqual(Buffer.concat(received), full);
    source.end();
  });

  it("refuses a header block that itself exceeds the cap", async () => {
    // No message behind these bytes can be legal: headers alone already cost
    // more than any accepted message, so waiting for a terminator would only
    // let a sender hold the buffer open.
    const source = new PassThrough();
    const bounded = createBoundedStdout(source, 16);
    const errors: Array<Error> = [];

    bounded.on("error", (error: Error) => errors.push(error));
    source.write(Buffer.from("this is not a framed message", "utf8"));
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(errors.length, 1);
    assert.equal(isLimitError(errors[0]), true);
  });
  it("lets the library report garbage instead of inventing its own verdict", async () => {
    // No parseable headers: pass everything through and let the JSON-RPC layer
    // fail on its own terms, exactly as before this module existed. The cap is
    // deliberately above the fragment so this tests pass-through, not refusal;
    // a header block that itself exceeds the cap is refused by the test above.
    const source = new PassThrough();
    const bounded = createBoundedStdout(source, 64);
    const received: Array<Buffer> = [];

    bounded.on("data", (chunk: Buffer) => received.push(chunk));
    source.write(Buffer.from("this is not a framed message", "utf8"));
    // Like the library itself, an unterminated header block is held until the
    // stream says there is no more coming — only then is it forwarded whole
    // for the library to judge.
    source.end();
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(Buffer.concat(received).toString("utf8"), "this is not a framed message");
    bounded.destroy();
  });

  it("accepts any Readable as a source", () => {
    const source = Readable.from([Buffer.from("x")]);
    const bounded = createBoundedStdout(source, 8);
    assert.equal(typeof bounded.read, "function");
    source.destroy();
    bounded.destroy();
  });
});

describe("withQueryLimits", () => {
  function stub(calls: Array<string>, answer: LspQueryResult): LanguageServerPort {
    return {
      serverName: "stub",
      workspaceRoot: "D:/w",
      ensureStarted: async () => {
        calls.push("start");
        return { ok: true };
      },
      openDocument: async () => {
        calls.push("open");
        return { ok: true };
      },
      query: async (q) => {
        calls.push(`query:${q.operation}`);
        return answer;
      },
      isRunning: () => true,
      close: async () => {
        calls.push("close");
      },
    };
  }

  const signal = new AbortController().signal;

  it("truncates through the port and says so", async () => {
    const calls: Array<string> = [];
    const port = withQueryLimits(
      stub(calls, { ok: true, operation: "references", answer: { status: "answered", locations: locations(12) }, truncated: false }),
      { ...DEFAULT_LSP_LIMITS, maxLocationsPerAnswer: 5 },
    );
    const result = await port.query({ operation: "references", path: "src/a.ts", line: 0, character: 0 }, signal);

    assert.equal(result.ok, true);

    if (!result.ok) return;

    assert.equal(result.truncated, true);

    if (result.answer.status !== "answered") return;

    assert.equal(result.answer.locations.length, 5);
  });

  it("refuses an oversize document before the delegate starts", async () => {
    const calls: Array<string> = [];
    const port = withQueryLimits(
      stub(calls, { ok: true, operation: "hover", answer: { status: "hover", markdown: "hi" }, truncated: false }),
      { ...DEFAULT_LSP_LIMITS, maxMessageBytes: 64 },
    );
    const result = await port.openDocument({ path: "src/huge.ts", languageId: "typescript", version: 1, text: "x".repeat(1000) });

    assert.equal(result.ok, false);

    if (result.ok) return;

    assert.equal(result.code, "lsp_limit_exceeded");
    assert.deepEqual(calls, []);
  });

  it("reaps an idle connection through close", async () => {
    const calls: Array<string> = [];
    const port = withQueryLimits(
      stub(calls, { ok: true, operation: "hover", answer: { status: "hover", markdown: "hi" }, truncated: false }),
      { ...DEFAULT_LSP_LIMITS, idleTtlMs: 40 },
    );

    assert.deepEqual(await port.ensureStarted(), { ok: true });
    await new Promise((resolve) => setTimeout(resolve, 120));
    assert.deepEqual(calls, ["start", "close"]);
    await port.close();
  });

  it("activity postpones the reap", async () => {
    const calls: Array<string> = [];
    const port = withQueryLimits(
      stub(calls, { ok: true, operation: "hover", answer: { status: "hover", markdown: "hi" }, truncated: false }),
      { ...DEFAULT_LSP_LIMITS, idleTtlMs: 100 },
    );

    assert.deepEqual(await port.ensureStarted(), { ok: true });

    for (let round = 0; round < 3; round += 1) {
      await new Promise((resolve) => setTimeout(resolve, 40));
      await port.query({ operation: "hover", path: "src/a.ts", line: 0, character: 0 }, signal);
    }

    assert.deepEqual(calls.includes("close"), false);
    await port.close();
  });

  it("double close calls the delegate once", async () => {
    const calls: Array<string> = [];
    const port = withQueryLimits(
      stub(calls, { ok: true, operation: "hover", answer: { status: "hover", markdown: "hi" }, truncated: false }),
      { ...DEFAULT_LSP_LIMITS, idleTtlMs: 10_000 },
    );

    assert.deepEqual(await port.ensureStarted(), { ok: true });
    await port.close();
    await port.close();
    assert.deepEqual(calls, ["start", "close"]);
  });

  it("idle firing plus explicit close calls the delegate once", async () => {
    // The race the old comment claimed dispose would win: the timer has
    // already fired, so only an idempotent close keeps the teardown to one.
    const calls: Array<string> = [];
    const port = withQueryLimits(
      stub(calls, { ok: true, operation: "hover", answer: { status: "hover", markdown: "hi" }, truncated: false }),
      { ...DEFAULT_LSP_LIMITS, idleTtlMs: 40 },
    );

    assert.deepEqual(await port.ensureStarted(), { ok: true });
    await new Promise((resolve) => setTimeout(resolve, 120));
    assert.deepEqual(calls, ["start", "close"]);
    await port.close();
    assert.deepEqual(calls, ["start", "close"]);
  });
});
