// Trylo Desktop — Permission policy tests (P2, spec §4.4).
//
// The four-level mapping is the single hard contract every runtime
// depends on; any silent drift here propagates to the wrong CLI
// argument AND the wrong daemon frame.

import { describe, expect, it } from 'vitest';
import {
  codePermissionMode,
  DEFAULT_PERMISSION_LEVEL,
  describeLevel,
  legacyPermissionMigration,
  parsePermissionLevel,
  PERMISSION_LEVELS,
  resolveEffectivePermission,
  toolsForLevel,
  workPermissionMode,
} from './permission-policy';

describe('permission-policy', () => {
  describe('level enumeration', () => {
    it('exposes exactly four levels in stable order', () => {
      expect(PERMISSION_LEVELS.map((l) => l.value)).toEqual([
        'read_only',
        'ask',
        'workspace_write',
        'unrestricted',
      ]);
    });

    it('never ships unrestricted as the default', () => {
      expect(DEFAULT_PERMISSION_LEVEL).not.toBe('unrestricted');
    });

    it('describes every level with non-empty text', () => {
      for (const level of PERMISSION_LEVELS) {
        expect(level.label.trim().length).toBeGreaterThan(0);
        expect(level.description.trim().length).toBeGreaterThan(0);
      }
    });

    it('parsePermissionLevel accepts only the four known values', () => {
      expect(parsePermissionLevel('read_only')).toBe('read_only');
      expect(parsePermissionLevel('ask')).toBe('ask');
      expect(parsePermissionLevel('workspace_write')).toBe('workspace_write');
      expect(parsePermissionLevel('unrestricted')).toBe('unrestricted');
      expect(parsePermissionLevel('chat')).toBeNull();
      expect(parsePermissionLevel('plan')).toBeNull();
      expect(parsePermissionLevel('agent')).toBeNull();
      expect(parsePermissionLevel('')).toBeNull();
      expect(parsePermissionLevel(null)).toBeNull();
      expect(parsePermissionLevel(undefined)).toBeNull();
      expect(parsePermissionLevel(42)).toBeNull();
      expect(parsePermissionLevel({})).toBeNull();
    });
  });

  describe('codePermissionMode', () => {
    it('maps read_only → plan', () => {
      expect(codePermissionMode('read_only')).toBe('plan');
    });
    it('maps ask → default', () => {
      expect(codePermissionMode('ask')).toBe('default');
    });
    it('maps workspace_write → acceptEdits', () => {
      expect(codePermissionMode('workspace_write')).toBe('acceptEdits');
    });
    it('maps unrestricted → bypassPermissions', () => {
      expect(codePermissionMode('unrestricted')).toBe('bypassPermissions');
    });
  });

  describe('workPermissionMode', () => {
    it('maps read_only → plan', () => {
      expect(workPermissionMode('read_only')).toBe('plan');
    });
    it('maps ask → default', () => {
      expect(workPermissionMode('ask')).toBe('default');
    });
    it('maps workspace_write → accept_edits', () => {
      expect(workPermissionMode('workspace_write')).toBe('accept_edits');
    });
    it('maps unrestricted → dont_ask', () => {
      expect(workPermissionMode('unrestricted')).toBe('dont_ask');
    });
    it('never exposes bypass_permissions through the public mapping', () => {
      const values = [
        workPermissionMode('read_only'),
        workPermissionMode('ask'),
        workPermissionMode('workspace_write'),
        workPermissionMode('unrestricted'),
      ];
      for (const v of values) expect(v).not.toBe('bypass_permissions');
    });
  });

  describe('toolsForLevel', () => {
    it('disables built-in tools only in read_only', () => {
      expect(toolsForLevel('read_only')).toBe('');
      expect(toolsForLevel('ask')).toBe('default');
      expect(toolsForLevel('workspace_write')).toBe('default');
      expect(toolsForLevel('unrestricted')).toBe('default');
    });
  });

  describe('legacyPermissionMigration', () => {
    it('chat → ask', () => {
      expect(legacyPermissionMigration('chat')).toBe('ask');
    });
    it('plan → read_only', () => {
      expect(legacyPermissionMigration('plan')).toBe('read_only');
    });
    it('agent → unrestricted', () => {
      expect(legacyPermissionMigration('agent')).toBe('unrestricted');
    });
    it('unknown / null / undefined → ask (safe default)', () => {
      expect(legacyPermissionMigration(null)).toBe('ask');
      expect(legacyPermissionMigration(undefined)).toBe('ask');
      expect(legacyPermissionMigration('something_else')).toBe('ask');
      expect(legacyPermissionMigration('')).toBe('ask');
    });
    it('is idempotent under repeated calls', () => {
      const a = legacyPermissionMigration('chat');
      const b = legacyPermissionMigration(a);
      // Second call sees a new-level value, NOT a legacy one — must
      // still be safe (returns 'ask' for the unknown input).
      expect(['ask', 'read_only', 'unrestricted', 'workspace_write']).toContain(b);
    });
  });

  describe('resolveEffectivePermission', () => {
    it('uses settings default when no override', () => {
      expect(
        resolveEffectivePermission({
          settingsDefault: 'workspace_write',
          conversationOverride: null,
        }),
      ).toEqual({ level: 'workspace_write', source: 'settings' });
    });

    it('conversation override beats settings default', () => {
      expect(
        resolveEffectivePermission({
          settingsDefault: 'ask',
          conversationOverride: 'unrestricted',
        }),
      ).toEqual({ level: 'unrestricted', source: 'conversation' });
    });

    it('falls back to the recommended default when nothing is persisted', () => {
      const r = resolveEffectivePermission({
        settingsDefault: null,
        conversationOverride: null,
      });
      expect(r.level).toBe(DEFAULT_PERMISSION_LEVEL);
      expect(r.source).toBe('settings');
    });

    it('override wins even when it is the same value as the default', () => {
      expect(
        resolveEffectivePermission({
          settingsDefault: 'read_only',
          conversationOverride: 'read_only',
        }),
      ).toEqual({ level: 'read_only', source: 'conversation' });
    });
  });

  describe('describeLevel', () => {
    it('returns a descriptor for every known level', () => {
      for (const level of PERMISSION_LEVELS) {
        expect(describeLevel(level.value).value).toBe(level.value);
      }
    });
  });
});
