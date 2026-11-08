import type { ViteDevServer } from 'vite';
import { MediaCompatibility } from './media-compat/service';
import { containedPreviewFile } from './path-scope';
import { allowPreviewRequest } from './request-origin';
import { mediaPlaylist } from '../../src/preview/providers/media-playlist';
import { previewCachePath } from '../../scripts/preview/cache-path.mjs';

export function registerMediaCompatibility(server: ViteDevServer): void {
  const service = new MediaCompatibility(previewCachePath('media'), process.env.TRYLO_MEDIA_ENGINE_ROOT);
  server.httpServer?.once('close', () => { void service.shutdown(); });
  server.middlewares.use('/__dev_preview/media-compat', async (req, res) => {
    if (!allowPreviewRequest(req)) { res.statusCode = 403; res.end(); return; }
    try {
      const route = (req.url ?? '').split('?')[0]!.replace(/^\//, '');
      if (req.method === 'POST' && !route) {
        let text = '';
        for await (const part of req) { text += part; if (text.length > 8192) throw new Error('请求过大'); }
        const { token, filePath, allowedRoot } = JSON.parse(text) as { token: string; filePath: string; allowedRoot: string };
        const target = await containedPreviewFile(filePath, allowedRoot);
        let disconnected = false;
        const abandon = () => { if (!res.writableEnded) { disconnected = true; void service.close(token); } };
        res.once('close', abandon);
        const info = await service.open(token, target);
        res.removeListener('close', abandon);
        if (disconnected) { await service.close(token); return; }
        res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ ...info, url: `/__dev_preview/media-compat/${token}/index.m3u8` })); return;
      }
      const parts = route.split('/'); const token = parts[0]!;
      if (!/^[\da-z-]{32,64}$/i.test(token)) { res.statusCode = 404; res.end(); return; }
      if (req.method === 'DELETE' && parts.length === 1) { await service.close(token); res.statusCode = 204; res.end(); return; }
      if (req.method !== 'GET' && req.method !== 'HEAD') { res.statusCode = 405; res.end(); return; }
      let bytes: Buffer; let mime: string;
      if (parts.length === 2 && parts[1] === 'index.m3u8') { bytes = Buffer.from(mediaPlaylist(service.info(token).duration)); mime = 'application/vnd.apple.mpegurl'; }
      else if (parts.length === 3 && parts[1] === 'segments' && /^\d+\.ts$/.test(parts[2]!)) { bytes = await service.segment(token, Number(parts[2]!.slice(0, -3))); mime = 'video/mp2t'; }
      else { res.statusCode = 404; res.end(); return; }
      res.setHeader('Content-Type', mime); res.setHeader('Cache-Control', 'no-store'); res.setHeader('Content-Length', bytes.length); res.setHeader('X-Content-Type-Options', 'nosniff');
      res.end(req.method === 'HEAD' ? undefined : bytes);
    } catch (error) { if (!res.headersSent && !res.destroyed) { res.statusCode = 422; res.end(error instanceof Error ? error.message : String(error)); } }
  });
}
