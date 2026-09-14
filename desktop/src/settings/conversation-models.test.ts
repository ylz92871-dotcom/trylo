// Trylo Desktop — per-conversation model choice store unit tests.

import { describe, expect, it } from 'vitest';
import {
  effectiveModelForConversation,
  getConversationChoice,
  resolveChoiceToConnection,
  resolveRunConnection,
  setConversationChoice,
  type ConversationModelMap,
} from './conversation-models';
import type { TryloSettings } from './settings-store';

const SETTINGS: TryloSettings = {
  apiKey: 'sk-ant-global',
  apiHost: 'https://global.example.com',
  apiModel: 'claude-3-5-sonnet-latest',
  poolModel: '',
  modelProfiles: [
    {
      id: 'cfg-profile-a',
      name: 'Grok',
      apiKey: 'sk-grok',
      apiHost: 'http://localhost:8080',
      apiModel: 'grok-4.5',
      apiFormat: 'openai',
      apiKeyHeader: 'x-api-key',
      apiKeyPrefix: 'Bearer ',
      extraHeadersText: '{"X-A":"1"}',
      providerId: 'grok',
    },
  ],
  activeModelProfileId: '',
  apiFormat: 'anthropic',
  apiKeyHeader: '',
  apiKeyPrefix: '',
  extraHeadersText: '{}',
  providerId: '',
  systemPrompt: '',
  permissionMode: 'agent',
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
    enabled: false,
    port: 49380,
    publicUrl: '',
    tunnelMode: 'named',
    autoStartTunnel: true,
    cloudflaredPath: '',
  },
  workBrowserDebug: false,
  workComputer: true,
  workCad: false,
  hermesWorkLearning: true,
  cliPath: 'C:/trylo-cli/cli.js',
  workspace: 'C:/work/demo-ws',
  userLearning: {
    enabled: false,
    defaultMode: 'shadow',
    dimensionMode: {},
    cognitionEnabled: true,
    inference: {
      mode: 'deterministic',
      enabled: false,
      allowExecutionContext: false,
      maxCallsPerHour: 0,
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

describe('conversation-models: set/get', () => {
  it('round-trips a choice per conversation without cross-talk', () => {
    let map: ConversationModelMap = {};
    map = setConversationChoice(map, 'ws-a', 'conv-1', { kind: 'pool', model: 'grok-4.5' });
    map = setConversationChoice(map, 'ws-a', 'conv-2', { kind: 'profile', id: 'cfg-profile-a' });
    map = setConversationChoice(map, 'ws-b', 'conv-3', { kind: 'own' });

    expect(getConversationChoice(map, 'ws-a', 'conv-1')).toEqual({ kind: 'pool', model: 'grok-4.5' });
    expect(getConversationChoice(map, 'ws-a', 'conv-2')).toEqual({ kind: 'profile', id: 'cfg-profile-a' });
    expect(getConversationChoice(map, 'ws-b', 'conv-3')).toEqual({ kind: 'own' });
    // distinct conversations / workspaces don't leak
    expect(getConversationChoice(map, 'ws-a', 'conv-3')).toBeUndefined();
    expect(getConversationChoice(map, 'ws-a', 'conv-2')).not.toEqual({ kind: 'own' });
  });
});

describe('conversation-models: resolveRunConnection', () => {
  it('falls back to global connection when no choice is saved', () => {
    expect(resolveRunConnection(SETTINGS, 'ws', 'conv')).toEqual({
      apiKey: 'sk-ant-global',
      apiHost: 'https://global.example.com',
      apiModel: 'claude-3-5-sonnet-latest',
      apiFormat: 'anthropic',
      apiKeyHeader: '',
      apiKeyPrefix: '',
      extraHeadersText: '{}',
      providerId: '',
    });
  });

  it('own choice uses the global connection', () => {
    let map: ConversationModelMap = {};
    map = setConversationChoice(map, 'ws', 'conv', { kind: 'own' });
    expect(resolveRunConnection(SETTINGS, 'ws', 'conv', map).apiModel).toBe('claude-3-5-sonnet-latest');
  });

  it('pool choice overrides only the model, keeps global auth', () => {
    let map: ConversationModelMap = {};
    map = setConversationChoice(map, 'ws', 'conv', { kind: 'pool', model: 'grok-4.5' });
    const conn = resolveRunConnection(SETTINGS, 'ws', 'conv', map);
    expect(conn.apiModel).toBe('grok-4.5');
    expect(conn.apiKey).toBe('sk-ant-global');
    expect(conn.apiHost).toBe('https://global.example.com');
  });

  it('profile choice expands the full saved connection', () => {
    let map: ConversationModelMap = {};
    map = setConversationChoice(map, 'ws', 'conv', { kind: 'profile', id: 'cfg-profile-a' });
    const conn = resolveRunConnection(SETTINGS, 'ws', 'conv', map);
    expect(conn).toEqual({
      apiKey: 'sk-grok',
      apiHost: 'http://localhost:8080',
      apiModel: 'grok-4.5',
      apiFormat: 'openai',
      apiKeyHeader: 'x-api-key',
      apiKeyPrefix: 'Bearer ',
      extraHeadersText: '{"X-A":"1"}',
      providerId: 'grok',
    });
  });

  it('falls back to global when the referenced profile was deleted', () => {
    let map: ConversationModelMap = {};
    map = setConversationChoice(map, 'ws', 'conv', { kind: 'profile', id: 'cfg-gone' });
    const conn = resolveRunConnection(SETTINGS, 'ws', 'conv', map);
    expect(conn.apiModel).toBe('claude-3-5-sonnet-latest');
    expect(conn.apiKey).toBe('sk-ant-global');
  });

  it('a different conversation keeps its own connection (no cross-talk)', () => {
    let map: ConversationModelMap = {};
    map = setConversationChoice(map, 'ws', 'conv-a', { kind: 'profile', id: 'cfg-profile-a' });
    expect(resolveRunConnection(SETTINGS, 'ws', 'conv-b', map).apiModel).toBe('claude-3-5-sonnet-latest');
  });
});

describe('conversation-models: effectiveModelForConversation', () => {
  it('reflects the chosen model for the context window', () => {
    let map: ConversationModelMap = {};
    map = setConversationChoice(map, 'ws', 'conv', { kind: 'pool', model: 'grok-4.5' });
    expect(effectiveModelForConversation(SETTINGS, 'ws', 'conv', map)).toBe('grok-4.5');
    expect(effectiveModelForConversation(SETTINGS, 'ws', 'other', map)).toBe('claude-3-5-sonnet-latest');
  });
});

describe('conversation-models: resolveChoiceToConnection', () => {
  it('handles undefined explicitly', () => {
    expect(resolveChoiceToConnection(SETTINGS, undefined).apiModel).toBe('claude-3-5-sonnet-latest');
  });
});