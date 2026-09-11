#!/usr/bin/env node
// End-to-end Work probe against a REAL trylo-workd daemon (real coworkd
// backend) with a fault-injecting LLM gateway in front of it.
//
// Purpose: measure how the daemon behaves under the two conditions that the
// user's gateway actually exhibits and that scripts/mock-anthropic-e2e.mjs
// never produces: HTTP 429 rate limiting and slow/stalled responses.
//
// Usage:
//   node work/scripts/work-fault-e2e.mjs --mode ratelimit:3
//   node work/scripts/work-fault-e2e.mjs --mode slow:8000 --timeout 90000
//   node work/scripts/work-fault-e2e.mjs --mode hang:2 --timeout 120000
//
// It never touches the user's real data dir; everything is a temp dir.

import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';

// Same renderer pipeline the Desktop UI runs: raw daemon frames →
// semantic items → the WorkTurnProjection the components read from. Feeding
// the live stream through it here means the probe reports what the UI would
// actually be able to show, not just what the socket carried.
import { consumeFrame, FrameDedupe } from '../src/consume-frame.js';
import { runIdForTask, TaskRegistry } from '../src/task-registry.js';
import {
  createWorkTurnProjection,
  reduceWorkItem,
} from '../src/work-workflow-reducer.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const WORK_ROOT = resolve(__dirname, '..');

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const FAULT_MODE = arg('mode', 'normal');
const SCENARIO = arg('scenario', 'default');
const TOTAL_TIMEOUT_MS = Number(arg('timeout', '120000'));
const GATEWAY_PORT = Number(arg('gateway-port', '47842'));
const DAEMON_PORT = Number(arg('daemon-port', '47891'));
// Must satisfy isStrongControlPlaneToken(): >=32 chars (product path uses a
// 64-char hex token from workd.rs::generate_control_plane_token).
const TOKEN = Array.from({ length: 64 }, () =>
  '0123456789abcdef'[Math.floor(Math.random() * 16)],
).join('');

const startedAt = Date.now();
const t = () => Date.now() - startedAt;
const say = (...a) => process.stdout.write(`[${String(t()).padStart(6)}ms] ${a.join(' ')}\n`);

const tmpRoot = mkdtempSync(join(tmpdir(), 'trylo-fault-e2e-'));
const userDataDir = join(tmpRoot, 'user-data');
const workspaceDir = join(tmpRoot, 'ws');
const daemonLogPath = join(tmpRoot, 'daemon.log');
const gatewayLogPath = join(tmpRoot, 'gateway.jsonl');
mkdirSync(workspaceDir, { recursive: true });
writeFileSync(join(workspaceDir, 'README.md'), '# fixture\n');

const children = [];
function stopAll() {
  for (const c of children) {
    try {
      c.kill('SIGKILL');
    } catch {
      /* ignore */
    }
  }
}

function daemonLog(line) {
  try {
    appendFileSync(daemonLogPath, line + '\n');
  } catch {
    /* ignore */
  }
}

// ── LLM call accounting, parsed from the daemon's own [LLM] log lines ──────
const llmCalls = new Map(); // callId -> { side, start, end, status }
function noteLlm(line) {
  const m = /\[LLM:([^\]]+)\]\s*#(\d+)(\s*\[side\])?\s+(start|success|error|cancelled)/.exec(
    line,
  );
  if (!m) return;
  const [, provider, idStr, side, phase] = m;
  const id = Number(idStr);
  const rec = llmCalls.get(id) ?? { provider, side: Boolean(side) };
  rec.provider = provider;
  if (side) rec.side = true;
  if (phase === 'start') rec.start = t();
  else {
    rec.end = t();
    rec.outcome = phase;
    const ms = /in (\d+)ms/.exec(line);
    if (ms) rec.durationMs = Number(ms[1]);
    const st = /"status":\s*(\d+)/.exec(line);
    if (st) rec.httpStatus = Number(st[1]);
  }
  llmCalls.set(id, rec);
}

// ── tiny WebSocket RPC client ─────────────────────────────────────────────
class Rpc {
  constructor() {
    this.ws = null;
    this.pending = new Map();
    this.id = 0;
    this.events = [];
    /** Set by main(): folds live frames into the UI projection. */
    this.onTaskEvent = null;
  }

  async open(url) {
    this.ws = new WebSocket(url);
    await new Promise((res, rej) => {
      const to = setTimeout(() => rej(new Error('socket open timeout')), 10000);
      this.ws.addEventListener('open', () => {
        clearTimeout(to);
        res();
      });
      this.ws.addEventListener('error', (e) => {
        clearTimeout(to);
        rej(new Error('socket error'));
      });
    });
    this.ws.addEventListener('message', (ev) => {
      const text = typeof ev.data === 'string' ? ev.data : '';
      let frame;
      try {
        frame = JSON.parse(text);
      } catch {
        return;
      }
      if (frame.type === 'event') {
        this.events.push({ t: t(), event: frame.event, payload: frame.payload });
        if (frame.event === 'task.event') this.onTaskEvent?.(frame);
        return;
      }
      if (frame.type === 'res') {
        const p = this.pending.get(frame.id);
        if (!p) return;
        clearTimeout(p.timer);
        this.pending.delete(frame.id);
        if (frame.ok) p.resolve(frame.payload);
        else p.reject(new Error(String(frame.error?.message || 'rpc failed')));
      }
    });
  }

  send(method, params, timeoutMs = 30000) {
    // protocol.ts requires frame.id to be a NON-EMPTY STRING; numeric ids are
    // silently dropped as "Invalid frame".
    const id = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method} timeout after ${timeoutMs}ms`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.ws.send(JSON.stringify({ type: 'req', id, method, params }));
    });
  }
}

async function waitFor(predicate, timeoutMs, label, intervalMs = 250) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return true;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error(`timeout waiting for ${label}`);
}

async function main() {
  say(`fault-mode=${FAULT_MODE} gateway=:${GATEWAY_PORT} daemon=:${DAEMON_PORT}`);

  // 1 ── gateway
  const gateway = spawn(
    process.execPath,
    [join(WORK_ROOT, 'scripts', 'fault-gateway.mjs')],
    {
      env: {
        ...process.env,
        FAULT_PORT: String(GATEWAY_PORT),
        FAULT_MODE,
        FAULT_LOG: gatewayLogPath,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  children.push(gateway);
  gateway.stdout.on('data', (b) => {
    for (const line of String(b).split('\n')) {
      if (line.startsWith('GATEWAY ')) daemonLog(line);
    }
  });

  // 2 ── real daemon
  const daemon = spawn(
    process.execPath,
    [join(WORK_ROOT, 'bin', 'trylo-workd.mjs'), '--user-data-dir', userDataDir],
    {
      env: {
        ...process.env,
        TRYLO_WORKD_MODE: 'real',
        TRYLO_WORKD_HOST: '127.0.0.1',
        TRYLO_WORKD_PORT: String(DAEMON_PORT),
        COWORK_CONTROL_PLANE_TOKEN: TOKEN,
        COWORK_IMPORT_ENV_SETTINGS_MODE: 'merge',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
      cwd: WORK_ROOT,
    },
  );
  children.push(daemon);
  daemon.stdout.on('data', (b) => {
    for (const line of String(b).split('\n')) {
      if (!line.trim()) continue;
      daemonLog(line);
      noteLlm(line);
    }
  });
  daemon.stderr.on('data', (b) => {
    for (const line of String(b).split('\n')) {
      if (line.trim()) daemonLog(line);
    }
  });

  // 3 ── connect
  const url = `ws://127.0.0.1:${DAEMON_PORT}`;
  const rpc = new Rpc();
  await waitFor(
    async () => {
      try {
        await rpc.open(url);
        return true;
      } catch {
        return false;
      }
    },
    120000,
    'daemon websocket',
    1000,
  );
  say('websocket open');
  await rpc.send('connect', { token: TOKEN });
  say('handshake ok');

  // 4 ── point the provider at the fault gateway
  await rpc.send('llm.configure', {
    providerType: 'anthropic-compatible',
    apiKey: 'e2e-key',
    model: 'trylo-fault-model',
    settings: { baseUrl: `http://127.0.0.1:${GATEWAY_PORT}` },
  });
  say('llm.configure ok');

  // 5 ── workspace
  let list = await rpc.send('workspace.list', {});
  let ws = list?.workspaces?.[0];
  let workspaceId = ws?.id;
  if (!workspaceId) {
    const created = await rpc.send('workspace.create', {
      name: 'fault-e2e',
      path: workspaceDir,
      permissions: { shell: true },
    });
    ws = created?.workspace ?? created;
    workspaceId = ws?.id;
  }
  // The daemon's default workspace points at <user-data>/company-workspaces/
  // local, not our temp dir — seed the fixture where tools will actually look.
  const wsPath = ws?.path ?? workspaceDir;
  mkdirSync(wsPath, { recursive: true });
  writeFileSync(join(wsPath, 'README.md'), '# fixture\n');
  say(`workspace=${workspaceId} path=${wsPath}`);

  // 6 ── create task
  const rpcT0 = Date.now();
  // Scenarios keep non-ASCII prompts inside this file (UTF-8) instead of
  // passing them through the shell, where console encoding mangles them.
  const SCENARIO_PROMPTS = {
    default: 'Read README.md and report the result.',
    // Real failure case: an analysis-only request phrased in Chinese. Before
    // the read-only localisation fix this was held to a strict
    // `mutation_required` contract and failed with
    // "mutation-required contract unmet".
    'readonly-zh': '帮我读一下工作区里的文件，给我一些分析建议，不是让你修改，先和我交流',
    // Control: a genuine Chinese mutation request must NOT be downgraded —
    // it contains no negator, so the contract must stay mutation-flavoured.
    'mutate-zh': '请帮我修改工作区里的 README.md 文件，补充一段说明并保存',
  };
  const taskPrompt = SCENARIO_PROMPTS[SCENARIO] ?? SCENARIO_PROMPTS.default;
  say(`scenario=${SCENARIO}`);

  const created = await rpc.send('task.create', {
    title: 'fault e2e',
    prompt: taskPrompt,
    workspaceId,
    shellAccess: true,
  }, 30000);
  const taskId = created?.taskId ?? created?.task?.id;
  say(`task.create ack in ${Date.now() - rpcT0}ms taskId=${taskId}`);

  // 6b ── mirror the live stream through the renderer pipeline so the report
  //      shows what the UI can actually display.
  const runId = runIdForTask(taskId);
  const registry = new TaskRegistry();
  registry.register({
    taskId,
    runId,
    turnId: `turn:${taskId}`,
    workspaceId,
    projectRoot: wsPath,
    conversationId: 'e2e',
    sessionId: 'e2e',
    status: 'running',
    lastSeq: 0,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    intent: 'task',
  });
  const dedupe = new FrameDedupe();
  let projection = createWorkTurnProjection({
    taskId,
    runId,
    turnId: `turn:${taskId}`,
    conversationId: 'e2e',
    intent: 'task',
  });
  rpc.onTaskEvent = (frame) => {
    const update = consumeFrame(frame, { registry, dedupe });
    if (update.kind !== 'accepted') return;
    for (const item of update.items) projection = reduceWorkItem(projection, item);
  };

  // 7 ── observe
  let lastStatus = null;
  const deadline = Date.now() + Math.max(1000, TOTAL_TIMEOUT_MS - (Date.now() - startedAt));
  while (Date.now() < deadline) {
    let row;
    try {
      row = await rpc.send('task.get', { taskId }, 10000);
    } catch (e) {
      say(`task.get failed: ${e.message}`);
      break;
    }
    const status = row?.task?.status ?? row?.status;
    if (status !== lastStatus) {
      say(`status -> ${status}`);
      lastStatus = status;
    }
    if (status && ['completed', 'failed', 'cancelled'].includes(status)) break;
    await new Promise((r) => setTimeout(r, 500));
  }

  // 8 ── report
  const calls = [...llmCalls.values()];
  const unfinished = calls.filter((c) => c.start !== undefined && c.end === undefined);
  const withStatus = calls.filter((c) => c.httpStatus !== undefined);
  const rateLimited = withStatus.filter((c) => c.httpStatus === 429);

  say('──────── REPORT ────────');
  say(`final status      : ${lastStatus ?? '(none)'}`);
  say(`llm calls total   : ${calls.length}`);
  say(`llm side calls    : ${calls.filter((c) => c.side).length}`);
  say(`429 responses     : ${rateLimited.length}`);
  say(`unfinished calls  : ${unfinished.length}${unfinished.length ? ' -> ' + JSON.stringify(unfinished.map((c) => c.start)) : ''}`);
  say(`total elapsed     : ${t()}ms`);
  say(`events seen       : ${rpc.events.length}`);
  const byType = {};
  for (const e of rpc.events) byType[e.event] = (byType[e.event] ?? 0) + 1;
  say(`event types       : ${JSON.stringify(byType)}`);

  // Inner event taxonomy: what the renderer actually branches on.
  const byInner = {};
  const notices = [];
  const contracts = [];
  for (const e of rpc.events) {
    if (e.event !== 'task.event') continue;
    const inner = e.payload?.type ?? '(none)';
    // The bridge nests the semantic name one level down:
    // frame.payload = { type, payload: { legacyType, message, elapsedMs } }
    const legacy = e.payload?.payload?.legacyType ?? e.payload?.legacyType ?? '';
    const key = legacy ? `${inner}<${legacy}>` : inner;
    byInner[key] = (byInner[key] ?? 0) + 1;
    if (/llm_slow|llm_retry|llm_plan_fallback|llm_routing/.test(key)) {
      notices.push(`${e.t}ms ${key}`);
    }
    // The daemon announces the step contract it will enforce. This is the
    // decision that failed the user's read-only Chinese task, so surface it.
    if (legacy.includes('required_tool_inference_decision')) {
      const p = e.payload?.payload ?? {};
      contracts.push(`${p.mode ?? '?'}/${p.contractReason ?? '?'}`);
    }
  }
  say(`inner event types : ${JSON.stringify(byInner)}`);
  say(`step contracts    : ${contracts.length ? contracts.join(' | ') : '(none observed)'}`);

  // What the UI can actually show, from the live projection.
  const activityKinds = {};
  for (const a of projection?.activities ?? []) {
    activityKinds[a.kind] = (activityKinds[a.kind] ?? 0) + 1;
  }
  const narrations = projection?.narrations ?? [];
  say('──────── UI PROJECTION ────────');
  say(`narrations (UI)   : ${narrations.length}`);
  for (const n of narrations.slice(-6)) {
    say(`   · ${n.text.slice(0, 78)}`);
  }
  say(`activities (UI)   : ${projection?.activities.length ?? 0}`);
  say(`activity kinds    : ${JSON.stringify(activityKinds)}`);
  say(`unclassified      : ${(projection?.activities ?? []).filter((a) => a.kind === 'other').length}`);
  say(`terminal          : ${projection?.terminal?.kind ?? '(none)'}`);
  say(`stall notices     : ${notices.length ? notices.join(' | ') : '(NONE — UI would show nothing)'}`);
  if (calls.length) {
    const gaps = calls
      .filter((c) => c.start !== undefined)
      .map((c) => c.start)
      .sort((a, b) => a - b);
    const deltas = gaps.slice(1).map((v, i) => v - gaps[i]);
    say(`inter-request gaps: ${JSON.stringify(deltas)}`);
  }
  say(`artifacts         : ${tmpRoot}`);
}

const timer = setTimeout(() => {
  say(`!! HARD TIMEOUT after ${TOTAL_TIMEOUT_MS}ms — this is the hang being measured`);
  reportAndExit(1);
}, TOTAL_TIMEOUT_MS);

function reportAndExit(code) {
  clearTimeout(timer);
  stopAll();
  process.exit(code);
}

main()
  .then(() => reportAndExit(0))
  .catch((err) => {
    say(`FATAL: ${err?.stack || err}`);
    reportAndExit(1);
  });
