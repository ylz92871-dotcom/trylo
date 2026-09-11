import { protocol } from "electron";
import * as fs from "fs";
import * as path from "path";
import { Readable } from "stream";
import {
  MEDIA_SCHEME,
  createLocalPreviewFileUrl,
  createMediaPlaybackUrl,
  deleteMediaToken,
  getMediaToken,
  isPathWithinWorkspace,
  isSupportedMediaFile,
  purgeExpiredMediaTokens,
} from "./media-token-store";

export { createLocalPreviewFileUrl, createMediaPlaybackUrl } from "./media-token-store";

function createErrorResponse(statusCode: number, message: string): Response {
  return new Response(message, {
    status: statusCode,
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": "private, no-store",
    },
  });
}

function parseRangeHeader(rangeHeader: string, size: number): { start: number; end: number } | null {
  const match = /^bytes=(\d*)-(\d*)$/i.exec(rangeHeader.trim());
  if (!match) return null;

  const startRaw = match[1];
  const endRaw = match[2];
  let start = startRaw ? Number.parseInt(startRaw, 10) : Number.NaN;
  let end = endRaw ? Number.parseInt(endRaw, 10) : Number.NaN;

  if (Number.isNaN(start) && Number.isNaN(end)) return null;

  if (Number.isNaN(start)) {
    const suffixLength = end;
    if (!Number.isFinite(suffixLength) || suffixLength <= 0) return null;
    start = Math.max(0, size - suffixLength);
    end = size - 1;
  } else if (Number.isNaN(end)) {
    end = size - 1;
  }

  if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end < start || start >= size) {
    return null;
  }

  return {
    start,
    end: Math.min(end, size - 1),
  };
}

export function registerMediaScheme(): void {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: MEDIA_SCHEME,
      privileges: {
        standard: true,
        secure: true,
        supportFetchAPI: true,
        corsEnabled: true,
        stream: true,
      },
    },
  ]);
}

export function registerMediaProtocol(): void {
  protocol.handle(MEDIA_SCHEME, async (request) => {
    purgeExpiredMediaTokens();

    let token = "";
    try {
      const url = new URL(request.url);
      token = decodeURIComponent(url.pathname).replace(/^\/+/, "");
    } catch {
      return createErrorResponse(400, "Invalid media URL");
    }

    if (!token) {
      return createErrorResponse(400, "Missing media token");
    }

    const record = getMediaToken(token);
    if (!record) {
      return createErrorResponse(404, "Media token not found");
    }

    if (record.expiresAt <= Date.now()) {
      deleteMediaToken(token);
      return createErrorResponse(403, "Media token expired");
    }

    const resolvedPath = path.resolve(record.resolvedPath);
    const workspaceRoot = path.resolve(record.workspaceRoot);
    if (
      !isPathWithinWorkspace(resolvedPath, workspaceRoot) ||
      !isSupportedMediaFile(resolvedPath, record.mimeType)
    ) {
      deleteMediaToken(token);
      return createErrorResponse(403, "Forbidden");
    }

    if (!fs.existsSync(resolvedPath)) {
      deleteMediaToken(token);
      return createErrorResponse(404, "Media file not found");
    }

    const stats = await fs.promises.stat(resolvedPath);
    if (!stats.isFile()) {
      return createErrorResponse(404, "Media file not found");
    }

    const baseHeaders = {
      "Content-Type": record.mimeType,
      "Accept-Ranges": "bytes",
      "Cache-Control": "private, no-store",
    };

    const rangeHeader = request.headers.get("range");
    if (!rangeHeader) {
      const stream = fs.createReadStream(resolvedPath);
      return new Response(Readable.toWeb(stream) as BodyInit, {
        status: 200,
        headers: {
          ...baseHeaders,
          "Content-Length": String(stats.size),
        },
      });
    }

    const range = parseRangeHeader(rangeHeader, stats.size);
    if (!range) {
      return new Response(null, {
        status: 416,
        headers: {
          ...baseHeaders,
          "Content-Range": `bytes */${stats.size}`,
        },
      });
    }

    const contentLength = range.end - range.start + 1;
    const stream = fs.createReadStream(resolvedPath, { start: range.start, end: range.end });
    return new Response(Readable.toWeb(stream) as BodyInit, {
      status: 206,
      headers: {
        ...baseHeaders,
        "Content-Length": String(contentLength),
        "Content-Range": `bytes ${range.start}-${range.end}/${stats.size}`,
      },
    });
  });
}
