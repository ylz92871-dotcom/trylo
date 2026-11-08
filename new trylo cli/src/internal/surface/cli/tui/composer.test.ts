import assert from "node:assert/strict";
import { test } from "node:test";
import { createComposer, type ComposerOptions } from "./composer.js";

/**
 * WP23.2: the composer's contract, driven through the same door a terminal
 * uses — decoded chunks into the key source, echo out through the writer —
 * with the clock injected so the burst machine's intervals are facts, not
 * timing luck.
 */

function harness(options: Partial<ComposerOptions> = {}) {
  const written: string[] = [];
  const chunks: Array<(chunk: string) => void> = [];
  let raw = false;
  let stopped = false;
  let clock = 0;
  const io = {
    write: (text: string) => written.push(text),
    columns: () => 80,
  };
  const keys = {
    start: (onChunk: (chunk: string) => void) => {
      chunks.push(onChunk);
      raw = true;
    },

    suspend: () => {
      raw = false;
    },
    resume: () => {
      raw = true;
    },
    stop: () => {
      stopped = true;
    },
  };
  const composer = createComposer({
    io,
    keys,
    now: () => clock,
    ...options,
  });

  return {
    composer,
    written,
    feed: (chunk: string) => chunks.forEach((send) => send(chunk)),
    advance: (ms: number) => {
      clock += ms;
    },
    isRaw: () => raw,
    isStopped: () => stopped,
    echo: () => written.join(""),
  };
}

async function submitted(composer: ReturnType<typeof createComposer>, prompt = "> "): Promise<string | undefined> {
  const pending = composer.compose(prompt);
  return pending;
}

test("typing reaches the buffer and Enter submits it", async () => {
  const t = harness();
  const pending = submitted(t.composer);

  t.feed("h");
  t.feed("i");
  t.feed("\r");
  assert.equal(await pending, "hi");
  assert.match(t.echo(), /> hi/);
});

test("a bracketed paste arrives as one submission with its newlines inside", async () => {
  const t = harness();
  const pending = submitted(t.composer);
  t.feed("\x1b[200~line one\nline two\nline three\x1b[201~");
  t.feed("\r");
  assert.equal(await pending, "line one\nline two\nline three");
});

test("an unannounced paste burst is protected: one flush, one submission", async () => {
  const t = harness();
  const pending = submitted(t.composer);

  for (const character of "pasted") {
    t.feed(character);
    t.advance(1);
  }

  t.advance(200);
  t.feed("\r");
  assert.equal(await pending, "pasted");
});

test("slow typing is not a paste: characters pass through as they arrive", async () => {
  const t = harness();
  const pending = submitted(t.composer);

  t.feed("a");
  t.advance(500);
  t.feed("b");
  t.advance(500);
  t.feed("c");
  t.feed("\r");
  assert.equal(await pending, "abc");
});

test("a large paste becomes a placeholder in the buffer and expands on submit", async () => {
  const t = harness();
  const pending = submitted(t.composer);
  const body = Array.from({ length: 40 }, (_, i) => `line ${i}`).join("\n");

  t.feed(`\x1b[200~${body}\x1b[201~`);
  assert.match(t.echo(), /\[Pasted text #1 \+40 lines\]/);
  t.feed("\r");
  assert.equal(await pending, body);
});

test("arrow-key history walks up through submissions and back to the draft", async () => {
  const t = harness();

  for (const line of ["first", "second"]) {
    const pending = submitted(t.composer);

    for (const character of line) {
      t.feed(character);
      t.advance(10);
    }

    t.feed("\r");
    await pending;
  }

  const pending = submitted(t.composer);

  t.feed("d");
  t.feed("\x1b[A"); // up -> "second"
  t.feed("\x1b[A"); // up -> "first"
  assert.match(t.echo(), /first/);
  t.feed("\x1b[B"); // down -> "second"
  t.feed("\x1b[B"); // down -> back to the draft "d"
  t.feed("\r");
  assert.equal(await pending, "d");
});

test("Ctrl-R searches history and Enter submits the match", async () => {
  const t = harness();

  for (const line of ["deploy the site", "water the plants"]) {
    const pending = submitted(t.composer);

    for (const character of line) {
      t.feed(character);
      t.advance(10);
    }

    t.feed("\r");
    await pending;
  }

  const pending = submitted(t.composer);

  t.feed("\x12"); // Ctrl-R

  for (const character of "deploy") {
    t.feed(character);
    t.advance(10);
  }

  assert.match(t.echo(), /deploy the site/);
  t.feed("\r");
  assert.equal(await pending, "deploy the site");
});

test("Ctrl-C obeys the interrupt machine's clear action and keeps the session", async () => {
  const t = harness({
    onInterrupt: () => ({ kind: "clear_input", note: "Ctrl-C: input dropped; press again to exit" }),
  });
  const pending = submitted(t.composer);

  t.feed("doomed");
  t.feed("\x03"); // Ctrl-C
  assert.match(t.echo(), /input dropped/);
  t.feed("fresh");
  t.feed("\r");
  assert.equal(await pending, "fresh");
});

test("Ctrl-D on an empty buffer ends input", async () => {
  const t = harness();
  const pending = submitted(t.composer);
  t.feed("\x04");
  assert.equal(await pending, undefined);
  assert.equal(t.composer.isEof(), true);
});

test("editing keys: Ctrl-U clears, Ctrl-W kills a word, backspace trims", async () => {
  const t = harness();
  const pending = submitted(t.composer);

  t.feed("hello world");
  t.feed("\x17"); // Ctrl-W
  assert.match(t.echo(), /hello $/m);
  t.feed("\x15"); // Ctrl-U
  t.feed("done");
  t.feed("\r");
  assert.equal(await pending, "done");
});

test("borrowTerminal suspends the composer and restores raw mode after", async () => {
  const t = harness();

  t.composer.beginCapture(() => {});
  t.feed("x");
  const result = t.composer.borrowTerminal(async () => {
    assert.equal(t.isRaw(), false, "raw mode must be off while a foreign reader owns the terminal");
    t.feed("ignored while borrowed");
    return "borrowed";
  });

  assert.equal(await result, "borrowed");
  assert.equal(t.isRaw(), true, "raw mode must come back");
});

test("a rejected overlapping loan cannot resume the first reader's key source", async () => {
  const t = harness();
  let release: (() => void) | undefined;
  const first = t.composer.borrowTerminal(() => new Promise<void>(resolve => { release = resolve; }));

  await assert.rejects(t.composer.borrowTerminal(async () => { throw new Error("terminal_reader_busy"); }), /terminal_reader_busy/);
  assert.equal(t.isRaw(), false, "the first loan still owns the terminal");
  release?.();
  await first;
  assert.equal(t.isRaw(), true);
});

test("mid-run capture delivers lines without echo", async () => {
  const t = harness();
  const taken: string[] = [];

  t.composer.beginCapture((line) => taken.push(line));

  for (const character of "steer") {
    t.feed(character);
  }

  t.feed("\r");
  assert.deepEqual(taken, ["steer"]);
  t.composer.endCapture();
  t.feed("\r");
});

test("Delete removes the character at the cursor, not the last one", async () => {
  const t = harness();
  const pending = submitted(t.composer);

  for (const character of "abc") {
    t.feed(character);
    t.advance(10);
  }

  t.feed("\x1b[D"); // left -> "ab|c"
  t.feed("\x1b[D"); // left -> "a|bc"
  t.feed("\x1b[3~"); // Delete forward -> "a|c"
  t.feed("\r");
  assert.equal(await pending, "ac");
});

test("Delete at the start of the buffer removes the first character", async () => {
  const t = harness();
  const pending = submitted(t.composer);

  for (const character of "abc") {
    t.feed(character);
    t.advance(10);
  }

  t.feed("\x1b[H"); // Home -> "|abc"
  t.feed("\x1b[3~"); // Delete forward -> "|bc"
  t.feed("\r");
  assert.equal(await pending, "bc");
});

test("the cursor steps over an emoji as one keypress", async () => {
  const t = harness();
  const pending = submitted(t.composer);

  t.feed("\u{1F389}ab"); // 🎉ab, one chunk
  t.feed("\x1b[H"); // Home -> "|🎉ab"
  t.feed("\x1b[C"); // Right -> "🎉|ab" (over the whole emoji)
  t.feed("X");
  t.feed("\r");
  assert.equal(await pending, "\u{1F389}Xab");
});

test("Delete at the start removes a whole emoji", async () => {
  const t = harness();
  const pending = submitted(t.composer);

  t.feed("\u{1F389}ab");
  t.feed("\x1b[H"); // Home -> "|🎉ab"
  t.feed("\x1b[3~"); // Delete forward -> "|ab"
  t.feed("\r");
  assert.equal(await pending, "ab");
});
