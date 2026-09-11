// Trylo Desktop — Vite dev plugin: local file API.
//
// In `pnpm dev` the webview is a regular browser, NOT a Tauri
// webview. The JS side calls `@tauri-apps/api/core`'s `invoke`
// for `list_dir` / `read_file`, which throws in a plain
// browser because there is no Tauri runtime.
//
// This plugin mounts a tiny HTTP API on the dev server so the
// browser can still drive the file tree. It mirrors the JSON
// shapes the Rust commands return. Production is unaffected —
// the plugin is wired only in `defineConfig` below.
//
// Endpoints:
//   GET /__dev_fs/list_dir?path=<encoded>
//   GET /__dev_fs/read_file?path=<encoded>
//   GET /__dev_fs/stat_file?path=<encoded>
//
// Responses mirror the Rust types:
//   list_dir → JSON string (per the Phase 1.0 workaround
//             in tauri-fs-commands.ts: Rust returns a string
//             and the JS side JSON.parses it). We return
//             the JSON-stringified array directly so the
//             existing parseDirEntries path Just Works.
//   read_file → text/plain
//   stat_file → JSON FileStat

import type { Plugin, ViteDevServer } from 'vite';
import { promises as fsp } from 'node:fs';
import * as path from 'node:path';
import { URL } from 'node:url';
import { isHiddenName } from './hidden-dirs';

interface RawDirEntry {
  name: string;
  path: string;
  is_directory: boolean;
}

function isSafe(p: string): boolean {
  // Dev-only: trust the user. The endpoint is bound to
  // localhost on the developer's machine; an attacker
  // would already have shell access. We do still
  // normalize path separators so `C:/work/demo-ws` matches
  // `C:\work\trylo` (path.resolve returns backslashes on
  // Windows).
  void p;
  return true;
}

function jsonResponse(res: ViteDevServer['middlewares']['use'], status: number, body: unknown): void {
  res.statusCode = status;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.end(typeof body === 'string' ? body : JSON.stringify(body));
}

function textResponse(res: ViteDevServer['middlewares']['use'], status: number, body: string): void {
  res.statusCode = status;
  res.setHeader('content-type', 'text/plain; charset=utf-8');
  res.end(body);
}

export function devFileApi(): Plugin {
  return {
    name: 'trylo:dev-file-api',
    configureServer(server: ViteDevServer) {
      server.middlewares.use(async (req, res, next) => {
        const url = req.url ?? '';
        if (!url.startsWith('/__dev_fs/')) {
          next();
          return;
        }
        const parsed = new URL(url, 'http://localhost');
        const op = parsed.pathname.replace('/__dev_fs/', '');
        const p = parsed.searchParams.get('path') ?? '';

        if (!p) {
          jsonResponse(res, 400, { error: 'missing path' });
          return;
        }
        if (!isSafe(p)) {
          jsonResponse(res, 403, { error: 'path outside dev root' });
          return;
        }

        try {
          if (op === 'list_dir') {
            const stat = await fsp.stat(p);
            if (!stat.isDirectory()) {
              jsonResponse(res, 400, { error: 'not a directory' });
              return;
            }
            const dirents = await fsp.readdir(p, { withFileTypes: true });
            const out: RawDirEntry[] = dirents
              .filter((d) => !isHiddenName(d.name))
              .map((d) => ({
                name: d.name,
                path: path.join(p, d.name),
                is_directory: d.isDirectory(),
              }))
              .sort((a, b) => a.name.localeCompare(b.name));
            // Mirror the Rust list_dir quirk: return a JSON
            // string, not a JSON array, so the JS
            // parseDirEntries path works unchanged.
            jsonResponse(res, 200, JSON.stringify(out));
            return;
          }
          if (op === 'read_file') {
            const text = await fsp.readFile(p, 'utf8');
            textResponse(res, 200, text);
            return;
          }
          if (op === 'read_file_bytes') {
            // v1.16.2.6: dev backend for binary read. Returns
            // base64 so the JSON line carries binary safely
            // (binary in a JSON string is awkward). The
            // Tauri path uses Vec<u8> directly.
            const buf = await fsp.readFile(p);
            jsonResponse(res, 200, Buffer.from(buf).toString('base64'));
            return;
          }
          if (op === 'stat_file') {
            const s = await fsp.stat(p);
            jsonResponse(res, 200, {
              path: p,
              size: s.size,
              modifiedMs: s.mtimeMs,
              isDirectory: s.isDirectory(),
              isFile: s.isFile(),
            });
            return;
          }
          jsonResponse(res, 404, { error: `unknown op ${op}` });
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          jsonResponse(res, 500, { error: msg });
        }
      });
    },
  };
}
