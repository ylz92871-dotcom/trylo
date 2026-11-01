import assert from "node:assert/strict";
import { test } from "node:test";
import { createGitRunner } from "./runner.js";

/**
 * WP11.1: the git subprocess runner, driven through its spawn seam.
 *
 * Red evidence: new module (import fails pre-WP11). No real git is spawned
 * by any case here; the seam script exits, output and errors.
 */

type Listener = (chunk?: unknown) => void;

function fakeChild(script: { exit: number | null; stdout?: string; stderr?: string; error?: Error }) {
  const listeners = new Map<string, Listener[]>();
  const outListeners: Listener[] = [];
  const errListeners: Listener[] = [];
  const child = {
    stdout: {
      on(event: string, listener: Listener): void {
        if (event === "data") {
          outListeners.push(listener);
        }
      },
    },
    stderr: {
      on(event: string, listener: Listener): void {
        if (event === "data") {
          errListeners.push(listener);
        }
      },
    },
    on(event: string, listener: Listener): void {
      listeners.set(event, [...(listeners.get(event) ?? []), listener]);
    },
    kill(): void {
      for (const listener of listeners.get("close") ?? []) {
        listener(null);
      }
    },
  };
  return {
    child,
    start(): void {
      queueMicrotask(() => {
        if (script.error !== undefined) {
          for (const listener of listeners.get("error") ?? []) {
            listener(script.error);
          }
          return;
        }
        if (script.stdout !== undefined) {
          for (const listener of outListeners) {
            listener(script.stdout);
          }
        }
        if (script.stderr !== undefined) {
          for (const listener of errListeners) {
            listener(script.stderr);
          }
        }
        for (const listener of listeners.get("close") ?? []) {
          listener(script.exit);
        }
      });
    },
  };
}

test("exits and output resolve, spawn errors reject", async () => {
  const ok = fakeChild({ exit: 1, stdout: "--- a/f.ts\n" });
  const runner = createGitRunner({
    spawnImpl: () => {
      ok.start();
      return ok.child as never;
    },
  });
  const result = await runner.run(["git", "diff"], "/work");
  assert.deepEqual(result, { exit: 1, stdout: "--- a/f.ts\n", stderr: "" });

  const failing = fakeChild({ exit: null, error: new Error("spawn git ENOENT") });
  const missing = createGitRunner({
    spawnImpl: () => {
      failing.start();
      return failing.child as never;
    },
  });
  await assert.rejects(missing.run(["git", "diff"], "/work"), /ENOENT/);
});

test("empty argv is refused before spawning", async () => {
  const runner = createGitRunner({
    spawnImpl: () => {
      throw new Error("must not spawn");
    },
  });
  await assert.rejects(runner.run([], "/work"), /empty argv/);
});

test("background git preserves output and cancellation without a Windows console", async () => {
  const ok = fakeChild({ exit: 0, stdout: "diff content\n" });
  const controller = new AbortController();
  const runner = createGitRunner({
    spawnImpl: (_file, _argv, options) => {
      assert.equal("windowsHide" in options && options.windowsHide, true);
      assert.equal(options.signal, controller.signal);
      assert.deepEqual(options.env, { GIT_OPTIONAL_LOCKS: "0" });
      ok.start();
      return ok.child as never;
    },
  });
  const result = await runner.run(["git", "diff"], "/work", {
    signal: controller.signal,
    env: { GIT_OPTIONAL_LOCKS: "0" },
  });
  assert.deepEqual(result, { exit: 0, stdout: "diff content\n", stderr: "" });
});
