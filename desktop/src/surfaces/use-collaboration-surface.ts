import { useCallback, useEffect, useState } from 'react';
import type { CollaborationSurface } from './types';

export interface CollaborationViewScope {
  readonly workspaceKey: string;
  readonly mode: 'code' | 'work';
  readonly conversationId: string | null;
}
export interface CollaborationViewStorage {
  load(): string | null;
  save(raw: string): void;
}

type Choices = ReadonlyMap<string, CollaborationSurface>;
const STORAGE_KEY = 'trylo:collaboration-views:v1';
const browserStorage: CollaborationViewStorage = {
  load: () => typeof window === 'undefined' ? null : window.localStorage.getItem(STORAGE_KEY),
  save: raw => { if (typeof window !== 'undefined') window.localStorage.setItem(STORAGE_KEY, raw); },
};

function loadChoices(storage: CollaborationViewStorage): Choices {
  try {
    const raw = storage.load();
    if (!raw) return new Map();
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null || !('schemaVersion' in parsed)
      || parsed.schemaVersion !== 1 || !('choices' in parsed) || !Array.isArray(parsed.choices)) return new Map();
    const choices = new Map<string, CollaborationSurface>();
    for (const entry of parsed.choices) {
      if (Array.isArray(entry) && entry.length === 2 && typeof entry[0] === 'string'
        && (entry[1] === 'person' || entry[1] === 'team')) choices.set(entry[0], entry[1]);
    }
    return choices;
  } catch {
    // Preferences are best effort; unavailable storage cannot hide task history.
    return new Map();
  }
}

/** Only explicit choices persist. History supplies a default, never a new task. */
export function useCollaborationSurface(scope: CollaborationViewScope, hasTeamHistory: boolean,
  storage: CollaborationViewStorage = browserStorage): readonly [CollaborationSurface, (surface: CollaborationSurface) => void] {
  const key = JSON.stringify([scope.workspaceKey, scope.mode, scope.conversationId]);
  const [state, setState] = useState(() => ({ choices: loadChoices(storage), saveNeeded: false }));
  useEffect(() => {
    if (!state.saveNeeded) return;
    try { storage.save(JSON.stringify({ schemaVersion: 1, choices: [...state.choices] })); }
    catch { /* Keep the in-memory choice when browser storage refuses this preference. */ }
  }, [state, storage]);
  const select = useCallback((surface: CollaborationSurface): void => {
    // Capture this session's key so late callbacks cannot select another chat.
    setState(previous => ({ choices: new Map(previous.choices).set(key, surface), saveNeeded: true }));
  }, [key]);
  return [state.choices.get(key) ?? (hasTeamHistory ? 'team' : 'person'), select];
}
