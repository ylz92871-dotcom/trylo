#!/usr/bin/env node
// Trylo Work — fresh-start baseline audit (D).
//
// Goal: measure the actual timing of
//   spawn → listen → WebSocket OPEN → handshake → llm.configure
// in a clean state (no orphan daemon, no leftover 47821).
//
// Tests three scenarios:
//   Scenario A: real-mode cold start, wait for OPEN, then llm.configure
//               (the "happy path" after the spawn race is over)
//   Scenario B: real-mode cold start, fire llm.configure immediately
//               after constructing the WebSocket, BEFORE OPEN
//               (reproduces the renderer race)
//   Scenario C: stub-mode cold start, same scenario B timing
//               (sanity check that the race is in the Work client,
//               not vendor-specific)
//
// Every timestamp is measured with process.hrtime.bigint() so we
// have nanosecond precision. Output is plain text, designed to be
// pasted into a report. The script does not modify any source.

import { spawn } from "node:child_process";
import { createConnection } from "node:net";
import { performance } from "node:perf_hooks";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
// tests/audit/ → work/ → repo root (C:/work/demo-ws/)
const repoRoot = resolve(__dirname, "..", "..", "..");
const workdScript = resolve(repoRoot, "work", "bin", "trylo-workd.mjs");

// ── helpers ──────────────────────────────────────────────────────────
const log = (...args) => console.log(...args);
const fmt = (ms) => `${ms.toFixed(1)}ms`;

function newId() {
  return Math.random().toString(36).slice(2, 10);
}

// Tracks in-flight request id → method so the message handler
// can label `res` frames with the originating method (the
// Control Plane protocol correlates responses by id, not by
// echoing the method name).
const pendingMethods = new Map();

function waitForTcpListen(host, port, timeoutMs = 30_000) {
  const start = performance.now();
  return new Promise((resolveP, rejectP) => {
    let attempts = 0;
    const tryOnce = () => {
      attempts += 1;
      const sock = createConnection({ host, port });
      let done = false;
      const cleanup = () => {
        if (done) return;
        done = true;
        sock.destroy();
      };
      sock.once("connect", () => {
        cleanup();
        resolveP({ tListen: performance.now() - start, attempts });
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

function spawnDaemon(mode, extraEnv = {}) {
  const env = {
    ...process.env,
    TRYLO_WORKD_MODE: mode,
    TRYLO_WORKD_HOST: "127.0.0.1",
    TRYLO_WORKD_PORT: "47821",
    COWORK_CONTROL_PLANE_TOKEN: "trylo-dev",
    // 401 fix: overwrite mode so stale empty apiKey is replaced.
    COWORK_IMPORT_ENV_SETTINGS_MODE: "overwrite",
    // Fake key — we only need llm.configure to be received and
    // acknowledged, not to actually call the LLM.
    ANTHROPIC_API_KEY: "sk-ant-fake-AUDIT-KEY",
    ...extraEnv,
  };
  const child = spawn(process.execPath, [workdScript], {
    cwd: repoRoot,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  return child;
}

function killDaemon(child) {
  return new Promise((resolveP) => {
    if (!child || child.killed) {
      resolveP();
      return;
    }
    child.once("close", () => resolveP());
    try {
      child.kill();
    } catch {
      resolveP();
    }
    setTimeout(() => {
      if (!child.killed) {
        try { child.kill("SIGKILL"); } catch {}
      }
      resolveP();
    }, 1500);
  });
}

// ── WS control plane client (mirrors work/src/control-plane/client.ts) ─
function makeProbeClient() {
  // This intentionally mirrors the renderer's sendRaw contract:
  // if the socket is not OPEN, the frame is dropped with a warning.
  // See work/src/control-plane/client.ts:161-169.
  let ws = null;
  const sent = { dropped: 0, sent: 0 };
  const log = [];

  function open(url) {
    ws = new WebSocket(url);
    return ws;
  }

  function sendRaw(method, params) {
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      sent.dropped += 1;
      log.push(`drop ${method} readyState=${ws ? ws.readyState : "null"}`);
      return false;
    }
    const id = newId();
    pendingMethods.set(id, method);
    ws.send(JSON.stringify({ type: "req", id, method, params }));
    sent.sent += 1;
    return id;  // return id so callers can correlate the res frame
  }

  return { open, sendRaw, sent, log, getWs: () => ws };
}

// ── scenarios ────────────────────────────────────────────────────────

async function scenario({ name, mode, race, env = {} }) {
  const t0 = performance.now();
  log("");
  log(`### ${name} (mode=${mode}, race=${race})`);

  // Step 1: spawn daemon
  const tSpawn = performance.now();
  const daemon = spawnDaemon(mode, env);
  let daemonStdout = "";
  let daemonStderr = "";
  daemon.stdout.on("data", (c) => (daemonStdout += c.toString()));
  daemon.stderr.on("data", (c) => (daemonStderr += c.toString()));
  let daemonCrashed = null;
  daemon.once("close", (code) => {
    daemonCrashed = code;
  });
  log(`  +${fmt(performance.now() - tSpawn)}  spawn(...) called`);

  // Step 2: wait for TCP listen on 47821
  let listenResult;
  try {
    listenResult = await waitForTcpListen("127.0.0.1", 47821, 30_000);
  } catch (e) {
    log(`  ERROR: ${e.message}`);
    log(`  daemon stdout: ${daemonStdout.slice(0, 200)}`);
    log(`  daemon stderr: ${daemonStderr.slice(0, 200)}`);
    await killDaemon(daemon);
    return;
  }
  const tListen = performance.now() - t0;
  log(`  +${fmt(tListen)}  TCP 47821 listen (after ${listenResult.attempts} probes)`);

  // Step 3: open WebSocket
  const tWsConstruct = performance.now();
  const probe = makeProbeClient();
  const ws = probe.open("ws://127.0.0.1:47821");
  log(`  +${fmt(performance.now() - t0)}  WebSocket constructed (readyState=${ws.readyState})`);

  // Step 4: optional race attempt — fire llm.configure BEFORE OPEN
  if (race) {
    const tRaceSend = performance.now();
    const result = probe.sendRaw("llm.configure", {
      providerType: "anthropic",
      apiKey: "sk-ant-fake-AUDIT-KEY",
    });
    const raceT = performance.now() - tRaceSend;
    log(`  +${fmt(performance.now() - t0)}  race-fire llm.configure (readyState=${ws.readyState})`);
    log(`            sendRaw returned: ${result === false ? "false (DROPPED)" : JSON.stringify(result)}  (call took ${fmt(raceT)})`);
  }

  // Step 5: wait for OPEN + handshake
  const handshakeResult = await new Promise((resolveP) => {
    const tWait = performance.now();
    const events = [];
    let configureId = null;
    ws.addEventListener("open", () => {
      events.push({ name: "open", t: performance.now() - t0 });
    });
    ws.addEventListener("message", (ev) => {
      let frame;
      try { frame = JSON.parse(ev.data); } catch { return; }
      if (frame.type === "event" && frame.event === "connect.challenge") {
        events.push({ name: "challenge", t: performance.now() - t0 });
        const connectId = newId();
        pendingMethods.set(connectId, "connect");
        const connectReq = {
          type: "req",
          id: connectId,
          method: "connect",
          params: { token: "trylo-dev" },
        };
        ws.send(JSON.stringify(connectReq));
        events.push({ name: "connect-sent", t: performance.now() - t0 });
      } else if (frame.type === "res" && frame.id) {
        // The server correlates responses by id, not by echoing method.
        // We track the most-recently sent method on a per-id basis.
        const sentMethod = pendingMethods.get(frame.id) ?? "unknown";
        events.push({
          name: `res:${sentMethod}`,
          t: performance.now() - t0,
          ok: frame.ok,
          error: frame.error ? JSON.stringify(frame.error).slice(0, 200) : undefined,
        });
        if (sentMethod === "connect") {
          // Connect done. Wait a tick, then send llm.configure.
          setTimeout(() => {
            const tC = performance.now();
            // sendRaw now registers the id→method mapping internally
            // and returns the id (or false if dropped). The returned
            // id is the one the daemon will echo back in the `res`.
            const sentId = probe.sendRaw("llm.configure", {
              providerType: "anthropic",
              apiKey: "sk-ant-fake-AUDIT-KEY",
            });
            const wasSent = sentId !== false;
            configureId = wasSent ? sentId : null;
            events.push({
              name: "llm.configure-attempt",
              t: performance.now() - t0,
              sent: wasSent,
              id: configureId,
              readyState: ws.readyState,
              callMs: performance.now() - tC,
            });
          }, 10);
        }
        if (frame.id === configureId) {
          // We've seen the configure response; resolve early.
          setTimeout(() => resolveP(events), 100);
        }
      } else if (frame.type === "event" && frame.event === "connect.success") {
        events.push({ name: "connect.success", t: performance.now() - t0 });
      }
    });
    setTimeout(() => {
      events.push({ name: "TIMEOUT", t: performance.now() - t0 });
      resolveP(events);
    }, 15_000);
  });

  for (const e of handshakeResult) {
    log(`  +${fmt(e.t)}  ${e.name}${e.ok !== undefined ? ` ok=${e.ok}` : ""}${e.error ? ` err=${e.error}` : ""}${e.sent !== undefined ? ` sent=${e.sent}` : ""}${e.readyState !== undefined ? ` readyState=${e.readyState}` : ""}${e.callMs !== undefined ? ` callMs=${fmt(e.callMs)}` : ""}`);
  }

  // Step 6: wait briefly for any pending llm.configure response, then close
  await new Promise((resolveP) => {
    const events = [];
    ws.addEventListener("message", (ev) => {
      let frame;
      try { frame = JSON.parse(ev.data); } catch { return; }
      if (frame.type === "res" && frame.method === "llm.configure") {
        events.push({ name: "llm.configure-res", t: performance.now() - t0, ok: frame.ok, error: frame.error });
      }
    });
    setTimeout(() => {
      for (const e of events) {
        log(`  +${fmt(e.t)}  ${e.name}${e.ok !== undefined ? ` ok=${e.ok}` : ""}${e.error ? ` err=${JSON.stringify(e.error)}` : ""}`);
      }
      try { ws.close(); } catch {}
      resolveP();
    }, 2000);
  });

  // Step 7: teardown
  await killDaemon(daemon);
  log(`  daemon closed code=${daemonCrashed}`);
  if (daemonStderr) {
    const lines = daemonStderr.split(/\r?\n/).filter(Boolean);
    if (lines.length > 0) {
      log(`  daemon stderr (last ${Math.min(5, lines.length)}):`);
      for (const l of lines.slice(-5)) log(`    ${l}`);
    }
  }
}

// ── main ─────────────────────────────────────────────────────────────
async function main() {
  log("=== Trylo Work fresh-start baseline ===");
  log(`workdScript = ${workdScript}`);
  log(`node = ${process.version}`);

  // Scenario A: real mode, no race (waits for OPEN)
  await scenario({
    name: "Scenario A",
    mode: "real",
    race: false,
  });

  // Scenario B: real mode, race (fires llm.configure before OPEN)
  await scenario({
    name: "Scenario B",
    mode: "real",
    race: true,
  });

  // Scenario C: stub mode, race (no coworker, faster)
  await scenario({
    name: "Scenario C",
    mode: "stub",
    race: true,
  });

  log("");
  log("=== Done ===");
  process.exit(0);
}

main().catch((err) => {
  console.error("fatal:", err);
  process.exit(2);
});
