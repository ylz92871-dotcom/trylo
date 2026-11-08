import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { CliContext } from "../context.js";
import type { TurnOutcome } from "../host.js";
import type { RunScaffold } from "../run-command.js";
import { handleTui, type TuiTurnRunner } from "./entry.js";
import type { TuiIo } from "./io.js";

/**
 * Where the idle dispatch point sits in the loop, and what it refuses to be.
 *
 * The queue itself is tested in `queued-dispatch.test.ts`. What is only visible
 * from inside the loop is **ordering** and **the two things a queued message is
 * not allowed to be**: not a slash command, and not something that jumps ahead
 * of a word the person just typed.
 *
 * Both matter more than they look. A slash command from a background message
 * would let a second terminal end this session; a queue that outranked the
 * prompt would answer a message that has been waiting a minute before the one
 * typed a second ago, which is the opposite of what "queued" is for.
 */

type Scripted = {
  readonly ctx: CliContext;
  readonly root: string;
  readonly io: TuiIo & { readonly written: string[] };
};

function scripted(lines: ReadonlyArray<string>): Scripted {
  const root = mkdtempSync(join(tmpdir(), "trylo-tui-queue-"));
  const home = join(root, "home");
  const cwd = join(root, "workspace");

  mkdirSync(cwd, { recursive: true });
  mkdirSync(join(home, ".trylo", "sessions"), { recursive: true });
  writeFileSync(join(home, ".trylo", "config.json"), JSON.stringify({ provider: "fixture" }));
  let at = 0;
  let ids = 0;
  const ctx: CliContext = {
    env: {},
    homeDir: home,
    cwd,
    nodeVersion: "v22.0.0",
    stdinIsTty: true,

    readFile: (absolutePath) => {
      try {
        return readFileSync(absolutePath, "utf8");
      } catch {
        return undefined;
      }
    },

    isDirectory: () => true,
    readDir: () => [],
    writeFile: () => true,
    readStdin: async () => "",

    readLine: async () => {
      if (at >= lines.length) {
        return undefined;
      }
      const line = lines[at];
      at += 1;
      return line;
    },

    readSecret: async () => undefined,
    stdout: () => undefined,
    stderr: () => undefined,
    now: () => 0,
    newId: (prefix) => `${prefix}-${(ids += 1)}`,
  };
  const written: string[] = [];
  const io: TuiIo & { readonly written: string[] } = {
    written,
    readLine: () => ctx.readLine(),
    write: (text) => written.push(text),
    size: () => ({ columns: 80, rows: 24 }),
  };

  return { ctx, root, io };
}

function outcomeOf(scaffold: RunScaffold): TurnOutcome {
  return {
    exitCode: 0,
    result: {
      type: "run_result",
      status: "completed",
      finishReason: "stop",
      sessionId: scaffold.sessionId,
      turnId: "turn-1",
      iterations: 1,
      usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
      durationMs: 1,
      lastMessage: "done",
    },
    transcript: [],
    view: undefined,
    warnings: [],
  };
}

/** Records the text every turn was given, in order. */
function recordingRunner(): { readonly runner: TuiTurnRunner; readonly seen: string[] } {
  const seen: string[] = [];
  const runner: TuiTurnRunner = async (scaffold, text) => {
    seen.push(text);
    return outcomeOf(scaffold);
  };
  return { runner, seen };
}

/** A dispatcher that hands out `texts` in order, then reports idle forever. */
function queueOf(texts: ReadonlyArray<string>) {
  let at = 0;
  return async (): Promise<
    | { readonly kind: "turn"; readonly id: string; readonly text: string; readonly remaining: number }
    | { readonly kind: "idle" }
    | { readonly kind: "unknown"; readonly code: "queue_locked" }
  > => {
    const text = texts[at];
    if (text === undefined) {
      return { kind: "idle" };
    }
    at += 1;
    return { kind: "turn", id: `q-${at}`, text, remaining: Math.max(0, texts.length - at) };
  };
}

test("a queued message starts a turn while the person is at the prompt", async () => {
  const s = scripted(["/exit"]);
  const { runner, seen } = recordingRunner();

  try {
    const code = await handleTui(s.ctx, s.io, runner, undefined, {}, undefined, queueOf(["from another terminal"]));
    assert.equal(code, 0);
    assert.deepEqual(seen, ["from another terminal"]);
    // The queue must not be invisible: the person who queued it wants to see it
    // leave the queue, not infer that from the reply.
    assert.match(s.io.written.join(""), /answering queued message q-1 \(last one\)/);
  } finally {
    rmSync(s.root, { recursive: true, force: true });
  }
});

test("the queue drains at idle, one message per tick, before the prompt is served", async () => {
  const s = scripted(["typed later", "/exit"]);
  const { runner, seen } = recordingRunner();

  try {
    await handleTui(s.ctx, s.io, runner, undefined, {}, undefined, queueOf(["first", "from the queue"]));
    // The queue is asked at every idle tick, before the loop blocks on a read.
    // That ordering is the feature: a queued message has to be answered in a
    // session nobody is sitting at, and a read-first loop would wait for a
    // keystroke that may never come.
    assert.deepEqual(seen, ["first", "from the queue", "typed later"]);
    assert.match(s.io.written.join(""), /answering queued message q-1 \(1 more waiting\)/);
    assert.match(s.io.written.join(""), /answering queued message q-2 \(last one\)/);
  } finally {
    rmSync(s.root, { recursive: true, force: true });
  }
});

test("a word the last turn never answered outranks the queue", async () => {
  const s = scripted(["/exit"]);
  const seen: string[] = [];
  // The runner hands back one word it never delivered — the mid-run-input case
  // — and that word is already spoken. It waits in `pending`, and `pending` is
  // checked before the queue, so a message somebody typed during the turn is
  // not overtaken by one that has been on disk longer.
  //
  // Returned once, not on every turn: a runner that always owes a word makes
  // `pending` permanently non-empty and the prompt is never read again. That is
  // a livelock this fixture would have hidden by hanging rather than failing.
  let turns = 0;
  const runner: TuiTurnRunner = async (scaffold, text) => {
    seen.push(text);
    turns += 1;

    // Conditional spread, not `unconsumedInput: undefined`: under
    // `exactOptionalPropertyTypes` an explicit undefined is a different thing
    // from an absent key, and the runner's contract says absent.
    return {
      ...outcomeOf(scaffold),
      ...(turns === 1
        ? { unconsumedInput: [{ turnId: "turn-1", text: "spoken during the turn", mode: "queue" as const }] }
        : {}),
    };
  };

  try {
    await handleTui(s.ctx, s.io, runner, undefined, {}, undefined, queueOf(["older, on disk"]));
    assert.deepEqual(seen, ["older, on disk", "spoken during the turn"]);
  } finally {
    rmSync(s.root, { recursive: true, force: true });
  }
});

test("a queued message does not reach the slash table", async () => {
  const s = scripted([]);
  const { runner, seen } = recordingRunner();

  try {
    // `/exit` from the queue must be answered as text, not obeyed as a command.
    // Otherwise a second terminal could end this session.
    const code = await handleTui(s.ctx, s.io, runner, undefined, {}, undefined, queueOf(["/exit"]));
    assert.equal(code, 0);
    assert.deepEqual(seen, ["/exit"]);
  } finally {
    rmSync(s.root, { recursive: true, force: true });
  }
});

test("a queued message does not reach the mention reader either", async () => {
  const s = scripted([]);
  const { runner, seen } = recordingRunner();

  try {
    // A mention is resolved against this process's cwd and files. Inheriting
    // that expansion from another terminal's text would let a queue message
    // name a file this session never opened.
    await handleTui(s.ctx, s.io, runner, undefined, {}, undefined, queueOf(["look at @package.json"]));
    assert.deepEqual(seen, ["look at @package.json"]);
  } finally {
    rmSync(s.root, { recursive: true, force: true });
  }
});

test("a queue that cannot be read says so once, not once per idle tick", async () => {
  const s = scripted(["a", "b", "c", "/exit"]);
  const { runner, seen } = recordingRunner();

  try {
    await handleTui(s.ctx, s.io, runner, undefined, {}, undefined, async () => ({
      kind: "unknown",
      code: "queue_unreadable",
    }));
    // Four typed lines, four idle ticks, one complaint. A prompt that repeats
    // itself on every tick is worse than one that stays quiet, and the tick
    // that finally succeeds must clear the memory so a later failure speaks up.
    const complaints = s.io.written.join("").match(/cannot read this session's queued messages/g) ?? [];

    assert.equal(complaints.length, 1);
    // And the prompt kept working throughout.
    assert.deepEqual(seen, ["a", "b", "c"]);
  } finally {
    rmSync(s.root, { recursive: true, force: true });
  }
});

test("a queue that recovers then fails again speaks the second time", async () => {
  const s = scripted(["a", "b", "c", "/exit"]);
  const codes: ReadonlyArray<"queue_locked" | "idle"> = ["queue_locked", "idle", "queue_locked"];
  let at = 0;
  const { runner } = recordingRunner();

  try {
    await handleTui(s.ctx, s.io, runner, undefined, {}, undefined, async () => {
      const code = codes[at] ?? "idle";
      at += 1;
      return code === "idle" ? { kind: "idle" } : { kind: "unknown", code };
    });
    // De-duplicating forever would be the other failure: the second outage is
    // a different event and the person has no other way to learn it happened.
    const complaints = s.io.written.join("").match(/cannot read this session's queued messages/g) ?? [];

    assert.equal(complaints.length, 2);
  } finally {
    rmSync(s.root, { recursive: true, force: true });
  }
});

test("no dispatcher means the loop never asks about a queue", async () => {
  const s = scripted(["hello", "/exit"]);
  const { runner, seen } = recordingRunner();

  try {
    // The absent-dispatcher path every existing caller and every other test
    // takes. It must stay byte-identical to the loop before this feature.
    await handleTui(s.ctx, s.io, runner);
    assert.deepEqual(seen, ["hello"]);
    assert.doesNotMatch(s.io.written.join(""), /queued message/);
  } finally {
    rmSync(s.root, { recursive: true, force: true });
  }
});

test("a locked queue is reported once and does not stop the prompt", async () => {
  const s = scripted(["still typing", "/exit"]);
  const { runner, seen } = recordingRunner();

  try {
    await handleTui(s.ctx, s.io, runner, undefined, {}, undefined, async () => ({
      kind: "unknown",
      code: "queue_locked",
    }));
    assert.deepEqual(seen, ["still typing"]);
    const complaints = s.io.written.join("").match(/cannot read this session's queued messages/g) ?? [];

    assert.equal(complaints.length, 1);
    // And it names the code, because "cannot read" and "not locked" lead to
    // different next moves.
    assert.match(s.io.written.join(""), /queue_locked/);
  } finally {
    rmSync(s.root, { recursive: true, force: true });
  }
});

test("a queued message's paths are never resolved against this session", async () => {
  const s = scripted([]);
  const asked: string[] = [];
  const inner = s.ctx.readFile;
  const ctx: CliContext = {
    ...s.ctx,

    readFile: (absolutePath) => {
      asked.push(absolutePath);
      return inner(absolutePath);
    },
  };
  const { runner } = recordingRunner();

  try {
    await handleTui(ctx, s.io, runner, undefined, {}, undefined, queueOf(["@README.md"]));
    // The startup page legitimately reads config and providers, so the claim is
    // not "nothing was read" — it is that no mention in a queued message was
    // expanded. A queue message naming a file would otherwise reach into this
    // session's cwd and pull a file in that the person who sent it never saw.
    assert.deepEqual(asked.filter((path) => path.includes("README.md")), []);
  } finally {
    rmSync(s.root, { recursive: true, force: true });
  }
});
