// Trylo Desktop — settings-store unit tests. See
// v1.15-handoff §3.1.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  applyProfile,
  connectionFields,
  createProfileId,
  loadSettings,
  removeProfile,
  remoteSettingsDefaults,
  saveSettings,
  settingsDefaults,
  upsertProfile,
  type ModelProfile,
  type TryloSettings,
} from './settings-store';

const SAMPLE: TryloSettings = {
  apiKey: 'sk-ant-test-1',
  apiHost: 'https://api.example.com',
  apiModel: 'claude-3-5-sonnet-latest',
  // v-modelsel: no built-in pool override by default.
  poolModel: '',
  modelProfiles: [],
  activeModelProfileId: '',
  apiFormat: 'anthropic',
  apiKeyHeader: '',
  apiKeyPrefix: '',
  extraHeadersText: '{}',
  providerId: '',
  systemPrompt: '',
  permissionMode: 'agent',
  // P2: the new field is required; tests keep the legacy
  // value here so the migration logic stays exercised.
  permissionLevel: 'workspace_write',
  vision: {
    usePrimaryConnection: true,
    providerId: '',
    apiFormat: 'anthropic',
    endpoint: '',
    apiKey: '',
    model: '',
    apiKeyHeader: '',
    apiKeyPrefix: '',
    extraHeadersText: '{}',
  },
  summary: {
    usePrimaryConnection: true,
    providerId: '',
    apiFormat: 'anthropic',
    endpoint: '',
    apiKey: '',
    model: '',
    apiKeyHeader: '',
    apiKeyPrefix: '',
    extraHeadersText: '{}',
  },
  companion: { enabled: true },
  remote: {
    enabled: true,
    port: 49999,
    publicUrl: 'https://trylo.example.dev',
    tunnelMode: 'quick',
    autoStartTunnel: false,
    cloudflaredPath: 'D:/cloudflared/cloudflared.exe',
  },
  workBrowserDebug: true,
  workComputer: true,
  workCad: true,
  // TRYLO-DUAL-SURFACE-SPEC §2.4: default `true`; tests may flip it.
  hermesWorkLearning: true,
  cliPath: 'D:/custom/cli.js',
  workspace: 'D:/proj',
  userLearning: {
    enabled: true,
    defaultMode: 'shadow',
    dimensionMode: {},
    cognitionEnabled: true,
    inference: {
      mode: 'deterministic',
      enabled: false,
      allowExecutionContext: false,
      maxCallsPerHour: 12,
      maxCallsPerTrace: 0,
    },
    teamAccessEnabled: false,
    teamComposerEnabled: false,
    userLearningV2Coordinator: true,
    userLearningBehaviorCommitments: true,
    userLearningReceipts: true,
    userLearningOutcomeEvaluation: true,
    userLearningNoTraceMode: true,
  },
};

describe('settings-store', () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  afterEach(() => {
    window.localStorage.clear();
  });

  it('returns defaults when storage is empty', () => {
    const s = loadSettings();
    expect(s).toEqual(settingsDefaults);
  });

  it('migrateUserLearning whitelists teamComposerEnabled (Foundation spec §9.4 / Pitfall 27)', () => {
    saveSettings({
      ...SAMPLE,
      userLearning: { ...SAMPLE.userLearning, teamAccessEnabled: true, teamComposerEnabled: true },
    });
    const loaded = loadSettings();
    expect(loaded.userLearning.teamAccessEnabled).toBe(true);
    expect(loaded.userLearning.teamComposerEnabled).toBe(true);
  });

  it('materializes and round-trips every User Learning v0.2 rollback switch', () => {
    const legacy = JSON.parse(JSON.stringify(SAMPLE)) as Record<string, unknown>;
    const legacyLearning = legacy.userLearning as Record<string, unknown>;
    delete legacyLearning.userLearningV2Coordinator;
    delete legacyLearning.userLearningBehaviorCommitments;
    delete legacyLearning.userLearningReceipts;
    delete legacyLearning.userLearningOutcomeEvaluation;
    delete legacyLearning.userLearningNoTraceMode;
    window.localStorage.setItem('trylo:settings:v1', JSON.stringify(legacy));
    expect(loadSettings().userLearning).toEqual(expect.objectContaining({
      userLearningV2Coordinator: true,
      userLearningBehaviorCommitments: true,
      userLearningReceipts: true,
      userLearningOutcomeEvaluation: true,
      userLearningNoTraceMode: true,
    }));

    saveSettings({
      ...SAMPLE,
      userLearning: {
        ...SAMPLE.userLearning,
        userLearningV2Coordinator: false,
        userLearningBehaviorCommitments: false,
        userLearningReceipts: false,
        userLearningOutcomeEvaluation: false,
        userLearningNoTraceMode: false,
      },
    });
    expect(loadSettings().userLearning).toEqual(expect.objectContaining({
      userLearningV2Coordinator: false,
      userLearningBehaviorCommitments: false,
      userLearningReceipts: false,
      userLearningOutcomeEvaluation: false,
      userLearningNoTraceMode: false,
    }));
  });

  it('round-trips a saved value', () => {
    saveSettings(SAMPLE);
    const s = loadSettings();
    expect(s).toEqual(SAMPLE);
  });

  it('loads pre-Phase-2 settings (no companion field) with the default companion', () => {
    // Regression (2026-08-28): strictly requiring `companion` discarded
    // every existing user's settings on upgrade.
    const legacy: Record<string, unknown> = { ...SAMPLE };
    delete legacy['companion'];
    saveSettings(legacy as unknown as TryloSettings);
    const s = loadSettings();
    expect(s.companion.enabled).toBe(true);
    expect(s.apiKey).toBe(SAMPLE.apiKey);
    expect(s.cliPath).toBe(SAMPLE.cliPath);
  });

  it('preserves valid credentials when unrelated stored fields are missing or malformed', () => {
    window.localStorage.setItem('trylo:settings:v1', JSON.stringify({
      apiKey: SAMPLE.apiKey,
      apiHost: SAMPLE.apiHost,
      apiFormat: 'future-format',
      vision: { apiKey: 'vision-key' },
    }));

    const s = loadSettings();
    expect(s.apiKey).toBe(SAMPLE.apiKey);
    expect(s.apiHost).toBe(SAMPLE.apiHost);
    expect(s.apiFormat).toBe(settingsDefaults.apiFormat);
    expect(s.vision.apiKey).toBe('vision-key');
    expect(s.vision.usePrimaryConnection).toBe(true);
    expect(s.companion.enabled).toBe(true);
  });

  it('preserves partial overrides (the rest falls back to defaults)', () => {
    // Saving only apiKey and reading back should still
    // surface the default cliPath, apiHost, etc.
    saveSettings({ ...settingsDefaults, apiKey: 'only-key' });
    const s = loadSettings();
    expect(s.apiKey).toBe('only-key');
    expect(s.cliPath).toBe(settingsDefaults.cliPath);
    expect(s.apiHost).toBe('');
  });

  it('falls back to defaults when stored JSON is invalid', () => {
    window.localStorage.setItem('trylo:settings:v1', '{ not json');
    const s = loadSettings();
    expect(s).toEqual(settingsDefaults);
  });

  it('falls back to defaults when stored shape is wrong', () => {
    window.localStorage.setItem('trylo:settings:v1', JSON.stringify({ nope: 1 }));
    const s = loadSettings();
    expect(s).toEqual(settingsDefaults);
  });

  it('overwrites the previous value on subsequent saves', () => {
    saveSettings({ ...SAMPLE, apiKey: 'first' });
    saveSettings({ ...SAMPLE, apiKey: 'second' });
    expect(loadSettings().apiKey).toBe('second');
  });

  it('keeps the last parseable value as a recovery backup', () => {
    saveSettings({ ...SAMPLE, apiKey: 'recover-me' });
    saveSettings({ ...SAMPLE, apiKey: 'current' });
    window.localStorage.setItem('trylo:settings:v1', '{ interrupted write');

    expect(loadSettings().apiKey).toBe('recover-me');
  });

  it('hermesWorkLearning defaults ON and persists an explicit OFF (spec §2.4)', () => {
    // Absent field ⇒ default `true`.
    const on = JSON.parse(JSON.stringify(SAMPLE)) as Record<string, unknown>;
    delete on.hermesWorkLearning;
    window.localStorage.setItem('trylo:settings:v1', JSON.stringify(on));
    expect(loadSettings().hermesWorkLearning).toBe(true);

    // Explicit `false` survives the round-trip.
    window.localStorage.setItem('trylo:settings:v1', JSON.stringify({ ...SAMPLE, hermesWorkLearning: false }));
    expect(loadSettings().hermesWorkLearning).toBe(false);
    expect(settingsDefaults.hermesWorkLearning).toBe(true);
  });

  describe('P2 permission level migration', () => {
    // Strip the new field so the legacy migration path is the
    // one that runs; otherwise the new field would silently win.
    const legacyOnly = (over: Record<string, unknown>): Record<string, unknown> => {
      const { permissionLevel: _drop, ...rest } = SAMPLE;
      void _drop;
      return { ...rest, ...over };
    };
    it('migrates legacy `chat` → ask', () => {
      window.localStorage.setItem(
        'trylo:settings:v1',
        JSON.stringify(legacyOnly({ permissionMode: 'chat' })),
      );
      expect(loadSettings().permissionLevel).toBe('ask');
    });
    it('migrates legacy `plan` → read_only', () => {
      window.localStorage.setItem(
        'trylo:settings:v1',
        JSON.stringify(legacyOnly({ permissionMode: 'plan' })),
      );
      expect(loadSettings().permissionLevel).toBe('read_only');
    });
    it('migrates legacy `agent` → unrestricted', () => {
      window.localStorage.setItem(
        'trylo:settings:v1',
        JSON.stringify(legacyOnly({ permissionMode: 'agent' })),
      );
      expect(loadSettings().permissionLevel).toBe('unrestricted');
    });
    it('prefers the new permissionLevel over the legacy mode', () => {
      window.localStorage.setItem(
        'trylo:settings:v1',
        JSON.stringify({
          ...SAMPLE,
          permissionMode: 'agent',
          permissionLevel: 'workspace_write',
        }),
      );
      expect(loadSettings().permissionLevel).toBe('workspace_write');
    });
    it('falls back to the recommended default when no field is set', () => {
      // The recommended default is NEVER unrestricted — the spec
      // calls this out explicitly.
      window.localStorage.setItem(
        'trylo:settings:v1',
        JSON.stringify(legacyOnly({ permissionMode: undefined })),
      );
      const level = loadSettings().permissionLevel;
      expect(level).toBe('workspace_write');
      expect(level).not.toBe('unrestricted');
    });
    it('ignores an unknown stored permissionLevel', () => {
      window.localStorage.setItem(
        'trylo:settings:v1',
        JSON.stringify(legacyOnly({ permissionLevel: 'god_mode' })),
      );
      // Unknown → falls back to migration of the legacy mode.
      expect(loadSettings().permissionLevel).toBe('unrestricted');
    });
  });

  it('remoteSettingsDefaults matches the legacy plugin defaults', () => {
    expect(remoteSettingsDefaults()).toEqual({
      enabled: false,
      port: 49380,
      publicUrl: '',
      tunnelMode: 'named',
      autoStartTunnel: true,
      cloudflaredPath: '',
    });
  });

  it('loads pre-remote settings (no remote field) with the default remote group', () => {
    // Regression (migration spec §8.1): strictly requiring `remote` must not
    // discard every existing user's settings on upgrade.
    const legacy: Record<string, unknown> = { ...SAMPLE };
    delete legacy['remote'];
    saveSettings(legacy as unknown as TryloSettings);
    const s = loadSettings();
    expect(s.remote).toEqual(remoteSettingsDefaults());
    expect(s.apiKey).toBe(SAMPLE.apiKey);
    expect(s.cliPath).toBe(SAMPLE.cliPath);
    expect(s.companion.enabled).toBe(true);
  });

  it('preserves remote credentials when unrelated stored fields are missing or malformed', () => {
    window.localStorage.setItem('trylo:settings:v1', JSON.stringify({
      apiKey: SAMPLE.apiKey,
      remote: {
        enabled: true,
        port: 50000,
        tunnelMode: 'future-tunnel', // invalid → falls back
        autoStartTunnel: 'yes',      // invalid → falls back
      },
    }));

    const s = loadSettings();
    expect(s.apiKey).toBe(SAMPLE.apiKey);
    expect(s.remote.enabled).toBe(true);
    expect(s.remote.port).toBe(50000);
    expect(s.remote.tunnelMode).toBe(settingsDefaults.remote.tunnelMode);
    expect(s.remote.autoStartTunnel).toBe(settingsDefaults.remote.autoStartTunnel);
    expect(s.remote.publicUrl).toBe(settingsDefaults.remote.publicUrl);
  });

  it('preserves partial remote overrides (the rest falls back to defaults)', () => {
    saveSettings({
      ...settingsDefaults,
      remote: { ...settingsDefaults.remote, enabled: true, port: 50001 },
    });
    const s = loadSettings();
    expect(s.remote.enabled).toBe(true);
    expect(s.remote.port).toBe(50001);
    expect(s.remote.publicUrl).toBe('');
    expect(s.remote.cloudflaredPath).toBe('');
  });

  it('round-trips a full remote group', () => {
    saveSettings(SAMPLE);
    const s = loadSettings();
    expect(s.remote).toEqual(SAMPLE.remote);
  });

  describe('saved connection profiles (我的配置)', () => {
    const profile = (over: Partial<ModelProfile> = {}): ModelProfile => ({
      id: 'cfg-test',
      name: 'Ollama',
      apiKey: 'local',
      apiHost: 'http://localhost:11434',
      apiModel: 'qwen2.5-coder',
      apiFormat: 'openai',
      apiKeyHeader: 'Authorization',
      apiKeyPrefix: 'Bearer ',
      extraHeadersText: '{}',
      providerId: 'ollama',
      ...over,
    });

    it('connectionFields snapshots only the primary connection', () => {
      const s = { ...SAMPLE, apiModel: 'grok-4.5', apiKey: 'xx', poolModel: 'grok-4.5' };
      expect(connectionFields(s)).toMatchObject({
        apiModel: 'grok-4.5',
        apiKey: 'xx',
        apiHost: SAMPLE.apiHost,
        apiFormat: SAMPLE.apiFormat,
      });
    });

    it('applyProfile loads the full connection and marks it active', () => {
      const p = profile();
      const s = applyProfile({ ...settingsDefaults, poolModel: 'grok-4.5' }, p);
      expect(s.apiModel).toBe('qwen2.5-coder');
      expect(s.apiHost).toBe('http://localhost:11434');
      expect(s.apiKey).toBe('local');
      expect(s.apiFormat).toBe('openai');
      expect(s.activeModelProfileId).toBe('cfg-test');
      // A profile is its own source of truth — the pool override is cleared
      // by the caller (App), not by applyProfile; assert the pool untouched here.
      expect(s.poolModel).toBe('grok-4.5');
    });

    it('upsertProfile adds and then replaces by id (keeping its order)', () => {
      const a = profile({ id: 'a', name: 'A' });
      const b = profile({ id: 'b', name: 'B' });
      const s1 = upsertProfile(settingsDefaults, a);
      const s2 = upsertProfile(s1, b);
      expect(s2.modelProfiles.map((p) => p.id)).toEqual(['a', 'b']);
      const s3 = upsertProfile(s2, { ...a, name: 'A2' });
      expect(s3.modelProfiles.map((p) => p.id)).toEqual(['a', 'b']);
      expect(s3.modelProfiles[0]!.name).toBe('A2');
    });

    it('removeProfile deletes and clears the active pointer when targeted', () => {
      const a = profile({ id: 'a' });
      const s = applyProfile(upsertProfile(settingsDefaults, a), a);
      const s2 = removeProfile(s, 'a');
      expect(s2.modelProfiles).toHaveLength(0);
      expect(s2.activeModelProfileId).toBe('');
    });

    it('removeProfile keeps the active pointer for other ids', () => {
      const a = profile({ id: 'a' });
      const b = profile({ id: 'b' });
      const s = removeProfile(applyProfile(upsertProfile(upsertProfile(settingsDefaults, a), b), a), 'b');
      expect(s.activeModelProfileId).toBe('a');
      expect(s.modelProfiles.map((p) => p.id)).toEqual(['a']);
    });

    it('createProfileId yields distinct ids', () => {
      expect(createProfileId()).not.toBe(createProfileId());
    });

    it('persists profiles through save/load and migrates malformed entries', () => {
      const p = profile();
      saveSettings(upsertProfile(settingsDefaults, p));
      const s = loadSettings();
      expect(s.modelProfiles).toHaveLength(1);
      expect(s.modelProfiles[0]).toEqual(p);

      // A malformed entry falls back per-field rather than dropping others.
      saveSettings({
        ...settingsDefaults,
        modelProfiles: [
          { id: 'x', name: 'X' },
        ] as unknown as ModelProfile[],
      });
      const migrated = loadSettings();
      expect(migrated.modelProfiles).toHaveLength(1);
      expect(migrated.modelProfiles[0]!.id).toBe('x');
      expect(migrated.modelProfiles[0]!.apiFormat).toBe(settingsDefaults.apiFormat);
      expect(migrated.modelProfiles[0]!.apiModel).toBe('');
    });
  });
});
