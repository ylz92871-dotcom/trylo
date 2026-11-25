import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import path from "node:path";
import { test } from "node:test";
import type { IsolationRequest } from "../../ports/isolation.js";
import { testScratchPath } from "../../testing/scratch.js";
import { createPlatformIsolation } from "./platform-isolation.js";

const macos = { skip: process.platform !== "darwin", timeout: 15000 };

test("macOS Seatbelt confines file writes, protects read and write carve-outs, and blocks TCP", macos, async t => {
  const scratch = mkdtempSync(testScratchPath("seatbelt-"));
  t.after(() => rmSync(scratch, { recursive: true, force: true }));
  const workspace = path.join(scratch, 'workspace "quoted"');
  const protectedDir = path.join(workspace, "protected");
  const hidden = path.join(protectedDir, "read-denied.txt");
  const alias = path.join(workspace, "alias.txt");
  const locked = path.join(workspace, "write-denied.txt");
  const allowed = path.join(workspace, "allowed.txt");
  const outside = path.join(scratch, "outside.txt");
  mkdirSync(protectedDir, { recursive: true });
  writeFileSync(hidden, "synthetic protected data");
  writeFileSync(locked, "original");
  symlinkSync(hidden, alias);

  let connections = 0;
  const server = createServer(socket => { connections += 1; socket.destroy(); });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  t.after(() => { server.close(); });
  const endpoint = server.address();
  assert.ok(endpoint !== null && typeof endpoint === "object");

  const adapter = createPlatformIsolation(process.env);
  assert.equal((await adapter.probe()).state, "ready");
  const check = `const fs = require('node:fs');
const net = require('node:net');
const params = JSON.parse(process.argv[1]);
const attempt = fn => { try { fn(); return 'ok'; } catch (err) { return err.code; } };
const result = {
  allowed: attempt(() => fs.writeFileSync(params.allowed, 'inside')),
  outside: attempt(() => fs.writeFileSync(params.outside, 'outside')),
  read: attempt(() => fs.readFileSync(params.hidden)),
  alias: attempt(() => fs.readFileSync(params.alias)),
  write: attempt(() => fs.writeFileSync(params.locked, 'outside')),
  rename: attempt(() => fs.renameSync(params.protectedDir, params.protectedDir + '-renamed')),
};
const socket = net.connect(params.port, '127.0.0.1');
socket.once('connect', () => { console.log(JSON.stringify({...result, net:'connected'})); socket.destroy(); });
socket.once('error', err => console.log(JSON.stringify({...result, net:err.code})));`;
  const request: IsolationRequest = {
    argv: [process.execPath, "-e", check, JSON.stringify({ allowed, outside, hidden, alias, locked, protectedDir, port: endpoint.port })],
    cwd: workspace, files: { writableRoots: [workspace], denyReadPaths: [hidden], denyWritePaths: [locked] },
    network: { allowedDomains: [], deniedDomains: [], egressFenceVerified: true }, timeoutMs: 4000, signal: t.signal,
  };
  const result = await adapter.run(request);
  assert.ok(result.outcome === "completed", JSON.stringify(result));
  assert.equal(result.exitCode, 0, result.stderr);
  const observed = JSON.parse(result.stdout) as Record<string, string>;
  assert.equal(observed.allowed, "ok");
  for (const denied of ["outside", "read", "alias", "write", "rename", "net"]) {
    assert.match(observed[denied] ?? "", /^(EPERM|EACCES)$/, denied);
  }
  assert.equal(readFileSync(allowed, "utf8"), "inside");
  assert.equal(readFileSync(locked, "utf8"), "original");
  assert.equal(connections, 0);

  const noDomainProxy = await adapter.run({ ...request, network: { ...request.network, allowedDomains: ["example.invalid"] } });
  assert.equal(noDomainProxy.outcome, "isolation_failed");
  if (noDomainProxy.outcome === "isolation_failed") assert.equal(noDomainProxy.code, "isolation_refused");
});
