// Trylo Desktop — Permission policy (P2, spec §4.4).
//
// The single source of truth for the permission LEVEL UI model and its
// mapping into the two runtimes' native permission modes.
//
// What lives here, and ONLY here:
//   1. The `PermissionLevel` UI type (four levels, no runtime jargon).
//   2. The native-mode mapping for Code (`--permission-mode`).
//   3. The native-mode mapping for Work (`task.create.permissionMode`).
//   4. The EffectivePermission resolver (settings default + conversation
//      override).
//   5. The legacy `chat | plan | agent` value migration.
//
// The hard rule from the spec: no other file is allowed to write a
// `level → native mode` switch. The CLI tools, the Work daemon, the
// InputBar, the SettingsModal, the App — all of them go through this
// module. Drift across copies is what caused the original "settings
// permission is in `agent` but the chip is in `plan`" confusion.

/** The UI permission level. Stable identity; persistable in localStorage. */
export type PermissionLevel =
  | 'read_only'
  | 'ask'
  | 'workspace_write'
  | 'unrestricted';

/** The legacy `chat | plan | agent` shape — accepted by the picker ONLY
 *  as a one-way read during migration. Never written. */
export type LegacyPermissionMode = 'chat' | 'plan' | 'agent';

/** Code CLI's `--permission-mode` enum (clap-style kebab in argv, but the
 *  values are stable identifiers). */
export type CodePermissionMode =
  | 'plan'
  | 'default'
  | 'acceptEdits'
  | 'bypassPermissions';

/** Work daemon's `task.create.permissionMode` enum. The `bypass_permissions`
 *  value exists upstream but is NOT exposed to the UI — it is reserved
 *  for the internal dev switch and must never surface in the picker. */
export type WorkPermissionMode =
  | 'plan'
  | 'default'
  | 'accept_edits'
  | 'dont_ask';

export interface EffectivePermission {
  readonly level: PermissionLevel;
  /** Where the resolved value came from. The picker uses this to show
   *  "来源：当前会话" vs "来源：设置默认". */
  readonly source: 'settings' | 'conversation';
}

export interface PermissionLevelDescriptor {
  readonly value: PermissionLevel;
  readonly label: string;
  readonly shortLabel: string;
  readonly description: string;
  readonly hint: string;
  /** Visual risk band — used to color the chip + order the menu. */
  readonly risk: 'safe' | 'balanced' | 'recommended' | 'high';
}

export const PERMISSION_LEVELS: readonly PermissionLevelDescriptor[] = [
  {
    value: 'read_only',
    label: '只读',
    shortLabel: '只读',
    description: '只读 — 可分析和读取，禁止修改与外部副作用',
    hint: '可读取、不可写、不可执行',
    risk: 'safe',
  },
  {
    value: 'ask',
    label: '每次审批',
    shortLabel: '审批',
    description: '每次审批 — 写入、命令、外部操作需要确认',
    hint: '危险操作前询问',
    risk: 'balanced',
  },
  {
    value: 'workspace_write',
    label: '自动编辑（推荐）',
    shortLabel: '自动',
    description: '自动编辑（推荐） — 工作区内读写自动，命令/删除/外部仍审批',
    hint: '工作区内自动，外部仍审批',
    risk: 'recommended',
  },
  {
    value: 'unrestricted',
    label: '完全自动',
    shortLabel: '完全',
    description: '完全自动 — 尽量自动执行（高风险）',
    hint: '高风险，不再询问',
    risk: 'high',
  },
] as const;

const LEVEL_INDEX: Readonly<Record<PermissionLevel, PermissionLevelDescriptor>> =
  PERMISSION_LEVELS.reduce(
    (acc, desc) => {
      acc[desc.value] = desc;
      return acc;
    },
    {} as Record<PermissionLevel, PermissionLevelDescriptor>,
  );

export function describeLevel(level: PermissionLevel): PermissionLevelDescriptor {
  return LEVEL_INDEX[level];
}

const VALID_LEVELS: ReadonlySet<PermissionLevel> = new Set([
  'read_only',
  'ask',
  'workspace_write',
  'unrestricted',
]);

/** Defensive read of a persisted level value. Unknown / missing values
 *  return `null` so callers can decide on a fallback (e.g. the resolver
 *  falls back to `ask` for safety, the migration resolves to the
 *  legacy value). */
export function parsePermissionLevel(value: unknown): PermissionLevel | null {
  return typeof value === 'string' && VALID_LEVELS.has(value as PermissionLevel)
    ? (value as PermissionLevel)
    : null;
}

/** The recommended default for a new user. The spec is explicit: NEVER
 *  ship `unrestricted` as the new-user default. */
export const DEFAULT_PERMISSION_LEVEL: PermissionLevel = 'workspace_write';

/** Map UI level → Code CLI `--permission-mode` value. */
export function codePermissionMode(level: PermissionLevel): CodePermissionMode {
  switch (level) {
    case 'read_only':
      return 'plan';
    case 'ask':
      return 'default';
    case 'workspace_write':
      return 'acceptEdits';
    case 'unrestricted':
      return 'bypassPermissions';
  }
}

/** Map UI level → Work daemon `permissionMode` value. `bypass_permissions`
 *  is intentionally not in this surface. */
export function workPermissionMode(level: PermissionLevel): WorkPermissionMode {
  switch (level) {
    case 'read_only':
      return 'plan';
    case 'ask':
      return 'default';
    case 'workspace_write':
      return 'accept_edits';
    case 'unrestricted':
      return 'dont_ask';
  }
}

/** What to pass `--tools` as. Read-only level disables built-in tools
 *  (mirrors the legacy `plan` behavior); all other levels keep the
 *  default toolset. */
export function toolsForLevel(level: PermissionLevel): string {
  return level === 'read_only' ? '' : 'default';
}

/**
 * Migrate a legacy `chat | plan | agent` value to the new level. Unknown
 * legacy values fall back to `ask` — safe and conservative, never
 * `unrestricted`. The migration is total: every legacy value maps to
 * exactly one new value, and re-running it is idempotent (legacy is
 * not consumed by the resolver).
 */
export function legacyPermissionMigration(
  legacy: LegacyPermissionMode | string | null | undefined,
): PermissionLevel {
  switch (legacy) {
    case 'chat':
      return 'ask';
    case 'plan':
      return 'read_only';
    case 'agent':
      return 'unrestricted';
    default:
      return 'ask';
  }
}

export interface ResolvePermissionInput {
  /** Persisted global default (settings). */
  readonly settingsDefault: PermissionLevel | null;
  /** Per-conversation override; `null` means "no override, use settings". */
  readonly conversationOverride: PermissionLevel | null;
}

/**
 * Resolve the effective permission for a turn: conversation override
 * wins over settings default. The source is reported so the UI can
 * label "来源：当前会话" / "来源：设置默认" without re-deriving.
 */
export function resolveEffectivePermission(
  input: ResolvePermissionInput,
): EffectivePermission {
  if (input.conversationOverride !== null) {
    return { level: input.conversationOverride, source: 'conversation' };
  }
  if (input.settingsDefault !== null) {
    return { level: input.settingsDefault, source: 'settings' };
  }
  // No persisted value at all → recommended default, treated as
  // settings source (the user has not chosen anything yet).
  return { level: DEFAULT_PERMISSION_LEVEL, source: 'settings' };
}
