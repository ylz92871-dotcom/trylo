import type { Plugin } from 'vite';
import { promises as fs } from 'node:fs';
import { containedPreviewFile } from './path-scope';
import { registerPreviewMedia } from './media';
import { registerMediaCompatibility } from './media-compat';
import { registerWebPreview } from './web';
import { allowPreviewRequest } from './request-origin';
export function previewResources(): Plugin {
  return { name: 'trylo:preview-resources', configureServer(server) {
    registerPreviewMedia(server);
    registerMediaCompatibility(server);
    registerWebPreview(server);
    for (const [route, limit] of [['resource', 10], ['text', 50], ['binary', 100], ['head', 0]] as const) server.middlewares.use(`/__dev_preview/${route}`, async (req, res) => {
      if (req.method !== 'POST' || !allowPreviewRequest(req)) { res.statusCode = 403; res.end(); return; }
      try {
        let body = '';
        for await (const part of req) { body += part; if (body.length > 8192) throw new Error('请求过大'); }
        const { filePath, allowedRoot } = JSON.parse(body) as { filePath: string; allowedRoot: string };
        const target = await containedPreviewFile(filePath, allowedRoot);
        const file = await fs.open(target, 'r');
        try {
          const stat = await file.stat();
          const prefix = route === 'head';
          const maximum = prefix ? 8192 : limit * 1024 * 1024;
          if (!stat.isFile() || (!prefix && stat.size > maximum)) throw new Error(`此预览支持 ${limit} MB 以内的文件，请使用外部应用打开更大的文件`);
          const parts: Buffer[] = []; let total = 0;
          // Reading through an opened handle also bounds a file that grows
          // after stat, instead of allocating its new unbounded length.
          for await (const chunk of file.createReadStream({ autoClose: false, end: prefix ? maximum - 1 : maximum })) { parts.push(chunk); total += chunk.length; }
          if (total > maximum) throw new Error('文件读取时超过预览大小限制');
          res.setHeader('Content-Type', 'application/octet-stream'); res.end(Buffer.concat(parts, total));
        } finally { await file.close(); }
      } catch (error) { res.statusCode = 422; res.end(error instanceof Error ? error.message : String(error)); }
    });
  } };
}
