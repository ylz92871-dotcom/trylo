import fs from 'node:fs/promises';
import path from 'node:path';

const paths = new Map([
  ['/account/', 'user/index.html'], ['/admin/', 'admin/index.html'],
  ...['user/app.js', 'user/style.css', 'admin/app.js', 'admin/style.css', 'admin/model-service/index.js', 'admin/model-service/api-client.js', 'admin/model-service/style.css', 'shared/ui.js', 'shared/api.js', 'shared/mfa.js', 'shared/base.css'].map(file => [`/console/${file}`, file]),
]);
const consoleHeaders = {
  'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer',
  'X-Frame-Options': 'DENY', 'Cross-Origin-Opener-Policy': 'same-origin', 'Cross-Origin-Resource-Policy': 'same-origin',
  'Origin-Agent-Cluster': '?1', 'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=(), usb=(), display-capture=()',
  'Content-Security-Policy': "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; font-src 'self'; connect-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'; object-src 'none'; worker-src 'none'; manifest-src 'none'",
};
export const isConsoleRoute = (method, pathname) => ['GET', 'HEAD'].includes(method) && (paths.has(pathname) || pathname === '/account' || pathname === '/admin');
export async function serveConsole(request, response, pathname, directory) {
  if (!directory || !isConsoleRoute(request.method, pathname)) return false;
  if (['/account', '/admin'].includes(pathname)) { response.writeHead(308, { ...consoleHeaders, Location: `${pathname}/` }); response.end(); return true; }
  const file = paths.get(pathname);
  if (!file) return false;
  const content = await fs.readFile(path.join(directory, file));
  response.writeHead(200, {
    ...consoleHeaders,
    'Content-Type': `${file.endsWith('.html') ? 'text/html' : file.endsWith('.css') ? 'text/css' : 'text/javascript'}; charset=utf-8`,
  });
  response.end(request.method === 'HEAD' ? undefined : content); return true;
}
