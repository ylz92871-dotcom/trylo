// Trylo Desktop — Settings store.
//
// v1.15: persistent settings for the Trylo CLI spawn. The
// shape mirrors the legacy `tryloCode` configuration in
// `mini-vscode-agent/extension.js` — see that file's
// `buildConfigFromVscode` + `readConfig` for the upstream
// reference. We port the fields the desktop app actually
// uses; further fields belong in Phase 3.
//
// v1.15.2: vision + summary sub-connection groups added.
// Same shape as the primary group (providerId / apiFormat /
// endpoint / apiKey / model / apiKeyHeader / apiKeyPrefix /
// extraHeadersText + a `usePrimaryConnection` toggle to
// fall back to the primary fields without re-typing them).
//
// v1.16.6: `remote` group added (migration spec §8.1 / arch §7).
// Desktop-side remote gateway knobs: enabled / port / publicUrl /
// tunnelMode / autoStartTunnel / cloudflaredPath. Defaults mirror the
// legacy plugin (`config.get('enabled', false)`) and the vendored
// gateway's default port 49380.
//
// Field map (extension.js → TryloSettings):
//   apiKey              ← context.secrets.get(K.apiKey)
//   apiHost             ← tryloCode.apiHost / endpoint
//   apiModel            ← primaryModel
//   apiFormat           ← 'anthropic' (default) | 'openai'
//   apiKeyHeader        ← apiKeyHeader
//   apiKeyPrefix        ← apiKeyPrefix
//   extraHeadersText    ← extraHeadersText (JSON)
//   providerId          ← providerId
//   systemPrompt        ← storedSystemPrompt
//   permissionMode      ← permissionMode (chat/plan/agent)
//   vision.*            ← visionProviderId, visionModel,
//                          visionEndpoint, visionApiKey,
//                          visionApiKeyHeader, ...
//   summary.*           ← summaryProviderId, summaryModel,
//                          summaryEndpoint, summaryApiKey,
//                          ...
//   cliPath             ← (desktop-only)
//   workspace           ← (desktop-only)
//
// Storage: localStorage under "trylo:settings:v1" for now.
// Phase 3 will move *Key fields to a Rust-side encrypted
// store (keyring / stronghold).

export type ApiFormat = 'anthropic' | 'openai';
/** Legacy permission mode kept only for one-way migration (P2, spec §4.4).
 *  New code must consume `PermissionLevel` from
 *  `../permission/permission-policy.ts`; the picker no longer writes this
 *  field, but `loadSettings` still reads it so an existing user keeps
 *  their old selection when the picker ships. */
export type PermissionMode = 'chat' | 'plan' | 'agent';
/** Re-exported here for convenience — the UI picker and any settings
 *  consumer that needs to know the runtime-native mode imports it from
 *  this module so the type surface stays alongside the persisted
 *  defaults. The mapping itself lives in permission-policy.ts. */
import type { PermissionLevel } from '../permission/permission-policy';
import {
  DEFAULT_LEARNING_INFERENCE,
  DEFAULT_USER_LEARNING_SETTINGS,
  type EnforcementMode,
  type UserLearningSettings,
} from '../user-learning/types';

/** Desktop pet (companion) settings, migration spec §6.5. Effective on
 *  Windows only; other platforms show "unsupported" in the UI. */
export interface CompanionSettings {
  readonly enabled: boolean;
}

/** Remote access (migration spec §8.1, arch §7). Effective on Windows /
 *  Tauri only; the controller reads this group defensively. Defaults mirror
 *  the legacy plugin (`enabled` → `config.get('enabled', false)`). */
export interface RemoteSettings {
  readonly enabled: boolean;
  readonly port: number;
  readonly publicUrl: string;
  readonly tunnelMode: 'named' | 'quick' | 'manual' | 'off';
  readonly autoStartTunnel: boolean;
  readonly cloudflaredPath: string;
}

/** A sub-connection (vision / summary). Mirrors the primary
 *  connection but with a `usePrimaryConnection` shortcut. */
export interface SubConnection {
  readonly usePrimaryConnection: boolean;
  readonly providerId: string;
  readonly apiFormat: ApiFormat;
  readonly endpoint: string;
  readonly apiKey: string;
  readonly model: string;
  readonly apiKeyHeader: string;
  readonly apiKeyPrefix: string;
  readonly extraHeadersText: string;
}

export interface TryloSettings {
  // ── Primary connection ──────────────────────────────────
  readonly apiKey: string;
  readonly apiHost: string;
  readonly apiModel: string;
  /**
   * v-modelsel: active built-in free-compute pool model override
   * ('' = none). Distinct from `apiModel` — the pool override never
   * clobbers the user's own configured model, so switching to the
   * pool and back always restores their model. Effective model for a
   * run = `poolModel || apiModel`.
   */
  readonly poolModel: string;
  readonly apiFormat: ApiFormat;
  readonly apiKeyHeader: string;
  readonly apiKeyPrefix: string;
  readonly extraHeadersText: string;
  readonly providerId: string;
  // ── Behavior ────────────────────────────────────────────
  readonly systemPrompt: string;
  /** Legacy `chat | plan | agent`. Read once at load to seed
   *  `permissionLevel`; the picker no longer writes it. */
  readonly permissionMode: PermissionMode;
  /** P2 (spec §4.4): the UI permission level. Preferred source for the
   *  picker + the runtime args; legacy `permissionMode` is the
   *  one-shot fallback for existing users. */
  readonly permissionLevel: PermissionLevel;
  // ── Sub-connections ─────────────────────────────────────
  readonly vision: SubConnection;
  readonly summary: SubConnection;
  // ── Desktop pet (spec §6.5) ─────────────────────────────
  readonly companion: CompanionSettings;
  // ── Remote access (spec §8.1 / arch §7) ─────────────────
  readonly remote: RemoteSettings;
  // 2026-09-06: `workComputer` retired — desktop control rides the 办公基底
  // unconditionally (per-action §6.6 gates are the enforcement). Old stored
  // values are ignored (same effective tools either way).
  /** PR-7 (spec §4.1/§10.x): explicit 浏览器调试 capability switch. `false`
   *  (the default) keeps the default Work Profile with Playwright. `true`
   *  swaps Playwright OUT for the pinned Chrome DevTools MCP surface
   *  (`work.browser-debug.v1`) — §4.1: the two browser surfaces are never
   *  co-resident, and the model can never pull the debug Profile in by
   *  itself. */
  readonly workBrowserDebug: boolean;
  /** TRYLO-CAD-EDA-TOOL-ADAPTER §4: explicit CAD/EDA capability switch.
   *  `false` (the default) keeps the default Work Profile. `true` upgrades
   *  Work sends to `work.cad.v1`, which carries the six pinned CAD/EDA
   *  adapter surfaces (SolidWorks / AutoCAD / KiCad / 嘉立创EDA / FreeCAD /
   *  Blender) plus windows-mcp (live-window acceptance is part of the CAD
   *  quality bar) and officecli (CAD work ends in acceptance reports/decks)
   *  behind the host classifier — each degraded honestly to
   *  an unavailable capability when its host application is missing.
   *  Highest Work-profile priority (2026-09-06: previously 电脑控制 always
   *  shadowed it, so the CAD adapters were unreachable in practice). */
  readonly workCad: boolean;
  /** TRYLO-DUAL-SURFACE-SPEC §2.4: Hermes learning for the Work surface.
   *  Default `true`. `false` turns Work mirror + review OFF (Code and User
   *  Learning unaffected). NOT a User Learning setting — modelled as its own
   *  top-level flag so the Work task-plane gate can read it independently. */
  readonly hermesWorkLearning: boolean;
  // ── Desktop-only ────────────────────────────────────────
  readonly cliPath: string;
  readonly workspace: string;
  readonly userLearning: UserLearningSettings;
}

const STORAGE_KEY = 'trylo:settings:v1';
const STORAGE_BACKUP_KEY = 'trylo:settings:v1:backup';

const DEFAULTS: TryloSettings = {
  apiKey: '',
  apiHost: '',
  apiModel: '',
  poolModel: '',
  apiFormat: 'anthropic',
  apiKeyHeader: '',
  apiKeyPrefix: '',
  extraHeadersText: '{}',
  providerId: '',
  systemPrompt: '',
  permissionMode: 'agent',
  permissionLevel: 'workspace_write',
  vision: subConnectionDefaults(),
  summary: subConnectionDefaults(),
  companion: { enabled: true },
  remote: remoteSettingsDefaults(),
  workBrowserDebug: false,
  workCad: false,
  hermesWorkLearning: true,
  cliPath: 'C:/trylo-cli/cli.js',
  workspace: 'C:/work/demo-ws',
  userLearning: { ...DEFAULT_USER_LEARNING_SETTINGS },
};

function subConnectionDefaults(): SubConnection {
  return {
    usePrimaryConnection: true,
    providerId: '',
    apiFormat: 'anthropic',
    endpoint: '',
    apiKey: '',
    model: '',
    apiKeyHeader: '',
    apiKeyPrefix: '',
    extraHeadersText: '{}',
  };
}

/** Defaults for the remote group. Exported so callers (Settings UI, tests)
 *  share one source of truth. Mirror the legacy plugin defaults. */
export function remoteSettingsDefaults(): RemoteSettings {
  return {
    enabled: false,
    port: 49380,
    publicUrl: '',
    tunnelMode: 'named',
    autoStartTunnel: true,
    cloudflaredPath: '',
  };
}

const VALID_API_FORMAT: ReadonlySet<ApiFormat> = new Set(['anthropic', 'openai']);
const VALID_PERMISSION_MODE: ReadonlySet<PermissionMode> = new Set([
  'chat',
  'plan',
  'agent',
]);
const VALID_REMOTE_TUNNEL_MODE: ReadonlySet<RemoteSettings['tunnelMode']> = new Set([
  'named',
  'quick',
  'manual',
  'off',
]);

function objectRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null
    ? value as Record<string, unknown>
    : null;
}

function stringValue(value: unknown, fallback: string): string {
  return typeof value === 'string' ? value : fallback;
}

/**
 * Settings are persisted user data, so schema evolution is field-tolerant:
 * one newly added or malformed field must never erase unrelated credentials.
 * Unknown fields are ignored and missing/invalid fields fall back individually.
 */
function migrateSubConnection(value: unknown, fallback: SubConnection): SubConnection {
  const stored = objectRecord(value);
  if (!stored) return { ...fallback };
  return {
    usePrimaryConnection:
      typeof stored['usePrimaryConnection'] === 'boolean'
        ? stored['usePrimaryConnection']
        : fallback.usePrimaryConnection,
    providerId: stringValue(stored['providerId'], fallback.providerId),
    apiFormat: VALID_API_FORMAT.has(stored['apiFormat'] as ApiFormat)
      ? stored['apiFormat'] as ApiFormat
      : fallback.apiFormat,
    endpoint: stringValue(stored['endpoint'], fallback.endpoint),
    apiKey: stringValue(stored['apiKey'], fallback.apiKey),
    model: stringValue(stored['model'], fallback.model),
    apiKeyHeader: stringValue(stored['apiKeyHeader'], fallback.apiKeyHeader),
    apiKeyPrefix: stringValue(stored['apiKeyPrefix'], fallback.apiKeyPrefix),
    extraHeadersText: stringValue(stored['extraHeadersText'], fallback.extraHeadersText),
  };
}

/** Field-tolerant remote group migration (spec §8.1). A malformed remote
 *  block must never erase unrelated credentials — each field falls back
 *  individually. */
function migrateRemoteSettings(value: unknown, fallback: RemoteSettings): RemoteSettings {
  const stored = objectRecord(value);
  if (!stored) return { ...fallback };
  return {
    enabled:
      typeof stored['enabled'] === 'boolean'
        ? stored['enabled']
        : fallback.enabled,
    port:
      typeof stored['port'] === 'number' && Number.isFinite(stored['port']) && stored['port'] > 0
        ? stored['port']
        : fallback.port,
    publicUrl: stringValue(stored['publicUrl'], fallback.publicUrl),
    tunnelMode: VALID_REMOTE_TUNNEL_MODE.has(stored['tunnelMode'] as RemoteSettings['tunnelMode'])
      ? stored['tunnelMode'] as RemoteSettings['tunnelMode']
      : fallback.tunnelMode,
    autoStartTunnel:
      typeof stored['autoStartTunnel'] === 'boolean'
        ? stored['autoStartTunnel']
        : fallback.autoStartTunnel,
    cloudflaredPath: stringValue(stored['cloudflaredPath'], fallback.cloudflaredPath),
  };
}

function migrateSettings(value: unknown): TryloSettings | null {
  const stored = objectRecord(value);
  if (!stored) return null;
  const companion = objectRecord(stored['companion']);
  // P2: prefer the new `permissionLevel`; fall back to a one-shot
  // migration of the legacy `permissionMode` (chat/plan/agent). The
  // legacy field is still accepted on read so a downgrade is not
  // destructive; the picker does NOT write it.
  //
  // When the user has never set EITHER field, return the
  // recommended default (`workspace_write`) — NOT the
  // migration of the legacy default, which would land on
  // `unrestricted`. The legacy default `agent` is a hostile
  // choice for a new user; the migration is a one-shot read
  // helper, not a way to set the default.
  const hasLegacy = 'permissionMode' in stored
    && VALID_PERMISSION_MODE.has(stored['permissionMode'] as PermissionMode);
  const hasNew = 'permissionLevel' in stored
    && parsePermissionLevel(stored['permissionLevel']) !== null;
  const legacyMode = hasLegacy
    ? (stored['permissionMode'] as PermissionMode)
    : null;
  let resolvedLevel: PermissionLevel;
  if (hasNew) {
    resolvedLevel = parsePermissionLevel(stored['permissionLevel'])!;
  } else if (hasLegacy) {
    resolvedLevel = legacyPermissionMigration(legacyMode!);
  } else {
    resolvedLevel = DEFAULT_PERMISSION_LEVEL;
  }
  return {
    apiKey: stringValue(stored['apiKey'], DEFAULTS.apiKey),
    apiHost: stringValue(stored['apiHost'], DEFAULTS.apiHost),
    apiModel: stringValue(stored['apiModel'], DEFAULTS.apiModel),
    poolModel: stringValue(stored['poolModel'], DEFAULTS.poolModel),
    apiFormat: VALID_API_FORMAT.has(stored['apiFormat'] as ApiFormat)
      ? stored['apiFormat'] as ApiFormat
      : DEFAULTS.apiFormat,
    apiKeyHeader: stringValue(stored['apiKeyHeader'], DEFAULTS.apiKeyHeader),
    apiKeyPrefix: stringValue(stored['apiKeyPrefix'], DEFAULTS.apiKeyPrefix),
    extraHeadersText: stringValue(stored['extraHeadersText'], DEFAULTS.extraHeadersText),
    providerId: stringValue(stored['providerId'], DEFAULTS.providerId),
    systemPrompt: stringValue(stored['systemPrompt'], DEFAULTS.systemPrompt),
    // Legacy field: read verbatim (so the round-trip is lossless),
    // but the picker never writes it.
    permissionMode: hasLegacy ? legacyMode! : DEFAULTS.permissionMode,
    permissionLevel: resolvedLevel,
    vision: migrateSubConnection(stored['vision'], DEFAULTS.vision),
    summary: migrateSubConnection(stored['summary'], DEFAULTS.summary),
    companion: {
      enabled:
        typeof companion?.['enabled'] === 'boolean'
          ? companion['enabled']
          : DEFAULTS.companion.enabled,
    },
    remote: migrateRemoteSettings(stored['remote'], DEFAULTS.remote),
    // Retired 2026-09-06: stored workComputer ignored (base carries it).
    workBrowserDebug: stored['workBrowserDebug'] === true,
    workCad: stored['workCad'] === true,
    // Whitelist: absent (= never persisted) ⇒ default `true`; an explicit
    // `false` persists the user's opt-out (spec §2.4).
    hermesWorkLearning: stored['hermesWorkLearning'] !== false,
    cliPath: stringValue(stored['cliPath'], DEFAULTS.cliPath),
    workspace: stringValue(stored['workspace'], DEFAULTS.workspace),
    userLearning: migrateUserLearning(stored['userLearning'], DEFAULTS.userLearning),
  };
}

const VALID_ENFORCEMENT: ReadonlySet<EnforcementMode> = new Set(['shadow', 'enforced', 'off']);

function migrateUserLearning(value: unknown, fallback: UserLearningSettings): UserLearningSettings {
  const stored = objectRecord(value);
  if (!stored) return { ...fallback, dimensionMode: { ...fallback.dimensionMode } };
  const mode = stored['defaultMode'];
  return {
    enabled: typeof stored['enabled'] === 'boolean' ? stored['enabled'] : fallback.enabled,
    defaultMode: VALID_ENFORCEMENT.has(mode as EnforcementMode) ? mode as EnforcementMode : fallback.defaultMode,
    dimensionMode: isObject(stored['dimensionMode'])
      ? { ...fallback.dimensionMode, ...(stored['dimensionMode'] as UserLearningSettings['dimensionMode']) }
      : { ...fallback.dimensionMode },
    cognitionEnabled: typeof stored['cognitionEnabled'] === 'boolean'
      ? stored['cognitionEnabled']
      : fallback.cognitionEnabled,
    inference: isObject(stored['inference'])
      ? { ...DEFAULT_LEARNING_INFERENCE, ...fallback.inference, ...(stored['inference'] as Partial<typeof DEFAULT_LEARNING_INFERENCE>) }
      : (fallback.inference ?? DEFAULT_LEARNING_INFERENCE),
    teamAccessEnabled: typeof stored['teamAccessEnabled'] === 'boolean'
      ? stored['teamAccessEnabled']
      : (fallback.teamAccessEnabled ?? false),
    // Foundation spec §9.4 / Pitfall 27: must be whitelisted here or the
    // user's toggle is silently dropped on every migrate.
    teamComposerEnabled: typeof stored['teamComposerEnabled'] === 'boolean'
      ? stored['teamComposerEnabled']
      : (fallback.teamComposerEnabled ?? false),
  };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function parseStoredSettings(raw: string | null): TryloSettings | null {
  if (!raw) return null;
  try {
    return migrateSettings(JSON.parse(raw) as unknown);
  } catch {
    return null;
  }
}

export function loadSettings(): TryloSettings {
  if (typeof window === 'undefined') return DEFAULTS;
  const primary = parseStoredSettings(window.localStorage.getItem(STORAGE_KEY));
  if (primary) return primary;
  // A malformed/partially-written primary must not strand the user. The
  // backup is the last parseable value captured before a successful save.
  return parseStoredSettings(window.localStorage.getItem(STORAGE_BACKUP_KEY)) ?? DEFAULTS;
}

export function saveSettings(s: TryloSettings): void {
  if (typeof window === 'undefined') return;
  try {
    const previousRaw = window.localStorage.getItem(STORAGE_KEY);
    if (parseStoredSettings(previousRaw)) {
      window.localStorage.setItem(STORAGE_BACKUP_KEY, previousRaw!);
    }
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(s));
  } catch {
    // Quota exceeded or private mode — ignore.
  }
}

export const settingsDefaults = DEFAULTS;

import {
  codePermissionMode,
  DEFAULT_PERMISSION_LEVEL,
  legacyPermissionMigration,
  parsePermissionLevel,
  toolsForLevel,
} from '../permission/permission-policy';

/**
 * Map the UI `PermissionLevel` to the CLI's `--permission-mode` value.
 * The picker no longer drives this directly — `App.onSend` resolves the
 * effective level once and snapshots it onto the run, but the run
 * pipeline still funnels through this single function so the CLI argv
 * stays consistent across the legacy and the new picker.
 */
export function permissionModeForCli(level: PermissionLevel): string {
  return codePermissionMode(level);
}

/** What to pass `--tools` as. Read-only level disables built-in tools. */
export function toolsForMode(level: PermissionLevel): string {
  return toolsForLevel(level);
}

/** Backwards-compatible helper for any code still passing a legacy
 *  `chat | plan | agent` shape through the old call sites. Routes
 *  through the same migration used at load time. */
export function legacyPermissionModeForCli(mode: PermissionMode): string {
  return codePermissionMode(legacyPermissionMigration(mode));
}
