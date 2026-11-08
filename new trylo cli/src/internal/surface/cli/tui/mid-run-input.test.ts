import assert from "node:assert/strict";
import { test } from "node:test";
import {
  MAX_PENDING_INPUT,
  type AddressedUserInput,
} from "../../../domain/input-queue.js";
import { EXIT_CODES } from "../../../protocol/cli-stream.js";
import { emptyInterruptState } from "./interrupt.js";
import type { InterruptHub } from "./interrupt-hub.js";
import type { TuiIo } from "./io.js";
import { createMidRunInput, type MidRunInputHooks } from "./mid-run-input.js";
import type { Painter } from "./painter.js";
import { emptyTuiState, type TuiState } from "./state.js";
import { tuiTurn, type TuiTurnRunner } from "./turn.js";
import type { RunScaffold } from "../run-command.js";
import { noPaint } from "./theme.js";

/**
 * The shell's reader, and the turn it feeds (WP08: C03, C82, L42).
 *
 * Two halves. The first is the reader on its own, driven by a line source this
 * test controls: what it takes, what it refuses, and what it hands back when the
 * turn stops asking. The second is the wiring — a turn that is handed a lender
 * actually reaches the loop with what the person said, and what it never
 * answered comes back out instead of disappearing.
 *
 * The line source is deliberately *not* a list of answers: a real terminal
 * blocks until a person presses Enter, and a fake that answers instantly would
 * model a machine typing faster than the turn can ask — which is how a first
 * draft of this feature made a turn of 1364 provider requests.
 *
 * It also counts outstanding reads, because that number is the defect this
 * design exists to prevent: with two reads outstanding on one terminal line
 * source the first one takes every line forever and the shell starves.
 */

type LineSource = {
  readonly io: TuiIo;
  /** Hand one line to whoever is reading. Throws if nobody is. */
  readonly say: (line: string | undefined) => Promise<void>;
  /** How many reads are waiting right now. */
  readonly waiting: () => number;
  /** The most reads that were ever waiting at once. Must stay at one. */
  readonly peak: () => number;
};

function lineSource(sink: string[] = []): LineSource {
  const readers: Array<(line: string | undefined) => void> = [];
  let peak = 0;

  return {
    io: {
      readLine: () => {
        peak = Math.max(peak, readers.length + 1);
        return new Promise<string | undefined>((resolve) => {
          readers.push(resolve);
        });
      },

      write: (text) => sink.push(text),
      size: () => ({ columns: 80, rows: 24 }),
    },

    say: async (line) => {
      const reader = readers.shift();
      assert.notEqual(reader, undefined, "nobody is reading; the shell has no outstanding read");
      reader?.(line);
      // One turn of the event loop is what the reader needs to route what it
      // was handed; the pump is deliberately not awaited by its owner.
      await new Promise((resolve) => setImmediate(resolve));
    },

    waiting: () => readers.length,
    peak: () => peak,
  };
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

function stateOf(): TuiState {
  return emptyTuiState(FACTS);
}

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

function hooksOf(): {
  readonly taken: string[];
  readonly refused: Array<{ readonly text: string; readonly reason: string }>;
  readonly hooks: MidRunInputHooks;
} {
  const taken: string[] = [];
  const refused: Array<{ readonly text: string; readonly reason: string }> = [];

  return {
    taken,
    refused,
    hooks: {
      onTaken: (texts) => taken.push(...texts),
      onRefused: (text, reason) => refused.push({ text, reason }),
    },
  };
}

test("a line typed while a turn runs is handed to that turn, once", async () => {
  const source = lineSource();
  const seen = hooksOf();
  const mid = createMidRunInput({ io: source.io });

  mid.begin(seen.hooks);
  assert.equal(source.waiting(), 1, "the reader is waiting from the moment it exists");
  await source.say("STOP: do not call that tool again");
  const first = mid.pendingInput("turn-1");

  assert.deepEqual(
    first.map((input) => input.text),
    ["STOP: do not call that tool again"],
  );
  assert.deepEqual(mid.pendingInput("turn-1"), [], "a second asking must not deliver it twice");
  assert.deepEqual(seen.taken, ["STOP: do not call that tool again"]);
  assert.deepEqual(seen.refused, []);
});

test("a turn that is not the one the words were typed for is handed nothing", async () => {
  const source = lineSource();
  const seen = hooksOf();
  const mid = createMidRunInput({ io: source.io });

  mid.begin(seen.hooks);
  await source.say("meant for turn-1");
  // The inbox is opened in the name of the turn that asks, so the words are
  // turn-1's: a late arrival from the turn before cannot reach this one.
  assert.deepEqual(mid.pendingInput("turn-1").map((input) => input.text), ["meant for turn-1"]);
  await source.say("meant for turn-2 as well");
  assert.deepEqual(mid.pendingInput("turn-2"), [], "and nothing leaks across turns");
});

test("a blank line and an overflowing queue are refused with a reason, not dropped", async () => {
  const source = lineSource();
  const seen = hooksOf();
  const mid = createMidRunInput({ io: source.io });

  mid.begin(seen.hooks);
  await source.say("   ");
  assert.deepEqual(seen.refused, [{ text: "   ", reason: "blank" }]);

  for (let index = 0; index <= MAX_PENDING_INPUT; index += 1) {
    await source.say(`line-${index}`);
  }

  assert.deepEqual(
    seen.refused.at(-1),
    { text: `line-${MAX_PENDING_INPUT}`, reason: "full" },
    "the ceiling is said out loud rather than quietly absorbing the words",
  );
});

test("ending a turn hands back what was never taken, instead of discarding it", async () => {
  const source = lineSource();
  const seen = hooksOf();
  const mid = createMidRunInput({ io: source.io });

  mid.begin(seen.hooks);
  await source.say("taken");
  mid.pendingInput("turn-1");
  await source.say("never taken");
  const back = mid.end();

  assert.deepEqual(
    back.map((input) => input.text),
    ["never taken"],
    "a turn that ended with words in its inbox gives them back",
  );
});

test("a line typed after the turn ended is kept for the prompt, not thrown away", async () => {
  const source = lineSource();
  const seen = hooksOf();
  const mid = createMidRunInput({ io: source.io });

  mid.begin(seen.hooks);
  await source.say("in the inbox when the turn ended");
  assert.deepEqual(
    mid.end().map((input) => input.text),
    ["in the inbox when the turn ended"],
  );
  // Spoken with no turn listening: it waits for the shell's own prompt, which
  // is the one reader that will be reading next.
  await source.say("spoken into the silence after it");
  assert.equal(await mid.takeLine(), "spoken into the silence after it");
  mid.begin(seen.hooks);
  await source.say("for the next turn");
  assert.deepEqual(mid.pendingInput("turn-2").map((input) => input.text), ["for the next turn"]);
});

test("the shell never holds two reads at once, so the prompt can never starve", async () => {
  // The defect this design exists to prevent. A reader that started and stopped
  // with each turn left a read parked that could not be taken back, and a
  // `node:readline` interface hands every subsequent line to the *first*
  // waiter — so the prompt would never hear another line after turn one.
  const source = lineSource();
  const seen = hooksOf();
  const mid = createMidRunInput({ io: source.io });

  for (let turn = 0; turn < 3; turn += 1) {
    mid.begin(seen.hooks);
    await source.say(`during turn ${turn}`);
    mid.pendingInput(`turn-${turn}`);
    mid.end();
    await source.say(`at the prompt after turn ${turn}`);
    assert.equal(
      await mid.takeLine(),
      `at the prompt after turn ${turn}`,
      "the prompt still hears lines after a turn has ended",
    );
  }

  assert.equal(source.waiting(), 1, "exactly one read is parked, never zero and never two");
  assert.ok(source.peak() <= 1, `no second read was ever opened (peak ${source.peak()})`);
});

test("end of input reaches the prompt, and stays end of input", async () => {
  const source = lineSource();
  const mid = createMidRunInput({ io: source.io });

  mid.begin(hooksOf().hooks);
  await source.say(undefined);
  assert.equal(await mid.takeLine(), undefined, "the prompt sees the same end of input");
  assert.equal(await mid.takeLine(), undefined, "and it does not start reading a closed stream");
  assert.equal(source.waiting(), 0, "nothing is parked on a stream that closed");
});

/** The lender a turn is handed: a function of the turn that is asking. */
type Lender = (turnId: string) => ReadonlyArray<AddressedUserInput>;

/** A door the test opens when it wants the turn to go on; no timers, no races. */
function gate(): { readonly wait: Promise<void>; readonly open: () => void } {
  let open = (): void => {};
  const wait = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { wait, open: () => open() };
}

/**
 * The wiring, through the real per-turn function.
 *
 * The runner stands in for the run host and is handed the lender exactly as the
 * loop is — a function of the turn's name, called while the request is in
 * flight. The gate is what makes that true here: the turn is already running
 * when the words are typed, which is the only situation this package exists
 * for.
 */
async function runOneTurnWith(
  source: LineSource,
  turn: (pending: Lender | undefined) => Promise<void>,
): Promise<{ readonly leftover: ReadonlyArray<string>; readonly state: TuiState }> {
  const runner: TuiTurnRunner = async (_scaffold, _text, _sink, _cancel, pending) => {
    await turn(pending);
    return { exitCode: 0, message: "the turn failed", hint: "try again" };
  };
  const painterRef: { current?: Painter | undefined } = {};
  const step = await tuiTurn(
    source.io,
    runner,
    scaffoldOf(),
    stateOf(),
    "the prompt line",
    hubOf(),
    noPaint,
    painterRef,
    createMidRunInput({ io: source.io }),
  );

  return { leftover: step.leftover, state: step.state };
}

function said(state: TuiState, text: string): boolean {
  return state.lines.some((line) => line.text === text);
}

test("a turn run by the shell is handed what the person typed while it ran", async () => {
  const source = lineSource();
  const held = gate();
  let taken: ReadonlyArray<string> = [];
  const running = runOneTurnWith(source, async (pending) => {
    assert.notEqual(pending, undefined, "a shell turn is handed a lender for its own words");
    await held.wait;
    taken = pending?.("turn-under-test").map((input) => input.text) ?? [];
  });

  // While the turn is in flight the shell keeps hearing: this is the whole
  // point, and it is what no surface did before this package.
  await source.say("only answer OK from here on");
  held.open();
  const step = await running;

  assert.deepEqual(taken, ["only answer OK from here on"]);
  assert.deepEqual(step.leftover, [], "and nothing was left unheard");
  assert.ok(
    said(step.state, "taken into this turn: only answer OK from here on"),
    "and the shell says on screen that the words went into the running turn",
  );
});

test("words a turn never took come back out for the prompt to run", async () => {
  const source = lineSource();
  const held = gate();
  const running = runOneTurnWith(source, async (pending) => {
    // Handed a lender and never asking it: the words sit staged, which is what
    // a turn that finishes before the next safe boundary looks like.
    assert.notEqual(pending, undefined);
    await held.wait;
  });

  await source.say("never asked for");
  held.open();
  const step = await running;

  assert.deepEqual(step.leftover, ["never asked for"]);
  assert.ok(
    said(step.state, "not delivered (the turn ended first): never asked for"),
    "and the shell says on screen that the words were not dropped",
  );
});

test("what the loop took from the reader and never promoted comes back too", async () => {
  // The other half of "nothing is dropped". A turn can hand a message to the
  // loop and end before the loop reaches a boundary that could promote it — the
  // reader no longer holds it, and the loop owes it. The loop says so in
  // `unconsumedInput`, and the shell must put it back where the person hears it
  // answered (WP08.3).
  const source = lineSource();
  const runner: TuiTurnRunner = async (scaffold, _text, _sink, _cancel, pending) => {
    pending?.("turn-under-test");
    return {
      exitCode: EXIT_CODES.OK,
      result: {
        type: "run_result",
        status: "cancelled",
        finishReason: "cancelled",
        sessionId: scaffold.sessionId,
        turnId: "turn-under-test",
        iterations: 1,
        usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
        durationMs: 0,
        lastMessage: "",
      },
      transcript: [],
      view: undefined,
      warnings: [],
      unconsumedInput: [
        { text: "taken by the loop, never promoted", mode: "steer", turnId: "turn-under-test" },
      ],
    };
  };
  const painterRef: { current?: Painter | undefined } = {};
  const step = await tuiTurn(
    source.io,
    runner,
    scaffoldOf(),
    stateOf(),
    "the prompt line",
    hubOf(),
    noPaint,
    painterRef,
    createMidRunInput({ io: source.io }),
  );

  assert.deepEqual(step.leftover, ["taken by the loop, never promoted"]);
  assert.ok(
    said(step.state, "not delivered (the turn ended first): taken by the loop, never promoted"),
    "the debt is said on screen rather than settling silently",
  );
});

test("a shell that never opted in runs a turn with no second reader at all", async () => {
  const source = lineSource();
  let handed: Lender | undefined = () => [];
  const runner: TuiTurnRunner = async (_scaffold, _text, _sink, _cancel, pending) => {
    handed = pending;
    return { exitCode: 0, message: "the turn failed", hint: "try again" };
  };
  const painterRef: { current?: Painter | undefined } = {};
  const step = await tuiTurn(
    source.io,
    runner,
    scaffoldOf(),
    stateOf(),
    "the prompt line",
    hubOf(),
    noPaint,
    painterRef,
  );

  // Absent is off, not "on with an empty queue": every caller written before
  // this package gets no lender and no reader, and nothing is left over.
  assert.equal(handed, undefined);
  assert.equal(source.waiting(), 0, "nobody borrowed the terminal");
  assert.deepEqual(step.leftover, []);
});
