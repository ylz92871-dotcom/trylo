// Trylo Desktop — RuntimeFingerprint.
//
// Spec TRYLO-CORE-AGENT-TOOL-EXTENSION-TECHNICAL-SPEC §9.
//
// Replaces `JSON.stringify(extraCliArgs)` as the identity of a spawned CLI.
// The old key only proved "the injected argv matches" — a process fixed at
// spawn time by its model, API host, permission level and system prompt
// could still be reused after any of those changed (spec §1.4). Two runs
// share a process ONLY when this fingerprint matches exactly.
//
// INCREMENTAL COMPATIBILITY (mandatory — this file sits on the Code warm
// path): when no Tool Profile was resolved, the fingerprint degrades to
// `legacy:<json of extraCliArgs>`, which is exactly the old key. The
// prewarm-adoption rule therefore stays byte-identical for a plain Code run.

import type { PermissionLevel } from '../permission/permission-policy';
import type { ResolvedToolRuntime } from './types';

/**
 * Two independent 32-bit FNV-1a variants, concatenated into a 64-bit
 * identity.
 *
 * NON-CRYPTOGRAPHIC BY DESIGN: the fingerprint is an in-process reuse key.
 * It is never persisted, never logged and never sent over IPC, so a fast
 * hash is correct here while a slow one would sit on the send path. The
 * sensitive inputs are already reduced before they reach it —
 * `authIdentity` hashes the key instead of carrying it (spec §9:
 * 「不记录 key 本身」).
 */
function fnv1a(input: string, offsetBasis: number, prime: number): number {
  let hash = offsetBasis >>> 0;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i) & 0xff;
    // Low byte only: charCodeAt can exceed 255 for non-Latin-1 prompts and
    // a JS bitwise op would silently truncate the value anyway.
    hash = Math.imul(hash, prime) >>> 0;
  }
  return hash >>> 0;
}

export function hashIdentity(parts: readonly string[]): string {
  const joined = parts.join('');
  const a = fnv1a(joined, 0x811c9dc5, 0x01000193);
  const b = fnv1a(joined, 0x9dc5811c, 0x85ebca6b);
  return `${a.toString(16).padStart(8, '0')}${b.toString(16).padStart(8, '0')}`;
}

/** Best-effort Windows-safe canonicalisation with no filesystem access. */
export function canonicalizeCwd(cwd: string): string {
  let out = (cwd ?? '').trim().replace(/\\/g, '/');
  // Lowercase only the drive letter — paths are case-insensitive on Windows
  // but case-sensitive everywhere else.
  out = out.replace(/^([A-Za-z]):/, (_m, d: string) => `${d.toLowerCase()}:`);
  if (out.length > 1) out = out.replace(/\/+$/, '');
  return out;
}

export interface RuntimeFingerprintInput {
  /** Path of the CLI entry. See the `cliBinaryHash` note below. */
  readonly cliPath: string;
  /**
   * Content hash of the CLI bundle (spec §9).
   *
   * PR-1 DEVIATION: always `''`. Hashing the ~50 MiB single-file bundle on
   * every send is not affordable, and `cliPath` already covers every real
   * case except an in-place rebuild, which the 15-minute prewarm TTL bounds.
   * Tracked as a follow-up; the field exists so the contract is not lost.
   */
  readonly cliBinaryHash?: string;
  readonly cwdCanonical: string;
  readonly providerFormat: string;
  readonly apiHost: string;
  readonly model: string;
  /** Hash of the key — never the key itself (spec §9). */
  readonly authIdentityHash: string;
  readonly apiKeyHeader?: string;
  readonly apiKeyPrefix?: string;
  readonly extraHeadersText?: string;
  readonly permissionLevel: PermissionLevel;
  readonly systemPromptHash: string;
  readonly toolProfileId: string;
  readonly toolProfileRevision: string;
  readonly mcpConfigHash: string;
  readonly permissionSettingsHash: string;
  readonly spawnEnv: Readonly<Record<string, string>>;
  /** Legacy injected argv. Part of the identity because it lands in argv. */
  readonly extraCliArgs: readonly string[];
}

function spawnEnvHash(spawnEnv: Readonly<Record<string, string>>): string {
  const keys = Object.keys(spawnEnv).sort();
  if (keys.length === 0) return '';
  return hashIdentity(keys.map((k) => `${k}=${spawnEnv[k]}`));
}

/**
 * The full runtime identity of a CLI process. Any change to ANY of these
 * forces a fresh spawn at the next safety boundary (spec §9).
 */
export function runtimeFingerprint(input: RuntimeFingerprintInput): string {
  const parts = [
    'v1',
    input.cliBinaryHash ? `bin:${input.cliBinaryHash}` : `path:${canonicalizeCwd(input.cliPath)}`,
    `cwd:${canonicalizeCwd(input.cwdCanonical)}`,
    `fmt:${input.providerFormat || 'anthropic'}`,
    `host:${input.apiHost ?? ''}`,
    `model:${input.model ?? ''}`,
    `auth:${input.authIdentityHash}`,
    `hdr:${input.apiKeyHeader ?? ''}`,
    `pfx:${input.apiKeyPrefix ?? ''}`,
    `xhdr:${hashIdentity([input.extraHeadersText ?? ''])}`,
    `perm:${input.permissionLevel}`,
    `sys:${input.systemPromptHash}`,
    `profile:${input.toolProfileId}@${input.toolProfileRevision}`,
    `mcp:${input.mcpConfigHash}`,
    `settings:${input.permissionSettingsHash}`,
    `env:${spawnEnvHash(input.spawnEnv)}`,
    `args:${JSON.stringify(input.extraCliArgs ?? [])}`,
  ];
  return `fp1:${hashIdentity(parts)}`;
}

/**
 * The pre-existing identity, preserved verbatim so a plain Code run keeps
 * byte-identical warm/prewarm behaviour when no Profile was resolved.
 */
export function legacyFingerprint(extraCliArgs: readonly string[] | undefined): string {
  return `legacy:${JSON.stringify(extraCliArgs ?? [])}`;
}

/**
 * Fingerprint for one run. Falls back to `legacy:` when the tool plane
 * produced no Profile — that fallback is what makes PR-1 incremental
 * instead of a flag-day swap of the Code warm path.
 */
export function fingerprintForRun(input: {
  readonly cliPath: string;
  readonly cwd: string;
  readonly apiKey?: string;
  readonly apiHost?: string;
  readonly apiModel?: string;
  readonly apiFormat?: 'anthropic' | 'openai';
  readonly apiKeyHeader?: string;
  readonly apiKeyPrefix?: string;
  readonly extraHeadersText?: string;
  readonly systemPrompt?: string;
  readonly permissionLevel: PermissionLevel;
  readonly extraCliArgs: readonly string[];
  readonly toolRuntime: ResolvedToolRuntime | null;
  /**
   * Effective spawn env for THIS process (Profile env + TRYLO_TEAM_SURFACE).
   * When omitted, falls back to `toolRuntime.spawnEnv`. A Work degrade
   * with no Profile still has to carry TRYLO_TEAM_SURFACE so it cannot
   * share a Code `legacy:[]` process.
   */
  readonly spawnEnv?: Readonly<Record<string, string>>;
}): string {
  const runtime = input.toolRuntime;
  const spawnEnv = input.spawnEnv ?? runtime?.spawnEnv ?? {};
  if (!runtime) {
    if (Object.keys(spawnEnv).length === 0) return legacyFingerprint(input.extraCliArgs);
    return `legacy:${JSON.stringify(input.extraCliArgs)}:env:${spawnEnvHash(spawnEnv)}`;
  }

  return runtimeFingerprint({
    cliPath: input.cliPath,
    cwdCanonical: input.cwd,
    providerFormat: input.apiFormat ?? 'anthropic',
    apiHost: input.apiHost ?? '',
    model: input.apiModel ?? '',
    // Identity only: the key is hashed and the hash stays in-process.
    authIdentityHash: hashIdentity([input.apiKey ?? '']),
    apiKeyHeader: input.apiKeyHeader,
    apiKeyPrefix: input.apiKeyPrefix,
    extraHeadersText: input.extraHeadersText,
    permissionLevel: input.permissionLevel,
    systemPromptHash: hashIdentity([input.systemPrompt ?? '']),
    toolProfileId: runtime.profileId,
    toolProfileRevision: runtime.profileRevision,
    mcpConfigHash: runtime.mcpConfigHash,
    permissionSettingsHash: runtime.permissionSettingsHash,
    spawnEnv,
    extraCliArgs: input.extraCliArgs,
  });
}
