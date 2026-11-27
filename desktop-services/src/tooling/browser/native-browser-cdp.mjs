import { WebSocket } from 'ws';

// Emulation overrides belong to the CDP connection. Keep that connection alive
// for the native page's lifetime; a one-shot socket silently loses the override.
export function createViewportCdp({ onDisconnect } = {}) {
  const connections = new Map();
  function connect(url) {
    let entry = connections.get(url);
    if (entry) return entry;
    const socket = new WebSocket(url), pending = new Map();
    let nextId = 0;
    const ready = new Promise((resolve, reject) => {
      const timer = setTimeout(() => { socket.terminate(); reject(new Error('页面尺寸控制连接超时')); }, 5000);
      socket.once('open', () => { clearTimeout(timer); resolve(); });
      socket.once('error', error => { clearTimeout(timer); reject(error); });
      socket.once('close', () => { clearTimeout(timer); reject(new Error('页面尺寸控制连接已断开')); });
    });
    const fail = () => {
      const owned = connections.get(url) === entry;
      if (owned) connections.delete(url);
      for (const request of pending.values()) request.finish(new Error('页面尺寸控制连接已断开'));
      if (owned) onDisconnect?.(url);
    };
    socket.on('error', fail); socket.on('close', fail);
    socket.on('message', raw => {
      const message = JSON.parse(String(raw));
      pending.get(message.id)?.finish(message.error ? new Error(message.error.message) : null, message.result);
    });
    entry = { socket, async send(method, params = {}) {
      await ready;
      if (socket.readyState !== WebSocket.OPEN) throw new Error('页面尺寸控制连接已断开');
      return new Promise((resolve, reject) => {
        const id = ++nextId;
        const timer = setTimeout(() => finish(new Error(`CDP ${method} timed out`)), 5000);
        const finish = (error, result) => { clearTimeout(timer); pending.delete(id); error ? reject(error) : resolve(result); };
        pending.set(id, { finish });
        socket.send(JSON.stringify({ id, method, params }), error => { if (error) finish(error); });
      });
    } };
    connections.set(url, entry);
    return entry;
  }
  return {
    send: (url, method, params) => connect(url).send(method, params),
    retain(urls) { for (const [url, entry] of connections) if (!urls.includes(url)) { entry.socket.terminate(); connections.delete(url); } },
    dispose() { for (const entry of connections.values()) entry.socket.terminate(); connections.clear(); },
  };
}
