import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import os from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const cli = fileURLToPath(new URL("./main.js", import.meta.url));

type Frame = Record<string, unknown>;

async function fixture(action?: "pause" | "cancel") {
  const root = mkdtempSync(join(os.tmpdir(), "trylo-goal-stdio-"));
  const workspace = join(root, "workspace");
  const home = join(root, "home");
  mkdirSync(workspace);
  mkdirSync(home);
  const run = async (resume: boolean): Promise<{ code: number | null; frames: Frame[]; stderr: string }> => {
    const child = spawn(process.execPath, [cli, "run", "--provider", action ? "fixture-write" : "fixture", "--format", "stream-json", "--max-iterations", "3",
      "--permission-prompt-tool", "stdio", resume ? "--resume" : "--session", "goal-test", "--workspace", workspace, "-"], {
      cwd: workspace, env: { ...process.env, TRYLO_HOME: home, USERPROFILE: home, HOME: home, TRYLO_API_KEY: "" }, stdio: ["pipe", "pipe", "pipe"],
    });
    const frames: Frame[] = [];
    let buffer = "";
    let stderr = "";
    let acted = false;

    child.stderr.on("data", value => { stderr += String(value); });
    child.stdout.on("data", value => {
      buffer += String(value);
      for (;;) {
        const end = buffer.indexOf("\n");
        if (end < 0) break;

        const frame = JSON.parse(buffer.slice(0, end)) as Frame;
        buffer = buffer.slice(end + 1);
        frames.push(frame);

        // Hold an actual approval wait before interrupting. A synchronous
        // fixture can finish before the parent handles run_start under load.
        if (action && !resume && !acted && frame.type === "control_request") {
          acted = true;
          child.stdin.write(`${JSON.stringify({ type: "goal_control", action })}\n`);
        }

        if (resume && frame.type === "control_request") child.stdin.write(`${JSON.stringify({ type: "control_response", response: {
          subtype: "success", request_id: frame.request_id, response: { behavior: "allow" },
        } })}\n`);
      }
    });
    const timer = setTimeout(() => child.kill(), 20_000);

    try {
      child.stdin.write(`${JSON.stringify({ type: "user", message: { role: "user", content: [{ type: "text", text: "Make progress toward the explicit goal." }] },
        goal: resume ? { version: 1, action: "resume" } : { version: 1, action: "create", objective: "Finish the fixture work" } })}\n`);
      const code = await new Promise<number | null>((resolve, reject) => {
        child.once("error", reject);
        child.once("close", resolve);
      });
      return { code, frames, stderr };
    } finally {
      clearTimeout(timer);
      child.stdin.destroy();
    }
  };

  try {
    const first = await run(false);
    const second = action === "pause" ? await run(true) : undefined;
    return { first, second };
  }
  finally {
    assert.ok(root.startsWith(join(os.tmpdir(), "trylo-goal-stdio-")));
    rmSync(root, { recursive: true, force: true });
  }
}

test("goal stdio keeps one terminal and persists a system pause at the execution ceiling", async () => {
  const { first } = await fixture();
  assert.equal(first.frames.filter(frame => frame.type === "run_result").length, 1, first.stderr);
  assert.equal(first.frames.filter(frame => frame.type === "run_start").length, 1);
  const goals = first.frames.filter(frame => frame.type === "goal_state");
  assert.equal((goals.at(-1)?.goal as Frame)?.status, "paused_by_system", first.stderr);
  assert.equal((first.frames.at(-1)?.type), "run_result");
});

test("goal stdio accepts user pause and resumes the same durable objective", async () => {
  const { first, second } = await fixture("pause");
  assert.equal((first.frames.filter(frame => frame.type === "goal_state").at(-1)?.goal as Frame)?.status, "paused_by_user", first.stderr);
  assert.equal(first.frames.filter(frame => frame.type === "run_result").length, 1);
  const resumed = second?.frames.filter(frame => frame.type === "goal_state").at(0)?.goal as Frame;
  assert.equal(resumed?.objective, "Finish the fixture work", second?.stderr);
  assert.equal(resumed?.status, "active");
});

test("goal stdio cancellation is distinct from success", async () => {
  const { first } = await fixture("cancel");
  assert.equal((first.frames.filter(frame => frame.type === "goal_state").at(-1)?.goal as Frame)?.status, "cancelled", first.stderr);
  assert.equal(first.frames.filter(frame => frame.type === "run_result").length, 1);
});
