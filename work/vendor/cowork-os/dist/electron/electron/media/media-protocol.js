"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.createMediaPlaybackUrl = exports.createLocalPreviewFileUrl = void 0;
exports.registerMediaScheme = registerMediaScheme;
exports.registerMediaProtocol = registerMediaProtocol;
const electron_1 = require("electron");
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
const stream_1 = require("stream");
const media_token_store_1 = require("./media-token-store");
var media_token_store_2 = require("./media-token-store");
Object.defineProperty(exports, "createLocalPreviewFileUrl", { enumerable: true, get: function () { return media_token_store_2.createLocalPreviewFileUrl; } });
Object.defineProperty(exports, "createMediaPlaybackUrl", { enumerable: true, get: function () { return media_token_store_2.createMediaPlaybackUrl; } });
function createErrorResponse(statusCode, message) {
    return new Response(message, {
        status: statusCode,
        headers: {
            "Content-Type": "text/plain; charset=utf-8",
            "Cache-Control": "private, no-store",
        },
    });
}
function parseRangeHeader(rangeHeader, size) {
    const match = /^bytes=(\d*)-(\d*)$/i.exec(rangeHeader.trim());
    if (!match)
        return null;
    const startRaw = match[1];
    const endRaw = match[2];
    let start = startRaw ? Number.parseInt(startRaw, 10) : Number.NaN;
    let end = endRaw ? Number.parseInt(endRaw, 10) : Number.NaN;
    if (Number.isNaN(start) && Number.isNaN(end))
        return null;
    if (Number.isNaN(start)) {
        const suffixLength = end;
        if (!Number.isFinite(suffixLength) || suffixLength <= 0)
            return null;
        start = Math.max(0, size - suffixLength);
        end = size - 1;
    }
    else if (Number.isNaN(end)) {
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
function registerMediaScheme() {
    electron_1.protocol.registerSchemesAsPrivileged([
        {
            scheme: media_token_store_1.MEDIA_SCHEME,
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
function registerMediaProtocol() {
    electron_1.protocol.handle(media_token_store_1.MEDIA_SCHEME, async (request) => {
        (0, media_token_store_1.purgeExpiredMediaTokens)();
        let token = "";
        try {
            const url = new URL(request.url);
            token = decodeURIComponent(url.pathname).replace(/^\/+/, "");
        }
        catch {
            return createErrorResponse(400, "Invalid media URL");
        }
        if (!token) {
            return createErrorResponse(400, "Missing media token");
        }
        const record = (0, media_token_store_1.getMediaToken)(token);
        if (!record) {
            return createErrorResponse(404, "Media token not found");
        }
        if (record.expiresAt <= Date.now()) {
            (0, media_token_store_1.deleteMediaToken)(token);
            return createErrorResponse(403, "Media token expired");
        }
        const resolvedPath = path.resolve(record.resolvedPath);
        const workspaceRoot = path.resolve(record.workspaceRoot);
        if (!(0, media_token_store_1.isPathWithinWorkspace)(resolvedPath, workspaceRoot) ||
            !(0, media_token_store_1.isSupportedMediaFile)(resolvedPath, record.mimeType)) {
            (0, media_token_store_1.deleteMediaToken)(token);
            return createErrorResponse(403, "Forbidden");
        }
        if (!fs.existsSync(resolvedPath)) {
            (0, media_token_store_1.deleteMediaToken)(token);
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
            return new Response(stream_1.Readable.toWeb(stream), {
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
        return new Response(stream_1.Readable.toWeb(stream), {
            status: 206,
            headers: {
                ...baseHeaders,
                "Content-Length": String(contentLength),
                "Content-Range": `bytes ${range.start}-${range.end}/${stats.size}`,
            },
        });
    });
}
