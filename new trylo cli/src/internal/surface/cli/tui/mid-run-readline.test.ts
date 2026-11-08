import assert from "node:assert/strict";
import readline from "node:readline";
import { PassThrough } from "node:stream";
import { test } from "node:test";
import type { AddressedUserInput } from "../../../domain/input-queue.js";
import { EXIT_CODES } from "../../../protocol/cli-stream.js";
import { emptyInterruptState } from "./interrupt.js";
import type { InterruptHub } from "./interrupt-hub.js";
import type { TuiIo } from "./io.js";
import { createMidRunInput, type MidRunInput } from "./mid-run-input.js";
import type { Painter } from "./painter.js";
import { emptyTuiState } from "./state.js";
import { tuiTurn, type TuiTurnRunner, type TurnStep } from "./turn.js";
import type { RunScaffold } from "../run-command.js";
import { noPaint } from "./theme.js";

/**
 * The same reader, over a line source that behaves like a terminal.
 *
 * `mid-run-input.test.ts` drives the reader through a scripted line source: one
 * call, one line, in order. That model is convenient and it is *wrong* about the
 * one thing this package most needs to be right about. A real terminal line
 * source (`node:readline`, and the `ctx.readLine` in `cmd/trylo/main.ts` built on
 * it) has no cancel and no queue: two outstanding `question()` calls on one
 * interface mean the **first** one takes every line and the second never
 * resolves at all. A scripted source cannot show that — it has no notion of two
 * readers at once.
 *
 * So this file talks to a real `readline.Interface` over a stream, and walks the
 * shell's actual rhythm: a turn starts, the person types while it runs, the turn
 * ends, the prompt reads, the next turn starts. If the reader ever stops being
 * the shell's single reader, the prompt read below does not return a line — it
 * simply never answers, which is what a frozen shell looks like from inside.
 */

/**
 * A deadline, so a frozen reader is a failing assertion rather than a hang.
 *
 * The timer is deliberately *not* unref'd. A readline read on a plain stream
 * holds no libuv handle, so an unref'd deadline would let the event loop drain
 * and the runner would report "the event loop has already resolved" — which says
 * nothing about which behaviour failed. A ref'd timer keeps the loop alive long
 * enough for `LATE` to be the verdict.
 */
const DEADLINE_MS = 2_000;

type Terminal = {
  readonly io: TuiIo;
  /** Type one line at whatever is currently reading, then let the reader settle. */
  readonly type: (line: string) => Promise<void>;
  readonly close: () => void;
};

function terminal(): Terminal {
  const input = new PassThrough();
  const output = new PassThrough();

  // The reader writes its prompt to `output`; nothing here displays it, but an
  // undrained stream would apply backpressure and stall the thing under test.
  output.resume();
  const rl = readline.createInterface({ input, output, terminal: false });

  return {
    io: {
      readLine: (prompt) =>
        new Promise<string | undefined>((resolve) => {
          let settled = false;
          const answer = (value: string | undefined): void => {
            if (!settled) {
              settled = true;
              resolve(value);
            }
          };

          rl.once("close", () => answer(undefined));
          rl.question(prompt ?? "", (line) => answer(line));
        }),
      write: () => {},
      size: () => ({ columns: 80, rows: 24 }),
    },

    type: async (line) => {
      input.write(`${line}\n`);
      await settle();
    },

    close: () => rl.close(),
  };
}

/** Let the reader's loop consume a line and park its next read. */
async function settle(times = 4): Promise<void> {
  for (let index = 0; index < times; index += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
}

async function withinDeadline<T>(promise: Promise<T>): Promise<T | "LATE"> {
  let timer: NodeJS.Timeout | undefined;
  const expiry = new Promise<"LATE">((resolve) => {
    timer = setTimeout(() => resolve("LATE"), DEADLINE_MS);
  });

  try {
    return await Promise.race([promise, expiry]);
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  }
}

function hubOf(): InterruptHub {
  return {
    armed: false,
    machine: emptyInterruptState,
    phase: "idle",
    cancelRequested: false,
    exitRequested: false,
    cancelTurn: undefined,
    notify: () => ({ kind: "none" }),
  };
}

const FACTS = {
  sessionId: "session-under-test",
  providerId: "fixture",
  model: "fixture/default",
  maxIterations: 32,
  contextTokenLimit: undefined,
};

function scaffoldOf(): RunScaffold {
  return {
    providerId: "fixture",
    providerKind: "fixture",
    model: "fixture/default",
    endpoint: "",
    format: "text",
    apiKey: undefined,
    workspaceRoot: ".",
    workspaceId: "workspace",
    checkpointRoot: ".trylo/checkpoints",
    sessionId: FACTS.sessionId,
    warnings: [],
    close: () => Promise.resolve(),
  };
}

function said(step: TurnStep, text: string): boolean {
  return step.state.lines.some((line) => line.text === text);
}

/**
 * One turn, through the real per-turn function. `asked` collects what the loop
 * would have received at its boundary, and `midRun` is what the person types
 * while the request is in flight.
 *
 * `askForInput: false` is the shape that matters for the leftover case: the turn
 * never reaches a boundary it could promote at, so whatever it was given is still
 * staged when it ends.
 */
async function runTurn(
  term: Terminal,
  mid: MidRunInput,
  turnId: string,
  asked: string[],
  midRun: () => Promise<void>,
  askForInput = true,
): Promise<TurnStep> {
  const runner: TuiTurnRunner = async (_scaffold, _text, _sink, _cancel, pending) => {
    await midRun();
    if (askForInput) {
      asked.push(...(pending?.(turnId) ?? []).map((input: AddressedUserInput) => input.text));
    }
    return { exitCode: 0, message: "the turn failed", hint: "try again" };
  };
  const painterRef: { current?: Painter | undefined } = {};

  return tuiTurn(
    term.io,
    runner,
    scaffoldOf(),
    emptyTuiState(FACTS),
    "the prompt line",
    hubOf(),
    noPaint,
    painterRef,
    mid,
  );
}

test("the prompt still reads after a turn ends, on a real line source", async () => {
  const term = terminal();
  try {
    const mid = createMidRunInput({ io: term.io });
    const asked: string[] = [];

    // Three turns, each: start, the person types mid-run, the turn ends, the
    // prompt reads. The failure this guards against is the prompt's read never
    // being answered from the second turn onward.
    for (let turn = 1; turn <= 3; turn += 1) {
      const step = await runTurn(term, mid, `turn-${turn}`, asked, async () => {
        await term.type(`words during turn ${turn}`);
      });

      assert.deepEqual(step.leftover, [], `turn ${turn} delivered everything it was given`);
      // Typed with no turn in flight: this is the line the prompt is waiting for.
      await term.type(`at the prompt after turn ${turn}`);
      const line = await withinDeadline(mid.takeLine());

      assert.equal(
        line,
        `at the prompt after turn ${turn}`,
        `the prompt never read after turn ${turn}; a second reader has taken the terminal`,
      );
    }

    assert.deepEqual(
      asked,
      ["words during turn 1", "words during turn 2", "words during turn 3"],
      "and every turn still received what was typed while it was running",
    );
  } finally {
    term.close();
  }
});

test("what a turn never took comes back, and the prompt keeps reading after it", async () => {
  const term = terminal();
  try {
    const mid = createMidRunInput({ io: term.io });
    const asked: string[] = [];
    // This turn never reaches a boundary it could ask at: its words are still
    // staged when it ends, which is what finishing early looks like.
    const step = await runTurn(
      term,
      mid,
      "turn-1",
      asked,
      async () => {
        await term.type("never asked for");
      },
      false,
    );

    assert.deepEqual(asked, [], "and this turn really did ask for nothing");
    assert.deepEqual(
      step.leftover,
      ["never asked for"],
      "the words the turn was handed and never took are handed back to the shell",
    );
    assert.ok(
      said(step, "not delivered (the turn ended first): never asked for"),
      "and the shell said on screen that they were not dropped",
    );

    // The reader is still the shell's: a line typed now reaches the prompt,
    // which is the shell's own read and nothing else's.
    await term.type("said at the prompt afterwards");
    const line = await withinDeadline(mid.takeLine());

    assert.equal(line, "said at the prompt afterwards");
  } finally {
    term.close();
  }
});

test("words typed during a cancelled turn come back, and the next turn can take them", async () => {
  const term = terminal();
  try {
    const mid = createMidRunInput({ io: term.io });
    const asked: string[] = [];

    // A turn that is cancelled mid-flight: the loop took the words, the turn
    // ended before a boundary could promote them, so it reports the debt.
    const cancelled: TurnStep = await tuiTurn(
      term.io,
      async (_scaffold, _text, _sink, _cancel, pending) => {
        await term.type("stop, do not do that");
        asked.push(...(pending?.("turn-1") ?? []).map((i: AddressedUserInput) => i.text));

        return {
          exitCode: EXIT_CODES.CANCELLED,
          result: {
            type: "run_result",
            status: "cancelled",
            finishReason: "cancelled",
            sessionId: FACTS.sessionId,
            turnId: "turn-1",
            iterations: 1,
            usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
            durationMs: 0,
            lastMessage: "",
          },
          transcript: [],
          view: undefined,
          warnings: [],
          unconsumedInput: [{ text: "stop, do not do that", mode: "steer", turnId: "turn-1" }],
        };
      },
      scaffoldOf(),
      emptyTuiState(FACTS),
      "do the thing",
      hubOf(),
      noPaint,
      {},
      mid,
    );

    // Taken by the loop, never promoted: it is the shell's debt now, and the
    // shell says so rather than the words evaporating with the cancelled engine.
    assert.deepEqual(asked, ["stop, do not do that"]);
    assert.deepEqual(cancelled.leftover, ["stop, do not do that"]);
    assert.ok(
      said(cancelled, "not delivered (the turn ended first): stop, do not do that"),
      "and the shell said the words were not dropped",
    );

    // Recoverable: the person runs them again, and this time a turn takes them.
    const resumed = await runTurn(term, mid, "turn-2", asked, async () => {
      await term.type("stop, do not do that");
    });

    assert.deepEqual(resumed.leftover, [], "the next turn delivered what it was handed");
    assert.deepEqual(
      asked,
      ["stop, do not do that", "stop, do not do that"],
      "and it reached the loop, once per turn that asked",
    );
  } finally {
    term.close();
  }
});

test("end of input on a real line source reaches the prompt, and stays there", async () => {
  const term = terminal();
  try {
    const mid = createMidRunInput({ io: term.io });

    // The interface closes under the reader: the read it was waiting on ends the
    // only way a terminal can end — with no more input.
    term.close();
    const first = await withinDeadline(mid.takeLine());

    assert.equal(first, undefined, "the prompt sees the end rather than hanging on it");
    const second = await withinDeadline(mid.takeLine());

    assert.equal(second, undefined, "and it does not start reading a stream that closed");
  } finally {
    term.close();
  }
});
