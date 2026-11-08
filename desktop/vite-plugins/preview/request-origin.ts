import type { IncomingMessage } from 'node:http';

/** Private development file APIs are for the local app origin. In particular,
 * opaque preview iframes send Origin: null; reject it without throwing out of
 * an async Connect handler. Host validation also rejects DNS-rebinding hosts. */
export function allowPreviewRequest(req: Pick<IncomingMessage, 'headers' | 'socket'>): boolean {
  try {
    if (!req.headers.host) return false;
    const secure = (req.socket as typeof req.socket & { encrypted?: boolean }).encrypted === true;
    const host = new URL(`${secure ? 'https' : 'http'}://${req.headers.host}`);
    if (!['localhost', '127.0.0.1', '[::1]'].includes(host.hostname) || host.username || host.password || host.pathname !== '/' || host.search || host.hash) return false;
    if (!req.headers.origin) return true;
    const origin = new URL(req.headers.origin);
    return origin.origin === host.origin && !origin.username && !origin.password && origin.pathname === '/' && !origin.search && !origin.hash;
  } catch { return false; }
}
