import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createWorkspaceTools } from "../../adapters/tools/index.js";
import { createWorkspaceSandbox } from "../../adapters/sandbox/index.js";
import { createProcessSessionRegistry } from "../../adapters/process-session/session-registry.js";
import { buildSubagentPorts } from "./wiring-subagent.js";
import { createAllowToolsPermission } from "./permission.js";
import type { ProviderPort } from "../../ports/provider.js";
import type { JsonObject } from "../../protocol/envelope.js";
import type { ToolOutcome } from "../../ports/tools.js";
import { createSubagentTaskResources } from "./subagent-task-resources.js";

function value(result: ToolOutcome): JsonObject {
  assert.equal(result.outcome, "result");
  return result.outcome === "result" ? result.value : {};
}
async function harness(t: TestContext, holdNewPerson = false) {
  const root = mkdtempSync(path.join(tmpdir(), "trylo-task-resource-"));
  const sessions = createProcessSessionRegistry();
  const tools = createWorkspaceTools({ workspaceRoot: root, sandbox: createWorkspaceSandbox({ workspaceRoot: root }), sessions });
  let veto = false;
  let personRounds = 0;
  let releasePerson!: () => void;
  let announcePerson!: () => void;
  const personReleased = new Promise<void>(resolve => { releasePerson = resolve; });
  const personPending = new Promise<void>(resolve => { announcePerson = resolve; });
  const command = `node -e ${JSON.stringify("console.log('OWNED_READY');setInterval(()=>{},1000)")}`;
  const provider: ProviderPort = { async *stream(request) {
    if (request.model === "person" && ++personRounds > 1 && holdNewPerson) {
      announcePerson(); await personReleased;
    }
    if (request.model === "worker" && !request.messages.some(message => message.role === "tool")) {
      yield { type: "tool_call", name: "run_shell", toolCallId: "bg", arguments: { command, runInBackground: true } };
      yield { type: "finish", reason: "tool_calls", rawReason: "tool_calls", requiresFollowUp: true };
    } else {
      yield { type: "text_start", blockId: "answer" };
      yield { type: "text_delta", blockId: "answer", text: veto ? "held" : "clear" };
      yield { type: "text_end", blockId: "answer" };
      yield { type: "finish", reason: "stop", rawReason: "stop", requiresFollowUp: false };
    }
  } };
  const built = buildSubagentPorts({ parentTools: tools, workspaceTools: tools, sessions, childProvider: provider,
    model: "parent", callerMessages: undefined,
    permission: createAllowToolsPermission(new Set(["run_shell"]), action => action.arguments["command"] === command),
    team: { runId: "team-resources", inspectRepresentation: output => output === "clear" ? { ready: true }
      : { ready: false, reason: "Person veto" }, members: ["person", "worker"].map(name => ({ memberId: `m-${name}`,
      baseRole: name, displayName: name, role: { name, model: name, description: name } })) } });
  t.after(async () => { releasePerson(); await built.runtime.cancelAll(); await sessions.shutdown(); });
  let sequence = 0;
  const call = (name: string, args: JsonObject) => built.tools.execute({ name, arguments: args,
    toolCallId: `parent-${++sequence}` }, new AbortController().signal);
  const person = String(value(await call("spawn_agent", { agent_type: "person", member_id: "m-person", message: "represent" }))["task_id"]);
  const personReport = value(await call("wait_agent", { targets: [person], timeout_ms: 1000 }));
  const worker = String(value(await call("spawn_agent", { agent_type: "worker", member_id: "m-worker", message: "start background" }))["task_id"]);
  await call("wait_agent", { targets: [worker], timeout_ms: 1000 });
  const owned = sessions.list().sessions.find(session => session.ownerId === worker);
  assert.equal(owned?.status, "running");
  assert.ok(owned);
  return { sessions, call, person, worker, owned, personReport, personPending, releasePerson, setVeto: () => { veto = true; } };
}

test("force closing a member stops its real background command and preserves other owners", { timeout: 15000 }, async t => {
  const h = await harness(t);
  const other = await h.sessions.start({ ownerId: "other-task", id: "", argv: [process.execPath, "-e", "setInterval(()=>{},1000)"],
    cwd: tmpdir(), env: {}, tty: false, rows: 24, cols: 80, maxBufferBytes: 65536 });
  const parent = await h.sessions.start({ id: "", argv: [process.execPath, "-e", "setInterval(()=>{},1000)"],
    cwd: tmpdir(), env: {}, tty: false, rows: 24, cols: 80, maxBufferBytes: 65536 });
  const closed = await h.call("close_agent", { target: h.worker, force: true });
  assert.equal(value(closed)["closed"], true);
  assert.equal(h.sessions.get(h.owned.id)?.status, "exited");
  assert.equal(h.sessions.get(other.id)?.status, "running");
  assert.equal(h.sessions.get(parent.id)?.status, "running");
});

test("a Person veto stops background commands from the active Worker", { timeout: 15000 }, async t => {
  const h = await harness(t);
  h.setVeto();
  const reports = h.personReport["results"] as JsonObject;
  const first = reports[h.person] as JsonObject;
  await h.call("send_input", { target: h.person, message: "veto implementation" });
  const held = value(await h.call("wait_agent", { targets: [h.person], after: { [h.person]: first["cursor"] ?? 0 }, timeout_ms: 5000 }));
  assert.equal(held["timed_out"], false);
  assert.equal(h.sessions.get(h.owned.id)?.status, "exited");
  const refused = await h.call("resume_agent", { target: h.worker });
  assert.equal(refused.outcome === "error" ? refused.code : "", "team_representation_held");
});

test("restarting a member confirms its old background command ended before continuation", { timeout: 15000 }, async t => {
  const h = await harness(t);
  const restarted = value(await h.call("send_input", { target: h.worker, message: "replacement work", mode: "restart" }));
  assert.equal(restarted["task_id"], h.worker);
  assert.equal(restarted["delivery"], "restarted");
  assert.equal(h.sessions.get(h.owned.id)?.status, "exited");
  assert.equal(h.sessions.list().sessions.some(session => session.ownerId === h.worker && session.status === "running"), false);
});

test("a native command that never started cannot permanently block task cleanup", { timeout: 10000 }, async t => {
  const root = mkdtempSync(path.join(tmpdir(), "trylo-task-no-process-"));
  const sessions = createProcessSessionRegistry();
  t.after(async () => { await sessions.shutdown(); });
  const started = await sessions.start({ id: "", ownerId: "task", argv: [path.join(root, "missing.exe")],
    cwd: root, env: {}, tty: false, rows: 24, cols: 80, maxBufferBytes: 1024 });
  const observed = await sessions.write({ sessionId: started.id, input: "", eof: false, yieldMs: 1000 });
  assert.ok(observed.ok && observed.read.end?.kind === "failed" && observed.read.end.code === "process_spawn_failed");
  assert.equal(sessions.get(started.id)?.pid, undefined, "the OS never assigned a process");
  await createSubagentTaskResources(sessions).stop("task");
});

test("new Person input stops an existing background command before its next representation is ready", { timeout: 15000 }, async t => {
  const h = await harness(t, true);
  assert.equal((await h.call("send_input", { target: h.person, message: "new user constraints" })).outcome, "result");
  await h.personPending;
  for (let poll = 0; poll < 10 && h.sessions.get(h.owned.id)?.status === "running"; poll += 1) {
    await h.sessions.write({ sessionId: h.owned.id, input: "", eof: false, yieldMs: 500 });
  }
  assert.equal(h.sessions.get(h.owned.id)?.status, "exited", "the Person answer is still pending; old implementation must already stop");
  assert.equal((await h.call("close_agent", { target: h.worker, force: true })).outcome, "result");
  const refused = await h.call("resume_agent", { target: h.worker });
  assert.equal(refused.outcome === "error" ? refused.code : "", "team_representation_pending");
});
