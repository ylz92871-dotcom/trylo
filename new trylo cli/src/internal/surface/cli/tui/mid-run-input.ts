import {
  admit,
  closeInbox,
  drainInbox,
  MAX_PENDING_INPUT,
  openInbox,
  type AddressedUserInput,
  type InputMode,
  type InputRejectReason,
  type UserInputInbox,
} from "../../../domain/input-queue.js";
import { readMultiLine } from "../multiline.js";
import type { TuiIo } from "./io.js";
import type { Composer } from "./composer.js";

/**
 * The shell's one line reader, which can also feed a running turn (WP08: C03,
 * C82, L42).
 *
 * Before this existed the shell's only reader sat in the prompt loop: it read a
 * line, handed it to a turn, and waited for that turn to finish before reading
 * again — so everything typed while a turn was running sat in the terminal's
 * own buffer and was delivered, all at once, as the *next* prompt. A person watching
 * a run go the wrong way had no way to say so.
 *
 * **Why this is one long-lived reader and not a second one that starts and
 * stops with a turn.** A first draft did exactly that, and it froze the shell:
 * the reader kept one `readLine` outstanding while the turn ran, and that read
 * could not be taken back when the turn ended. A probe of `node:readline` says
 * what happens then — with two `question()` calls outstanding on one interface,
 * the **first** waiter receives the line and the second never receives anything,
 * ever (`probe-readline2.cjs`: `pump: ["typed-at-the-prompt"] shell: []`,
 * `prompt settled: false` after a second line). The prompt would have starved
 * permanently after the very first turn. A terminal line source has no cancel,
 * so the only sound shape is one reader for the life of the shell: it owns every
 * read, and routes each line by whether a turn is in flight.
 *
 * Three facts make it safe to run beside a turn:
 *
 *  - **A line is taken once.** `drainInbox` empties what it hands over, so a
 *    second asking finds nothing rather than delivering the same words twice.
 *  - **Refusal has a reason.** A queue at its ceiling, a blank line, words typed
 *    after the turn closed — each is reported, because words dropped without a
 *    reason are words the person types again into a turn that cannot hear them
 *    either.
 *  - **Ending a turn is not discarding.** `end` hands back what was never taken,
 *    so a turn that ended with words still in its inbox gives them to the shell
 *    instead of garbage-collecting them.
 *
 * The turn's identity is *not* known when a line is typed — the run host mints
 * it — so typed lines are staged until the loop first asks, and the inbox is
 * opened in the name of the turn that asked. Staging is bounded by the same
 * ceiling as the inbox, so a person who keeps typing meets the same refusal a
 * queue would give them instead of an unbounded list.
 *
 * **Where the lines come from (WP23.2).** With a composer, the pump reads the
 * composer instead of `readLine`: at the prompt the composer draws and edits
 * (paste protection, history, history search), mid-run it captures drafts and
 * hands each line to `stage` through `beginCapture`. Without one — every test
 * that injects line IO, every non-terminal — the old `readLine` pump runs, byte
 * for byte as it was.
 *
 * Not solved here, and deliberately left to the composer itself: the drawing of
 * the line being typed. The composer owns prompt echo and exposes the mid-run
 * draft for the painter; this module only stages and delivers submitted words.
 */

export type MidRunInputOptions = {
  readonly io: TuiIo;
  /**
   * The prompt composer (WP23.2). Present, it is the source of every line and
   * the pump only orchestrates where each line goes; absent, lines come from
   * `io.readLine` as they always did.
   */
  readonly composer?: Composer;
  /**
   * What a line typed mid-run is. `steer` — the default, and the honest reading
   * of "the person typed while the run was busy" — takes every leading message
   * at the next safe boundary and forgives the steps already spent; `queue`
   * takes one per boundary and forgives nothing.
   */
  readonly mode?: InputMode;
};

/** What the running turn wants said on screen; this module decides nothing else. */
export type MidRunInputHooks = {
  readonly onQueued?: (count: number) => void;
  readonly onTaken: (texts: ReadonlyArray<string>) => void;
  readonly onRefused: (text: string, reason: InputRejectReason) => void;
};

export type MidRunInput = {
  /**
   * A turn is starting. From here until `end`, every line spoken goes to that
   * turn, and `hooks` are who hears what it made of them.
   */
  readonly begin: (hooks: MidRunInputHooks) => void;
  /**
   * A turn has ended: stop routing to it and hand back what it never took.
   * Empty is the common case and the good one — everything said was delivered.
   */
  readonly end: () => ReadonlyArray<AddressedUserInput>;
  /** The lender the loop asks; named for the turn that is asking. */
  readonly pendingInput: (turnId: string) => ReadonlyArray<AddressedUserInput>;
  /**
   * The shell's own read. Blocks until a line is spoken, or answers `undefined`
   * at end of input — the same way the prompt's reader always did.
   */
  readonly takeLine: () => Promise<string | undefined>;
  /** How many words are still owed to the turn in flight; for the queue projection. */
  readonly waiting: () => number;
};

/**
 * How the shell gets its reader.
 *
 * A factory rather than one object passed in because only the composition root
 * knows which terminal this shell is attached to, and because absent — every
 * caller that wants no mid-run input, which is every test and every
 * non-interactive surface — must leave the shell's own reading exactly as it
 * was. One call, one reader, one `readLine` outstanding for the whole session.
 */
export type MidRunInputFactory = () => MidRunInput;

export function createMidRunInput(options: MidRunInputOptions): MidRunInput {
  const mode = options.mode ?? "steer";
  const io = options.io;
  const composer = options.composer;
  let hooks: MidRunInputHooks | undefined;
  let inbox: UserInputInbox | undefined;
  let staged: ReadonlyArray<string> = [];
  let live = false;
  let eof = false;
  /** True when the next read is the first line of a fresh prompt, not a `\\` continuation. */
  let atPromptStart = true;
  const backlog: string[] = [];
  const waiters: Array<(line: string | undefined) => void> = [];

  /**
   * The prompt shown for one raw read. `"> "` only where it used to be: first
   * line at the prompt, and never while a turn is drawing its own frame.
   */
  const promptFor = (): string => {
    if (live || !atPromptStart) {
      return "";
    }
    atPromptStart = false;
    return "> ";
  };

  /**
   * Hand a line to the prompt: whoever is waiting, or the backlog, or nobody.
   *
   * End of input is a *state*, not a delivery: it is recorded even when a waiter
   * takes it, because a reader that only told the first person who asked would
   * leave the next one waiting on a stream that can never answer again.
   */
  const handToPrompt = (line: string | undefined): void => {
    if (line === undefined) {
      eof = true;
    }

    const waiter = waiters.shift();
    if (waiter !== undefined) {
      atPromptStart = true;
      waiter(line);
      return;
    }

    if (line !== undefined) {
      backlog.push(line);
    }
  };

  const stage = (text: string): void => {
    if (text.trim().length === 0) {
      hooks?.onRefused(text, "blank");
      return;
    }

    if (staged.length >= MAX_PENDING_INPUT) {
      hooks?.onRefused(text, "full");
      return;
    }

    staged = [...staged, text];
    hooks?.onQueued?.(staged.length + (inbox?.items.length ?? 0));
  };

  /**
   * One loop, for the life of the shell, when lines come from `readLine` (no
   * composer): a terminal line source has no cancel, so the read it is parked
   * on is the shell's read, and there is never a second one behind it.
   *
   * With a composer there is deliberately no background loop: `takeLine`
   * composes directly, and mid-run lines arrive through `beginCapture`'s
   * callback. A pump would race the turn — between a resolved prompt and
   * `begin` it would compose a phantom prompt into the turn's frame.
   */
  const pump = async (): Promise<void> => {
    for (;;) {
      let line: string | undefined;

      try {
        line = await readMultiLine(() => io.readLine(promptFor()));
      } catch {
        // A reader that broke is a reader that reached its end: the words
        // already taken stay taken, and the shell meets the same end of input at
        // its own prompt, which is where leaving the session has always been
        // decided.
        handToPrompt(undefined);
        return;
      }

      if (line === undefined) {
        handToPrompt(undefined);
        return;
      }

      if (live) {
        stage(line);
        continue;
      }

      handToPrompt(line);
    }
  };

  if (composer === undefined) {
    // Deliberately not awaited: the reader runs beside the shell, and nothing
    // it does is allowed to hold a turn up.
    void pump();
  }

  return {
    begin: (next) => {
      hooks = next;
      inbox = undefined;
      staged = [];
      live = true;
      atPromptStart = true;
      // Mid-run lines stop being composed and start being captured: the turn's
      // frame owns the screen, so the composer goes silent (WP23.2).
      composer?.beginCapture((line) => stage(line));
    },

    end: () => {
      live = false;
      atPromptStart = true;
      hooks = undefined;
      composer?.endCapture();
      const held = staged;

      staged = [];
      const current = inbox;

      inbox = undefined;
      const kept = held.map((text) => ({ text, mode }));

      if (current === undefined) {
        return kept;
      }

      return [...closeInbox(current).unconsumed, ...kept];
    },

    pendingInput: (turnId) => {
      // Opened in the name of the turn that asked, which is the first moment
      // anybody knows its name: words staged before then were typed during it,
      // so they are this turn's, and nobody else's.
      if (inbox === undefined) {
        inbox = openInbox(turnId);
      }

      if (inbox.turnId !== turnId) {
        // Words held for a turn that is not the one asking: none of them are
        // this turn's to take.
        return [];
      }

      for (const text of staged) {
        const verdict = admit(inbox, { text, mode, turnId });
        inbox = verdict.inbox;
        if (verdict.kind === "rejected") {
          hooks?.onRefused(text, verdict.reason);
        }
      }

      staged = [];
      const drained = drainInbox(inbox);

      inbox = drained.inbox;

      if (drained.taken.length > 0) {
        hooks?.onTaken(drained.taken.map((input) => input.text));
      }

      return drained.taken;
    },

    takeLine: async () => {
      if (composer !== undefined) {
        // Typeahead from between the prompts comes first, then a fresh
        // composition. End of input is the composer's Ctrl-D on an empty line.
        const pending = composer.takePending();
        if (pending !== undefined) {
          return pending;
        }

        if (composer.isEof()) {
          return undefined;
        }

        const line = await composer.compose(promptFor());

        atPromptStart = true;

        return line;
      }

      const first = backlog.shift();
      if (first !== undefined) {
        atPromptStart = true;
        return first;
      }

      if (eof) {
        return undefined;
      }

      return new Promise<string | undefined>((resolve) => {
        waiters.push(resolve);
      });
    },

    waiting: () => staged.length + (inbox?.items.length ?? 0),
  };
}
