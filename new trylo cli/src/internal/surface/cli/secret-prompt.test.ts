import assert from "node:assert/strict";
import { test } from "node:test";
import { readSecretLine, type SecretTerminal } from "./secret-prompt.js";

/**
 * Contract for reading a login secret off a terminal (WP §0 F1).
 *
 * The leak this closes is the terminal driver's echo, which no context sink can
 * see: a readline interface with `terminal: false` silences *readline* and
 * leaves the driver printing every keystroke onto the screen. So these tests
 * drive a fake terminal that records the mode changes, spy on the process's own
 * output streams, and assert that the bytes the user typed reached neither.
 *
 * No pty and no child process: the reader takes an injected terminal, so the
 * "never echoed" property is testable on a machine without a console.
 */

type FakeTerminal = SecretTerminal & {
  /** Delivers bytes exactly as the terminal driver would. */
  readonly feed: (text: string) => void;
  /** Delivers end of input, which is a refusal and not an empty secret. */
  readonly close: () => void;
  /** Every raw-mode request, in order. */
  readonly modes: boolean[];
};

function fakeTerminal(options: { readonly rawModeAvailable?: boolean } = {}): FakeTerminal {
  const listeners = new Map<string, Array<(chunk: Buffer) => void>>();
  const modes: boolean[] = [];
  const emit = (event: string, chunk: Buffer) => {
    for (const listener of [...(listeners.get(event) ?? [])]) {
      listener(chunk);
    }
  };
  const terminal: FakeTerminal = {
    ...(options.rawModeAvailable === false
      ? {}
      : {
          setRawMode: (mode: boolean) => {
            modes.push(mode);
          },
        }),
    resume: () => undefined,
    pause: () => undefined,

    on: (event, listener) => {
      listeners.set(event, [...(listeners.get(event) ?? []), listener]);
      return terminal;
    },

    off: (event, listener) => {
      listeners.set(
        event,
        (listeners.get(event) ?? []).filter((each) => each !== listener),
      );
      return terminal;
    },

    feed: (text) => {
      emit("data", Buffer.from(text, "utf8"));
    },
    close: () => {
      emit("end", Buffer.alloc(0));
    },
    modes,
  };

  return terminal;
}

/**
 * Runs `read` with both process output streams captured.
 *
 * The cast is forced by Node's overloaded `write`, and the capture is the point
 * of the test: if the reader ever grew an echo, this is what would see it.
 */
async function withOutputCapture<T>(
  read: () => Promise<T>,
): Promise<{ readonly value: T; readonly output: string }> {
  const captured: string[] = [];
  const capture = (chunk: unknown): boolean => {
    captured.push(String(chunk));
    return true;
  };
  const stdoutWrite = process.stdout.write;
  const stderrWrite = process.stderr.write;

  process.stdout.write = capture as typeof process.stdout.write;
  process.stderr.write = capture as typeof process.stderr.write;

  try {
    return { value: await read(), output: captured.join("") };
  } finally {
    process.stdout.write = stdoutWrite;
    process.stderr.write = stderrWrite;
  }
}

test("a typed secret is returned and never written to the process output", async () => {
  const terminal = fakeTerminal();
  const { value, output } = await withOutputCapture(() => {
    const pending = readSecretLine(terminal);
    terminal.feed("sk-typed-once");
    terminal.feed("\r");
    return pending;
  });

  assert.equal(value, "sk-typed-once");
  assert.equal(output.includes("sk-typed-once"), false);
  assert.deepEqual(terminal.modes, [true, false], "raw mode is entered, then restored");
});

test("Ctrl-C cancels the read and still restores the terminal", async () => {
  const terminal = fakeTerminal();
  const { value, output } = await withOutputCapture(() => {
    const pending = readSecretLine(terminal);
    terminal.feed("half-a-secret");
    terminal.feed("\u0003");
    return pending;
  });

  assert.equal(value, undefined, "a cancelled prompt is not an empty secret");
  assert.equal(output.includes("half-a-secret"), false);
  assert.deepEqual(terminal.modes, [true, false]);
});

test("a terminal that cannot turn echo off is refused, not read in the clear", async () => {
  const terminal = fakeTerminal({ rawModeAvailable: false });
  const { value } = await withOutputCapture(() => {
    const pending = readSecretLine(terminal);
    terminal.feed("sk-should-never-be-read");
    return pending;
  });

  assert.equal(value, undefined);
  assert.deepEqual(terminal.modes, []);
});

test("backspace edits the secret instead of printing it", async () => {
  const terminal = fakeTerminal();
  const { value, output } = await withOutputCapture(() => {
    const pending = readSecretLine(terminal);
    terminal.feed("wipe\u007f\u007f\u007f\u007f");
    terminal.feed("key\r");
    return pending;
  });

  assert.equal(value, "key");
  assert.equal(output.includes("wipe"), false);
  assert.deepEqual(terminal.modes, [true, false]);
});

test("end of input resolves as a refusal rather than blocking", async () => {
  const terminal = fakeTerminal();
  const { value } = await withOutputCapture(() => {
    const pending = readSecretLine(terminal);
    terminal.close();
    return pending;
  });

  assert.equal(value, undefined);
  assert.deepEqual(terminal.modes, [true, false], "raw mode never stays on after a refusal");
});
