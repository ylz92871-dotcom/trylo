import { promises as fs } from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

// Remote preferences share the account's Desktop data directory. Browser
// origins used by dev/release WebViews must not select different transports.
export function createRemoteConfiguration({ appDataDir = process.env.TRYLO_APP_DATA_DIR, relay }) {
  const file = appDataDir ? path.join(appDataDir, 'Trylo', 'remote', 'connection-settings.json') : '';
  let operations = Promise.resolve();
  function normalize(value = {}) {
    return { connectionMode: value.connectionMode === 'server' ? 'server' : 'tunnel',
      enabled: value.enabled === true,
      relayUrl: typeof value.relayUrl === 'string' ? value.relayUrl : 'https://relay.trylocode.me',
      port: Number.isInteger(value.port) && value.port >= 1024 && value.port <= 65535 ? value.port : 49380,
      publicUrl: typeof value.publicUrl === 'string' ? value.publicUrl : '',
      tunnelMode: ['named', 'quick', 'manual', 'off'].includes(value.tunnelMode) ? value.tunnelMode : 'named',
      autoStartTunnel: value.autoStartTunnel !== false,
      cloudflaredPath: typeof value.cloudflaredPath === 'string' ? value.cloudflaredPath : '' };
  }
  function serialize(operation) { const result = operations.then(operation); operations = result.catch(() => {}); return result; }
  async function save(value) {
    if (!file) throw new Error('远程连接配置目录不可用。');
    const settings = normalize(value);
    await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
    const temporary = `${file}.${crypto.randomUUID()}.tmp`;
    try { await fs.writeFile(temporary, JSON.stringify(settings), { mode: 0o600 }); await fs.rename(temporary, file); }
    finally { await fs.rm(temporary, { force: true }).catch(() => {}); }
    return settings;
  }
  return {
    save: value => serialize(() => save(value)),
    load: fallback => serialize(async () => {
      if (!file) throw new Error('远程连接配置目录不可用。');
      try { return normalize(JSON.parse(await fs.readFile(file, 'utf8'))); }
      catch (error) { if (error.code !== 'ENOENT') throw new Error('远程连接配置读取失败，请检查本机数据目录。'); }
      const account = await relay.status();
      const initial = { ...fallback };
      if (!initial.connectionMode && account.loggedIn) { initial.connectionMode = 'server'; initial.relayUrl = account.serverUrl; }
      return save(initial);
    }),
  };
}
