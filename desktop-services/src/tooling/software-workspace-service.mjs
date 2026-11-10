import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { discoverRepositoryToolRegistry } from './tool-package-manager.mjs';
import { createSoftwareProcess } from './software-workspace-process.mjs';
import { SOFTWARE_RUNTIME_FILES, SOFTWARE_VERSION, softwareInput, softwareScope } from './software-workspace-contract.mjs';

const json = (response, status, value) => {
  if (response.destroyed) return;
  response.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  response.end(JSON.stringify(value));
};
const readBody = async request => {
  let result = '';
  for await (const part of request) result += part;
  return JSON.parse(result || '{}');
};

/** One conversation-scoped native owner. The MCP relay changes placement,
 * not tool schemas, approval policy, API implementation or the CLI engine. */
export function createSoftwareWorkspace({ storageRoot, resolveRuntime, emit = () => {},
  platform = process.platform, createProcess = createSoftwareProcess,
  prepareDirectory = directory => fs.mkdir(directory, { recursive: true }).then(() => directory) } = {}) {
  const sessions = new Map();
  let server, listening, clientMonitor, closed = false;

  function sessionFor(params) {
    if (closed) throw new Error('software_workspace_closed');
    const scope = softwareScope(params);
    let session = sessions.get(scope);
    if (!session) {
      session = { scope, token: crypto.randomBytes(32).toString('hex'), projectRoot: params.projectRoot,
        conversationId: params.conversationId, id: crypto.randomUUID(), revision: 0,
        held: false, active: 0, packages: new Map(), clients: new Map(), applications: [], windows: [], state: 'idle', detail: '' };
      sessions.set(scope, session);
    }
    return session;
  }
  function state(session) {
    return { scope: session.scope, sessionId: session.id, revision: session.revision,
      state: session.state, detail: session.detail, control: session.held ? session.active ? 'pending' : 'user' : 'agent',
      inFlight: session.active, applications: session.applications, windows: session.windows };
  }
  function report(session) { session.revision++; emit('softwareWorkspaceState', state(session)); }

  async function native(session) {
    if (session.stopping) throw new Error('软件工作区正在关闭，请稍后重试');
    if (session.process) return session.process;
    if (session.starting) return session.starting;
    session.state = 'starting'; session.detail = ''; report(session);
    const incarnation = session.id;
    const starting = (async () => {
      if (platform !== 'win32') throw new Error('软件工作区目前支持 Windows');
      const runtime = await resolveRuntime();
      if (!runtime?.executable || !runtime.entry) throw new Error('内置电脑工具运行环境不可用，请在设置中检查工具服务');
      const directory = await prepareDirectory(path.join(storageRoot, 'software-workspaces', incarnation));
      if (session.id !== incarnation || closed) throw new Error('软件工作区已取消');
      const child = createProcess({ ...runtime, directory, onEvent: event => {
        if (session.id === incarnation && event.event === 'applicationLaunched') {
          session.applications = [...session.applications.filter(app => app.id !== event.application.id), event.application];
          session.state = 'running'; report(session);
        }
      }, onFailure: detail => {
        if (session.id !== incarnation || session.stopping) return;
        session.process = undefined; session.state = 'error'; session.detail = detail; report(session);
      } });
      session.process = child;
      session.state = 'running'; report(session);
      return child;
    })().catch(error => {
      if (session.id === incarnation && !session.stopping) { session.state = 'error'; session.detail = error.message; report(session); }
      throw error;
    }).finally(() => { if (session.starting === starting) session.starting = undefined; });
    session.starting = starting;
    return starting;
  }
  async function refreshNative(session, discover = false) {
    const incarnation = session.id;
    const child = await native(session);
    const observed = await child.request('status');
    const installed = discover ? (await child.request('discover')).applications : session.installed;
    if (session.id !== incarnation || session.process !== child) throw new Error('软件工作区已切换，本次观察已取消');
    session.applications = observed.applications;
    session.windows = observed.windows;
    const exited = observed.applications.filter(app => app.exitCode !== null && app.exitCode !== undefined);
    session.detail = exited.length && !observed.applications.some(app => app.running)
      ? `${exited.at(-1).name} 已退出（退出码 ${exited.at(-1).exitCode}）。请重新启动软件并查看其提示。` : '';
    if (installed) session.installed = installed;
    report(session);
    return { ...state(session), ...(installed ? { installed } : {}) };
  }
  function refresh(session, discover = false) {
    if (session.refreshing) return session.refreshing;
    const refreshing = refreshNative(session, discover).finally(() => {
      if (session.refreshing === refreshing) session.refreshing = undefined;
    });
    session.refreshing = refreshing;
    return refreshing;
  }
  async function stop(session) {
    if (session.stopping) return session.stopping;
    session.stopping = (async () => {
      session.id = crypto.randomUUID();
      session.starting = undefined;
      session.refreshing = undefined;
      session.active = 0;
      const child = session.process;
      session.process = undefined;
      await child?.stop();
      session.applications = []; session.windows = []; session.held = false;
      session.state = 'stopped'; session.detail = ''; report(session);
    })().finally(() => { session.stopping = undefined; });
    return session.stopping;
  }
  async function leased(session, actor, action) {
    if (actor === 'agent' && session.held) throw new Error('用户已接管软件工作区；请等待交还控制后再操作。');
    if (actor === 'user' && (!session.held || session.active)) throw new Error(session.active ? '模型正在完成当前软件操作，完成后即可接管。' : '请先接管软件工作区再操作。');
    const incarnation = session.id;
    session.active++; report(session);
    try { return await action(); }
    finally { if (session.id === incarnation) { session.active--; report(session); } }
  }
  async function execute(session, operation, raw, actor) {
    if (operation === 'control' && actor === 'user') {
      if (typeof raw?.heldByUser !== 'boolean') throw new Error('software_invalid_control');
      session.held = raw.heldByUser; report(session); return state(session);
    }
    const parsed = softwareInput(operation, raw);
    const input = operation === 'open' ? { ...parsed, path: path.resolve(session.projectRoot, parsed.path) } : parsed;
    if (operation === 'status') return ['stopped', 'error'].includes(session.state) && !session.process
      ? { ...state(session), installed: session.installed } : refresh(session, !session.installed);
    if (operation === 'snapshot') {
      if (!session.process) throw new Error('请先启动软件，再读取工作区画面');
      const incarnation = session.id;
      const result = await session.process.request('snapshot', input);
      if (incarnation !== session.id) throw new Error('软件画面已失效，请刷新');
      return { ...result, sessionId: incarnation };
    }
    if (operation === 'close' && actor === 'user') { await stop(session); return state(session); }
    if (operation === 'open' && actor === 'user') {
      if (session.active) throw new Error('模型正在完成当前软件操作，完成后即可启动其他软件。');
      const prior = session.held;
      const incarnation = session.id;
      session.held = true;
      try {
        return await leased(session, 'user', async () => {
          await (await native(session)).request('launch', input);
          return refresh(session);
        });
      } finally { if (session.id === incarnation) { session.held = prior; report(session); } }
    }
    if (operation === 'input' && actor === 'user' && session.held && session.active) {
      const observed = await refresh(session);
      if (!observed.windows.some(window => window.id === input.windowId && window.dialog)) throw new Error('模型正在完成当前软件操作；目前只能处理该软件弹出的对话框。');
      return (await native(session)).request('input', { ...input, dialogOnly: true });
    }
    return leased(session, actor, async () => {
      if (operation === 'close') { await stop(session); return state(session); }
      const child = await native(session);
      const result = await child.request(operation === 'open' ? 'launch' : operation, input);
      if (operation === 'open') return refresh(session);
      return result;
    });
  }
  async function serve(request, response) {
    if (request.headers.origin) return json(response, 403, { error: 'browser origins are not permitted' });
    const [token, route] = new URL(request.url, 'http://127.0.0.1').pathname.slice(1).split('/');
    const session = [...sessions.values()].find(entry => entry.token === token);
    if (!session || request.method !== 'POST' || !['api', 'call'].includes(route)) return json(response, 404, { error: 'not found' });
    try {
      const value = await readBody(request);
      if (route === 'call') return json(response, 200, await execute(session, value.operation, value.input ?? {}, 'agent'));
      const spec = session.packages.get(value.packageId);
      if (!spec) throw new Error('software_api_not_configured');
      const message = value.message;
      if (!message || typeof message !== 'object' || typeof message.method !== 'string') throw new Error('software_invalid_rpc');
      if (typeof value.clientId !== 'string' || !/^[a-zA-Z0-9-]+$/.test(value.clientId)) throw new Error('software_invalid_api_client');
      const key = `${value.packageId}:${value.clientId}`;
      let client = session.clients.get(key);
      if (message.method === 'trylo/clientClosed') {
        session.clients.delete(key);
        if (session.process) await session.process.request('rpc_close', { key });
        return json(response, 200, { ok: true });
      }
      if (!client) {
        client = { spec, pid: Number.isSafeInteger(value.pid) && value.pid > 0 ? value.pid : undefined };
        session.clients.set(key, client);
      }
      if (message.method === 'initialize') client.initialize = message.params;
      const forward = async () => (await native(session)).request('rpc', { packageId: value.packageId,
        clientId: value.clientId, server: client.spec, initialize: client.initialize, message });
      const result = message.method === 'tools/call' ? await leased(session, 'agent', forward) : await forward();
      json(response, 200, result);
    } catch (error) { json(response, 409, { error: String(error.message ?? error) }); }
  }
  async function listen() {
    if (!listening) listening = new Promise((resolve, reject) => {
      server = http.createServer((request, response) => { void serve(request, response); });
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
      // A conversation-scoped gate owned by the tooling services: like the
      // model-preview gate, it must never be the handle that holds the host
      // process open. dispose() remains the release path.
      server.unref();
      clientMonitor = setInterval(() => {
        for (const session of sessions.values()) for (const [key, client] of session.clients) {
          if (!client.pid) continue;
          try { process.kill(client.pid, 0); }
          catch (error) {
            if (error.code !== 'ESRCH') continue;
            session.clients.delete(key);
            void session.process?.request('rpc_close', { key }).catch(() => {});
          }
        }
      }, 1000);
      clientMonitor.unref();
    });
    await listening;
  }
  return {
    async configure(params) {
      const session = sessionFor(params);
      if (params.packageId) {
        if (!['solidworks-mcp', 'autocad-mcp'].includes(params.packageId) || !params.server?.command || !Array.isArray(params.server.args)) throw new Error('software_invalid_api_package');
        session.packages.set(params.packageId, params.server);
      }
      await listen();
      return { gate: `http://127.0.0.1:${server.address().port}/${session.token}`, version: SOFTWARE_VERSION };
    },
    async command(params) { return execute(sessionFor(params), params.operation, params.input ?? {}, 'user'); },
    async dispose() {
      closed = true;
      clearInterval(clientMonitor);
      await Promise.allSettled([...sessions.values()].map(stop));
      server?.closeAllConnections();
      if (server) await new Promise(resolve => server.close(resolve));
      sessions.clear();
    },
  };
}

/** Resolve adjacent shipped assets through the existing registry, never cwd
 * or a developer interpreter. The stager includes the complete Python tree. */
export async function softwareRuntimeEntry(registry = discoverRepositoryToolRegistry()) {
  if (!registry) throw new Error('software_workspace_runtime_missing');
  const root = path.dirname(registry);
  const definition = JSON.parse(await fs.readFile(registry, 'utf8'));
  const bundled = definition.tools?.['windows-mcp']?.policy === 'bundled';
  const inventory = bundled ? JSON.parse(await fs.readFile(path.join(root, 'inventory.json'), 'utf8')).files : undefined;
  for (const relative of SOFTWARE_RUNTIME_FILES) {
    const file = path.join(root, 'software-workspace', relative);
    const stat = await fs.lstat(file);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`软件工作区资源无效：${relative}`);
    if (bundled) {
      const digest = crypto.createHash('sha256').update(await fs.readFile(file)).digest('hex');
      if (inventory?.[`software-workspace/${relative}`] !== digest) throw new Error(`软件工作区资源校验失败：${relative}`);
    }
  }
  return path.join(root, 'software-workspace', 'controller.py');
}
