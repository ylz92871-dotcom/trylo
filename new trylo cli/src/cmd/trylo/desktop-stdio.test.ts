import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, existsSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const cli = fileURLToPath(new URL("./main.js", import.meta.url));

async function runDesktop(answer: "allow" | "deny" | "eof"): Promise<{
  code: number | null; frames: Array<Record<string, unknown>>; written: string | undefined; stderr: string;
}> {
  const root = mkdtempSync(join(os.tmpdir(), "trylo-desktop-stdio-"));
  const workspace = join(root, "workspace");
  const home = join(root, "home");

  mkdirSync(workspace);
  mkdirSync(home);
  writeFileSync(join(workspace, "package.json"), '{"name":"stdio-contract"}');
  const child = spawn(process.execPath, [cli, "run", "--provider", "fixture-write", "--format", "stream-json",
    "--permission-prompt-tool", "stdio", "--ask", "always", "--workspace", workspace, "-"], {
    cwd: workspace, env: { ...process.env, TRYLO_HOME: home, USERPROFILE: home, HOME: home, TRYLO_API_KEY: "" },
    stdio: ["pipe", "pipe", "pipe"],
  });
  const frames: Array<Record<string, unknown>> = [];
  let buffer = "";
  let stderr = "";

  child.stderr.on("data", chunk => { stderr += String(chunk); });
  child.stdout.on("data", chunk => {
    buffer += String(chunk);
    for (;;) {
      const end = buffer.indexOf("\n");
      if (end < 0) break;

      const frame = JSON.parse(buffer.slice(0, end)) as Record<string, unknown>;

      buffer = buffer.slice(end + 1);
      frames.push(frame);

      if (frame.type === "control_request") {
        assert.equal(existsSync(join(workspace, "fixture-output.txt")), false, "must wait for approval before writing");
        if (answer === "eof") child.stdin.end();
        else child.stdin.write(`${JSON.stringify({ type: "control_response", response: {
          subtype: "success", request_id: frame.request_id, response: { behavior: answer },
        } })}\n`);
      }
    }
  });
  const timer = setTimeout(() => child.kill(), 10_000);

  try {
    child.stdin.write(`${JSON.stringify({ type: "user", message: { role: "user", content: [{ type: "text", text: "write a fixture" }] } })}\n`);
    const code = await new Promise<number | null>((resolve, reject) => {
      child.once("error", reject);
      child.once("close", resolve);
    });
    const target = join(workspace, "fixture-output.txt");

    return { code, frames, written: existsSync(target) ? readFileSync(target, "utf8") : undefined, stderr };
  } finally {
    clearTimeout(timer);
    child.stdin.destroy();
    rmSync(root, { recursive: true, force: true });
  }
}

test("Desktop stdio runs before EOF and exits after approving the actual write", async () => {
  const result = await runDesktop("allow");

  assert.equal(result.code, 0, result.stderr);
  assert.equal(typeof result.written, "string");
  const request = result.frames.find(frame => frame.type === "control_request");

  assert.equal((request?.request as Record<string, unknown>).tool_name, "write_file");
  const use = result.frames.find(frame => frame.type === "tool_use");

  assert.equal((use?.input as Record<string, unknown>).path, "fixture-output.txt");
  assert.equal(result.frames.filter(frame => frame.type === "run_result").length, 1);
});

test("Desktop denial never performs the requested write", async () => {
  const result = await runDesktop("deny");
  assert.equal(result.code, 1, result.stderr);
  assert.equal(result.written, undefined);
  assert.equal(result.frames.find(frame => frame.type === "run_result")?.status, "failed");
});

test("Desktop approval input closing cancels rather than approving", async () => {
  const result = await runDesktop("eof");
  assert.equal(result.code, 130, result.stderr);
  assert.equal(result.written, undefined);
  assert.equal(result.frames.find(frame => frame.type === "run_result")?.status, "cancelled");
});
