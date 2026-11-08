// @vitest-environment node
import { afterEach, describe, expect, it } from 'vitest';
import { request } from 'node:http';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { openWebSession } from './web';

const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'trylo-web-test-'));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, 'site'));
  for (const [name, text] of [['site/index.html', '<button>ready</button>'], ['site/app.js', 'export const ready = true'], ['site/.env', 'PRIVATE'], ['private.txt', 'OUTSIDE']]) await writeFile(path.join(root, name!), text!);
  const session = await openWebSession(path.join(root, 'site/index.html'), root);
  cleanup.push(() => new Promise<void>((resolve) => { session.server.closeAllConnections(); session.server.close(() => resolve()); }));
  return session;
}
function get(url: string, pathname: string, headers: Record<string, string> = {}, method = 'GET') {
  const source = new URL(url);
  return new Promise<{ status: number; text: string; headers: Record<string, unknown> }>((resolve, reject) => {
    const req = request({ hostname: '127.0.0.1', port: source.port, path: pathname, method, headers: { Host: source.host, ...headers } }, (res) => {
      let text = ''; res.setEncoding('utf8'); res.on('data', (chunk) => { text += chunk; }); res.on('end', () => resolve({ status: res.statusCode!, text, headers: res.headers }));
    }); req.on('error', reject); req.end();
  });
}
describe('isolated development HTML host', () => {
  it('serves modules and root-relative assets only with its unguessable authority', async () => {
    const session = await fixture();
    expect((await get(session.url, '/index.html')).text).toContain('<button>ready');
    const module = await get(session.url, '/app.js');
    expect(module.status).toBe(200); expect(module.headers['access-control-allow-origin']).toBe('*');
    expect(module.headers['content-security-policy']).toContain("object-src 'none'");
    expect((await get(session.url, '/app.js', { Host: new URL(session.url).port })).status).toBe(403);
    expect((await get(session.url, '/app.js', {}, 'POST')).status).toBe(405);
    expect((await get(session.url, '/app.js', {}, 'HEAD')).text).toBe('');
  });
  it('blocks traversal and hidden files, diagnoses missing assets, and supports SPA routes', async () => {
    const session = await fixture();
    for (const name of ['/%2e%2e/private.txt', '/%2eenv', '/..%5cprivate.txt', '/missing.js']) expect((await get(session.url, name)).status).toBe(404);
    expect((await get(session.url, '/client/route', { Accept: 'text/html' })).text).toContain('<button>ready');
    expect(session.warnings.length).toBeGreaterThan(0);
    session.server.closeAllConnections(); await new Promise<void>((resolve) => session.server.close(() => resolve()));
    await expect(get(session.url, '/index.html')).rejects.toThrow();
  });
});
