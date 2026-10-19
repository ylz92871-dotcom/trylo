import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { SandboxPolicy } from "../../ports/tools.js";
import { planMutation } from "./planner.js";
import type { ShellModeResult } from "./shell-mode.js";

const POLICY: SandboxPolicy = {
  mode: "workspace_write",
  network: "restricted",
  workspaceRoot: "D:/w",
  maxWriteBytes: 1024,
  allowAbsoluteExecutable: false,
};

function call(command: string, extra?: { readonly steps?: ReadonlyArray<string>; readonly pipeTo?: string }): {
  readonly name: string;
  readonly toolCallId: string;
  readonly arguments: { readonly command: string; readonly steps?: ReadonlyArray<string>; readonly pipeTo?: string };
} {
  return { name: "run_shell", toolCallId: "c1", arguments: { command, ...(extra ?? {}) } };
}

function shellMode(kind: "powershell"): ShellModeResult {
  return {
    ok: true,
    mode: { kind: "shell", shell: { kind, path: kind === "powershell" ? "C:/Windows/System32/WindowsPowerShell/v1.0/powershell.exe" : "powershell" } },
  };
}

/**
 * Planning under an interpreter (WP05 C06).
 *
 * The load-bearing property: the mode changes *what the plan contains* (one
 * shell step, whole string, no tokenizing), never *whether the call was
 * allowed*. Approval, cwd and composition rules run exactly as before; only
 * the shape of an approved command differs.
 */
describe("planMutation under a shell mode", () => {
  it("hands the whole string to the interpreter without tokenizing", () => {
    const result = planMutation(POLICY, call("echo hello | grep h"), shellMode("powershell"));
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.plan.tool, "run_shell");
    if (result.plan.tool !== "run_shell") return;
    assert.equal(result.plan.shape.kind, "direct");
    assert.equal(result.plan.steps.length, 0);
    // The command travels as ONE argv element: the interpreter parses, not us.
    assert.ok(result.plan.argv[result.plan.argv.length - 1]?.includes("echo hello | grep h"));
  });

  it("refuses composition rather than running it twice", () => {
    const steps = planMutation(POLICY, call("echo a", { steps: ["echo b"] }), shellMode("powershell"));
    assert.equal(steps.ok, false);
    if (steps.ok) return;
    assert.equal(steps.code, "shell_mode_rejects_composition");
    const pipe = planMutation(POLICY, call("echo a", { pipeTo: "cat" }), shellMode("powershell"));
    assert.equal(pipe.ok, false);
    if (pipe.ok) return;
    assert.equal(pipe.code, "shell_mode_rejects_composition");
  });

  it("fails the call when the requested shell is not installed", () => {
    const result = planMutation(POLICY, call("echo hi"), { ok: false, code: "shell_not_installed", message: "zsh is not installed" });
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.code, "shell_not_installed");
  });

  it("leaves the direct path byte-identical when no mode is given", () => {
    const result = planMutation(POLICY, call("echo hi"));
    assert.equal(result.ok, true);
    if (!result.ok) return;
    if (result.plan.tool !== "run_shell") return;
    assert.equal(result.plan.shape.kind, "direct");
    assert.equal(result.plan.steps.length, 1);
  });
});
