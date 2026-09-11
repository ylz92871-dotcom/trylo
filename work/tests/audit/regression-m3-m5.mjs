#!/usr/bin/env node
// Trylo Work — M3+M5 regression test.
//
// Goal: prove the ControlPlane client no longer drops
// requests that arrive before the WebSocket is OPEN, and
// that whenReady() resolves once the handshake completes.
//
// Setup:
//   1. Spawn a real-mode trylo-workd daemon (cold start).
//   2. IMMEDIATELY create a ControlPlaneClient and fire
//      send('llm.configure', ...) — this races the spawn.
//   3. Also call client.whenReady() — should resolve after
//      the handshake, not reject.
//
// Pass criteria:
//   - The send must NOT be dropped. The promise must
//     eventually resolve with an `ok=true` response, OR
//     reject with a timeout (but not with "dropping ...
//     socket not open").
//   - whenReady() must resolve (not reject) once the
//     handshake completes.
//
// Why a separate test: the previous baseline-fresh-start
// uses a hand-rolled probe that mirrors the OLD sendRaw
// drop behaviour, so it can only show the bug, not the
// fix. This test exercises the real client.

import { spawn } from "node:child_process";
import { createConnection } from "node:net";
import { performance } from "node:perf_hooks";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { createControlPlaneClient } from "../../src/control-plane/client.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
// tests/audit/ → work/ → repo root
const repoRoot = resolve(__dirname, "..", "..", "..");
const workdScript = resolve(repoRoot, "work", "bin", "trylo-workd.mjs");

function log(...args) { console.log(...args); }
const fmt = (ms) => `${ms.toFixed(1)}ms`;

function waitForTcpListen(host, port, timeoutMs = 30_000) {
  const start = performance.now();
  return new Promise((resolveP, rejectP) => {
    const tryOnce = () => {
      const sock = createConnection({ host, port });
      let done = false;
      const cleanup = () => {
        if (done) return;
        done = true;
        sock.destroy();
      };
      sock.once("connect", () => {
        cleanup();
        resolveP({ tListen: performance.now() - start });
      });
      sock.once("error", () => {
        cleanup();
        if (performance.now() - start > timeoutMs) {
          rejectP(new Error(`TCP listen wait timed out after ${timeoutMs}ms`));
          return;
        }
        setTimeout(tryOnce, 25);
      });
    };
    tryOnce();
  });
}

function spawnDaemon() {
  const env = {
    ...process.env,
    TRYLO_WORKD_MODE: "real",
    TRYLO_WORKD_HOST: "127.0.0.1",
    TRYLO_WORKD_PORT: "47821",
    COWORK_CONTROL_PLANE_TOKEN: "trylo-dev",
    COWORK_IMPORT_ENV_SETTINGS_MODE: "overwrite",
    ANTHROPIC_API_KEY: "sk-ant-fake-AUDIT-KEY",
  };
  const child = spawn(process.execPath, [workdScript], {
    cwd: repoRoot,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stderr = "";
  child.stderr.on("data", (c) => (stderr += c.toString()));
  return { child, getStderr: () => stderr };
}

function killDaemon(child) {
  return new Promise((resolveP) => {
    if (!child || child.killed) {
      resolveP();
      return;
    }
    child.once("close", () => resolveP());
    try { child.kill(); } catch {}
    setTimeout(() => {
      if (!child.killed) { try { child.kill("SIGKILL"); } catch {} }
      resolveP();
    }, 1500);
  });
}

async function runOnce(label) {
  const t0 = performance.now();
  log("");
  log(`### ${label}`);

  // 1. Cold start: spawn daemon.
  const tSpawn = performance.now();
  const { child, getStderr } = spawnDaemon();
  let exited = null;
  child.once("close", (code) => { exited = code; });
  log(`  +${fmt(performance.now() - t0)}  spawn() called`);

  // 2. IMMEDIATELY (no await on listen) create the client
  //    and fire both a send and a whenReady. This is the
  //    real renderer race.
  const client = createControlPlaneClient({
    url: "ws://127.0.0.1:47821",
    token: "trylo-dev",
    onEvent: () => {},
  });
  log(`  +${fmt(performance.now() - t0)}  client created`);

  const tSendStart = performance.now();
  const sendPromise = client.send("llm.configure", {
    providerType: "anthropic",
    apiKey: "sk-ant-fake-AUDIT-KEY",
  });
  log(`  +${fmt(performance.now() - t0)}  client.send('llm.configure', ...) called (status=${client.status()})`);

  const tReadyStart = performance.now();
  const readyPromise = client.whenReady(15_000);
  log(`  +${fmt(performance.now() - t0)}  client.whenReady() called`);

  // 3. Wait for the daemon to come up.
  try {
    const { tListen } = await waitForTcpListen("127.0.0.1", 47821, 20_000);
    log(`  +${fmt(performance.now() - t0)}  TCP 47821 listen (${fmt(tListen)} after spawn)`);
  } catch (e) {
    log(`  ERROR: ${e.message}`);
    if (exited !== null) log(`  daemon exit code: ${exited}`);
    if (getStderr()) log(`  daemon stderr: ${getStderr().slice(0, 200)}`);
    await killDaemon(child);
    return { passed: false, reason: "tcp-listen-timeout" };
  }

  // 4. Drive the client. We don't have a Tauri "connect the
  //    client" trigger because the real renderer does that
  //    in the auto-spawn useEffect (M4). The client was
  //    created in step 2 with no connect() call yet; call it
  //    now.
  client.connect();
  log(`  +${fmt(performance.now() - t0)}  client.connect() called`);

  // 5. Wait for both promises.
  const results = await Promise.allSettled([readyPromise, sendPromise]);

  const [readyRes, sendRes] = results;
  log(`  +${fmt(performance.now() - t0)}  whenReady() ${readyRes.status === "fulfilled" ? "RESOLVED" : `REJECTED: ${readyRes.reason?.message ?? readyRes.reason}`}`);
  log(`  +${fmt(performance.now() - t0)}  send()      ${sendRes.status === "fulfilled" ? `RESOLVED: ok=${sendRes.value?.ok !== false ? "true" : sendRes.value?.ok}` : `REJECTED: ${sendRes.reason?.message ?? sendRes.reason}`}`);

  await killDaemon(child);
  if (getStderr()) {
    const lines = getStderr().split(/\r?\n/).filter(Boolean).slice(-3);
    if (lines.length) {
      log(`  daemon stderr (last 3):`);
      for (const l of lines) log(`    ${l}`);
    }
  }

  // Pass criteria:
  //   whenReady must resolve
  //   send must resolve (not be dropped) with ok=true
  const passed =
    readyRes.status === "fulfilled" &&
    sendRes.status === "fulfilled" &&
    (sendRes.value?.ok !== false);
  return {
    passed,
    reason: passed ? "ok" :
      readyRes.status !== "fulfilled" ? "whenReady-rejected" :
      sendRes.status !== "fulfilled" ? "send-rejected" :
      "send-not-ok",
  };
}

async function main() {
  log("=== Trylo Work M3+M5 regression ===");
  log(`workdScript = ${workdScript}`);

  const results = [];
  for (let i = 1; i <= 2; i++) {
    // Cleanup between runs.
    try {
      const r = await runOnce(`Run ${i}`);
      results.push(r);
    } catch (e) {
      log(`  FATAL: ${e.message}`);
      results.push({ passed: false, reason: e.message });
    }
  }

  log("");
  log("=== Summary ===");
  log(JSON.stringify(results, null, 2));
  process.exit(results.every((r) => r.passed) ? 0 : 1);
}

main().catch((err) => {
  console.error("fatal:", err);
  process.exit(2);
});
