import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const MIME = { '.html': 'text/html', '.htm': 'text/html', '.css': 'text/css', '.js': 'text/javascript',
  '.mjs': 'text/javascript', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.ico': 'image/x-icon',
  '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf', '.wasm': 'application/wasm',
  '.mp3': 'audio/mpeg', '.ogg': 'audio/ogg', '.mp4': 'video/mp4',
  '.glb': 'model/gltf-binary', '.gltf': 'model/gltf+json', '.bin': 'application/octet-stream',
  '.obj': 'model/obj', '.stl': 'model/stl', '.3mf': 'model/3mf' };

function contentType(file) {
  const type = MIME[path.extname(file).toLowerCase()];
  // Only textual media carry a charset; binary model buffers remain opaque.
  return type.startsWith('text/') || type.endsWith('+xml') || type.endsWith('+json') ? `${type}; charset=utf-8` : type;
}

/** Separate origin from the CDP/lease gate. Static files only, bounded by real paths. */
export function createWorkspacePagePreview(projectRoot) {
  const token = crypto.randomBytes(24).toString('hex');
  let server, ready;
  const inside = (root, file) => { const relative = path.relative(root, file); return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative)); };
  async function safeFile(file) {
    const root = await fsp.realpath(projectRoot), absolute = await fsp.realpath(file);
    const relative = path.relative(root, absolute);
    const segments = relative.split(/[\\/]/);
    // Published task output is readable; sibling session state and nested
    // hidden files retain the same exclusion after resolving links.
    const names = path.sep === '\\' ? segments.map(segment => segment.toLowerCase()) : segments;
    const productOutput = names[0] === '.trylo' && names[1] === 'out';
    if (!inside(root, absolute) || segments.some((part, index) => part.startsWith('.') && !(productOutput && index === 0))
      || !MIME[path.extname(absolute).toLowerCase()]) throw new Error('Local preview only serves static files inside this workspace');
    const stat = await fsp.stat(absolute);
    if (!stat.isFile() || stat.size > 64 * 1024 * 1024) throw new Error('Local preview file is unavailable or too large');
    return { root, absolute };
  }
  async function serve(request, response) {
    try {
      if (!['GET', 'HEAD'].includes(request.method)) { response.writeHead(405); response.end(); return; }
      const url = new URL(request.url, 'http://127.0.0.1');
      const prefix = `/${token}/`;
      if (!url.pathname.startsWith(prefix)) { response.writeHead(404); response.end(); return; }
      const relative = decodeURIComponent(url.pathname.slice(prefix.length));
      const { absolute } = await safeFile(path.resolve(projectRoot, relative));
      response.writeHead(200, { 'Content-Type': contentType(absolute),
        'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' });
      if (request.method === 'HEAD') { response.end(); return; }
      fs.createReadStream(absolute).on('error', () => response.destroy()).pipe(response);
    } catch { if (!response.headersSent) response.writeHead(403); response.end(); }
  }
  return {
    async open(rawUrl) {
      const url = new URL(rawUrl);
      // WHATWG erases the localhost authority. Reject hosted and UNC forms
      // before filesystem resolution, consistently with the host classifier.
      const authority = /^file:\/\/([^/\\]*)/i.exec(String(rawUrl).trim())?.[1];
      if (url.protocol !== 'file:' || authority || url.hostname || url.pathname.startsWith('//')
        || !/\.html?$/i.test(url.pathname)) throw new Error('Local preview requires a workspace HTML page');
      const { root, absolute } = await safeFile(fileURLToPath(url));
      if (!ready) {
        server = http.createServer((req, res) => { void serve(req, res); });
        ready = new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
      }
      await ready;
      const relative = path.relative(root, absolute).split(path.sep).map(encodeURIComponent).join('/');
      return `http://127.0.0.1:${server.address().port}/${token}/${relative}${url.search}${url.hash}`;
    },
    async dispose() {
      if (!server) return;
      await ready?.catch(() => {}); server.closeAllConnections();
      await new Promise(resolve => server.close(resolve));
    },
  };
}
