// Trylo Desktop — Per-conversation model choice store.
//
// Model selection lives globally in `TryloSettings` (settings.apiModel /
// settings.poolModel / settings.activeModelProfileId). However the user
// wants DIFFERENT conversations to be able to use DIFFERENT models. This
// module adds a thin per-conversation override: a conversation can remember
// which of the three model sources it is using (own configured model / a
// built-in pool model / a saved connection profile).
//
// Design decisions:
// - We only remember the *choice* (a lightweight discriminated union), NOT a
//   full connection snapshot. The actual connection (key/host/model/headers)
//   still comes from the live `TryloSettings` + `modelProfiles` + built-in
//   pool at run time. This matches the "lightweight" approach.
// - `resolveRunConnection` expands a choice into the concrete connection the
//   CLI should be spawned with. A choice of `own` (or no saved choice for a
//   conversation) falls back to the global settings — identical to today.
// - Storage shape is `Record<workspaceKey, Record<conversationId, Choice>>`.
//   Migration is field-tolerant (malformed entries are dropped, never fatal).

import {
  connectionFields,
  type ModelProfile,
  type TryloSettings,
} from './settings-store';

/** A conversation's remembered model source. */
export type ConversationModelChoice =
  /** Use the user's own configured model (settings.apiModel). */
  | { readonly kind: 'own' }
  /** Use a built-in free-compute pool model (settings.poolModel). */
  | { readonly kind: 'pool'; readonly model: string }
  /** Use a saved connection profile (settings.modelProfiles[id]). */
  | { readonly kind: 'profile'; readonly id: string };

export type ConversationModelMap = Readonly<
  Record<string, Readonly<Record<string, ConversationModelChoice>>>
>;

const STORAGE_KEY = 'trylo:conversation-models:v1';
const EMPTY: ConversationModelMap = {};

export function conversationModelKey(workspaceKey: string, conversationId: string): string {
  return `${workspaceKey}::${conversationId}`;
}

/** Look up a conversation's remembered choice (undefined = none → global). */
export function getConversationChoice(
  map: ConversationModelMap,
  workspaceKey: string,
  conversationId: string,
): ConversationModelChoice | undefined {
  return map[workspaceKey]?.[conversationId];
}

/** Return a new map with `choice` set for the given conversation. */
export function setConversationChoice(
  map: ConversationModelMap,
  workspaceKey: string,
  conversationId: string,
  choice: ConversationModelChoice,
): ConversationModelMap {
  return {
    ...map,
    [workspaceKey]: {
      ...(map[workspaceKey] ?? {}),
      [conversationId]: choice,
    },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function migrateChoice(value: unknown): ConversationModelChoice | null {
  if (!isRecord(value)) return null;
  if (value['kind'] === 'own') return { kind: 'own' };
  if (value['kind'] === 'pool' && typeof value['model'] === 'string') {
    return { kind: 'pool', model: value['model'] };
  }
  if (value['kind'] === 'profile' && typeof value['id'] === 'string') {
    return { kind: 'profile', id: value['id'] };
  }
  return null;
}

function migrate(raw: string | null): ConversationModelMap {
  if (!raw) return EMPTY;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    return EMPTY;
  }
  if (!isRecord(parsed)) return EMPTY;
  const out: Record<string, Record<string, ConversationModelChoice>> = {};
  for (const [wsKey, convs] of Object.entries(parsed)) {
    if (!isRecord(convs)) continue;
    const convOut: Record<string, ConversationModelChoice> = {};
    for (const [convId, choice] of Object.entries(convs)) {
      const migrated = migrateChoice(choice);
      if (migrated) convOut[convId] = migrated;
    }
    if (Object.keys(convOut).length > 0) out[wsKey] = convOut;
  }
  return out;
}

export function loadConversationModels(): ConversationModelMap {
  if (typeof window === 'undefined') return EMPTY;
  return migrate(window.localStorage.getItem(STORAGE_KEY));
}

export function saveConversationModels(map: ConversationModelMap): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(map));
  } catch {
    // Quota exceeded or private mode — ignore.
  }
}

/** The minimal connection subset the CLI spawn reads from settings. */
export type RunConnection = Pick<
  TryloSettings,
  'apiKey' | 'apiHost' | 'apiModel' | 'apiFormat' | 'apiKeyHeader' | 'apiKeyPrefix' | 'extraHeadersText'
>;

/**
 * Expand a conversation's model choice into the concrete connection to spawn
 * with. Falls back to the global settings for `own` / no-choice / missing
 * profile id — identical to current (global) behaviour.
 */
export function resolveRunConnection(
  settings: TryloSettings,
  workspaceKey: string,
  conversationId: string,
  conversationModels: ConversationModelMap = EMPTY,
): RunConnection {
  const choice = getConversationChoice(conversationModels, workspaceKey, conversationId);
  return resolveChoiceToConnection(settings, choice);
}

/** Expand a single choice (exposed for tests / reuse). */
export function resolveChoiceToConnection(
  settings: TryloSettings,
  choice: ConversationModelChoice | undefined,
): RunConnection {
  if (choice?.kind === 'pool') {
    return { ...connectionFields(settings), apiModel: choice.model };
  }
  if (choice?.kind === 'profile') {
    const profile = settings.modelProfiles.find((p) => p.id === choice.id);
    if (profile) return connectionFields(profile);
    return connectionFields(settings);
  }
  // own / none
  return connectionFields(settings);
}

/** Convenience: the effective model id for a conversation (context window etc.). */
export function effectiveModelForConversation(
  settings: TryloSettings,
  workspaceKey: string,
  conversationId: string,
  conversationModels: ConversationModelMap = EMPTY,
): string {
  return resolveRunConnection(settings, workspaceKey, conversationId, conversationModels).apiModel;
}

export type { ModelProfile };