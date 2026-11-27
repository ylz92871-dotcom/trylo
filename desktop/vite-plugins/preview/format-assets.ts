import type { Plugin } from 'vite';
import { readFile } from 'node:fs/promises';
import { previewFormatFiles } from '../../scripts/build/shared/preview/codec-files.mjs';

export function previewFormatAssets(): Plugin {
  const assets = previewFormatFiles();
  return {
    name: 'trylo:preview-format-assets',
    configureServer(server) {
      server.middlewares.use(async (req, res, next) => {
        const name = (req.url ?? '').split('?')[0]!.replace(/^\//, '');
        const file = assets.get(name);
        if (!file) { next(); return; }
        if (req.method !== 'GET' && req.method !== 'HEAD') { res.statusCode = 405; res.end(); return; }
        try {
          const bytes = await readFile(file);
          res.setHeader('Content-Type', name.endsWith('.js') ? 'text/javascript' : name.endsWith('.wasm') ? 'application/wasm' : 'text/plain; charset=utf-8');
          res.setHeader('Content-Length', bytes.length);
          res.end(req.method === 'HEAD' ? undefined : bytes);
        } catch { res.statusCode = 500; res.end('预览解码器资源缺失'); }
      });
    },
    async generateBundle() {
      for (const [fileName, file] of assets) this.emitFile({ type: 'asset', fileName, source: await readFile(file) });
    },
  };
}
