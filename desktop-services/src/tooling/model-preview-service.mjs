import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { FRAME_LIMIT } from '../protocol/frames.mjs';
import { MODEL_PREVIEW_EXTENSIONS, modelPreviewScope, previewInput } from './model-preview-contract.mjs';
import { createModelPreviewWatch } from './model-preview-watch.mjs';

async function modelFile(root, requested) {
  const absolute = await fsp.realpath(path.resolve(root, requested));
  const relative = path.relative(root, absolute);
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new Error('model_preview_path_outside_workspace');
  if (!MODEL_PREVIEW_EXTENSIONS.has(path.extname(absolute).toLowerCase())) throw new Error('model_preview_unsupported_format');
  const before = await fsp.stat(absolute);
  if (!before.isFile()) throw new Error('model_preview_file_required');
  const hash = crypto.createHash('sha256');
  for await (const chunk of fs.createReadStream(absolute)) hash.update(chunk);
  const after = await fsp.stat(absolute);
  if (before.size !== after.size || before.mtimeMs !== after.mtimeMs) throw new Error('model_preview_file_changed_while_reading');
  return { path: absolute, fileSignature: hash.digest('hex') };
}
const json = (response, status, value) => { if (!response.destroyed) { response.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); response.end(JSON.stringify(value)); } };

/** Service Host owns scope capabilities and file watches; Desktop owns pixels. */
export function createModelPreviewService({ emit = () => {}, watch, schedule, cancel } = {}) {
  const sessions = new Map(), pending = new Map();
  const incarnation = crypto.randomUUID();
  let bridgeId, server, listening, disposed = false;
  const revisionFor = (session, signature, kind) => `${incarnation}:${signature}:${kind}-${++session.generation}`;
  const watchers = createModelPreviewWatch({ ...(watch ? { watch } : {}), ...(schedule ? { schedule } : {}), ...(cancel ? { cancel } : {}),
    async changed(session, _generation, error, files) {
      if (!bridgeId || !session.model || sessions.get(session.scope) !== session) return;
      const model = session.model, owner = bridgeId;
      const samePath = file => {
        const absolute = path.resolve(session.projectRoot, file);
        return process.platform === 'win32' ? absolute.toLowerCase() === model.path.toLowerCase() : absolute === model.path;
      };
      if (!error && files.length && files.every(samePath)) {
        try {
          const current = await modelFile(session.projectRoot, model.path);
          if (session.model !== model || bridgeId !== owner) return;
          // A foreground open may already have adopted these exact bytes.
          if (current.fileSignature === model.fileSignature) return;
          model.fileSignature = current.fileSignature;
        } catch { error = new Error('model_preview_file_unavailable'); }
      }
      if (session.model !== model || bridgeId !== owner) return;
      model.revision = revisionFor(session, model.fileSignature, 'watch');
      if (error) session.autoRefresh = false;
      emit('modelPreviewChanged', { bridgeId, scope: session.scope, projectRoot: session.projectRoot, workspaceRoot: session.workspaceRoot, conversationId: session.conversationId,
        path: model.path, revision: model.revision, fileSignature: model.fileSignature, ...(error ? { error: 'model_preview_watch_unavailable' } : {}) });
    } });
  function rejectPending(predicate, reason) {
    for (const [id, entry] of pending) if (predicate(entry)) {
      pending.delete(id); entry.reject(new Error(reason));
      emit('modelPreviewCancelled', { id, bridgeId: entry.bridgeId, scope: entry.session.scope });
    }
  }
  function command(session, operation, input, response) {
    if (response?.destroyed) return Promise.reject(new Error('model_preview_cancelled'));
    if (!bridgeId) return Promise.reject(new Error('model_preview_bridge_unavailable: Open Trylo’s 3D preview interface and retry.'));
    const id = crypto.randomUUID(), owner = bridgeId;
    return new Promise((resolve, reject) => {
      const gone = () => rejectPending(entry => entry.id === id, 'model_preview_cancelled');
      const finish = (action, value) => { response?.off('close', gone); action(value); };
      pending.set(id, { id, session, bridgeId: owner, resolve: value => finish(resolve, value), reject: error => finish(reject, error), operation });
      response?.once('close', gone);
      try { emit('modelPreviewCommand', { id, bridgeId: owner, scope: session.scope, projectRoot: session.projectRoot, workspaceRoot: session.workspaceRoot, conversationId: session.conversationId, operation, ...input }); }
      catch { rejectPending(entry => entry.id === id, 'model_preview_bridge_unavailable'); }
    });
  }
  function closeSession(session) {
    watchers.close(session);
    session.watchBridge = undefined;
    rejectPending(entry => entry.session === session, 'model_preview_closed');
    session.model = undefined;
  }
  function connectWatch(session) {
    session.watchBridge = bridgeId;
    try { watchers.open(session); session.autoRefresh = true; }
    catch { session.autoRefresh = false; } // Reading and rendering remain available without a watcher.
  }
  function advanced(session, model, revision, owner, response) {
    return !response?.destroyed && bridgeId === owner && session.model === model && model.revision !== revision;
  }
  async function ready(session, model, response) {
    for (;;) {
      if (session.model !== model) throw new Error('model_preview_superseded');
      if (session.watchBridge !== bridgeId) connectWatch(session);
      const revision = model.revision, owner = bridgeId;
      try {
        const result = await command(session, 'open', { ...model, autoRefresh: session.autoRefresh }, response);
        if (session.model !== model) throw new Error('model_preview_superseded');
        if (result.revision !== model.revision) throw new Error('model_preview_stale_result');
        session.ackBridge = owner; session.readyRevision = revision;
        return { ...result, autoRefresh: session.autoRefresh };
      } catch (error) {
        if (error.message === 'model_preview_file_changed_before_render' && !response?.destroyed && bridgeId === owner && session.model === model) {
          const current = await modelFile(session.projectRoot, model.path);
          if (!response?.destroyed && bridgeId === owner && session.model === model && current.fileSignature !== model.fileSignature) {
            model.fileSignature = current.fileSignature;
            model.revision = revisionFor(session, model.fileSignature, 'changed');
          }
        }
        // Continue only on an observed scene revision, never a repeated error.
        if (!advanced(session, model, revision, owner, response)) throw error;
      }
    }
  }
  async function open(session, requested, response) {
    const file = await modelFile(session.projectRoot, requested);
    if (response?.destroyed) throw new Error('model_preview_cancelled');
    rejectPending(entry => entry.session === session, 'model_preview_superseded');
    const model = { ...file, revision: revisionFor(session, file.fileSignature, 'open') };
    session.model = model;
    connectWatch(session);
    return ready(session, model, response);
  }
  async function execute(session, operation, raw, response) {
    const input = previewInput(operation, raw);
    if (!bridgeId) throw new Error('model_preview_bridge_unavailable: Open Trylo’s 3D preview interface and retry.');
    if (operation === 'open') return open(session, input.path, response);
    if (operation === 'close') {
      if (!session.model) return { closed: true };
      const result = await command(session, operation, { path: session.model.path }, response);
      closeSession(session);
      return result;
    }
    if (!session.model) throw new Error('model_preview_not_open: Call preview_open with a workspace model first.');
    let model = session.model;
    const current = await modelFile(session.projectRoot, model.path);
    if (session.model !== model) throw new Error('model_preview_superseded');
    if (current.fileSignature !== model.fileSignature) { await open(session, current.path, response); model = session.model; }
    for (;;) {
      if (session.model !== model) throw new Error('model_preview_superseded');
      if (session.ackBridge !== bridgeId || session.readyRevision !== model.revision) await ready(session, model, response);
      const revision = model.revision, owner = bridgeId;
      try {
        const result = await command(session, operation, { ...input, path: model.path, revision,
          ...(operation === 'snapshot' ? { maxWidth: 1024, quality: 0.85 } : {}) }, response);
        if (session.model !== model) throw new Error('model_preview_superseded');
        if (result.revision !== model.revision) throw new Error('model_preview_stale_result');
        return result;
      } catch (error) {
        if (!advanced(session, model, revision, owner, response)) throw error;
      }
    }
  }
  async function serve(request, response) {
    if (request.headers.origin) return json(response, 403, { error: 'model_preview_origin_denied' });
    const route = new URL(request.url, 'http://127.0.0.1').pathname;
    const session = [...sessions.values()].find(item => route === `/${item.token}/call`);
    if (!session || request.method !== 'POST') return json(response, 404, { error: 'model_preview_not_found' });
    try {
      let bytes = 0;
      const chunks = [];
      for await (const chunk of request) { bytes += chunk.length; if (bytes > FRAME_LIMIT) throw new Error('model_preview_frame_too_large'); chunks.push(chunk); }
      const value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      const result = await execute(session, value.operation, value.input, response);
      json(response, 200, result);
    } catch (error) { json(response, /bridge|closed|cancelled|superseded/.test(error.message) ? 409 : 400, { error: error.message }); }
  }
  return {
    async configure({ projectRoot, conversationId }) {
      if (disposed) throw new Error('model_preview_host_closed');
      const canonical = await fsp.realpath(projectRoot);
      if (!(await fsp.stat(canonical)).isDirectory()) throw new Error('model_preview_workspace_directory_required');
      if (disposed) throw new Error('model_preview_host_closed');
      const scope = modelPreviewScope({ projectRoot, conversationId });
      if (!sessions.has(scope)) sessions.set(scope, { scope, projectRoot: canonical, workspaceRoot: path.resolve(projectRoot), conversationId, token: crypto.randomBytes(24).toString('hex'), generation: 0 });
      if (!listening) {
        server = http.createServer((request, response) => { void serve(request, response).catch(() => json(response, 500, { error: 'model_preview_host_error' })); });
        listening = new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
        server.unref();
      }
      await listening;
      if (disposed) throw new Error('model_preview_host_closed');
      const session = sessions.get(scope);
      return { scope, gate: `http://127.0.0.1:${server.address().port}/${session.token}` };
    },
    attach() {
      if (disposed) throw new Error('model_preview_host_closed');
      rejectPending(() => true, 'model_preview_bridge_replaced');
      bridgeId = crypto.randomUUID();
      return { bridgeId };
    },
    detach(value = {}) {
      if (!bridgeId || value.bridgeId !== bridgeId) return { ok: false };
      bridgeId = undefined;
      rejectPending(() => true, 'model_preview_bridge_unavailable');
      for (const session of sessions.values()) { watchers.close(session); session.watchBridge = undefined; }
      return { ok: true };
    },
    close({ scope } = {}) {
      const session = sessions.get(scope);
      if (!session) return { ok: false };
      closeSession(session);
      return { ok: true };
    },
    commandResult({ id, bridgeId: owner, result, error } = {}) {
      const entry = pending.get(id);
      if (!entry || owner !== bridgeId || owner !== entry.bridgeId) return { ok: false };
      pending.delete(id);
      try {
        if (error) throw new Error(String(error));
        if (!result || typeof result !== 'object' || Array.isArray(result) || Buffer.byteLength(JSON.stringify(result)) + 1024 >= FRAME_LIMIT) throw new Error('model_preview_invalid_or_oversized_result');
        if (entry.operation !== 'close') {
          const model = entry.session.model;
          if (!model || path.resolve(result.path ?? '') !== model.path || result.revision !== model.revision
            || result.fileSignature !== undefined && result.fileSignature !== model.fileSignature
            || !Number.isSafeInteger(result.version) || result.version < 1) throw new Error('model_preview_stale_result');
        }
        if (entry.operation === 'snapshot') {
          const match = /^data:image\/jpeg;base64,([A-Za-z0-9+/]+={0,2})$/.exec(result.dataUrl ?? '');
          const bytes = match ? Buffer.from(match[1], 'base64') : undefined;
          if (!bytes || bytes.toString('base64') !== match[1] || bytes.length < 4 || bytes[0] !== 255 || bytes[1] !== 216 || bytes.at(-2) !== 255 || bytes.at(-1) !== 217
            || result.mimeType !== 'image/jpeg' || !Number.isSafeInteger(result.width) || result.width < 1 || !Number.isSafeInteger(result.height) || result.height < 1) throw new Error('model_preview_invalid_snapshot');
        }
        entry.resolve(result);
        return { ok: true };
      } catch (failure) { entry.reject(failure); return { ok: false }; }
    },
    async dispose() {
      disposed = true; bridgeId = undefined;
      rejectPending(() => true, 'model_preview_host_closed'); watchers.dispose(); sessions.clear();
      if (server) { await listening?.catch(() => {}); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
    },
  };
}
