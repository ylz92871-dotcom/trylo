import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer, type Server, type ServerResponse } from "node:http";
import os from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

/**
 * Resume over a stored window, end to end (WP E 波 §6.3).
 *
 * The loop-level case already proves the projection; this one proves the whole
 * delivery face keeps it — the session is written by `--session`, reopened by
 * `--resume`, and the *next provider request* is inspected on a real socket.
 * That last part is the point: a resumed run that quietly replays the full
 * transcript still looks correct from the CLI's own output.
 *
 * Two numberings meet on this path and the fixture is built so that they cannot
 * be confused: the store writes `session_start` at 0, a `turn_start` at 1, the
 * transcript items from 2, then envelopes, effect rows and a terminal. A window
 * bounded in the loop's own numbering (which has no bookkeeping records) would
 * therefore land short by exactly the rows before it — which is what this case
 * pins, from both ends: the stored bounds, and what the model is then sent.
 *
 * The fixture is built so that compaction is forced but the hard gate is not:
 * the initial history exceeds the ceiling and its summary fits beneath it,
 * so compaction clears the hard gate. The fake provider is driven by request
 * count rather than by inspecting the prompt — its job is to be a provider, not
 * a second reader of the loop's own message shapes.
 */

const cli = fileURLToPath(new URL("./main.js", import.meta.url));

/** User instructions remain live; the provider report triggers compaction. */
const LONG_TEXT = "x".repeat(2000);
const CEILING = 4096;

type Captured = {
  readonly messages: ReadonlyArray<{ readonly role: string; readonly content: string }>;
};

type Endpoint = {
  readonly url: string;
  readonly requests: Captured[];
  readonly setPhase: (phase: "tool-then-stop" | "stop-only") => void;
  readonly close: () => Promise<void>;
};

function sse(res: ServerResponse, frames: readonly unknown[]): void {
  res.writeHead(200, { "content-type": "text/event-stream" });
  for (const frame of frames) {
    res.write(`data: ${JSON.stringify(frame)}\n\n`);
  }
  res.write("data: [DONE]\n\n");
  res.end();
}

/** Later requests report a small view after the stored window. */
const USAGE = { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 };

function toolCallFrames(): ReadonlyArray<unknown> {
  return [
    {
      choices: [
        {
          delta: {
            tool_calls: [
              {
                index: 0,
                id: "call-1",
                function: { name: "read_file", arguments: '{"path":"package.json"}' },
              },
            ],
          },
          finish_reason: null,
        },
      ],
    },
    { choices: [{ delta: {}, finish_reason: "tool_calls" }], usage: { ...USAGE, prompt_tokens: CEILING + 1000, total_tokens: CEILING + 1005 } },
  ];
}

const STOP_FRAMES: ReadonlyArray<unknown> = [
  { choices: [{ delta: { content: "done" }, finish_reason: "stop" }], usage: USAGE },
];

function startEndpoint(): Promise<Endpoint> {
  const requests: Captured[] = [];
  let phase: "tool-then-stop" | "stop-only" = "stop-only";
  let hitsInPhase = 0;
  const server: Server = createServer((req, res) => {
    let body = "";

    req.setEncoding("utf8");
    req.on("data", (chunk: string) => {
      body += chunk;
    });
    req.on("end", () => {
      let messages: Captured["messages"] = [];

      try {
        const parsed = JSON.parse(body) as { messages?: Captured["messages"] };
        messages = parsed.messages ?? [];
      } catch {
        messages = [];
      }

      requests.push({ messages });
      hitsInPhase += 1;

      // The first stream of a tool-then-stop run asks for a tool; the gap after
      // it is where compaction happens. Every later stream just stops.
      if (phase === "tool-then-stop" && hitsInPhase === 1) {
        sse(res, toolCallFrames());
        return;
      }

      sse(res, STOP_FRAMES);
    });
  });

  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address !== null ? address.port : 0;

      resolve({
        url: `http://127.0.0.1:${port}/v1/chat/completions`,
        requests,

        setPhase: (next) => {
          phase = next;
          hitsInPhase = 0;
        },

        close: () =>
          new Promise<void>((done) => {
            server.close(() => done());
          }),
      });
    });
  });
}

type Row = {
  readonly sequence: number;
  readonly type: string;
  readonly payload: Record<string, unknown>;
};

/** Every durable record the run wrote, oldest first — the journal is the evidence. */
function journalRows(root: string): ReadonlyArray<Row> {
  const rows: Row[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) {
        walk(full);
        continue;
      }

      for (const line of readFileSync(full, "utf8").split("\n")) {
        const text = line.trim();
        if (text.length === 0) {
          continue;
        }

        const parsed = JSON.parse(text) as {
          sequence: number;
          record: { type: string; payload: Record<string, unknown> };
        };

        rows.push({
          sequence: parsed.sequence,
          type: parsed.record.type,
          payload: parsed.record.payload,
        });
      }
    }
  };

  walk(root);

  return rows.sort((left, right) => left.sequence - right.sequence);
}

type Fixture = {
  readonly workspace: string;
  readonly home: string;
  readonly cleanup: () => void;
};

function fixture(): Fixture {
  const root = mkdtempSync(join(os.tmpdir(), "trylo-resume-"));
  const workspace = join(root, "workspace");
  const home = join(root, "home");

  mkdirSync(workspace, { recursive: true });
  mkdirSync(home, { recursive: true });
  mkdirSync(join(workspace, ".trylo"), { recursive: true });
  writeFileSync(join(workspace, "package.json"), JSON.stringify({ name: "resume-fixture" }), "utf8");
  writeFileSync(
    join(workspace, ".trylo", "config.json"),
    JSON.stringify({
      provider: "openai-compatible",
      model: "resume-model",
      contextTokenLimit: CEILING,
      maxIterations: 4,
    }),
    "utf8",
  );

  return { workspace, home, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

type RunResult = {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
};

/**
 * Asynchronous on purpose: the fake provider lives in this process, and a
 * synchronous spawn would block the very event loop that has to answer it.
 */
function run(fx: Fixture, endpoint: string, args: readonly string[]): Promise<RunResult> {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    TRYLO_HOME: fx.home,
    TRYLO_API_KEY: "sk-resume-fixture",
  };
  const argv = [
    cli,
    ...args,
    "--provider",
    "openai-compatible",
    "--endpoint",
    endpoint,
    "--format",
    "stream-json",
    "--tools=read_file",
  ];

  return new Promise((resolve) => {
    const child = spawn(process.execPath, argv, {
      cwd: fx.workspace,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.on("close", (status) => resolve({ status, stdout, stderr }));
  });
}

test("反方 #26 — a resumed run sends the stored window, not the replayed transcript", async () => {
  const endpoint = await startEndpoint();
  const fx = fixture();

  try {
    endpoint.setPhase("tool-then-stop");
    const first = await run(fx, endpoint.url, ["run", LONG_TEXT, "--session", "resume-1"]);

    assert.equal(first.status, 0, `${first.stderr}\n${first.stdout}`);
    // The gap compacted. The CLI stream does not project `compact` — it is a
    // journal fact, not a surface event — so the evidence is read off the
    // durable session the run has just written.
    const rows = journalRows(fx.home);
    const items = rows.filter((row) => row.type === "transcript_item");
    const window = rows.find((row) => row.type === "compact")?.payload;

    assert.notEqual(window, undefined);
    assert.equal(items.length >= 4, true);

    // The window covers the user line, its tool call and the tool result — the
    // three items the summary names. Its bounds are *journal* sequences, so they
    // start at 2: `session_start` is 0 and `turn_start` is 1. Bounds in the
    // loop's own numbering would read 0..3, which is one row short of `turn_start`
    // and leaves the tool result in the model's live history.
    assert.equal(window?.replacedFromSequence, items[0]?.sequence);
    assert.equal(window?.replacedToSequence, items[2]?.sequence);
    assert.equal(items[0]?.sequence, 2);

    const before = endpoint.requests.length;

    assert.equal(before >= 2, true);

    endpoint.setPhase("stop-only");
    const second = await run(fx, endpoint.url, ["run", "again", "--resume", "resume-1"]);

    assert.equal(second.status, 0, `${second.stderr}\n${second.stdout}`);

    const resumed = endpoint.requests.slice(before);

    assert.equal(resumed.length, 1, "a resumed turn rebuilds one request");
    const messages = resumed[0]?.messages ?? [];

    // The digest, plus what genuinely happened after the window: the assistant's
    // closing line and this turn's own. Original user constraints also stay live.
    // (The tool list rides first, with the seed ahead of all history.)
    assert.deepEqual(messages.filter(message => message.role !== "system").map(message => message.role), ["user", "assistant", "user"]);
    assert.equal(messages.some(message => message.role === "user" && message.content === LONG_TEXT), true);
    const system = messages.filter(message => message.role === "system");

    assert.equal(system.filter(message => message.content.startsWith("You are Trylo, a coding agent")).length, 1);
    assert.equal(system.filter(message => message.content.includes("Available tools this run")).length, 1);
    assert.equal(system.filter(message => message.content.includes("workspace root:")).length, 1);
    assert.equal(system.filter(message => message.content.includes("[compacted history ")).length, 1);
    assert.equal(messages.at(-1)?.content, "again");
    assert.equal(messages.some((message) => message.role === "tool"), false);
    // The digest is extractive, so it legitimately repeats the tool output's own
    // words. What must not survive is the *item*: no message outside the digest
    // may carry it.
    assert.equal(
      messages
        .filter((message) => !message.content.includes("[compacted history "))
        .some((message) => message.content.includes("resume-fixture")),
      false,
      "the tool result the window replaced must not come back as a live item",
    );
  } finally {
    await endpoint.close();
    fx.cleanup();
  }
});
