export const mediaEngineRoot: string;
export const mediaEngineLock: { provider: string; version: string; files: { path: string; size: number; sha256: string }[] };
export function mediaFileDigest(file: string): Promise<string>;
export function verifyMediaEngine(root?: string): Promise<{ encoder: string; probe: string }>;
