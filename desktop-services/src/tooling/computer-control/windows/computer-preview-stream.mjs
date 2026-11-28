import path from 'node:path';
import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { COMPUTER_PREVIEW_WORKER } from './computer-preview-worker.mjs';

// Service Host frames have a 2 MiB cap, including JSON and base64 overhead.
const MAX_LINE_BYTES = 1900 * 1024;
const MAX_PIXELS = 34 * 1024 * 1024;
const MAX_PREFETCH_AGE_MS = 200;

export function computerPreviewScope({ projectRoot, conversationId }) {
  return JSON.stringify([path.resolve(projectRoot).replaceAll('\\', '/').toLowerCase().replace(/\/$/, ''), conversationId]);
}

function validFrame(frame) {
  return frame && typeof frame === 'object' && frame.type === 'frame' && ['image/jpeg', 'image/png'].includes(frame.mimeType)
    && typeof frame.data === 'string' && frame.data.length <= 1_800_000 && /^[A-Za-z0-9+/]+={0,2}$/.test(frame.data)
    && Number.isInteger(frame.width) && frame.width > 0
    && Number.isInteger(frame.height) && frame.height > 0
    && frame.width * frame.height <= MAX_PIXELS
    && ['originX', 'originY', 'timestamp', 'seq'].every(key => Number.isFinite(frame[key]))
    && Number.isSafeInteger(frame.seq) && frame.seq > 0
    && ['cursorX', 'cursorY'].every(key => frame[key] === undefined || Number.isFinite(frame[key]));
}

/** Owns only the read-only capture worker. It never starts an MCP server or
 * touches the mouse, keyboard, model input, screenshot cache or active task. */
export function createComputerPreviewStream({ resolveExecutable, emit, spawnWorker = spawn,
  platform = process.platform, startupTimeoutMs = 12_000, frameTimeoutMs = 10_000 }) {
  let current;
  let generation = 0;

  const status = (entry, state, detail = '') => emit?.('computerPreviewStatus', { scope: entry.scope, streamId: entry.streamId, state, detail });
  function release(entry, state = 'stopped', detail = '') {
    clearTimeout(entry.startupTimer);
    clearTimeout(entry.frameTimer);
    clearTimeout(entry.deliveryTimer);
    entry.pendingFrame = undefined;
    entry.cancelResolution?.(detail || '预览已取消');
    if (current === entry) current = undefined;
    entry.active = false;
    try { entry.child?.stdin.end('stop\n'); } catch { /* Broken pipe already disconnects capture. */ }
    if (entry.child && entry.child.exitCode == null) {
      const timer = setTimeout(() => { try { entry.child.kill(); } catch { /* Already exited. */ } }, 300);
      timer.unref?.();
      entry.child.once('exit', () => clearTimeout(timer));
    }
    status(entry, state, detail);
  }

  function stop(params = {}) {
    if (params.scope && current?.scope !== params.scope) return { ok: true };
    if (params.streamId && current?.streamId !== params.streamId) return { ok: true };
    generation++;
    if (current) release(current);
    return { ok: true };
  }

  async function start(params = {}) {
    if (typeof params.projectRoot !== 'string' || !path.isAbsolute(params.projectRoot)
      || typeof params.conversationId !== 'string' || !params.conversationId.trim()
      || (params.streamId !== undefined && (typeof params.streamId !== 'string' || !params.streamId || params.streamId.length > 1024))
      || (params.display !== undefined && (!Number.isInteger(params.display) || params.display < 0))
      || (params.excludeWindow !== undefined && (!Number.isSafeInteger(params.excludeWindow) || params.excludeWindow < 0))) {
      return { ok: false, error: '预览需要有效的项目、会话和显示器' };
    }
    const scope = computerPreviewScope(params);
    const display = params.display ?? 0;
    const excludeWindow = params.excludeWindow ?? 0;
    const same = current?.scope === scope && current.display === display && current.excludeWindow === excludeWindow;
    const streamId = params.streamId ?? (same ? current.streamId : randomUUID());
    if (same && current.streamId === streamId) return { ok: true, streamId };
    stop();
    const version = generation;
    const entry = { scope, streamId, display, excludeWindow, active: true, buffer: '', waiting: false, seq: 0 };
    current = entry;
    status(entry, 'starting', '正在连接实时电脑画面');
    if (platform !== 'win32') {
      release(entry, 'error', '实时电脑预览仅支持 Windows');
      return { ok: false, error: '实时电脑预览仅支持 Windows' };
    }
    try {
      const interrupted = new Promise(resolve => {
        entry.cancelResolution = error => resolve({ error });
      });
      // Package resolution and Python initialization share one budget. A
      // pending resolver must also release its RPC immediately on cancellation.
      entry.startupTimer = setTimeout(() => {
        if (current === entry && entry.active && version === generation) release(entry, 'error', '实时预览启动超时');
      }, startupTimeoutMs);
      const resolution = await Promise.race([
        Promise.resolve(resolveExecutable()).then(executable => ({ executable })), interrupted,
      ]);
      entry.cancelResolution = undefined;
      if (resolution.error) return { ok: false, error: resolution.error };
      const executable = resolution.executable;
      if (version !== generation || current !== entry) return { ok: false, error: '预览已取消' };
      if (!executable) throw new Error('Windows-MCP 的 Python 环境不可用');
      const child = spawnWorker(executable, ['-u', '-c', COMPUTER_PREVIEW_WORKER, String(display), String(excludeWindow)], {
        windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
      });
      entry.child = child;
      const active = () => entry.active && current === entry && version === generation;
      const fail = detail => { if (active()) release(entry, 'error', detail); };
      const next = () => {
        // One capture can overlap the renderer round trip, but a slow viewer
        // gets at most one prefetched frame and one unacknowledged delivery.
        if (!active() || entry.waiting || entry.pendingFrame || (entry.awaitingAck && !entry.flushed)) return;
        entry.waiting = true;
        entry.frameTimer = setTimeout(() => fail('实时画面采集超时'), frameTimeoutMs);
        try { child.stdin.write('next\n'); } catch (error) { fail(error.message); }
      };
      entry.completeDelivery = () => {
        if (!active() || !entry.awaitingAck || !entry.flushed || !entry.acknowledged) return;
        clearTimeout(entry.deliveryTimer);
        entry.awaitingAck = false;
        if (entry.pendingFrame) {
          const frame = entry.pendingFrame;
          entry.pendingFrame = undefined;
          if (Date.now() - frame.timestamp <= MAX_PREFETCH_AGE_MS) deliver(frame);
          else next();
        } else next();
      };
      const deliver = message => {
        entry.deliveredSeq = message.seq;
        entry.awaitingAck = true;
        entry.flushed = false;
        entry.acknowledged = false;
        entry.deliveryTimer = setTimeout(() => fail('实时预览未收到画面确认'), frameTimeoutMs);
        const { type: _type, ...frame } = message;
        // Never put a second frame on the transport before the first is
        // acknowledged. Only the local capture overlaps that acknowledgement.
        Promise.resolve(emit?.('computerPreviewFrame', { ...frame, scope, streamId })).then(() => {
          if (!active()) return;
          entry.flushed = true;
          entry.completeDelivery();
          next();
        }, error => fail(error.message));
      };
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', chunk => {
        if (!active()) return;
        entry.buffer += chunk;
        if (entry.buffer.length > MAX_LINE_BYTES) { fail('预览帧超过传输上限'); return; }
        let newline;
        while (active() && (newline = entry.buffer.indexOf('\n')) >= 0) {
          const line = entry.buffer.slice(0, newline);
          entry.buffer = entry.buffer.slice(newline + 1);
          let message;
          try { message = JSON.parse(line); } catch { fail('实时预览协议损坏'); return; }
          if (message?.type === 'status') {
            if (message.state === 'error') { fail(String(message.detail ?? '采集失败')); return; }
            if (message.state === 'running' && !entry.ready) {
              entry.ready = true;
              clearTimeout(entry.startupTimer);
              status(entry, 'running', String(message.detail ?? ''));
              next();
            }
          } else if (validFrame(message)) {
            // A worker may only answer the single outstanding pull.
            if (!entry.waiting || message.seq <= entry.seq) continue;
            clearTimeout(entry.frameTimer);
            entry.waiting = false;
            entry.seq = message.seq;
            if (entry.awaitingAck) entry.pendingFrame = message;
            else deliver(message);
          } else { fail('实时预览帧无效'); return; }
        }
      });
      child.stderr.on('data', () => {}); // Drain diagnostics without retaining pixels or unbounded logs.
      child.stdin.on('error', error => fail(error.message));
      child.once('error', error => fail(error.message));
      child.once('exit', (code) => {
        if (active()) release(entry, 'error', `实时预览进程退出 (${code ?? 'signal'})`);
      });
      return { ok: true, streamId };
    } catch (error) {
      if (version === generation && current === entry) release(entry, 'error', error.message);
      return { ok: false, error: error.message };
    }
  }
  function ack(params = {}) {
    const entry = current;
    if (entry?.active && entry.scope === params.scope && entry.streamId === params.streamId
      && entry.awaitingAck && entry.deliveredSeq === params.seq) {
      entry.acknowledged = true;
      entry.completeDelivery?.();
    }
    return { ok: true };
  }
  return { start, stop, ack, dispose: () => stop() };
}

export async function resolveComputerPreviewPython({ catalog, packages }) {
  const manifest = catalog.get('windows-mcp');
  if (!manifest) return null;
  const resolved = await packages.resolve(manifest);
  if (!resolved?.executable) return null;
  const python = path.join(path.dirname(resolved.executable), 'python.exe');
  return fs.existsSync(python) ? python : null;
}
