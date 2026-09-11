const fs = require('node:fs');
const fsPromises = require('node:fs/promises');
const https = require('node:https');
const path = require('node:path');
const { spawn } = require('node:child_process');

const QUICK_TUNNEL_PATTERN = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/gi;
const DEFAULT_NAMED_TUNNEL_URL = 'https://remote.trylocode.me';

function normalizePublicUrl(value) {
  return String(value || '').trim().replace(/\/+$/, '');
}

function extractQuickTunnelUrl(value) {
  const matches = String(value || '').match(QUICK_TUNNEL_PATTERN);
  return matches?.length ? normalizePublicUrl(matches[matches.length - 1]) : '';
}

function isQuickTunnelUrl(value) {
  try {
    return new URL(normalizePublicUrl(value)).hostname.toLowerCase().endsWith('.trycloudflare.com');
  } catch {
    return false;
  }
}

function isTryloNamedTunnelUrl(value) {
  try {
    return new URL(normalizePublicUrl(value)).hostname.toLowerCase() === 'remote.trylocode.me';
  } catch {
    return false;
  }
}

function probeTryloGateway(value, timeoutMs = 5000) {
  const publicUrl = normalizePublicUrl(value);
  if (!/^https:\/\//i.test(publicUrl)) return Promise.resolve(false);
  return new Promise(resolve => {
    let settled = false;
    const finish = result => {
      if (settled) return;
      settled = true;
      resolve(result);
    };
    const request = https.get(`${publicUrl}/health`, {
      headers: { Accept: 'application/json', 'User-Agent': 'Trylo-Code-Remote/0.6' },
    }, response => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', chunk => {
        if (body.length < 8192) body += chunk;
      });
      response.on('end', () => {
        if (response.statusCode !== 200) return finish(false);
        try {
          const payload = JSON.parse(body);
          finish(payload?.ok === true && payload?.service === 'trylo-remote-gateway');
        } catch {
          finish(false);
        }
      });
    });
    request.setTimeout(timeoutMs, () => request.destroy(new Error('Tunnel health check timed out.')));
    request.once('error', () => finish(false));
  });
}

function cloudflaredCandidates(configuredPath = '') {
  const candidates = [
    normalizePublicUrl(configuredPath),
    'cloudflared',
    process.platform === 'win32' ? 'C:\\Program Files (x86)\\cloudflared\\cloudflared.exe' : '',
    process.platform === 'win32' ? 'C:\\Program Files\\cloudflared\\cloudflared.exe' : '',
    process.platform !== 'win32' ? '/usr/local/bin/cloudflared' : '',
    process.platform !== 'win32' ? '/usr/bin/cloudflared' : '',
  ].filter(Boolean);
  return [...new Set(candidates)];
}

async function spawnDetachedCloudflared(executable, args, logPath) {
  await fsPromises.mkdir(path.dirname(logPath), { recursive: true });
  await fsPromises.writeFile(logPath, '', 'utf8');
  const logHandle = fs.openSync(logPath, 'a');
  try {
    return await new Promise((resolve, reject) => {
      let child;
      try {
        child = spawn(executable, args, {
          detached: true,
          windowsHide: true,
          stdio: ['ignore', logHandle, logHandle],
        });
      } catch (error) {
        reject(error);
        return;
      }
      child.once('error', reject);
      child.once('spawn', () => resolve(child));
    });
  } finally {
    fs.closeSync(logHandle);
  }
}

async function startCloudflareQuickTunnel({
  port,
  logPath,
  configuredPath = '',
  timeoutMs = 35_000,
}) {
  const args = [
    'tunnel',
    '--no-autoupdate',
    '--loglevel',
    'info',
    '--url',
    `http://127.0.0.1:${port}`,
  ];
  let child = null;
  let lastError = null;
  for (const executable of cloudflaredCandidates(configuredPath)) {
    try {
      child = await spawnDetachedCloudflared(executable, args, logPath);
      break;
    } catch (error) {
      lastError = error;
      if (error?.code !== 'ENOENT') throw error;
    }
  }
  if (!child) {
    const detail = lastError?.message ? ` (${lastError.message})` : '';
    throw new Error(`cloudflared was not found${detail}. Install Cloudflare Tunnel or set tryloCode.remote.cloudflaredPath.`);
  }

  child.unref();
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const output = await fsPromises.readFile(logPath, 'utf8').catch(() => '');
    const publicUrl = extractQuickTunnelUrl(output);
    if (publicUrl) return { publicUrl, pid: child.pid || 0, logPath };
    if (child.exitCode !== null) {
      throw new Error(`cloudflared exited before creating a Quick Tunnel (exit code ${child.exitCode}).`);
    }
    await new Promise(resolve => setTimeout(resolve, 250));
  }

  if (child.pid) {
    try { process.kill(child.pid); } catch {}
  }
  throw new Error(`Cloudflare Quick Tunnel did not return a public URL within ${Math.round(timeoutMs / 1000)} seconds.`);
}

module.exports = {
  DEFAULT_NAMED_TUNNEL_URL,
  extractQuickTunnelUrl,
  isQuickTunnelUrl,
  isTryloNamedTunnelUrl,
  normalizePublicUrl,
  probeTryloGateway,
  startCloudflareQuickTunnel,
};
