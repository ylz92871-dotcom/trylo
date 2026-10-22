import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import type { CliContext } from "./context.js";
import { normalizeChatEndpoint } from "./connection-endpoint.js";
import { saveConnection } from "./connection-save.js";
import { connectionStatus, listConnections } from "./connection-status.js";
import { probeConnection } from "./connection-probe.js";
import { storeCredential } from "./credential-login.js";
import { switchRunConnection, setDefaultConnection } from "./connection-switch.js";
import { prepareRun, isRunFailure } from "./run-command.js";
import { permissionFor } from "./permission-for-run.js";
import { createSessionPermissions } from "./session-permissions.js";
import { buildPermissionAction } from "../../loop/permission-grants.js";
import type { ConnectionDraft } from "./connection-draft.js";

function fixture(t: { after: (fn: () => void) => void }) {
  const root = mkdtempSync(path.join(tmpdir(), "trylo-connect-service-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  let ids = 0;
  const writes: string[] = [];
  const ctx: CliContext = {
    env: { TRYLO_HOME: path.join(root, "profile") }, homeDir: root, cwd: root,
    nodeVersion: "v24.0.0", platform: "win32", stdinIsTty: true,
    readFile: file => { try { return readFileSync(file, "utf8"); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; } },
    isDirectory: file => { try { return statSync(file).isDirectory(); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; } },
    readDir: () => [], writeFile: (file, text) => { mkdirSync(path.dirname(file), { recursive: true }); writeFileSync(file, text); writes.push(file); return true; },
    readLine: async () => "y", readSecret: async () => undefined, readStdin: async () => "",
    stdout: () => undefined, stderr: () => undefined, now: () => Date.now(), newId: prefix => `${prefix}-${++ids}`,
  };
  return { ctx, root, writes };
}

test("connecting saves the generated account binding and reopens without the secret in public state", t => {
  const fx = fixture(t);
  assert.equal(connectionStatus(fx.ctx).kind, "needs_connection");
  const saved = saveConnection(fx.ctx, { operation: "add", id: "lab", address: "https://example.invalid/api/v1/", model: "manual-model", credential: { kind: "secret", secret: "service-test-key", label: "Lab account" } });
  assert.equal(saved.ok, true);
  if (!saved.ok) return;
  assert.ok(saved.accountId);
  const restarted = connectionStatus({ ...fx.ctx });
  assert.equal(restarted.kind, "ready");
  assert.equal(restarted.provider.accountId, saved.accountId);
  assert.equal(restarted.provider.endpoint, "https://example.invalid/api/v1/chat/completions");
  assert.equal(restarted.provider.model, "manual-model");
  assert.equal(JSON.stringify(restarted).includes("service-test-key"), false);
  const choices = listConnections(fx.ctx);
  assert.equal(choices.ok, true);
  assert.equal(JSON.stringify(choices).includes("service-test-key"), false);
  assert.equal(normalizeChatEndpoint(restarted.provider.endpoint).ok, true);
  assert.deepEqual(normalizeChatEndpoint(restarted.provider.endpoint), { ok: true, endpoint: restarted.provider.endpoint });
});

test("probe uses the bound account, leaves defaults untouched and returns only text-connection evidence", async t => {
  const fx = fixture(t);
  const old = storeCredential(fx.ctx, { providerId: "openai-compatible", accountId: "host-a", secret: "key-for-host-a", scope: "user" });
  assert.equal(old.ok, true);
  assert.equal(storeCredential(fx.ctx, { providerId: "openai-compatible", accountId: "host-b", secret: "key-for-host-b", scope: "user" }).ok, true);
  const requests: { auth: string | undefined; model: string; tools?: unknown }[] = [];
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", chunk => { body += chunk; });
    req.on("end", () => {
      const parsed = JSON.parse(body);
      requests.push({ auth: req.headers.authorization, model: parsed.model, tools: parsed.tools });
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end('data: {"choices":[{"index":0,"delta":{"content":"OK"},"finish_reason":null}]}\n\ndata: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n');
    });
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => { server.close(); server.closeAllConnections(); });
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  if (address === null || typeof address === "string") return;
  const draft: ConnectionDraft = { operation: "add", id: "host-a", address: `http://127.0.0.1:${address.port}/v1`, model: "typed-model-id", credential: { kind: "account", accountId: "host-a" } };
  const before = fx.writes.length;
  const probed = await probeConnection(fx.ctx, draft);
  assert.equal(probed.ok, true);
  assert.equal(fx.writes.length, before);
  assert.equal(connectionStatus(fx.ctx).kind, "needs_connection");
  assert.equal(requests[0]?.auth, "Bearer key-for-host-a");
  assert.equal(requests[0]?.model, "typed-model-id");
  assert.equal(requests[0]?.tools, undefined);
  if (probed.ok) assert.equal(probed.scope, "text-only");
});

test("auto-edit asks for shell, explicit tool allowance is revocable, and read-only denies mutations", async t => {
  const { ctx } = fixture(t);
  const session = createSessionPermissions();
  session.setMode("auto-edit");
  let asked = 0;
  const interactive = { ...ctx, approval: { requestApproval: async () => { asked += 1; return { resolution: "approved" as const, scope: "once" as const }; } } };
  const decide = async (name: string) => {
    const port = permissionFor("interactive", interactive, session.choice({}));
    const ticket = await port.request(buildPermissionAction("c", name, name === "run_shell"
      ? { command: "node --version" } : { path: "result.txt", content: "data" }));
    return await port.awaitDecision(ticket.ticketId);
  };
  assert.equal((await decide("write_file")).resolution, "approved");
  assert.equal(asked, 0);
  assert.equal((await decide("run_shell")).resolution, "approved");
  assert.equal(asked, 1);
  session.allowTool("run_shell");
  assert.equal((await decide("run_shell")).resolution, "approved");
  assert.equal(asked, 1);
  session.revokeTool("run_shell");
  await decide("run_shell");
  assert.equal(asked, 2);
  session.setMode("read-only");
  const denied = await decide("write_file");
  assert.equal(denied.resolution, "denied");
  assert.equal(denied.reason, "policy_denied");
  assert.equal(asked, 2);
});

test("switch preparation failure preserves the original session and default selection is explicit", async t => {
  const fx = fixture(t);
  const sink = { stdout: fx.ctx.stdout, stderr: fx.ctx.stderr };
  const current = await prepareRun(fx.ctx, { options: { message: [], readStdin: false, provider: "fixture", session: "before-switch", format: "stream-json" }, sink, permissionMode: "interactive" });
  assert.equal(isRunFailure(current), false);
  if (isRunFailure(current)) return;
  t.after(() => current.close());
  const failed = await switchRunConnection(fx.ctx, current, { providerId: "missing" }, sink, "interactive");
  assert.equal(isRunFailure(failed), true);
  const stillLocked = await prepareRun(fx.ctx, { options: { message: [], readStdin: false, provider: "fixture", resume: current.sessionId }, sink, permissionMode: "interactive" });
  assert.equal(isRunFailure(stillLocked), true);
  if (isRunFailure(stillLocked)) assert.match(stillLocked.message, /lock_conflict/);
  const saved = saveConnection(fx.ctx, { operation: "add", id: "typed", address: "https://example.invalid/v1", model: "m1", credential: { kind: "secret", secret: "test-key" } }, false);
  assert.equal(saved.ok, true);
  assert.equal(connectionStatus(fx.ctx).kind, "needs_connection");
  assert.equal(setDefaultConnection(fx.ctx, { providerId: "typed", model: "m2" }).ok, true);
  const active = connectionStatus(fx.ctx);
  assert.equal(active.kind, "ready");
  assert.equal(active.provider.model, "m2");
  const switched = await switchRunConnection(fx.ctx, current, { providerId: "typed", model: "m3" }, sink, "interactive");
  assert.equal(isRunFailure(switched), false);
  if (isRunFailure(switched)) return;
  t.after(() => switched.close());
  assert.notEqual(switched.sessionId, current.sessionId);
  assert.equal(switched.providerId, "typed");
  assert.equal(switched.model, "m3");
  assert.equal(switched.format, "stream-json");
  const unchanged = connectionStatus(fx.ctx);
  assert.equal(unchanged.kind, "ready");
  assert.equal(unchanged.provider.model, "m2", "use this turn must not replace the saved default");
  const old = await prepareRun(fx.ctx, { options: { message: [], readStdin: false, provider: "fixture", resume: current.sessionId }, sink, permissionMode: "interactive" });
  assert.equal(isRunFailure(old), false, "the old session remains resumable");
  if (!isRunFailure(old)) t.after(() => old.close());
});
