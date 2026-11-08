import assert from "node:assert/strict";
import { test } from "node:test";
import { createProcessContext } from "./main.js";

/**
 * The process's interrupt surface (WP `2026-09-16-WP-传统CLI-交付面收尾波` D2).
 *
 * An interrupt is the one thing a terminal sends that nothing below the root can
 * observe, so the capability is built in `main.ts` and nowhere else. What can be
 * pinned without a terminal is the laziness
 * (no SIGINT listener until somebody asks) and that SIGINT really is what the
 * observers are called by.
 *
 * Not pinned here, and not claimed: that a real terminal turns Ctrl-C into
 * SIGINT. That is the OS's promise, and this build relies on it rather than
 * reimplementing it with a raw-mode reader.
 */

type Interrupts = NonNullable<ReturnType<typeof createProcessContext>["interrupts"]>;

function withFakedTty<T>(value: boolean, body: () => T): T {
  const stdin = process.stdin as unknown as { isTTY?: boolean };
  const original = Object.getOwnPropertyDescriptor(stdin, "isTTY");

  Object.defineProperty(stdin, "isTTY", { value, configurable: true });

  try {
    return body();
  } finally {
    if (original === undefined) {
      delete stdin.isTTY;
    } else {
      Object.defineProperty(stdin, "isTTY", original);
    }
  }
}

/** Runs `body` and then uninstalls exactly the SIGINT listeners it added. */
function withScopedSigint<T>(body: () => T): T {
  const before = process.listeners("SIGINT");
  try {
    return body();
  } finally {
    for (const listener of process.listeners("SIGINT")) {
      if (!before.includes(listener)) {
        process.off("SIGINT", listener);
      }
    }
  }
}

test("a piped run can observe SIGINT and detach its observer after the run", () => {
  withScopedSigint(() => {
    const before = process.listenerCount("SIGINT");
    const ctx = withFakedTty(false, () => createProcessContext());
    const interrupts = ctx.interrupts;

    assert(interrupts);
    assert.equal(process.listenerCount("SIGINT"), before);
    let seen = 0;
    const observer = () => { seen += 1; };

    interrupts.observe(observer);
    process.emit("SIGINT");
    assert.equal(seen, 1);
    interrupts.unobserve?.(observer);
    assert.equal(process.listenerCount("SIGINT"), before);
  });
});

test("a terminal gets the surface, and SIGINT is hooked only when somebody asks", () => {
  withScopedSigint(() => {
    const before = process.listenerCount("SIGINT");
    const ctx = withFakedTty(true, () => createProcessContext());
    const interrupts: Interrupts | undefined = ctx.interrupts;

    assert.notEqual(interrupts, undefined);

    if (interrupts === undefined) {
      return;
    }

    assert.equal(process.listenerCount("SIGINT"), before, "asking is what installs it, not building the context");
    const seen: string[] = [];

    interrupts.observe(() => seen.push("first"));
    assert.equal(process.listenerCount("SIGINT"), before + 1);
    interrupts.observe(() => seen.push("second"));
    assert.equal(process.listenerCount("SIGINT"), before + 1, "one listener serves however many observers");
    process.emit("SIGINT");
    assert.deepEqual(seen, ["first", "second"]);
    assert.equal(typeof interrupts.exit, "function");
  });
});
