const dgram = require('node:dgram');
const net = require('node:net');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');

const COMPANION_PORT = 49371;
const COMPANION_CHAT_PORT = 49372;
const HEARTBEAT_MS = 2000;
const CHAT_RECONNECT_MS = 1200;

function createDesktopCompanionBridge(options = {}) {
  const extensionPath = String(options.extensionPath || __dirname);
  const workspacePath = String(options.workspacePath || '');
  const companionPort = Number(options.companionPort) || COMPANION_PORT;
  const companionChatPort = Number(options.chatPort) || COMPANION_CHAT_PORT;
  const workspaceName = path.basename(workspacePath) || 'Trylo Code';
  const clientId = crypto.randomUUID();
  let socket = null;
  let heartbeat = null;
  let chatSocket = null;
  let chatReconnect = null;
  let chatBuffer = '';
  let enabled = false;
  let pendingPermission = null;
  let permissionDecisionHandler = null;
  let chatRequestHandler = null;
  // --- Trylo Desktop introspection (added 2026-08-28, audit §4.2 PET-P0-2) ---
  // Read-only projection of what this bridge actually did, so `pet.status`
  // can report real state instead of `exeFound: platform === 'win32'`.
  // Everything here is derived from existing locals; no control flow, no
  // protocol change, no new dependencies. `exePath` is a BASENAME only —
  // renderer-facing diagnostics must not carry private absolute paths.
  let chatConnected = false;
  let lastLaunch = { exeFound: false, launched: false, exePath: '', reasonCode: 'not_attempted' };
  // Notified (never awaited) when the chat socket's connectivity changes, so
  // the host can re-publish `pet.status`. Purely observational: the bridge
  // does not care whether anyone is listening.
  let chatStateHandler = null;
  const notifyChatState = () => {
    if (typeof chatStateHandler !== 'function') return;
    try {
      chatStateHandler(chatConnected);
    } catch {
      /* a listener's failure must not break the socket lifecycle */
    }
  };
  let lastState = {
    state: 'idle',
    detail: 'Ready',
    level: 'info',
    progress: 0,
    at: Date.now(),
  };

  const envelope = payload => ({
    protocol: 1,
    clientId,
    workspacePath,
    workspaceName,
    extensionPid: process.pid,
    ...payload,
    permission: pendingPermission,
  });

  const ensureSocket = () => {
    if (socket) return socket;
    socket = dgram.createSocket('udp4');
    socket.on('error', () => {});
    socket.on('message', (body, remote) => {
      if (remote.address !== '127.0.0.1' && remote.address !== '::1') return;
      let message;
      try {
        message = JSON.parse(body.toString('utf8'));
      } catch {
        return;
      }
      const decision = String(message?.decision || '').trim().toLowerCase();
      const requestId = String(message?.requestId || '').trim();
      if (
        message?.protocol !== 1 ||
        message?.type !== 'permission_decision' ||
        message?.clientId !== clientId ||
        !pendingPermission ||
        requestId !== pendingPermission.requestId ||
        (decision !== 'allow' && decision !== 'deny') ||
        typeof permissionDecisionHandler !== 'function'
      ) {
        return;
      }
      Promise.resolve(permissionDecisionHandler({ requestId, decision })).catch(() => {});
    });
    socket.unref();
    return socket;
  };

  const send = payload => {
    if (!enabled && payload.type !== 'detach') return;
    const body = Buffer.from(JSON.stringify(envelope(payload)), 'utf8');
    const activeSocket = ensureSocket();
    activeSocket.send(body, companionPort, '127.0.0.1', () => {});
  };

  const sendChat = payload => {
    if (!chatSocket || chatSocket.destroyed || !chatSocket.writable) return false;
    try {
      chatSocket.write(`${JSON.stringify({
        protocol: 2,
        clientId,
        workspacePath,
        workspaceName,
        ...payload,
      })}\n`);
      return true;
    } catch {
      return false;
    }
  };

  const scheduleChatReconnect = () => {
    if (!enabled || chatReconnect) return;
    chatReconnect = setTimeout(() => {
      chatReconnect = null;
      ensureChatSocket();
    }, CHAT_RECONNECT_MS);
    chatReconnect.unref?.();
  };

  const handleChatLine = line => {
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      return;
    }
    if (
      message?.protocol !== 2 ||
      message?.clientId !== clientId ||
      typeof chatRequestHandler !== 'function'
    ) {
      return;
    }
    const type = String(message.type || '');
    if (!['chat_history_request', 'chat_send', 'chat_clear', 'chat_cancel'].includes(type)) return;
    const mode = String(message.mode || 'chat').toLowerCase();
    if (!['chat', 'fun'].includes(mode)) {
      sendChat({
        type: 'chat_error',
        requestId: String(message.requestId || ''),
        mode,
        error: 'Desktop companion only supports Chat and Cat Box modes.',
      });
      return;
    }
    const emit = payload => sendChat(payload);
    Promise.resolve(chatRequestHandler({ ...message, mode }, emit)).catch(err => {
      emit({
        type: 'chat_error',
        requestId: String(message.requestId || ''),
        mode,
        error: err && err.message ? String(err.message) : 'Desktop chat request failed.',
      });
    });
  };

  function ensureChatSocket() {
    if (!enabled || (chatSocket && !chatSocket.destroyed)) return;
    chatBuffer = '';
    const nextSocket = net.createConnection({ host: '127.0.0.1', port: companionChatPort });
    chatSocket = nextSocket;
    nextSocket.setEncoding('utf8');
    nextSocket.on('connect', () => {
      chatConnected = true;
      notifyChatState();
      sendChat({ type: 'chat_hello', at: Date.now() });
    });
    nextSocket.on('data', chunk => {
      chatBuffer += String(chunk || '');
      let newlineIndex;
      while ((newlineIndex = chatBuffer.indexOf('\n')) >= 0) {
        const line = chatBuffer.slice(0, newlineIndex).trim();
        chatBuffer = chatBuffer.slice(newlineIndex + 1);
        if (line) handleChatLine(line);
      }
      if (chatBuffer.length > 1024 * 1024) chatBuffer = '';
    });
    nextSocket.on('error', () => {
      if (chatSocket === nextSocket) {
        chatConnected = false;
        notifyChatState();
      }
    });
    nextSocket.on('close', () => {
      if (chatSocket === nextSocket) {
        chatSocket = null;
        chatConnected = false;
        notifyChatState();
      }
      scheduleChatReconnect();
    });
    nextSocket.unref();
  }

  const companionCandidates = [
    path.join(extensionPath, 'desktop-companion', 'publish', 'TryloDesktopPet.exe'),
    path.join(
      extensionPath,
      'desktop-companion',
      'bin',
      'Release',
      'net9.0-windows',
      'win-x64',
      'publish',
      'TryloDesktopPet.exe',
    ),
    path.join(
      extensionPath,
      'desktop-companion',
      'bin',
      'Release',
      'net9.0-windows',
      'TryloDesktopPet.exe',
    ),
  ];

  const launchCompanion = () => {
    if (process.platform !== 'win32') {
      lastLaunch = { exeFound: false, launched: false, exePath: '', reasonCode: 'unsupported_platform' };
      return false;
    }
    const executable = companionCandidates.find(candidate => fs.existsSync(candidate));
    if (!executable) {
      lastLaunch = { exeFound: false, launched: false, exePath: '', reasonCode: 'exe_not_found' };
      return false;
    }
    const exePath = path.basename(executable);
    try {
      const child = spawn(executable, [], {
        cwd: path.dirname(executable),
        detached: true,
        stdio: 'ignore',
        windowsHide: true,
      });
      child.unref();
      if (typeof child.pid === 'number' && child.pid > 0) {
        lastLaunch = { exeFound: true, launched: true, exePath, reasonCode: '' };
        return true;
      }
      lastLaunch = { exeFound: true, launched: false, exePath, reasonCode: 'spawn_no_pid' };
      return false;
    } catch {
      lastLaunch = { exeFound: true, launched: false, exePath, reasonCode: 'spawn_failed' };
      return false;
    }
  };

  const announce = () => {
    send({ type: 'hello', ...lastState });
  };

  const enable = () => {
    if (enabled || process.platform !== 'win32') return;
    enabled = true;
    launchCompanion();
    announce();
    ensureChatSocket();
    setTimeout(announce, 500).unref?.();
    setTimeout(announce, 1500).unref?.();
    setTimeout(ensureChatSocket, 500).unref?.();
    setTimeout(ensureChatSocket, 1500).unref?.();
    heartbeat = setInterval(() => {
      send({ type: 'heartbeat', ...lastState });
    }, HEARTBEAT_MS);
    heartbeat.unref?.();
  };

  const disable = () => {
    if (!enabled && !socket) return;
    enabled = false;
    // The detach tells the exe to exit, so `launched` is no longer true.
    // `exeFound` survives (the binary is still where we found it) — that is
    // the one fact that stays useful after a shutdown.
    chatConnected = false;
    lastLaunch = {
      exeFound: lastLaunch.exeFound,
      launched: false,
      exePath: lastLaunch.exePath,
      reasonCode: 'not_attempted',
    };
    if (heartbeat) {
      clearInterval(heartbeat);
      heartbeat = null;
    }
    if (chatReconnect) {
      clearTimeout(chatReconnect);
      chatReconnect = null;
    }
    try {
      sendChat({ type: 'chat_detach', at: Date.now() });
      chatSocket?.destroy();
    } catch {}
    chatSocket = null;
    chatBuffer = '';
    send({ type: 'detach', at: Date.now() });
    const socketToClose = socket;
    socket = null;
    setTimeout(() => {
      try {
        socketToClose?.close();
      } catch {}
    }, 120).unref?.();
  };

  const publish = payload => {
    if (!payload || typeof payload !== 'object') return;
    if (payload.type === 'permissionRequestState') {
      const request = Array.isArray(payload.requests)
        ? payload.requests.find(item => item && item.approvalState === 'pending')
        : null;
      pendingPermission = request
        ? {
            requestId: String(request.requestId || request.id || ''),
            title: String(request.title || 'Permission required'),
            detail: String(request.detail || ''),
            description: String(request.description || ''),
            category: String(request.category || 'edit'),
            approvalState: 'pending',
          }
        : null;
      send({ type: 'state', ...lastState });
    } else if (payload.type === 'agentState') {
      lastState = {
        state: String(payload.state || 'idle'),
        detail: String(payload.detail || ''),
        level: String(payload.level || 'info'),
        progress: Number(payload.meta?.progress) || 0,
        at: Number(payload.at) || Date.now(),
      };
    } else if (payload.type === 'assistant') {
      lastState = { state: 'done', detail: 'Final response ready', level: 'success', progress: 100, at: Date.now() };
    } else if (payload.type === 'stopped') {
      lastState = { state: 'waiting_output', detail: 'Task stopped', level: 'warn', progress: 0, at: Date.now() };
    } else if (payload.type === 'error') {
      lastState = { state: 'failed', detail: String(payload.message || 'Task failed'), level: 'error', progress: 100, at: Date.now() };
    } else {
      return;
    }
    if (payload.type !== 'permissionRequestState') {
      send({ type: 'state', ...lastState });
    }
  };

  const openChat = () => {
    if (process.platform !== 'win32') return false;
    const wasEnabled = enabled;
    enable();
    if (wasEnabled && (!chatSocket || chatSocket.destroyed)) launchCompanion();
    const requestOpen = () => send({ type: 'open_chat', ...lastState, at: Date.now() });
    if (wasEnabled) {
      requestOpen();
      setTimeout(requestOpen, 220).unref?.();
    } else {
      setTimeout(requestOpen, 350).unref?.();
      setTimeout(requestOpen, 900).unref?.();
      setTimeout(requestOpen, 1600).unref?.();
    }
    return true;
  };

  const setPermissionDecisionHandler = handler => {
    permissionDecisionHandler = typeof handler === 'function' ? handler : null;
    return () => {
      if (permissionDecisionHandler === handler) permissionDecisionHandler = null;
    };
  };

  const setChatRequestHandler = handler => {
    chatRequestHandler = typeof handler === 'function' ? handler : null;
    return () => {
      if (chatRequestHandler === handler) chatRequestHandler = null;
    };
  };

  return {
    enable,
    disable,
    openChat,
    publish,
    setPermissionDecisionHandler,
    setChatRequestHandler,
    dispose: disable,
    get enabled() {
      return enabled;
    },
    get chatConnected() {
      return chatConnected;
    },
    /// Observe chat-socket connectivity (added 2026-08-28, audit §4.2
    /// PET-P0-2). Observational only — setting a handler changes no
    /// behaviour of the socket lifecycle.
    setChatStateHandler(handler) {
      chatStateHandler = typeof handler === 'function' ? handler : null;
    },
    /// Read-only status projection for `pet.status` (audit §4.2 PET-P0-2).
    /// Never throws, never spawns, never touches the wire.
    getStatus() {
      return {
        enabled,
        chatConnected,
        exeFound: lastLaunch.exeFound,
        // `launched` and `launchAttempted` are different facts and the UI
        // needs both: "we never even tried" (module preload, non-Windows)
        // must not be rendered the same way as "we tried and it failed".
        launchAttempted: lastLaunch.reasonCode !== 'not_attempted',
        launched: lastLaunch.launched,
        // Basename only — no private absolute path crosses the boundary.
        exePath: lastLaunch.exePath,
        reasonCode: lastLaunch.reasonCode || '',
      };
    },
  };
}

module.exports = {
  createDesktopCompanionBridge,
};
