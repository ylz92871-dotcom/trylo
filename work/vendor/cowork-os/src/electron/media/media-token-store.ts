import { randomUUID } from "crypto";
import * as path from "path";

export const MEDIA_SCHEME = "media";
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

export type MediaTokenRecord = {
  resolvedPath: string;
  workspaceRoot: string;
  mimeType: string;
  expiresAt: number;
};

const mediaTokenStore = new Map<string, MediaTokenRecord>();

export function purgeExpiredMediaTokens(now = Date.now()): void {
  for (const [token, record] of mediaTokenStore.entries()) {
    if (record.expiresAt <= now) {
      mediaTokenStore.delete(token);
    }
  }
}

export function getMediaToken(token: string): MediaTokenRecord | undefined {
  return mediaTokenStore.get(token);
}

export function deleteMediaToken(token: string): void {
  mediaTokenStore.delete(token);
}

export function isPathWithinWorkspace(resolvedPath: string, workspaceRoot: string): boolean {
  const normalizedWorkspace = path.resolve(workspaceRoot);
  const normalizedFile = path.resolve(resolvedPath);
  const relative = path.relative(normalizedWorkspace, normalizedFile);
  return !relative.startsWith("..") && !path.isAbsolute(relative);
}

export function isSupportedMediaFile(resolvedPath: string, mimeType: string): boolean {
  const ext = path.extname(resolvedPath).toLowerCase();
  return ALLOWED_EXTENSIONS.has(ext) && ALLOWED_MIME_TYPES.has(mimeType.toLowerCase());
}

export function createMediaPlaybackUrl(params: {
  resolvedPath: string;
  workspaceRoot: string;
  mimeType: string;
}): string {
  return createTokenizedMediaUrl(params);
}

export function createLocalPreviewFileUrl(params: {
  resolvedPath: string;
  rootPath: string;
  mimeType: string;
}): string {
  return createTokenizedMediaUrl({
    resolvedPath: params.resolvedPath,
    workspaceRoot: params.rootPath,
    mimeType: params.mimeType,
  });
}

function createTokenizedMediaUrl(params: {
  resolvedPath: string;
  workspaceRoot: string;
  mimeType: string;
}): string {
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

  const token = randomUUID();
  mediaTokenStore.set(token, {
    resolvedPath,
    workspaceRoot,
    mimeType,
    expiresAt: Date.now() + TOKEN_TTL_MS,
  });

  return `${MEDIA_SCHEME}://local/${token}`;
}
