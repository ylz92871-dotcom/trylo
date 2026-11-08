// Include PDF.js CJK CMaps, fallback fonts and image decoders offline.
import type { Plugin } from 'vite';
import { promises as fs } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
const base = fileURLToPath(new URL('../../node_modules/pdfjs-dist/', import.meta.url));
const folders = ['cmaps', 'standard_fonts', 'wasm'];
export function pdfAssets(): Plugin {
  return {
    name: 'trylo:pdf-assets',
    configureServer(server) {
      server.middlewares.use('/pdf-assets', async (req, res, next) => {
        const parts = (req.url ?? '').split('?')[0]?.split('/').filter(Boolean) ?? [];
        if (parts.length !== 2 || !folders.includes(parts[0]!) || !/^[\w.-]+$/.test(parts[1]!)) return next();
        try {
          const data = await fs.readFile(path.join(base, ...parts));
          res.setHeader('Content-Type', parts[1]!.endsWith('.wasm') ? 'application/wasm' : parts[1]!.endsWith('.js') ? 'application/javascript' : 'application/octet-stream');
          res.end(data);
        } catch { res.statusCode = 404; res.end(); }
      });
    },
    async generateBundle() {
      for (const folder of folders) {
        for (const file of await fs.readdir(path.join(base, folder), { withFileTypes: true })) {
          if (file.isFile()) this.emitFile({ type: 'asset', fileName: `pdf-assets/${folder}/${file.name}`, source: await fs.readFile(path.join(base, folder, file.name)) });
        }
      }
    },
  };
}
