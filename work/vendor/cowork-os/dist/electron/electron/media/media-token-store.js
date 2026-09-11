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
exports.MEDIA_SCHEME = void 0;
exports.purgeExpiredMediaTokens = purgeExpiredMediaTokens;
exports.getMediaToken = getMediaToken;
exports.deleteMediaToken = deleteMediaToken;
exports.isPathWithinWorkspace = isPathWithinWorkspace;
exports.isSupportedMediaFile = isSupportedMediaFile;
exports.createMediaPlaybackUrl = createMediaPlaybackUrl;
exports.createLocalPreviewFileUrl = createLocalPreviewFileUrl;
const crypto_1 = require("crypto");
const path = __importStar(require("path"));
exports.MEDIA_SCHEME = "media";
const TOKEN_TTL_MS = 60 * 60 * 1000;
const ALLOWED_MIME_TYPES = new Set([
    "video/mp4",
    "video/webm",
    "audio/mpeg",
    "audio/mp3",
    "audio/wav",
    "image/png",
]);
const ALLOWED_EXTENSIONS = new Set([".mp4", ".webm", ".mp3", ".wav", ".png"]);
const mediaTokenStore = new Map();
function purgeExpiredMediaTokens(now = Date.now()) {
    for (const [token, record] of mediaTokenStore.entries()) {
        if (record.expiresAt <= now) {
            mediaTokenStore.delete(token);
        }
    }
}
function getMediaToken(token) {
    return mediaTokenStore.get(token);
}
function deleteMediaToken(token) {
    mediaTokenStore.delete(token);
}
function isPathWithinWorkspace(resolvedPath, workspaceRoot) {
    const normalizedWorkspace = path.resolve(workspaceRoot);
    const normalizedFile = path.resolve(resolvedPath);
    const relative = path.relative(normalizedWorkspace, normalizedFile);
    return !relative.startsWith("..") && !path.isAbsolute(relative);
}
function isSupportedMediaFile(resolvedPath, mimeType) {
    const ext = path.extname(resolvedPath).toLowerCase();
    return ALLOWED_EXTENSIONS.has(ext) && ALLOWED_MIME_TYPES.has(mimeType.toLowerCase());
}
function createMediaPlaybackUrl(params) {
    return createTokenizedMediaUrl(params);
}
function createLocalPreviewFileUrl(params) {
    return createTokenizedMediaUrl({
        resolvedPath: params.resolvedPath,
        workspaceRoot: params.rootPath,
        mimeType: params.mimeType,
    });
}
function createTokenizedMediaUrl(params) {
    purgeExpiredMediaTokens();
    const resolvedPath = path.resolve(params.resolvedPath);
    const workspaceRoot = path.resolve(params.workspaceRoot);
    const mimeType = String(params.mimeType || "").toLowerCase();
    if (!isPathWithinWorkspace(resolvedPath, workspaceRoot)) {
        throw new Error("Access denied: media path is outside the allowed root");
    }
    if (!isSupportedMediaFile(resolvedPath, mimeType)) {
        throw new Error("Unsupported media type");
    }
    const token = (0, crypto_1.randomUUID)();
    mediaTokenStore.set(token, {
        resolvedPath,
        workspaceRoot,
        mimeType,
        expiresAt: Date.now() + TOKEN_TTL_MS,
    });
    return `${exports.MEDIA_SCHEME}://local/${token}`;
}
