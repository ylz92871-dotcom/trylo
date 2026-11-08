import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ConnectionSlots } from "./lsp-slots.js";
import { DeadlineExceeded, withDeadline } from "./lsp-deadline.js";
import { mapLspError } from "./lsp-request.js";
import { decodeAnswer, InvalidLspResult } from "./lsp-decode.js";
import { toCapabilities } from "./lsp-capabilities.js";

describe("ConnectionSlots", () => {
  it("settles every pending request when the server exits", async () => {
    // The failure this guards: a server dies, its promise never settles, and the
    // tool call hangs until its own timeout instead of reporting the exit.
    const slots = new ConnectionSlots();
    const first = slots.track(new Promise<string>(() => undefined), undefined);
    const second = slots.track(new Promise<string>(() => undefined), undefined);
    const exited = new Error("gone");

    exited.name = "LspServerExited";
    slots.settleAllPending(exited);
    await assert.rejects(first, /gone/);
    await assert.rejects(second, /gone/);
  });

  it("counts load so the caller can enforce a ceiling", async () => {
    const slots = new ConnectionSlots();

    assert.equal(slots.load, 0);
    const pending = slots.track(new Promise<string>(() => undefined), undefined);

    assert.equal(slots.load, 1);
    slots.settleAllPending(new Error("x"));
    await assert.rejects(pending);
    assert.equal(slots.load, 0);
  });

  it("settles on abort without waiting for the server", async () => {
    const slots = new ConnectionSlots();
    const controller = new AbortController();
    const pending = slots.track(new Promise<string>(() => undefined), controller.signal);
    controller.abort();
    await assert.rejects(pending, /cancelled/);
  });

  it("does not double-settle a request already rejected by teardown", async () => {
    const slots = new ConnectionSlots();
    const pending = slots.track(new Promise<string>(() => undefined), undefined);

    slots.settleAllPending(new Error("exit"));
    await assert.rejects(pending, /exit/);
    // A late server reply must not resurrect the slot or resolve after the exit.
    assert.equal(slots.load, 0);
    assert.equal(slots.count, 0);
  });
});

describe("withDeadline", () => {
  it("returns the value when the work finishes in time", async () => {
    assert.equal(await withDeadline(Promise.resolve("ok"), 1000, () => undefined), "ok");
  });

  it("rejects with DeadlineExceeded and runs the cancel hook", async () => {
    let cancelled = false;
    const never = new Promise<string>(() => undefined);

    await assert.rejects(
      withDeadline(never, 5, () => {
        cancelled = true;
      }),
      (error: unknown) => error instanceof DeadlineExceeded,
    );
    assert.equal(cancelled, true);
  });

  it("does not fire the cancel hook on the success path", async () => {
    let cancelled = false;
    await withDeadline(Promise.resolve(1), 1000, () => {
      cancelled = true;
    });
    assert.equal(cancelled, false);
  });
});

describe("mapLspError", () => {
  it("names a dead server rather than reporting no results", () => {
    const error = new Error("pipe closed");
    error.name = "LspServerExited";
    assert.equal(mapLspError(error, "hover").code, "lsp_server_exited");
  });

  it("distinguishes timeout from cancellation", () => {
    assert.equal(mapLspError(new DeadlineExceeded(10), "hover").code, "lsp_timeout");
    const cancelled = new Error("cancelled");
    cancelled.name = "LspCancelled";
    assert.equal(mapLspError(cancelled, "hover").code, "lsp_cancelled");
  });

  it("reports a malformed result as invalid, not as an empty answer", () => {
    const result = mapLspError(new InvalidLspResult("not an array"), "document_symbols");
    assert.equal(result.code, "lsp_invalid_result");
  });

  it("names a missing executable as a start failure", () => {
    const error = Object.assign(new Error("spawn ENOENT"), { code: "ENOENT" });
    assert.equal(mapLspError(error, "initialize ts").code, "lsp_start_failed");
  });

  it("tells the caller to re-read when the document changed underneath", () => {
    const error = Object.assign(new Error("content modified"), { code: -32801 });
    const mapped = mapLspError(error, "definition a.ts");
    assert.equal(mapped.code, "lsp_invalid_position");
    assert.match(mapped.message, /re-read/);
  });
});

describe("decodeAnswer", () => {
  it("separates an empty answer from a failure", () => {
    // "No definition here" and "the server never ran" must not look alike.
    assert.deepEqual(decodeAnswer(null, "definition"), { status: "empty" });
  });

  it("decodes a single definition location", () => {
    const answer = decodeAnswer(
      { uri: "file:///src/a.ts", range: { start: { line: 10, character: 2 }, end: { line: 10, character: 8 } } },
      "definition",
    );

    assert.equal(answer.status, "answered");
    assert.deepEqual(answer.status === "answered" ? answer.locations : [], [
      { path: "/src/a.ts", line: 10, character: 2, endLine: 10, endCharacter: 8 },
    ]);
  });

  it("decodes references as several locations", () => {
    const answer = decodeAnswer(
      [
        { uri: "file:///src/a.ts", range: { start: { line: 1, character: 0 } } },
        { uri: "file:///src/b.ts", range: { start: { line: 2, character: 0 } } },
      ],
      "references",
    );
    assert.equal(answer.status === "answered" ? answer.locations.length : 0, 2);
  });

  it("drops a non-file document instead of pointing at a path that is not there", () => {
    const answer = decodeAnswer([{ uri: "untitled:Untitled-1", range: { start: { line: 0, character: 0 } } }], "references");
    assert.deepEqual(answer, { status: "answered", locations: [] });
  });

  it("rejects a reply that is not the shape the protocol promises", () => {
    assert.throws(() => decodeAnswer({ nope: true }, "document_symbols"), InvalidLspResult);
  });

  it("flattens nested symbols and names the container", () => {
    const answer = decodeAnswer(
      [
        {
          name: "Outer",
          kind: 5,
          range: { start: { line: 0, character: 0 } },
          children: [{ name: "inner", kind: 6, range: { start: { line: 2, character: 2 } } }],
        },
      ],
      "document_symbols",
    );

    assert.equal(answer.status, "symbols");
    const symbols = answer.status === "symbols" ? answer.symbols : [];

    assert.deepEqual(symbols.map((s) => `${s.name}/${s.container ?? "-"}`), ["Outer/-", "inner/Outer"]);
    assert.equal(symbols[0]?.kind, "class");
  });

  it("keeps an unknown symbol kind visible rather than collapsing it", () => {
    const answer = decodeAnswer([{ name: "x", kind: 999, range: { start: { line: 0, character: 0 } } }], "document_symbols");
    const symbols = answer.status === "symbols" ? answer.symbols : [];
    assert.equal(symbols[0]?.kind, "kind:999");
  });

  it("decodes hover text from every content form", () => {
    const plain = decodeAnswer({ contents: "hello" }, "hover");
    assert.equal(plain.status === "hover" ? plain.markdown : "", "hello");
    const marked = decodeAnswer({ contents: { language: "ts", value: "const x: number" } }, "hover");
    assert.equal(marked.status === "hover" ? marked.markdown : "", "const x: number");
    const list = decodeAnswer({ contents: [{ value: "a" }, { value: "b" }] }, "hover");
    assert.equal(list.status === "hover" ? list.markdown : "", "a\n\nb");
  });

  it("decodes incoming calls and reports empty when there are none", () => {
    const answered = decodeAnswer(
      [{ from: { name: "caller", kind: 12, location: { uri: "file:///src/c.ts", selectionRange: { start: { line: 4, character: 0 } } } } }],
      "call_hierarchy",
    );
    assert.equal(answered.status, "calls");
    assert.deepEqual(decodeAnswer([], "call_hierarchy"), { status: "empty" });
  });
});

describe("toCapabilities", () => {
  it("treats an absent key as unsupported", () => {
    const capabilities = toCapabilities({ hoverProvider: true });
    assert.equal(capabilities.hover, true);
    assert.equal(capabilities.definition, false);
  });

  it("treats no capabilities at all as supporting nothing", () => {
    const capabilities = toCapabilities(undefined);
    assert.equal(capabilities.callHierarchy, false);
    assert.equal(capabilities.references, false);
  });

  it("accepts a boolean provider as well as an options object", () => {
    assert.equal(toCapabilities({ definitionProvider: true }).definition, true);
    assert.equal(toCapabilities({ definitionProvider: false }).definition, false);
  });
});
