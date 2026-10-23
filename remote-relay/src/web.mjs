import fs from 'node:fs/promises';
import path from 'node:path';

const paths = new Map([
  ['/account/', 'user/index.html'], ['/admin/', 'admin/index.html'],
  ...['user/app.js', 'user/style.css', 'admin/app.js', 'admin/style.css', 'admin/model-service/index.js', 'admin/model-service/api-client.js', 'admin/model-service/style.css', 'shared/ui.js', 'shared/api.js', 'shared/base.css'].map(file => [`/console/${file}`, file]),
]);
export async function serveConsole(request, response, pathname, directory) {
  if (!directory || !['GET', 'HEAD'].includes(request.method)) return false;
  if (['/account', '/admin'].includes(pathname)) { response.writeHead(308, { Location: `${pathname}/` }); response.end(); return true; }
  const file = paths.get(pathname);
  if (!file) return false;
  const content = await fs.readFile(path.join(directory, file));
  response.writeHead(200, {
    'Content-Type': `${file.endsWith('.html') ? 'text/html' : file.endsWith('.css') ? 'text/css' : 'text/javascript'}; charset=utf-8`,
    'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer',
    'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
  });
  response.end(request.method === 'HEAD' ? undefined : content); return true;
}
