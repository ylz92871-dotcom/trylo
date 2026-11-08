import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createWorkspaceSandbox } from "../../sandbox/index.js";
import { resolveShellMode, type ShellModeResult } from "../../sandbox/shell-mode.js";
import type { ShellEnvironment } from "../../sandbox/shell-detect.js";
import { createNodeSpawner } from "./shell-spawn.js";
import { createMutatingTools } from "./index.js";
import { RUN_SHELL_TOOL } from "./names.js";

/**
 * A shell that actually interprets (WP05 C06/C07, production reachability).
 *
 * Planning tests prove the shape; these prove the run: a resolved interpreter
 * receives the whole string and its operators work, while an unresolvable or
 * mis-composed call fails before any process exists. The first two tests run
 * a real shell on this machine — the same live-process posture as the c09
 * evidence suites — because a shell path proven only against a recording
 * spawner would prove the argv, not the interpreting.
 */

function surface(): ShellEnvironment {
  return {
    platform: process.platform,
    env: { ...process.env },
    fileExists: (absolutePath) => {
      try {
        return existsSync(absolutePath);
      } catch {
        return false;
      }
    },
  };
}

function resolveLive(): ShellModeResult {
  // Either family proves interpreting; the machine under test decides which.
  const wanted = process.platform === "win32" ? "cmd" : "sh";
  const resolved = resolveShellMode(surface(), wanted);
  assert.equal(resolved.ok, true, `no ${wanted} on this machine: ${resolved.ok ? "" : resolved.message}`);
  return resolved;
}

function toolsFor(root: string, shellMode?: ShellModeResult, spawns: { count: number } = { count: 0 }) {
  // Both plannings see the mode: the sandbox approves and the tools execute,
  // and the two must agree rather than merely coexist.
  const sandbox = createWorkspaceSandbox({ workspaceRoot: root, ...(shellMode === undefined ? {} : { shellMode }) });
  const counting = {
    count: spawns.count,
    spawner: async (spec: Parameters<ReturnType<typeof createNodeSpawner>>[0]) => {
      spawns.count += 1;
      return createNodeSpawner()(spec);
    },
  };

  return { tools: createMutatingTools({ sandbox, spawner: counting.spawner, ...(shellMode === undefined ? {} : { shellMode }) }), spawns: counting };
}

function shellCall(command: string, extra?: { readonly steps?: ReadonlyArray<string> }): {
  readonly toolCallId: string;
  readonly name: string;
  readonly arguments: { readonly command: string; readonly steps?: ReadonlyArray<string> };
} {
  return { toolCallId: "sh-1", name: RUN_SHELL_TOOL, arguments: { command, ...(extra ?? {}) } };
}

const SIGNAL = new AbortController().signal;

test("a shell interprets operators the direct path refuses", async () => {
  const root = mkdtempSync(join(os.tmpdir(), "trylo-shell-live-"));
  try {
    const mode = resolveLive();
    const { tools } = toolsFor(root, mode);
    // `&&` is refused without a shell and runs with one, on cmd and on sh alike.
    const outcome = await tools.execute(shellCall("echo alpha && echo beta"), SIGNAL);

    assert.equal(outcome.outcome, "result");

    if (outcome.outcome !== "result") return;

    assert.match(outcome.output, /alpha/);
    assert.match(outcome.output, /beta/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a requested shell that is not installed fails the call and starts nothing", async () => {
  const root = mkdtempSync(join(os.tmpdir(), "trylo-shell-live-"));
  try {
    const spawns = { count: 0 };
    const { tools } = toolsFor(
      root,
      { ok: false, code: "shell_not_installed", message: "zsh is not installed on this machine" },
      spawns,
    );
    const outcome = await tools.execute(shellCall("echo hi"), SIGNAL);

    assert.equal(outcome.outcome, "error");

    if (outcome.outcome !== "error") return;

    assert.equal(outcome.code, "shell_not_installed");
    assert.equal(spawns.count, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("steps with a shell are refused before any process exists", async () => {
  const root = mkdtempSync(join(os.tmpdir(), "trylo-shell-live-"));
  try {
    const spawns = { count: 0 };
    const { tools } = toolsFor(root, resolveLive(), spawns);
    const outcome = await tools.execute(shellCall("echo a", { steps: ["echo b"] }), SIGNAL);

    assert.equal(outcome.outcome, "error");

    if (outcome.outcome !== "error") return;

    assert.equal(outcome.code, "shell_mode_rejects_composition");
    assert.equal(spawns.count, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the mode changes no binding: the catalog is identical with and without it", () => {
  const root = mkdtempSync(join(os.tmpdir(), "trylo-shell-live-"));
  try {
    const plain = toolsFor(root).tools.snapshot().map((binding) => binding.name);
    const shelled = toolsFor(root, resolveLive()).tools.snapshot().map((binding) => binding.name);
    assert.deepEqual(shelled, plain);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
