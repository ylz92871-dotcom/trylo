// Pet chain smoke (audit §4.2 PET-P0-1 turn-2 gate).
//
// Drives the Service Host EXACTLY like the Rust shell does — env + stdio,
// no ports — sends pet.enable, and ASSERTS what came back. Previously this
// script only printed; it exited 0 even when no pet ever appeared, so the
// "pet silently never launches" regression could not be caught by CI.
//
// Two modes:
//   default  — assert the protocol chain + an HONEST status. Passes on any
//              machine (the companion exe is optional here).
//   --require-exe
//            — additionally require that TryloDesktopPet.exe actually
//              launched. Windows + a built companion only; CI runs this on
//              the packaging job.
//
// Exit codes: 0 = all assertions passed, 1 = an assertion failed.
const { spawn } = require('node:child_process');
const net = require('node:net');
const path = require('node:path');
const fs = require('node:fs');

const REQUIRE_EXE = process.argv.includes('--require-exe');
const EXE_NAME = 'TryloDesktopPet.exe';
/// The pet's local bridge port (audit §4.3): the ONLY health signal that is
/// about the pet itself. `tasklist` proved the wrong thing — the process can
/// be alive while the window never appears.
const PET_PORT = 49_372;
const PET_HOST = '127.0.0.1';

const repoRoot = path.resolve(__dirname, '..', '..');
const bundled = path.join(repoRoot, 'desktop-services', 'dist', 'host.bundle.mjs');
const unbundled = path.join(repoRoot, 'desktop-services', 'src', 'host.mjs');
// Prefer the built bundle (that is what ships); fall back to the dev entry
// so the gate is runnable before a build.
const entry = fs.existsSync(bundled) ? bundled : unbundled;
const sidecarsDir = path.join(repoRoot, 'desktop', 'sidecars');

const failures = [];
function check(ok, label, detail) {
  if (ok) {
    console.log(`  ok   ${label}`);
    return true;
  }
  console.error(`  FAIL ${label}${detail === undefined ? '' : ` — ${detail}`}`);
  failures.push(label);
  return false;
}

const STATUS_KEYS = [
  'enabled',
  'exeFound',
  'launchAttempted',
  'launched',
  'chatConnected',
  'exePath',
  'reasonCode',
];

const child = spawn(process.execPath, [entry], {
  // stderr is CAPTURED, not inherited: on timeout it is echoed as a
  // diagnostic. The host sanitises it, but it is still bounded here so a
  // flood cannot swamp the harness either.
  stdio: ['pipe', 'pipe', 'pipe'],
  env: {
    ...process.env,
    TRYLO_SIDECARS_DIR: sidecarsDir,
    TRYLO_APP_DATA_DIR:
      process.env.TRYLO_APP_DATA_DIR ||
      path.join(process.env.APPDATA || process.env.HOME || '', 'com.trylo.desktop'),
  },
});

let out = '';
// Bounded: keep only the tail, so a runaway sidecar cannot exhaust the
// harness's memory.
let err = '';
const STDERR_LIMIT = 8_192;
child.stdout.on('data', (d) => {
  out += d.toString();
  if (out.length > 65_536) out = out.slice(-32_768);
});
child.stderr.on('data', (d) => {
  err += d.toString();
  if (err.length > STDERR_LIMIT) err = `…(truncated)…\n${err.slice(-STDERR_LIMIT / 2)}`;
});

const frames = () =>
  out
    .split('\n')
    .filter(Boolean)
    .map((l) => {
      try {
        return JSON.parse(l);
      } catch {
        return null;
      }
    })
    .filter(Boolean);

async function waitFor(pred, label, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const found = frames().find(pred);
    if (found) return found;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

/// Is the pet's bridge actually LISTENING? This is the real "the pet is up"
/// signal (audit §4.3): it proves the WPF companion reached the point where
/// it serves its local channel, which a bare process check cannot.
function petPortIsListening(timeoutMs = 1_500) {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    let settled = false;
    const done = (value) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(value);
    };
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => done(true));
    socket.once('timeout', () => done(false));
    socket.once('error', () => done(false));
    socket.connect(PET_PORT, PET_HOST);
  });
}

/// Wait for the pet.status value to STOP changing (audit §4.3: "最后一条稳定
/// pet.status"). pet.enable can emit a transient status before the chat
/// socket settles; asserting on the first frame tests a race, not a result.
async function waitForStableStatus(timeoutMs = 15_000, quietMs = 1_500) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  let lastChangedAt = Date.now();
  for (;;) {
    const events = frames().filter((f) => f.type === 'event' && f.topic === 'pet.status');
    const current = events.at(-1)?.payload ?? null;
    const serialized = JSON.stringify(current);
    if (serialized !== JSON.stringify(last)) {
      last = current;
      lastChangedAt = Date.now();
    } else if (current !== null && Date.now() - lastChangedAt >= quietMs) {
      return current;
    }
    if (Date.now() > deadline) {
      throw new Error(
        `pet.status never settled — last=${serialized ?? '(none)'}`,
      );
    }
    await new Promise((r) => setTimeout(r, 100));
  }
}

const send = (frame) => child.stdin.write(`${JSON.stringify(frame)}\n`);

(async () => {
  console.log(`pet-chain-smoke: entry=${path.relative(repoRoot, entry)}`);
  console.log(`pet-chain-smoke: sidecarsDir=${sidecarsDir}`);

  // 1. The host must announce readiness on stdout — the Rust shell waits
  //    for this frame before it considers the spawn successful.
  const ready = await waitFor((f) => f.type === 'event' && f.topic === 'ready', 'the ready frame');
  check(ready.type === 'event', 'host announces ready');

  // 2. Liveness: the shell pings, the host must pong (audit SH-P0-4).
  send({ version: 1, type: 'ping' });
  const pong = await waitFor((f) => f.type === 'pong', 'pong');
  check(pong.type === 'pong', 'host answers the shell ping with pong');

  // 3. pet.enable must produce a status with every field present.
  send({ version: 1, type: 'request', id: 'e1', method: 'pet.enable', params: { workspacePath: repoRoot } });

  // The enable RESPONSE that belongs to THIS request — matching by id, not
  // by "whichever response arrived first".
  const enabled = await waitFor((f) => f.type === 'response' && f.id === 'e1', 'the pet.enable response');
  const result = enabled.result || {};

  // The LAST STABLE status event (audit §4.3): enable can emit a transient
  // status before the chat socket settles, and asserting on that first frame
  // tests a race rather than a result.
  const payload = await waitForStableStatus();

  const missingKeys = STATUS_KEYS.filter((k) => !(k in payload));
  check(missingKeys.length === 0, 'pet.status carries every field', missingKeys.join(','));

  // 4. The core regression: never claim a launch that did not happen. The
  //    ground truth is the pet's own bridge port — a live process whose
  //    window never opened must still not be reported as `launched`.
  const listening = await petPortIsListening();
  if (listening) {
    check(payload.launched === true, 'status says launched when the pet bridge is listening');
    check(payload.exeFound === true, 'status says exeFound when the pet bridge is listening');
  } else {
    check(
      payload.launched === false,
      'status does NOT claim launched when the pet bridge is not listening',
      `launched=${payload.launched} reasonCode=${payload.reasonCode}`,
    );
    // A silent failure is the thing that cost a debug round: the status must
    // always carry a reason when the pet is not up.
    check(
      Boolean(payload.reasonCode),
      'a non-launch reports a reason code instead of silence',
      `reasonCode=${payload.reasonCode || '(empty)'}`,
    );
  }

  // 5. The enable response and the settled event must agree — otherwise the
  //    UI is being told two different stories.
  check(
    result.launched === payload.launched && result.reasonCode === payload.reasonCode,
    'the enable response agrees with the settled pet.status event',
    `response=${JSON.stringify(result)} event=${JSON.stringify(payload)}`,
  );

  // 6. pet.status must be queryable without a prior enable (PET-P0-1).
  send({ version: 1, type: 'request', id: 'q1', method: 'pet.status' });
  const query = await waitFor((f) => f.type === 'response' && f.id === 'q1', 'the pet.status response', 5_000);
  check(query.ok === true, 'pet.status is a query, not only an event');
  for (const key of STATUS_KEYS) {
    check(key in (query.result || {}), `pet.status query carries '${key}'`);
  }

  // 7. Opt-in: the pet must really be up (packaging job on Windows).
  if (REQUIRE_EXE) {
    check(payload.launched === true, '--require-exe: the companion launched', `reasonCode=${payload.reasonCode}`);
    check(listening, `--require-exe: ${EXE_NAME} is listening on ${PET_PORT}`);
    check(payload.chatConnected === true, '--require-exe: chatConnected is true', `chatConnected=${payload.chatConnected}`);
  }

  console.log(`pet-chain-smoke: enable response=${JSON.stringify(result)}`);
  console.log(`pet-chain-smoke: settled status=${JSON.stringify(payload)}`);

  // Leave no pet behind: pet.disable sends the UDP detach so the WPF window
  // exits instead of lingering after the harness does.
  send({ version: 1, type: 'request', id: 'x1', method: 'pet.disable' });
  try {
    await waitFor((f) => f.type === 'response' && f.id === 'x1', 'the pet.disable response', 3_000);
  } catch {
    /* best effort — the harness is about to exit anyway */
  }
  if (failures.length > 0) {
    console.error(`pet-chain-smoke: FAILED (${failures.length} check(s))`);
    process.exit(1);
  }
  console.log('pet-chain-smoke: OK');
  process.exit(0);
})().catch((e) => {
  // The audit's explicit requirement: on timeout, print the reason code and
  // the sanitised stderr tail. "It timed out" alone is what made this class
  // of failure expensive to diagnose.
  console.error(`pet-chain-smoke: FAILED — ${e.message}`);
  const lastStatus = frames()
    .filter((f) => f.type === 'event' && f.topic === 'pet.status')
    .at(-1);
  if (lastStatus) {
    console.error(`pet-chain-smoke: last pet.status reasonCode=${lastStatus.payload?.reasonCode}`);
  }
  if (err.trim()) {
    console.error(`pet-chain-smoke: host stderr (sanitised, tail only):\n${err.trim()}`);
  }
  child.kill();
  process.exit(1);
});
