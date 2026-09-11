// Trylo Desktop — ResultDockPrefsStore tests (C-Edge P2-4).
//
// Pins the contract: prefs are independent per (surface, projectKey,
// conversationId); Code and Work never share; deletion clears.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ResultDockPrefsStore,
  resultDockKeyToString,
  type ResultDockKey,
} from './result-dock-prefs';

const KEY_A: ResultDockKey = { surface: 'code', projectKey: 'P', conversationId: 'C1' };
const KEY_B: ResultDockKey = { surface: 'code', projectKey: 'P', conversationId: 'C2' };
const KEY_WORK: ResultDockKey = { surface: 'work', projectKey: 'P', conversationId: 'C1' };
const KEY_OTHER: ResultDockKey = { surface: 'code', projectKey: 'Q', conversationId: 'C1' };

let store: ResultDockPrefsStore;
let now = 1_000;

beforeEach(() => {
  store = new ResultDockPrefsStore();
  now = 1_000;
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe('ResultDockPrefsStore — get / set', () => {
  it('returns the fallback when no record exists', () => {
    expect(store.getOpen(KEY_A, true)).toBe(true);
    expect(store.getOpen(KEY_A, false)).toBe(false);
  });

  it('stores and reads back the open flag', () => {
    store.setOpen(KEY_A, false, now);
    expect(store.getOpen(KEY_A, true)).toBe(false);
    const prefs = store.get(KEY_A);
    expect(prefs?.open).toBe(false);
    expect(prefs?.lastUpdatedAt).toBe(now);
  });

  it('records lastUpdatedAt on each change', () => {
    store.setOpen(KEY_A, true, 1_000);
    store.setOpen(KEY_A, false, 1_500);
    expect(store.get(KEY_A)?.lastUpdatedAt).toBe(1_500);
  });

  it('is a no-op when setting the same value', () => {
    const listener = vi.fn();
    store.setOpen(KEY_A, true, 1_000);
    store.subscribeKey(KEY_A, listener);
    store.setOpen(KEY_A, true, 1_500);
    expect(listener).not.toHaveBeenCalled();
  });
});

describe('ResultDockPrefsStore — isolation by key', () => {
  it('Code and Work of the same conversation do not share state', () => {
    store.setOpen(KEY_A, false, now);
    store.setOpen(KEY_WORK, true, now);
    expect(store.getOpen(KEY_A, true)).toBe(false);
    expect(store.getOpen(KEY_WORK, false)).toBe(true);
  });

  it('different conversations in the same project do not share state', () => {
    store.setOpen(KEY_A, false, now);
    store.setOpen(KEY_B, true, now);
    expect(store.getOpen(KEY_A, true)).toBe(false);
    expect(store.getOpen(KEY_B, false)).toBe(true);
  });

  it('different projects do not share state', () => {
    store.setOpen(KEY_A, false, now);
    store.setOpen(KEY_OTHER, true, now);
    expect(store.getOpen(KEY_A, true)).toBe(false);
    expect(store.getOpen(KEY_OTHER, false)).toBe(true);
  });
});

describe('ResultDockPrefsStore — clearConversation / clearProject', () => {
  it('clearConversation drops only the targeted entry', () => {
    store.setOpen(KEY_A, false, now);
    store.setOpen(KEY_B, true, now);
    store.setOpen(KEY_WORK, true, now);
    store.clearConversation(KEY_A);
    expect(store.get(KEY_A)).toBeUndefined();
    expect(store.get(KEY_B)?.open).toBe(true);
    expect(store.get(KEY_WORK)?.open).toBe(true);
  });

  it('clearProject drops every entry for that project, both surfaces', () => {
    store.setOpen(KEY_A, false, now);
    store.setOpen(KEY_B, true, now);
    store.setOpen(KEY_WORK, true, now);
    store.setOpen(KEY_OTHER, true, now);
    store.clearProject('P');
    expect(store.get(KEY_A)).toBeUndefined();
    expect(store.get(KEY_B)).toBeUndefined();
    expect(store.get(KEY_WORK)).toBeUndefined();
    expect(store.get(KEY_OTHER)?.open).toBe(true);
  });

  it('clearConversation on a missing key is a no-op', () => {
    const listener = vi.fn();
    store.subscribeKey(KEY_A, listener);
    store.clearConversation(KEY_A);
    expect(listener).not.toHaveBeenCalled();
  });
});

describe('ResultDockPrefsStore — subscription', () => {
  it('notifies subscribers on setOpen', () => {
    const listener = vi.fn();
    store.subscribeKey(KEY_A, listener);
    store.setOpen(KEY_A, false, now);
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('does not notify unrelated keys', () => {
    const a = vi.fn();
    const b = vi.fn();
    store.subscribeKey(KEY_A, a);
    store.subscribeKey(KEY_B, b);
    store.setOpen(KEY_A, false, now);
    expect(a).toHaveBeenCalledTimes(1);
    expect(b).not.toHaveBeenCalled();
  });

  it('unsubscribe stops further notifications', () => {
    const a = vi.fn();
    const off = store.subscribeKey(KEY_A, a);
    off();
    store.setOpen(KEY_A, false, now);
    expect(a).not.toHaveBeenCalled();
  });

  it('a throwing listener does not poison the store', () => {
    const bad = vi.fn(() => {
      throw new Error('boom');
    });
    const good = vi.fn();
    store.subscribeKey(KEY_A, bad);
    store.subscribeKey(KEY_A, good);
    store.setOpen(KEY_A, false, now);
    expect(bad).toHaveBeenCalled();
    expect(good).toHaveBeenCalled();
  });
});

describe('ResultDockPrefsStore — key encoding', () => {
  it('different keys with the same string repr do not collide', () => {
    // sanity: the encoding is `(surface|projectKey|conversationId)` so
    // a 'work' surface cannot accidentally read the 'code' surface's
    // record.
    expect(resultDockKeyToString(KEY_A)).toBe('code|P|C1');
    expect(resultDockKeyToString(KEY_WORK)).toBe('work|P|C1');
    expect(resultDockKeyToString(KEY_A)).not.toBe(resultDockKeyToString(KEY_WORK));
  });
});
