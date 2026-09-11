const http = require('node:http');
const crypto = require('node:crypto');
const os = require('node:os');
const { WebSocketServer, WebSocket } = require('ws');

const DEFAULT_PORT = 49380;
const BODY_LIMIT = 256 * 1024;
const SOCKET_TICKET_TTL_MS = 30 * 1000;
const TIMELINE_LIMIT = 24;
const CONVERSATION_LIMIT = 120;
// Trylo P3 patch (2026-09-06, additive): read-only Work deliverables for the
// phone + `surface` forwarding for POST /v1/chat/messages. The Desktop stays
// the authority for every new route (see invokeHandler below); the gateway
// only sanitizes shapes and streams bytes. Recorded in work/README.md
// ("Vendor patches") — this file is no longer byte-identical to upstream.
const ARTIFACT_LIST_LIMIT = 100;
const ARTIFACT_CONTENT_LIMIT = 12 * 1024 * 1024;
const ARTIFACT_PATH_LIMIT = 512;

const PROGRESS_STAGES = {
  idle: { floor: 0, ceiling: 0 },
  thinking: { floor: 4, ceiling: 28 },
  planning: { floor: 12, ceiling: 42 },
  writing_files: { floor: 38, ceiling: 76 },
  running_command: { floor: 52, ceiling: 86 },
  waiting_output: { floor: 64, ceiling: 92 },
  program_running: { floor: 70, ceiling: 95 },
  stalled: { floor: 72, ceiling: 96 },
  done: { floor: 100, ceiling: 100 },
};

const INTERNAL_TRACE_PATTERNS = [
  /adaptive thinking/i,
  /anthropic-compatible endpoint/i,
  /claude cli command started/i,
  /task timeout disabled/i,
  /first token received/i,
  /assistant message detail/i,
  /runtime configuration/i,
  /model request/i,
];

function normalizeAgentMode(value) {
  const mode = String(value || '').toLowerCase();
  return ['agent', 'plan', 'chat', 'office'].includes(mode) ? mode : 'agent';
}

function classifyTimelineEvent(payload, title, detail) {
  const haystack = `${payload.kind || ''} ${title} ${detail}`.toLowerCase();
  if (/permission|approval|approve/.test(haystack)) return 'approval';
  if (/write|edit|patch|create|modified|file/.test(haystack)) return 'change';
  if (/command|shell|terminal|run |build|test/.test(haystack)) return 'command';
  if (/search|read|inspect|find|workspace/.test(haystack)) return 'inspect';
  if (/think|analy|plan|reason/.test(haystack)) return 'thinking';
  return 'progress';
}

function buildConversationFromSession(session) {
  if (!session || typeof session !== 'object') return [];
  const sessionId = String(session.id || 'session');
  const items = [];
  (Array.isArray(session.messages) ? session.messages : []).forEach((message, index) => {
    const role = message && message.role === 'assistant' ? 'assistant' : 'user';
    const text = String(message && message.text || '').trim();
    if (!text) return;
    items.push({
      id: `${sessionId}:message:${index}:${Number(message.at) || 0}`,
      role,
      text: text.slice(0, 24000),
      at: Number(message.at) || Date.now(),
      status: 'done',
    });
  });
  (Array.isArray(session.turns) ? session.turns : []).forEach(turn => {
    (Array.isArray(turn && turn.events) ? turn.events : []).forEach(event => {
      if (String(event && (event.category || event.kind) || '').toLowerCase() !== 'reasoning') return;
      const text = String(event && event.detail || '').trim();
      if (!text) return;
      items.push({
        id: String(event.id || `${turn.id}:thinking:${event.at || 0}`),
        role: 'thinking',
        title: String(event.title || '思考摘要').slice(0, 120),
        text: String(event.rawDetail || event.detail || '').trim(),
        at: Number(event.at) || Number(turn.startedAt) || Date.now(),
        status: event.status === 'running' ? 'streaming' : 'done',
        mode: normalizeAgentMode(turn.mode),
        turnId: String(turn.id || ''),
      });
    });
  });
  return items.sort((left, right) => left.at - right.at).slice(-CONVERSATION_LIMIT);
}

function upsertConversationItem(conversation, item) {
  const items = Array.isArray(conversation) ? conversation.slice(0) : [];
  const index = items.findIndex(existing => existing.id === item.id);
  if (index >= 0) items[index] = { ...items[index], ...item };
  else items.push(item);
  return items.sort((left, right) => left.at - right.at).slice(-CONVERSATION_LIMIT);
}

function normalizeAgentStatus(value) {
  const state = String(value || '').toLowerCase();
  if (state === 'idle') return 'idle';
  if (state === 'done') return 'done';
  if (state === 'failed') return 'failed';
  if (state === 'waiting_output' || state === 'stalled') return 'waiting';
  if (state === 'thinking' || state === 'planning') return 'thinking';
  return 'running';
}

function titleForAgentStatus(status) {
  if (status === 'idle') return 'Trylo 已就绪';
  if (status === 'thinking') return '正在分析任务';
  if (status === 'waiting') return '等待继续';
  if (status === 'done') return '任务已完成';
  if (status === 'failed') return '任务执行失败';
  return '正在执行任务';
}

// Trylo P3 patch: workspace-relative deliverable path guard. The Desktop
// authority re-validates against `.trylo/out`; this gateway-side check only
// rejects obvious traversal before a handler is ever invoked.
function sanitizeArtifactPath(value) {
  const rel = String(value || '');
  if (!rel || rel.length > ARTIFACT_PATH_LIMIT) return null;
  if (rel.startsWith('/') || /^[a-zA-Z]:/.test(rel) || rel.includes('\\')) return null;
  const parts = rel.split('/');
  if (parts.some(part => part === '' || part === '.' || part === '..')) return null;
  return parts.join('/');
}

// Trylo P3 patch: bound the artifact list shape the Desktop returns so a
// misbehaving authority cannot blow the snapshot budget on the phone.
function sanitizeArtifactList(value) {
  if (!Array.isArray(value)) return [];
  return value.slice(0, ARTIFACT_LIST_LIMIT).map(item => ({
    id: String(item && item.id || '').slice(0, 200),
    name: String(item && (item.name || item.id) || 'file').slice(0, 200),
    kind: String(item && item.kind || 'file').slice(0, 32),
    size: Math.max(0, Number(item && item.size) || 0),
    modifiedAt: Number(item && (item.modifiedAt || item.updatedAt)) || Date.now(),
  })).filter(item => item.id);
}

function isAllowedOrigin(origin) {
  if (!origin) return true;
  if (origin === 'capacitor://localhost' || origin === 'https://localhost' || origin === 'http://localhost') {
    return true;
  }
  return /^https?:\/\/(?:127\.0\.0\.1|localhost)(?::\d+)?$/i.test(origin);
}

function timingSafeTokenEqual(actual, expected) {
  const actualBuffer = Buffer.from(String(actual || ''), 'utf8');
  const expectedBuffer = Buffer.from(String(expected || ''), 'utf8');
  return actualBuffer.length === expectedBuffer.length && crypto.timingSafeEqual(actualBuffer, expectedBuffer);
}

function createRemoteGateway(options = {}) {
  const port = Number(options.port) || DEFAULT_PORT;
  const host = String(options.host || '127.0.0.1');
  const authToken = String(options.authToken || '');
  if (authToken.length < 32) throw new Error('Remote Gateway requires an authentication token of at least 32 characters.');

  const workspaceName = String(options.workspaceName || 'Trylo Code');
  const deviceName = String(options.deviceName || os.hostname() || 'Trylo computer');
  const deviceId = crypto
    .createHash('sha256')
    .update(String(options.deviceSeed || `${deviceName}|${workspaceName}`))
    .digest('hex')
    .slice(0, 20);

  let server = null;
  let heartbeat = null;
  let startedAt = 0;
  let handlers = { ...(options.handlers || {}) };
  let progressSignalCharacters = 0;
  const sockets = new Set();
  const socketTickets = new Map();
  const state = {
    device: {
      id: deviceId,
      name: deviceName,
      workspace: workspaceName,
      online: true,
      latencyMs: 0,
      lastSeenAt: Date.now(),
    },
    agent: {
      status: 'idle',
      title: 'Trylo 已就绪',
      detail: '等待新任务',
      progress: 0,
      elapsed: '00:00',
      mode: 'agent',
      phase: 'ready',
      finalResponse: null,
      technicalEventCount: 0,
      timeline: [],
    },
    sessions: [],
    activeSessionId: '',
    conversation: [],
    projects: [],
    activeProjectId: '',
    approvals: [],
  };

  const corsHeaders = request => {
    const origin = String(request.headers.origin || '');
    return isAllowedOrigin(origin)
      ? {
          'Access-Control-Allow-Origin': origin || '*',
          'Access-Control-Allow-Headers': 'Authorization, Content-Type',
          'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
          'Access-Control-Max-Age': '600',
          Vary: 'Origin',
        }
      : {};
  };

  const sendJson = (request, response, statusCode, payload) => {
    const body = Buffer.from(JSON.stringify(payload), 'utf8');
    response.writeHead(statusCode, {
      ...corsHeaders(request),
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Length': String(body.length),
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
    });
    response.end(body);
  };

  const readJsonBody = request =>
    new Promise((resolve, reject) => {
      const chunks = [];
      let size = 0;
      request.on('data', chunk => {
        size += chunk.length;
        if (size > BODY_LIMIT) {
          reject(Object.assign(new Error('Request body is too large.'), { statusCode: 413 }));
          request.destroy();
          return;
        }
        chunks.push(chunk);
      });
      request.on('end', () => {
        if (!chunks.length) return resolve({});
        try {
          resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
        } catch {
          reject(Object.assign(new Error('Request body must be valid JSON.'), { statusCode: 400 }));
        }
      });
      request.on('error', reject);
    });

  const isAuthorized = request => {
    const header = String(request.headers.authorization || '');
    const match = header.match(/^Bearer\s+(.+)$/i);
    return Boolean(match && timingSafeTokenEqual(match[1], authToken));
  };

  const buildSnapshot = () => {
    const elapsedMs = startedAt && state.agent.status !== 'idle' ? Date.now() - startedAt : 0;
    const seconds = Math.max(0, Math.floor(elapsedMs / 1000));
    return {
      device: { ...state.device, lastSeenAt: Date.now() },
      agent: {
        ...state.agent,
        elapsed: `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`,
        timeline: state.agent.timeline.map(item => ({ ...item })),
      },
      sessions: state.sessions.map(item => ({ ...item })),
      activeSessionId: state.activeSessionId,
      conversation: state.conversation.map(item => ({ ...item })),
      projects: state.projects.map(item => ({ ...item })),
      activeProjectId: state.activeProjectId,
      approvals: state.approvals.map(item => ({ ...item })),
    };
  };

  const broadcast = payload => {
    const body = JSON.stringify(payload);
    sockets.forEach(socket => {
      if (socket.readyState !== WebSocket.OPEN) return;
      try {
        socket.send(body);
      } catch {}
    });
  };

  const addTimelineEvent = payload => {
    const title = String(payload.title || payload.message || payload.detail || '').trim();
    if (!title) return;
    const detail = String(payload.detail || payload.text || '').trim();
    if (INTERNAL_TRACE_PATTERNS.some(pattern => pattern.test(`${title} ${detail}`))) {
      state.agent.technicalEventCount += 1;
      return;
    }
    const previous = state.agent.timeline[state.agent.timeline.length - 1];
    if (previous && previous.title === title && previous.detail === detail) return;
    const activeIndex = state.agent.timeline.findIndex(item => item.state === 'active');
    if (activeIndex >= 0) state.agent.timeline[activeIndex].state = 'done';
    const kind = classifyTimelineEvent(payload, title, detail);
    state.agent.timeline.push({
      id: String(payload.id || crypto.randomUUID()),
      title: title.slice(0, 120),
      detail: detail.slice(0, 240),
      kind,
      state: payload.phase === 'completed' ? 'done' : 'active',
      at: new Date(Number(payload.at) || Date.now()).toLocaleTimeString('zh-CN', {
        hour: '2-digit',
        minute: '2-digit',
        hour12: false,
      }),
    });
    state.agent.timeline = state.agent.timeline.slice(-TIMELINE_LIMIT);
    return kind;
  };

  const setProgress = value => {
    const next = Number(value);
    if (!Number.isFinite(next)) return;
    state.agent.progress = Math.max(0, Math.min(100, Math.round(next)));
  };

  const advanceProgress = (increment = 1, floor = 0, ceiling = 98) => {
    const current = Number(state.agent.progress) || 0;
    setProgress(Math.min(ceiling, Math.max(floor, current + Math.max(1, Math.round(increment)))));
  };

  const updateProgressForState = (rawState, explicitProgress, isStarting) => {
    const stateName = String(rawState || '').toLowerCase();
    if (Number.isFinite(explicitProgress)) {
      setProgress(explicitProgress);
      return;
    }
    if (stateName === 'idle') {
      setProgress(0);
      return;
    }
    if (stateName === 'done') {
      setProgress(100);
      return;
    }
    if (stateName === 'failed') return;
    if (isStarting) setProgress(2);
    const stage = PROGRESS_STAGES[stateName] || { floor: 6, ceiling: 88 };
    advanceProgress(stateName === 'planning' ? 2 : 1, stage.floor, stage.ceiling);
  };

  const updateProgressForTrace = kind => {
    if (!kind || ['idle', 'done', 'failed'].includes(state.agent.status)) return;
    const progressByKind = {
      thinking: { increment: 1, floor: 6, ceiling: 38 },
      inspect: { increment: 2, floor: 16, ceiling: 58 },
      change: { increment: 3, floor: 42, ceiling: 82 },
      command: { increment: 2, floor: 54, ceiling: 90 },
      approval: { increment: 1, floor: 68, ceiling: 94 },
      progress: { increment: 1, floor: 8, ceiling: 92 },
    };
    const hint = progressByKind[kind] || progressByKind.progress;
    advanceProgress(hint.increment, hint.floor, hint.ceiling);
  };

  const updateProgressForStream = (characters, phase) => {
    progressSignalCharacters += Math.max(0, Number(characters) || 0);
    const threshold = phase === 'answer' ? 420 : 720;
    if (progressSignalCharacters < threshold) return;
    const steps = Math.min(3, Math.floor(progressSignalCharacters / threshold));
    progressSignalCharacters %= threshold;
    if (phase === 'answer') advanceProgress(steps, 86, 98);
    else advanceProgress(steps, 8, 68);
  };

  const publish = payload => {
    if (!payload || typeof payload !== 'object') return;
    const now = Number(payload.at) || Date.now();
    let accepted = true;

    if (payload.type === 'agentState') {
      const rawState = String(payload.state || '').toLowerCase();
      const status = normalizeAgentStatus(rawState);
      const previousStatus = state.agent.status;
      const isStarting = status !== 'idle'
        && (previousStatus === 'idle' || previousStatus === 'done' || previousStatus === 'failed' || !startedAt);
      if (isStarting) startedAt = now;
      if (status === 'idle') startedAt = 0;
      if (isStarting) {
        state.agent.timeline = [];
        state.agent.finalResponse = null;
        state.agent.technicalEventCount = 0;
        progressSignalCharacters = 0;
      }
      state.agent.status = status;
      state.agent.title = titleForAgentStatus(status);
      state.agent.detail = String(payload.detail || '');
      const explicitProgress = payload.meta && Object.prototype.hasOwnProperty.call(payload.meta, 'progress')
        ? Number(payload.meta.progress)
        : Number.NaN;
      updateProgressForState(rawState, explicitProgress, isStarting);
      state.agent.mode = normalizeAgentMode(payload.mode || state.agent.mode);
      state.agent.phase = status === 'idle' ? 'ready' : status;
    } else if (payload.type === 'trace') {
      const kind = addTimelineEvent(payload);
      updateProgressForTrace(kind);
      state.agent.mode = normalizeAgentMode(payload.mode || state.agent.mode);
      state.agent.phase = payload.kind === 'tool' ? 'running' : state.agent.phase;
    } else if (payload.type === 'assistant') {
      state.agent.status = 'done';
      state.agent.title = '任务已完成';
      state.agent.detail = String(payload.text || '').slice(0, 180);
      state.agent.progress = 100;
      state.agent.mode = normalizeAgentMode(payload.mode || state.agent.mode);
      state.agent.phase = 'completed';
      state.agent.finalResponse = {
        text: String(payload.text || ''),
        at: now,
      };
      const turnId = String(payload.turnId || 'active');
      state.conversation = upsertConversationItem(state.conversation, {
        id: `${turnId}:assistant-live`,
        role: 'assistant',
        text: String(payload.text || '').slice(0, 24000),
        at: now,
        status: 'done',
        mode: state.agent.mode,
        turnId,
      });
      const activeIndex = state.agent.timeline.findIndex(item => item.state === 'active');
      if (activeIndex >= 0) state.agent.timeline[activeIndex].state = 'done';
    } else if (payload.type === 'error') {
      state.agent.status = 'failed';
      state.agent.title = '任务执行失败';
      state.agent.detail = String(payload.message || 'Unknown error').slice(0, 180);
      state.agent.phase = 'failed';
    } else if (payload.type === 'stopped') {
      state.agent.status = 'waiting';
      state.agent.title = '任务已停止';
      state.agent.detail = '等待新的操作';
      state.agent.phase = 'waiting';
    } else if (payload.type === 'modeState') {
      state.agent.mode = normalizeAgentMode(payload.mode);
    } else if (payload.type === 'projectsState') {
      state.projects = (Array.isArray(payload.projects) ? payload.projects : []).slice(0, 40).map(project => ({
        id: String(project.id || ''),
        name: String(project.name || 'Project').slice(0, 100),
        lastSeenAt: Number(project.lastSeenAt) || Date.now(),
      })).filter(project => project.id);
      state.activeProjectId = String(payload.activeProjectId || '');
      const activeProject = state.projects.find(project => project.id === state.activeProjectId);
      if (activeProject) state.device.workspace = activeProject.name;
    } else if (payload.type === 'turnStarted') {
      if (state.agent.status !== 'idle') advanceProgress(1, 3, 22);
      const turn = payload.turn && typeof payload.turn === 'object' ? payload.turn : {};
      const prompt = String(turn.prompt || '').trim();
      if (prompt) {
        state.conversation = upsertConversationItem(state.conversation, {
          id: `${String(turn.id || 'active')}:user`,
          role: 'user',
          text: prompt.slice(0, 24000),
          at: Number(turn.startedAt) || now,
          status: 'done',
          mode: normalizeAgentMode(turn.mode || state.agent.mode),
          turnId: String(turn.id || ''),
        });
      }
    } else if (payload.type === 'turnEvent') {
      const event = payload.event && typeof payload.event === 'object' ? payload.event : {};
      if (String(event.category || event.kind || '').toLowerCase() === 'reasoning') {
        const text = String(event.rawDetail || event.detail || '').trim();
        if (text) {
          const turnId = String(payload.turnId || 'active');
          const liveId = `${turnId}:thinking-live`;
          const liveItem = state.conversation.find(item => item.id === liveId);
          state.conversation = upsertConversationItem(state.conversation, {
            id: liveItem ? liveId : String(event.id || `${turnId}:thinking`),
            role: 'thinking',
            title: String(event.title || '思考摘要').slice(0, 120),
            text: liveItem?.text || text,
            at: Number(event.at) || now,
            status: event.status === 'running' ? 'streaming' : 'done',
            mode: state.agent.mode,
            turnId,
          });
        }
      }
    } else if (payload.type === 'ideStreamText') {
      const delta = String(payload.delta || '');
      if (delta) {
        updateProgressForStream(delta.length, 'answer');
        const turnId = String(payload.turnId || 'active');
        const id = `${turnId}:assistant-live`;
        const existing = state.conversation.find(item => item.id === id);
        state.conversation = upsertConversationItem(state.conversation, {
          id,
          role: 'assistant',
          text: `${existing && existing.text || ''}${delta}`.slice(0, 24000),
          at: existing && existing.at || now,
          status: 'streaming',
          mode: state.agent.mode,
          turnId,
        });
      }
    } else if (payload.type === 'ideStreamThinking') {
      const delta = String(payload.delta || '');
      if (delta) {
        updateProgressForStream(delta.length, 'thinking');
        const turnId = String(payload.turnId || 'active');
        const id = `${turnId}:thinking-live`;
        const existing = state.conversation.find(item => item.id === id)
          || [...state.conversation].reverse().find(item => item.role === 'thinking' && item.turnId === turnId);
        if (existing && existing.id !== id) {
          state.conversation = state.conversation.filter(item => item.id !== existing.id);
        }
        state.conversation = upsertConversationItem(state.conversation, {
          id,
          role: 'thinking',
          title: '思考过程',
          text: `${existing && existing.text || ''}${delta}`,
          at: existing && existing.at || now,
          status: 'streaming',
          mode: state.agent.mode,
          turnId,
        });
      }
    } else if (payload.type === 'turnFinished') {
      const turn = payload.turn && typeof payload.turn === 'object' ? payload.turn : {};
      const resultText = String(turn.resultText || '').trim();
      if (resultText) {
        const turnId = String(turn.id || 'active');
        state.conversation = upsertConversationItem(state.conversation, {
          id: `${turnId}:assistant-live`,
          role: 'assistant',
          text: resultText.slice(0, 24000),
          at: Number(turn.completedAt) || now,
          status: 'done',
          mode: normalizeAgentMode(turn.mode || state.agent.mode),
          turnId,
        });
      }
    } else if (payload.type === 'sessionState') {
      const activeSessionId = String(payload.activeSessionId || '');
      const sessions = Array.isArray(payload.sessions) ? payload.sessions : [];
      state.sessions = (Array.isArray(payload.sessions) ? payload.sessions : []).slice(0, 40).map(session => ({
        id: String(session.id || ''),
        title: String(session.title || 'New session').slice(0, 100),
        preview: String(session.preview || '').slice(0, 180),
        updatedAt: Number(session.updatedAt) || Date.now(),
        active: String(session.id || '') === activeSessionId,
        workspace: session.workspace && typeof session.workspace === 'object'
          ? {
              id: String(session.workspace.id || ''),
              name: String(session.workspace.name || 'Project').slice(0, 100),
              path: String(session.workspace.path || ''),
            }
          : null,
      }));
      state.activeSessionId = activeSessionId;
      const activeSession = sessions.find(session => String(session && session.id || '') === activeSessionId) || sessions[0];
      state.conversation = buildConversationFromSession(activeSession);
    } else if (payload.type === 'funHistoryState') {
      broadcast({ type: 'action_event', action: 'fun', payload, at: now });
    } else if (payload.type === 'permissionRequestState') {
      state.approvals = (Array.isArray(payload.requests) ? payload.requests : []).map(request => ({
        id: String(request.requestId || request.id || ''),
        category: String(request.category || 'command'),
        title: String(request.title || 'Permission required').slice(0, 120),
        detail: String(request.detail || ''),
        description: String(request.description || ''),
        toolName: String(request.toolName || ''),
        blockedPath: String(request.blockedPath || ''),
        decisionReason: String(request.decisionReason || ''),
        risk: request.category === 'command' ? 'medium' : 'low',
        requestedAt: Number(request.at) || Date.now(),
      }));
      if (state.approvals.length) advanceProgress(1, 68, 94);
    } else {
      accepted = false;
    }

    if (!accepted) return;
    state.device.lastSeenAt = now;
    broadcast({ type: 'snapshot_update', snapshot: buildSnapshot(), at: now });
  };

  const invokeHandler = async (name, payload, onEmit) => {
    const handler = handlers[name];
    if (typeof handler !== 'function') {
      throw Object.assign(new Error(`${name} is not available while the Trylo panel is closed.`), { statusCode: 409 });
    }
    return handler(payload, emitted => {
      broadcast({ type: 'action_event', action: name, payload: emitted, at: Date.now() });
      if (typeof onEmit === 'function') onEmit(emitted);
    });
  };

  const handleRequest = async (request, response) => {
    const url = new URL(request.url || '/', `http://${request.headers.host || 'localhost'}`);
    if (request.method === 'OPTIONS') {
      response.writeHead(isAllowedOrigin(String(request.headers.origin || '')) ? 204 : 403, corsHeaders(request));
      response.end();
      return;
    }
    if (request.method === 'GET' && url.pathname === '/health') {
      sendJson(request, response, 200, { ok: true, service: 'trylo-remote-gateway', version: 1 });
      return;
    }
    if (!isAuthorized(request)) {
      sendJson(request, response, 401, { error: 'Unauthorized' });
      return;
    }
    if (request.method === 'GET' && url.pathname === '/v1/snapshot') {
      sendJson(request, response, 200, buildSnapshot());
      return;
    }
    if (request.method === 'GET' && url.pathname === '/v1/projects') {
      const result = await invokeHandler('projects', {});
      state.projects = (Array.isArray(result?.projects) ? result.projects : []).map(project => ({
        id: String(project?.id || ''),
        name: String(project?.name || 'Trylo Code'),
        lastSeenAt: Number(project?.lastSeenAt || Date.now()),
      })).filter(project => project.id);
      state.activeProjectId = String(result?.activeProjectId || state.activeProjectId || '');
      sendJson(request, response, 200, { projects: state.projects, activeProjectId: state.activeProjectId });
      return;
    }
    if (request.method === 'POST' && url.pathname === '/v1/socket-ticket') {
      const ticket = crypto.randomBytes(32).toString('base64url');
      socketTickets.set(ticket, Date.now() + SOCKET_TICKET_TTL_MS);
      sendJson(request, response, 201, { ticket, expiresInMs: SOCKET_TICKET_TTL_MS });
      return;
    }
    if (request.method === 'GET' && url.pathname === '/v1/chat/history') {
      sendJson(request, response, 200, { conversation: state.conversation.map(item => ({ ...item })) });
      return;
    }
    if (request.method === 'GET' && url.pathname === '/v1/fun') {
      const result = await invokeHandler('fun', { type: 'fun_state_request' });
      sendJson(request, response, 200, result || { characters: [], histories: {} });
      return;
    }
    const funHistoryMatch = url.pathname.match(/^\/v1\/fun\/([^/]+)\/history$/);
    if (request.method === 'GET' && funHistoryMatch) {
      const result = await invokeHandler('fun', {
        type: 'chat_history_request',
        charId: decodeURIComponent(funHistoryMatch[1]),
      });
      sendJson(request, response, 200, result || { messages: [] });
      return;
    }
    if (request.method === 'POST' && url.pathname === '/v1/fun/characters') {
      const body = await readJsonBody(request);
      const result = await invokeHandler('fun', {
        type: 'fun_character_upsert',
        character: body.character && typeof body.character === 'object' ? body.character : body,
      });
      sendJson(request, response, 201, result || {});
      return;
    }
    const funMemoryMatch = url.pathname.match(/^\/v1\/fun\/([^/]+)\/memory$/);
    if (request.method === 'GET' && funMemoryMatch) {
      const result = await invokeHandler('fun', {
        type: 'fun_memory_request',
        charId: decodeURIComponent(funMemoryMatch[1]),
      });
      sendJson(request, response, 200, result || { memories: { facts: [], impression: '' } });
      return;
    }
    const funMessageMatch = url.pathname.match(/^\/v1\/fun\/([^/]+)\/messages$/);
    if (request.method === 'POST' && funMessageMatch) {
      const body = await readJsonBody(request);
      const text = String(body.text || '').trim();
      if (!text) throw Object.assign(new Error('Message is empty.'), { statusCode: 400 });
      const requestId = crypto.randomUUID();
      const payload = {
        type: 'chat_send',
        requestId,
        charId: decodeURIComponent(funMessageMatch[1]),
        text,
        thinkMode: Boolean(body.thinkMode),
        messages: Array.isArray(body.messages) ? body.messages : [],
      };
      void invokeHandler('fun', payload).catch(error => {
        broadcast({
          type: 'action_event',
          action: 'fun',
          payload: { type: 'chat_error', requestId, mode: 'fun', error: String(error?.message || error), at: Date.now() },
          at: Date.now(),
        });
      });
      sendJson(request, response, 202, { accepted: true, requestId });
      return;
    }
    const funSpeechMatch = url.pathname.match(/^\/v1\/fun\/([^/]+)\/speech$/);
    if (request.method === 'POST' && funSpeechMatch) {
      const body = await readJsonBody(request);
      const result = await invokeHandler('fun', {
        type: 'fun_tts',
        charId: decodeURIComponent(funSpeechMatch[1]),
        text: String(body.text || ''),
        voice: String(body.voice || ''),
      });
      sendJson(request, response, 200, result || {});
      return;
    }
    const funClearMatch = url.pathname.match(/^\/v1\/fun\/([^/]+)\/clear$/);
    if (request.method === 'POST' && funClearMatch) {
      await invokeHandler('fun', { type: 'chat_clear', charId: decodeURIComponent(funClearMatch[1]) });
      sendJson(request, response, 200, { ok: true });
      return;
    }
    const funCancelMatch = url.pathname.match(/^\/v1\/fun\/([^/]+)\/cancel$/);
    if (request.method === 'POST' && funCancelMatch) {
      await invokeHandler('fun', { type: 'chat_cancel', charId: decodeURIComponent(funCancelMatch[1]) });
      sendJson(request, response, 200, { ok: true });
      return;
    }
    if (request.method === 'POST' && url.pathname === '/v1/chat/messages') {
      const body = await readJsonBody(request);
      const text = String(body.text || '').trim();
      const attachments = Array.isArray(body.attachments) ? body.attachments : [];
      if (!text && attachments.length === 0) throw Object.assign(new Error('Message is empty.'), { statusCode: 400 });
      const requestId = crypto.randomUUID();
      // Trylo P3 patch: forward the phone's Code / Work surface so the
      // Desktop `task` handler can route to the right runtime. Older phones
      // send nothing and land on Code (the router's default).
      const surface = String(body.surface || '').toLowerCase() === 'work' ? 'work' : 'code';
      await invokeHandler('task', { type: 'task_send', mode: state.agent.mode, requestId, text, attachments, surface });
      sendJson(request, response, 202, { accepted: true, requestId });
      return;
    }
    if (request.method === 'POST' && url.pathname === '/v1/tasks/current/cancel') {
      await invokeHandler('cancel', {});
      sendJson(request, response, 200, { ok: true });
      return;
    }
    // Trylo P3 patch: read-only Work deliverables (`.trylo/out` of the active
    // workspace). List is JSON; content streams raw bytes. Both delegate to
    // the Desktop authority — the gateway never touches the filesystem.
    if (request.method === 'GET' && url.pathname === '/v1/artifacts') {
      const result = await invokeHandler('artifacts', {});
      sendJson(request, response, 200, { artifacts: sanitizeArtifactList(result && result.artifacts) });
      return;
    }
    if (request.method === 'GET' && url.pathname === '/v1/artifacts/content') {
      const rel = sanitizeArtifactPath(url.searchParams.get('path'));
      if (!rel) throw Object.assign(new Error('Invalid artifact path.'), { statusCode: 400 });
      const result = await invokeHandler('artifact', { path: rel });
      const data = String(result && result.data || '');
      if (!data) throw Object.assign(new Error('Artifact is empty or unavailable.'), { statusCode: 404 });
      let bytes;
      try {
        bytes = Buffer.from(data, 'base64');
      } catch {
        throw Object.assign(new Error('Artifact payload is corrupt.'), { statusCode: 502 });
      }
      if (!bytes.length) throw Object.assign(new Error('Artifact is empty or unavailable.'), { statusCode: 404 });
      if (bytes.length > ARTIFACT_CONTENT_LIMIT) {
        throw Object.assign(new Error('Artifact is too large for mobile download.'), { statusCode: 413 });
      }
      const name = String(result.name || rel.split('/').pop() || 'file').slice(0, 200);
      response.writeHead(200, {
        ...corsHeaders(request),
        'Content-Type': String(result.mimeType || 'application/octet-stream').slice(0, 100),
        'Content-Length': String(bytes.length),
        'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(name)}`,
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
        'Referrer-Policy': 'no-referrer',
      });
      response.end(bytes);
      return;
    }
    if (request.method === 'POST' && url.pathname === '/v1/admin/handoff') {
      const result = await invokeHandler('handoff', {});
      sendJson(request, response, 202, { accepted: true, ...(result || {}) });
      return;
    }
    const projectMatch = url.pathname.match(/^\/v1\/projects\/([^/]+)\/select$/);
    if (request.method === 'POST' && projectMatch) {
      const projectId = decodeURIComponent(projectMatch[1]);
      await invokeHandler('project', { projectId });
      sendJson(request, response, 202, { accepted: true, projectId });
      return;
    }
    const sessionMatch = url.pathname.match(/^\/v1\/sessions\/([^/]+)\/select$/);
    if (request.method === 'POST' && sessionMatch) {
      const sessionId = decodeURIComponent(sessionMatch[1]);
      const result = await invokeHandler('session', { sessionId });
      sendJson(request, response, 202, { accepted: true, sessionId, ...(result || {}) });
      return;
    }
    const permissionMatch = url.pathname.match(/^\/v1\/permissions\/([^/]+)\/decision$/);
    if (request.method === 'POST' && permissionMatch) {
      const body = await readJsonBody(request);
      const decision = String(body.decision || '').toLowerCase();
      if (decision !== 'allow' && decision !== 'deny') {
        throw Object.assign(new Error('Decision must be allow or deny.'), { statusCode: 400 });
      }
      await invokeHandler('permission', { requestId: decodeURIComponent(permissionMatch[1]), decision });
      sendJson(request, response, 200, { ok: true, decision });
      return;
    }
    sendJson(request, response, 404, { error: 'Not found' });
  };

  const start = () =>
    new Promise((resolve, reject) => {
      if (server) return resolve(server.address());
      const nextServer = http.createServer((request, response) => {
        Promise.resolve(handleRequest(request, response)).catch(error => {
          if (response.headersSent) return response.destroy();
          sendJson(request, response, Number(error.statusCode) || 500, {
            error: Number(error.statusCode) && error.statusCode < 500 ? error.message : 'Gateway request failed.',
          });
        });
      });
      const webSocketServer = new WebSocketServer({ noServer: true, maxPayload: BODY_LIMIT });

      nextServer.on('upgrade', (request, socket, head) => {
        try {
          const url = new URL(request.url || '/', `http://${request.headers.host || 'localhost'}`);
          const ticket = String(url.searchParams.get('ticket') || '');
          const expiresAt = socketTickets.get(ticket) || 0;
          socketTickets.delete(ticket);
          if (url.pathname !== '/v1/events' || !ticket || expiresAt < Date.now()) {
            socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
            socket.destroy();
            return;
          }
          webSocketServer.handleUpgrade(request, socket, head, webSocket => {
            webSocketServer.emit('connection', webSocket, request);
          });
        } catch {
          socket.destroy();
        }
      });

      webSocketServer.on('connection', socket => {
        socket.isAlive = true;
        sockets.add(socket);
        socket.on('pong', () => { socket.isAlive = true; });
        socket.on('close', () => sockets.delete(socket));
        socket.on('error', () => sockets.delete(socket));
        socket.send(JSON.stringify({ type: 'snapshot', snapshot: buildSnapshot(), at: Date.now() }));
      });

      nextServer.once('error', reject);
      nextServer.listen(port, host, () => {
        server = nextServer;
        heartbeat = setInterval(() => {
          const now = Date.now();
          for (const [ticket, expiresAt] of socketTickets) {
            if (expiresAt < now) socketTickets.delete(ticket);
          }
          sockets.forEach(socket => {
            if (socket.isAlive === false) return socket.terminate();
            socket.isAlive = false;
            socket.ping();
          });
        }, 25000);
        heartbeat.unref?.();
        resolve(nextServer.address());
      });
    });

  const stop = () =>
    new Promise(resolve => {
      if (heartbeat) clearInterval(heartbeat);
      heartbeat = null;
      sockets.forEach(socket => socket.close(1001, 'Gateway stopping'));
      sockets.clear();
      socketTickets.clear();
      const activeServer = server;
      server = null;
      if (!activeServer) return resolve();
      activeServer.close(() => resolve());
    });

  return {
    start,
    stop,
    publish,
    getSnapshot: buildSnapshot,
    setHandlers(nextHandlers) {
      handlers = { ...handlers, ...(nextHandlers || {}) };
      return () => {
        Object.keys(nextHandlers || {}).forEach(key => {
          if (handlers[key] === nextHandlers[key]) delete handlers[key];
        });
      };
    },
    getPairingInfo(publicUrl = '') {
      return {
        protocol: 1,
        service: 'trylo-remote',
        deviceId,
        deviceName,
        workspaceName,
        baseUrl: String(publicUrl || `http://${host}:${port}`).replace(/\/$/, ''),
        token: authToken,
      };
    },
    get listening() {
      return Boolean(server);
    },
  };
}

module.exports = {
  createRemoteGateway,
  DEFAULT_PORT,
};
