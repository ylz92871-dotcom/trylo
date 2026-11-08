import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { JsonObject, JsonValue } from "../../../protocol/envelope.js";
import type { ToolOutcome } from "../../../ports/tools.js";
import { createReadOnlyTools } from "./index.js";
import { DEFAULT_READ_ONLY_LIMITS, type ReadOnlyToolLimits } from "./limits.js";
import { createNodeFileSystemReader } from "./node-fs.js";

/**
 * `read_file` reading past line 2000, through the real tool (WP-CLI-B1 §4).
 *
 * `range.test.ts` proves the arithmetic on a string. This file proves the tool
 * agrees with it: that the arguments reach the selection, that the positions come
 * back in the reply a model can act on, and — the part that actually matters —
 * that a caller who only passes `{path}`, which is what every existing session
 * and every other package's code does, gets byte-for-byte what it got before.
 *
 * Real temporary files, real disk reader, real dispatch. A mock here would agree
 * with whatever the implementation claimed, which is the one thing these tests
 * exist to check.
 */

function tempRoot(): string {
  return mkdtempSync(join(os.tmpdir(), "trylo-range-"));
}

function write(root: string, relative: string, text: string): void {
  writeFileSync(join(root, relative), text, "utf8");
}

function tools(root: string, limits?: ReadOnlyToolLimits): ReturnType<typeof createReadOnlyTools> {
  return createReadOnlyTools({
    workspaceRoot: root,
    reader: createNodeFileSystemReader(),
    ...(limits === undefined ? {} : { limits }),
  });
}

function read(args: JsonObject): { toolCallId: string; name: string; arguments: JsonObject } {
  return { toolCallId: "c1", name: "read_file", arguments: args };
}

/** A reply reduced to the fields a model reads. Numbers stay `undefined` if absent. */
type Reply = {
  readonly outcome: ToolOutcome;
  readonly content: string;
  readonly startLine: number | undefined;
  readonly endLine: number | undefined;
  readonly totalLines: number | undefined;
  readonly nextOffset: number | undefined;
  readonly truncated: boolean;
  readonly lineTooLong: JsonObject | undefined;
};

function replyOf(outcome: ToolOutcome): Reply {
  const value: JsonObject = outcome.outcome === "result" ? outcome.value : {};
  const tooLong = value.lineTooLong;
  const object = (candidate: JsonValue | undefined): JsonObject | undefined =>
    typeof candidate === "object" && candidate !== null && !Array.isArray(candidate)
      ? (candidate as JsonObject)
      : undefined;

  return {
    outcome,
    content: String(value.content ?? ""),
    startLine: typeof value.startLine === "number" ? value.startLine : undefined,
    endLine: typeof value.endLine === "number" ? value.endLine : undefined,
    totalLines: typeof value.totalLines === "number" ? value.totalLines : undefined,
    nextOffset: typeof value.nextOffset === "number" ? value.nextOffset : undefined,
    truncated: value.truncated === true,
    lineTooLong: object(tooLong),
  };
}

/** `count` LF-terminated lines, the shape of an ordinary source file. */
function lines(count: number): string {
  return Array.from({ length: count }, (_, index) => `line ${index + 1}`).join("\n") + "\n";
}

/** Follow `nextOffset` to the end, collecting every chunk. Returns the reassembled text. */
async function walkAll(root: string, relative: string, limits?: ReadOnlyToolLimits): Promise<string> {
  const port = tools(root, limits);
  const signal = new AbortController().signal;
  const chunks: string[] = [];
  let args: JsonObject = { path: relative, offset: 0 };

  for (let guard = 0; guard < 50; guard += 1) {
    const reply = replyOf(await port.execute(read(args), signal));

    assert.equal(reply.outcome.outcome, "result", `reading ${JSON.stringify(args)} failed`);
    chunks.push(reply.content);

    if (reply.nextOffset === undefined) {
      break;
    }

    args = { path: relative, offset: reply.nextOffset };
  }

  return chunks.join("");
}

/* ------------------------------------------------- existing callers unchanged */

test("a plain {path} read is byte for byte what it was before ranges existed", async () => {
  const root = tempRoot();
  try {
    const source = lines(300);

    write(root, "small.ts", source);
    const reply = replyOf(await tools(root).execute(read({ path: "small.ts" }), new AbortController().signal));

    assert.equal(reply.outcome.outcome, "result");
    assert.equal(reply.content, source, "no line prefix, no dropped terminator, no appended notice");
    assert.equal(reply.startLine, 1);
    assert.equal(reply.endLine, 300);
    assert.equal(reply.totalLines, 300);
    assert.equal(reply.nextOffset, undefined, "a file that fits does not invite a continuation");
    assert.equal(reply.truncated, false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a file longer than the line ceiling reports where to continue", async () => {
  const root = tempRoot();
  try {
    const source = lines(2600);

    write(root, "long.ts", source);
    const reply = replyOf(await tools(root).execute(read({ path: "long.ts" }), new AbortController().signal));

    assert.equal(reply.startLine, 1);
    assert.equal(reply.endLine, 2000, "the pre-existing ceiling, unchanged");
    assert.equal(reply.totalLines, 2600, "the model learns the file is bigger than what it got");
    assert.equal(reply.nextOffset, 2000);
    assert.equal(reply.truncated, true);
    assert.equal(reply.content, source.split("\n").slice(0, 2000).join("\n"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

/* --------------------------------------------------------------- continuing */

test("following nextOffset reaches the end of a file past the line ceiling", async () => {
  const root = tempRoot();
  try {
    const source = lines(2600);
    write(root, "long.ts", source);
    assert.equal(await walkAll(root, "long.ts"), source, "the ranges reassemble into the file");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("an explicit offset reads the region it names and stops at the end", async () => {
  const root = tempRoot();
  try {
    const source = lines(2600);

    write(root, "long.ts", source);
    const reply = replyOf(
      await tools(root).execute(read({ path: "long.ts", offset: 2579, limit: 80 }), new AbortController().signal),
    );

    assert.equal(reply.startLine, 2580);
    assert.equal(reply.endLine, 2600, "21 lines are left; the request is not padded to 80");
    assert.equal(reply.nextOffset, undefined, "nothing follows the end of the file");
    assert.equal(reply.truncated, false, "served as asked, not cut short");
    // Stated as a walk rather than a slice: the point is "these are lines 2580 to
    // 2600, exactly as the file has them", and a slice index is easy to get
    // subtly wrong in a way that still looks plausible.
    assert.deepEqual(reply.content.split("\n").slice(0, -1), source.split("\n").slice(2579, 2600));
    assert.equal(reply.content.endsWith("line 2600\n"), true, "the last line keeps its terminator");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("offset and limit are honoured together, without touching the byte ceiling", async () => {
  const root = tempRoot();
  try {
    write(root, "mid.ts", lines(500));
    const reply = replyOf(
      await tools(root).execute(read({ path: "mid.ts", offset: 100, limit: 3 }), new AbortController().signal),
    );

    assert.equal(reply.startLine, 101);
    assert.equal(reply.endLine, 103);
    assert.equal(reply.nextOffset, 103);
    assert.equal(reply.content, "line 101\nline 102\nline 103\n");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

/* ------------------------------------------------------------ bad arguments */

test("a bad offset is refused by name, before the file is read", async () => {
  const root = tempRoot();
  try {
    write(root, "a.ts", "one\n");
    for (const [args, expected] of [
      [{ path: "a.ts", offset: -1 }, "offset must be 0 or greater"],
      [{ path: "a.ts", offset: 1.5 }, "offset must be an integer"],
      [{ path: "a.ts", offset: "3" }, "offset must be an integer"],
      [{ path: "a.ts", limit: 0 }, "limit must be 1 or more"],
      [{ path: "a.ts", limit: -2 }, "limit must be 1 or more"],
      [{ path: "a.ts", limit: "ten" }, "limit must be an integer"],
    ] as ReadonlyArray<[JsonObject, string]>) {
      const outcome = await tools(root).execute(read(args), new AbortController().signal);
      assert.equal(outcome.outcome, "error", JSON.stringify(args));
      assert.equal(outcome.code, "invalid_arguments", JSON.stringify(args));
      assert.match(outcome.message, new RegExp(expected.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

/* ----------------------------------------------------------- the byte ceiling */

test("a byte ceiling that lands mid-line still lets the read finish", async () => {
  const root = tempRoot();
  try {
    const source = lines(100);
    write(root, "tight.ts", source);
    // 200 bytes ends one byte into line 27: the case where reporting "too long"
    // would strand the model on a file it could have read to the end.
    const limits = { ...DEFAULT_READ_ONLY_LIMITS, maxBytes: 200 };
    assert.equal(await walkAll(root, "tight.ts", limits), source);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a line that cannot fit the budget is named, with its real length", async () => {
  const root = tempRoot();
  try {
    const source = "short\n" + "x".repeat(5000) + "\ntail\n";

    write(root, "wide.ts", source);
    const reply = replyOf(
      await tools(root, { ...DEFAULT_READ_ONLY_LIMITS, maxBytes: 200 }).execute(
        read({ path: "wide.ts" }),
        new AbortController().signal,
      ),
    );

    assert.deepEqual(reply.lineTooLong, { line: 2, bytes: 5001 });
    assert.equal(reply.nextOffset, undefined, "no fake position inside a line that cannot be read");
    assert.equal(reply.content.startsWith("short\n"), true, "the lines before it come back whole");
    assert.equal(reply.content.endsWith("x".repeat(50)), true, "and the prefix of the long line");
    assert.equal(reply.truncated, true, "a prefix is not a whole line, and says so");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

/* --------------------------------------------------------------- the schema */

test("the schema tells the model the unit, the base and how to continue", async () => {
  const root = tempRoot();
  try {
    const binding = tools(root).snapshot().find((entry) => entry.name === "read_file");

    assert.ok(binding, "read_file is offered");
    const description = binding.description;

    // WP §4: the description is not allowed to merely mention the parameters.
    assert.match(description, /LINES/);
    assert.match(description, /0-based/);
    assert.match(description, /1-based/);
    assert.match(description, /nextOffset/);
    assert.match(description, /unchanged/);

    const properties = binding.parameters.properties as JsonObject;

    assert.equal((properties.offset as JsonObject).type, "integer");
    assert.equal((properties.offset as JsonObject).minimum, 0);
    assert.equal((properties.limit as JsonObject).minimum, 1);
    // Still one required argument: an existing caller must keep working.
    assert.deepEqual(binding.parameters.required, ["path"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
