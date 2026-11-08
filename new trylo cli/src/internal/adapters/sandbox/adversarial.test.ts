import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { EDIT_FILE_TOOL, RUN_SHELL_TOOL, WRITE_FILE_TOOL } from "../tools/mutating/names.js";
import { createWorkspaceSandbox } from "./index.js";
import { createSandboxPolicy } from "./policy.js";
import { planMutation } from "./planner.js";

/**
 * H2: the sandbox must lose every argument with reality.
 *
 * These cases use a real temporary tree and real links. A fake file system
 * would happily report success for the one thing that matters here — whether a
 * path reaches outside the root — so nothing below is allowed to substitute one.
 *
 * On Windows this machine creates both junctions and file symlinks without
 * elevation (recorded in HY4-RUN.md), so the escape cases really run; every
 * helper still degrades honestly rather than mutating an assertion into a pass.
 */

function tempRoot(): string {
  return mkdtempSync(join(os.tmpdir(), "trylo-sandbox-"));
}

function policyFor(root: string, mode: "workspace_write" | "read_only" | "deny_all" = "workspace_write") {
  return createSandboxPolicy({ workspaceRoot: root, mode, maxWriteBytes: 64 });
}

function makeLink(linkPath: string, target: string): boolean {
  try {
    symlinkSync(target, linkPath, process.platform === "win32" ? "junction" : "dir");
    return true;
  } catch {
    return false;
  }
}

function makeFileLink(linkPath: string, target: string): boolean {
  try {
    symlinkSync(target, linkPath, "file");
    return true;
  } catch {
    return false;
  }
}

test("escaping write targets are refused and nothing appears outside the root", () => {
  const root = tempRoot();
  const outside = tempRoot();

  try {
    writeFileSync(join(outside, "escape.txt"), "outside");
    const cases: ReadonlyArray<[string, string]> = [
      ["../run-away.txt", "path_outside_workspace"],
      ["a/../../run-away.txt", "path_outside_workspace"],
      ["nested/deep/../../../outside.txt", "path_outside_workspace"],
      ["C:/Windows/win.ini", "path_outside_workspace"],
      ["/etc/passwd", "path_outside_workspace"],
      ["NUL", "path_outside_workspace"],
      ["contains\0inside.txt", "invalid_path"],
      ["", "invalid_arguments"],
    ];

    for (const [candidate, code] of cases) {
      const planned = planMutation(policyFor(root), {
        toolCallId: "c",
        name: WRITE_FILE_TOOL,
        arguments: { path: candidate, content: "x" },
      });

      assert.equal(planned.ok, false, candidate);

      if (!planned.ok) {
        assert.equal(planned.code, code, candidate);
      }
    }

    assert.deepEqual(readdirSync(outside), ["escape.txt"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

test("a junction out of the workspace is refused for writes at any depth", (t) => {
  const root = tempRoot();
  const outside = tempRoot();

  try {
    if (!makeLink(join(root, "escape-link"), outside)) {
      t.skip("the platform refused to create the symlink, so this escape case cannot run here");
      return;
    }

    const shallow = planMutation(policyFor(root), {
      toolCallId: "c",
      name: WRITE_FILE_TOOL,
      arguments: { path: "escape-link/x.txt", content: "x" },
    });

    assert.equal(shallow.ok, false);

    if (!shallow.ok) {
      assert.equal(shallow.code, "path_escapes_via_link");
    }

    const deeper = planMutation(policyFor(root), {
      toolCallId: "c",
      name: WRITE_FILE_TOOL,
      arguments: { path: "escape-link/deeper/x.txt", content: "x" },
    });

    assert.equal(deeper.ok, false);

    if (!deeper.ok) {
      // The ancestor walk stops at the junction itself, so the refusal names the
      // real problem instead of reporting a missing directory inside it.
      assert.equal(deeper.code, "path_escapes_via_link");
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

test("writing through a file symlink that points outside is refused", (t) => {
  const root = tempRoot();
  const outside = tempRoot();

  try {
    writeFileSync(join(outside, "target.txt"), "original");

    if (!makeFileLink(join(root, "alias.txt"), join(outside, "target.txt"))) {
      t.skip("the platform refused to create the symlink, so this escape case cannot run here");
      return;
    }

    const planned = planMutation(policyFor(root), {
      toolCallId: "c",
      name: WRITE_FILE_TOOL,
      arguments: { path: "alias.txt", content: "hijacked" },
    });

    assert.equal(planned.ok, false);

    if (!planned.ok) {
      assert.equal(planned.code, "path_escapes_via_link");
    }

    assert.equal(readFileSync(join(outside, "target.txt"), "utf8"), "original");
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

test("a write into a missing directory is planned (parents are created at execution); a missing edit target is refused", () => {
  const root = tempRoot();
  try {
    const nested = planMutation(policyFor(root), {
      toolCallId: "c",
      name: WRITE_FILE_TOOL,
      arguments: { path: "not-there/a.txt", content: "x" },
    });

    assert.equal(nested.ok, true);

    if (nested.ok && nested.plan.tool === "write_file") {
      assert.match(nested.plan.absolutePath, /[\\/]not-there[\\/]a\.txt$/);
    } else {
      assert.fail("expected a write_file plan");
    }

    const missingEdit = planMutation(policyFor(root), {
      toolCallId: "c",
      name: EDIT_FILE_TOOL,
      arguments: { path: "absent.txt", patch: "@@ -1 +1 @@\n-a\n+b\n" },
    });

    assert.equal(missingEdit.ok, false);

    if (!missingEdit.ok) {
      assert.equal(missingEdit.code, "file_missing");
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("an oversized write is rejected rather than truncated into a shorter file", () => {
  const root = tempRoot();
  try {
    const planned = planMutation(policyFor(root), {
      toolCallId: "c",
      name: WRITE_FILE_TOOL,
      arguments: { path: "big.txt", content: "x".repeat(65) },
    });

    assert.equal(planned.ok, false);

    if (!planned.ok) {
      assert.equal(planned.code, "write_too_large");
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("multibyte content is measured in bytes, not code units", () => {
  const root = tempRoot();
  try {
    const planned = planMutation(policyFor(root), {
      toolCallId: "c",
      name: WRITE_FILE_TOOL,
      arguments: { path: "utf8.txt", content: "é".repeat(33) },
    });

    assert.equal(planned.ok, false);

    if (!planned.ok) {
      assert.equal(planned.code, "write_too_large");
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("read_only and deny_all refuse every mutating tool even inside the root", () => {
  const root = tempRoot();
  try {
    writeFileSync(join(root, "exists.txt"), "hello");
    const calls: ReadonlyArray<[string, Record<string, string>]> = [
      [WRITE_FILE_TOOL, { path: "a.txt", content: "x" }],
      [EDIT_FILE_TOOL, { path: "exists.txt", patch: "@@ -1 +1 @@\n-a\n+b\n" }],
      [RUN_SHELL_TOOL, { command: "node -v" }],
    ];

    for (const mode of ["read_only", "deny_all"] as const) {
      for (const [name, args] of calls) {
        const planned = planMutation(policyFor(root, mode), {
          toolCallId: "c",
          name,
          arguments: args,
        });

        assert.equal(planned.ok, false, `${mode}/${name}`);

        if (!planned.ok) {
          assert.equal(planned.code, mode === "read_only" ? "sandbox_read_only" : "sandbox_deny_all");
        }
      }
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a tool with no sandbox constraint is refused instead of waved through", () => {
  const root = tempRoot();
  try {
    const planned = planMutation(policyFor(root), {
      toolCallId: "c",
      name: "read_file",
      arguments: { path: "a.txt" },
    });

    assert.equal(planned.ok, false);

    if (!planned.ok) {
      assert.equal(planned.code, "unknown_tool");
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("shell commands cannot change directory, use operators or escape the root", () => {
  const root = tempRoot();
  const outside = tempRoot();

  try {
    const cases: ReadonlyArray<[string, string]> = [
      ["cd ..", "cd_forbidden"],
      ["cd /tmp", "cd_forbidden"],
      ["echo a > b.txt", "shell_operator_forbidden"],
      ["echo $HOME", "shell_operator_forbidden"],
      ["echo `whoami`", "shell_operator_forbidden"],
      ["a && b", "shell_operator_forbidden"],
      ["echo 'unterminated", "shell_parse_failed"],
      ["trailing\\", "shell_parse_failed"],
      ["C:/Windows/System32/cmd.exe", "path_outside_workspace"],
      ["/bin/sh", "path_outside_workspace"],
      // An empty command is a missing argument before it is a command at all.
      ["", "invalid_arguments"],
      ["   ", "empty_command"],
    ];
    for (const [command, code] of cases) {
      const planned = planMutation(policyFor(root), {
        toolCallId: "c",
        name: RUN_SHELL_TOOL,
        arguments: { command },
      });

      assert.equal(planned.ok, false, command);

      if (!planned.ok) {
        assert.equal(planned.code, code, command);
      }
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

test("D7: a pipeline is planned segment by segment under the same refusal rules", () => {
  // P2-③窄口径：只放开 `|`。每段独立过 planShellCommand——其它操作符、
  // 重定向、命令替换在段内照样被拒；空段（`||`、首尾 `|`）是解析失败。
  const root = tempRoot();
  try {
    const policy = policyFor(root);
    const planned = planMutation(policy, {
      toolCallId: "c",
      name: RUN_SHELL_TOOL,
      arguments: { command: "node -e 1 | node -e 2 | node -e 3" },
    });

    assert.equal(planned.ok, true);

    if (planned.ok && planned.plan.tool === "run_shell") {
      const [head, ...rest] = planned.plan.steps;
      assert.equal(rest.length, 0);
      assert.deepEqual(head?.argv, ["node", "-e", "1"]);
      assert.deepEqual(head?.pipeTo?.argv, ["node", "-e", "2"]);
      assert.deepEqual(head?.pipeTo?.pipeTo?.argv, ["node", "-e", "3"]);
    }

    const refused: ReadonlyArray<[string, string]> = [
      ["a || b", "shell_parse_failed"],
      ["| b", "shell_parse_failed"],
      ["a | ", "shell_parse_failed"],
      ["a | b && c", "shell_operator_forbidden"],
      ["a > f | b", "shell_operator_forbidden"],
      ["a | b 2>&1", "shell_operator_forbidden"],
      ["a $HOME | b", "shell_operator_forbidden"],
      ["`whoami` | b", "shell_operator_forbidden"],
      ["$(whoami) | b", "shell_operator_forbidden"],
    ];

    for (const [command, code] of refused) {
      const denied = planMutation(policy, { toolCallId: "c", name: RUN_SHELL_TOOL, arguments: { command } });
      assert.equal(denied.ok, false, command);
      if (!denied.ok) {
        assert.equal(denied.code, code, command);
      }
    }

    // 引号里的竖线是字面量，不是管道。
    const quoted = planMutation(policy, {
      toolCallId: "c",
      name: RUN_SHELL_TOOL,
      arguments: { command: 'node -e "console.log(1)"' },
    });

    assert.equal(quoted.ok, true);

    if (quoted.ok && quoted.plan.tool === "run_shell") {
      assert.equal(quoted.plan.steps[0]?.pipeTo, undefined);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("an accepted shell plan pins the working directory to the workspace root", () => {
  const root = tempRoot();
  try {
    const planned = planMutation(policyFor(root), {
      toolCallId: "c",
      name: RUN_SHELL_TOOL,
      arguments: { command: "node -v" },
    });

    assert.equal(planned.ok, true);

    if (planned.ok && planned.plan.tool === "run_shell") {
      assert.deepEqual(planned.plan.argv, ["node", "-v"]);
      assert.equal(planned.plan.cwd, realpathSync(root));
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("quoting decides whether an operator is literal: only quoted ones survive", () => {
  const root = tempRoot();
  try {
    const quoted = planMutation(policyFor(root), {
      toolCallId: "c",
      name: RUN_SHELL_TOOL,
      arguments: { command: `node -e "console.log('a>b')"` },
    });

    assert.equal(quoted.ok, true);

    if (quoted.ok && quoted.plan.tool === "run_shell") {
      assert.equal(quoted.plan.argv[2], "console.log('a>b')");
    }

    const bare = planMutation(policyFor(root), {
      toolCallId: "c",
      name: RUN_SHELL_TOOL,
      arguments: { command: `node -e console.log(a>b)` },
    });

    assert.equal(bare.ok, false);

    if (!bare.ok) {
      assert.equal(bare.code, "shell_operator_forbidden");
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

/**
 * The plan is computed once for admission and once for execution. They must be
 * identical, otherwise "what was approved" and "what runs" could diverge.
 */
test("planning the same call twice is deterministic", () => {
  const root = tempRoot();
  try {
    const policy = policyFor(root);
    const call = {
      toolCallId: "c",
      name: RUN_SHELL_TOOL,
      arguments: { command: "node -v" },
    } as const;

    assert.deepEqual(planMutation(policy, call), planMutation(policy, call));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the sandbox wrapper reports the policy it was built with", () => {
  const root = tempRoot();
  try {
    const sandbox = createWorkspaceSandbox({ workspaceRoot: root });
    assert.equal(sandbox.policy.mode, "workspace_write");
    assert.equal(sandbox.policy.network, "restricted");
    assert.equal(sandbox.evaluate({ toolCallId: "c", name: WRITE_FILE_TOOL, arguments: { path: "a", content: "x" } }).ok, true);
    assert.equal(sandbox.evaluate({ toolCallId: "c", name: "unknown", arguments: {} }).ok, false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
