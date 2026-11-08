import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import type { CliContext } from "./context.js";
import { createInteractivePermission } from "./permission.js";
import { decision } from "../../ports/permission.js";
import { buildPermissionAction } from "../../loop/permission-grants.js";
import { planShellPipeline } from "../../adapters/sandbox/command.js";
import { handleProvidersConfig } from "./commands-providers.js";
import { prepareRun, isRunFailure, runOneTurn } from "./run-command.js";

test("an empty approval answer waits for a real choice", async () => {
  const answers = ["", "y"];
  const port = createInteractivePermission({ prompt: () => undefined, readLine: async () => answers.shift() });
  const ticket = await port.request(buildPermissionAction("call", "run_shell", { command: "node --version" }));
  assert.equal((await port.awaitDecision(ticket.ticketId)).resolution, "approved");
  assert.equal(answers.length, 0);
});

test("disabling a tool retains its session scope", () => {
  assert.equal(decision("denied", "session").scope, "session");
});

test("unsupported workspace redirection does not claim an observed escape", () => {
  const result = planShellPipeline({ workspaceRoot: "/workspace", allowAbsoluteExecutable: false }, "node --version > result.txt");
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.doesNotMatch(result.message, /would write outside the workspace/);
  assert.match(result.message, /not supported|no shell/i);
});

function context(root: string, answers: string[]) {
  const out: string[] = [];
  const err: string[] = [];
  let reads = 0;
  let ids = 0;
  const ctx: CliContext = {
    env: { TRYLO_HOME: path.join(root, "profile") }, homeDir: root, cwd: root,
    nodeVersion: "v24.0.0", platform: "win32", stdinIsTty: true,

    readFile: file => { try { return readFileSync(file, "utf8"); } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    } },

    isDirectory: file => { try { return statSync(file).isDirectory(); } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw error;
    } },

    readDir: () => [],

    writeFile: (file, text) => {
      mkdirSync(path.dirname(file), { recursive: true });
      writeFileSync(file, text);
      return true;
    },

    readLine: async () => {
      reads += 1;
      return answers.shift();
    }, readSecret: async () => undefined,
    readStdin: async () => "", stdout: text => out.push(text), stderr: text => err.push(text),
    now: () => 0, newId: prefix => `${prefix}-${++ids}`,
  };

  return { ctx, out, err, reads: () => reads };
}

test("providers config reports the same configured provider as an actual run", t => {
  const root = mkdtempSync(path.join(tmpdir(), "trylo-ux-config-"));

  t.after(() => rmSync(root, { recursive: true, force: true }));
  const fx = context(root, []);

  fx.ctx.writeFile(path.join(root, "profile/config.json"), JSON.stringify({ provider: "lab" }));
  fx.ctx.writeFile(path.join(root, "profile/providers.json"), JSON.stringify({ version: 1, providers: [{ id: "lab", kind: "openai-compatible", endpoint: "https://example.invalid/v1/chat/completions", model: "manual-model" }] }));
  assert.equal(handleProvidersConfig(fx.ctx, { json: true }), 0);
  assert.equal(JSON.parse(fx.out.join("")).id, "lab");
});

test("a CLI session approval survives the next turn with the same arguments", async t => {
  const root = mkdtempSync(path.join(tmpdir(), "trylo-ux-grant-"));

  t.after(() => rmSync(root, { recursive: true, force: true }));
  const fx = context(root, ["s"]);
  const events: { kind: string; timestamp: string }[] = [];
  const ctx = { ...fx.ctx, onRunEnvelope: (event: { kind: string; timestamp: string }) => events.push(event) };
  const scaffold = await prepareRun(ctx, { options: { message: [], readStdin: false, provider: "fixture-write", session: "ux-grant" }, sink: { stdout: fx.ctx.stdout, stderr: fx.ctx.stderr }, permissionMode: "interactive" });

  assert.equal(isRunFailure(scaffold), false);

  if (isRunFailure(scaffold)) return;

  t.after(() => scaffold.close());

  for (let i = 0; i < 2; i += 1) {
    const outcome = await runOneTurn(ctx, scaffold, "write the fixture file", { stdout: fx.ctx.stdout, stderr: fx.ctx.stderr }, "interactive", {});
    assert.ok("result" in outcome);
    if (!("result" in outcome)) return;
    assert.equal(outcome.result.status, "completed");
  }

  assert.equal(fx.reads(), 1);
  assert.equal(events.filter(event => event.kind === "terminal").length, 2);
  assert.ok(events.every(event => Number.isFinite(Date.parse(event.timestamp))));
});

test("declared connection identity is recorded and a different declared model cannot resume it", async t => {
  const root = mkdtempSync(path.join(tmpdir(), "trylo-ux-identity-"));

  t.after(() => rmSync(root, { recursive: true, force: true }));
  const fx = context(root, []);

  fx.ctx.writeFile(path.join(root, "profile/providers.json"), JSON.stringify({ version: 1, selected: "lab", providers: [{ id: "lab", kind: "openai-compatible", endpoint: "https://example.invalid/v1/chat/completions", model: "model-a" }] }));
  const options = { message: [], readStdin: false };
  const sink = { stdout: fx.ctx.stdout, stderr: fx.ctx.stderr };
  const first = await prepareRun(fx.ctx, { options: { ...options, session: "declared-identity" }, sink, permissionMode: "interactive" });

  assert.equal(isRunFailure(first), false);

  if (isRunFailure(first)) return;

  await first.close();
  fx.ctx.writeFile(path.join(root, "profile/providers.json"), JSON.stringify({ version: 1, selected: "lab", providers: [{ id: "lab", kind: "openai-compatible", endpoint: "https://example.invalid/v1/chat/completions", model: "model-b" }] }));
  const resumed = await prepareRun(fx.ctx, { options: { ...options, resume: "declared-identity" }, sink, permissionMode: "interactive" });
  if (!isRunFailure(resumed)) await resumed.close();

  assert.equal(isRunFailure(resumed), true);

  if (isRunFailure(resumed)) assert.match(resumed.message, /model changed/);
});
