import { describe, expect, it } from 'vitest';
import { legacyConnectionEnv } from './legacy-connection-env';

describe('legacy connection headers', () => {
  it('uses the SDK custom-header channel and lets the explicit key win case-insensitively', () => {
    expect(legacyConnectionEnv({ apiKey: 'fixture-key', apiFormat: 'openai', apiKeyHeader: 'Authorization',
      apiKeyPrefix: 'Bearer ', extraHeadersText: '{"authorization":"stale","X-Trace":"1"}' }))
      .toEqual({ ANTHROPIC_API_KEY: 'fixture-key', ANTHROPIC_AUTH_TOKEN: '',
        ANTHROPIC_CUSTOM_HEADERS: 'Authorization: Bearer fixture-key\nX-Trace: 1' });
  });
  it('defaults an OpenAI connection to bearer authentication', () => {
    expect(legacyConnectionEnv({ apiKey: 'fixture-key', apiFormat: 'openai', apiKeyHeader: '', apiKeyPrefix: '' })
      .ANTHROPIC_CUSTOM_HEADERS).toBe('Authorization: Bearer fixture-key');
  });
  it('preserves custom non-bearer prefixes and the plain Anthropic API-key path', () => {
    expect(legacyConnectionEnv({ apiKey: 'fixture', apiKeyHeader: 'Authorization', apiKeyPrefix: 'Token ' })
      .ANTHROPIC_CUSTOM_HEADERS).toBe('Authorization: Token fixture');
    expect(legacyConnectionEnv({ apiKey: 'fixture', apiFormat: 'anthropic', extraHeadersText: '{}' }))
      .toEqual({ ANTHROPIC_API_KEY: 'fixture', ANTHROPIC_AUTH_TOKEN: '' });
    expect(legacyConnectionEnv({ apiKey: 'fixture', apiFormat: 'openai', apiKeyHeader: 'Authorization', apiKeyPrefix: '' })
      .ANTHROPIC_CUSTOM_HEADERS).toBe('Authorization: fixture');
  });
  it('does not replace CLI-owned credentials when Desktop has no key', () => {
    expect(legacyConnectionEnv({ apiHost: 'https://example.test', apiModel: 'model' }))
      .toEqual({ ANTHROPIC_BASE_URL: 'https://example.test', ANTHROPIC_MODEL: 'model' });
  });
  it('keeps newline-style legacy extra headers working', () => {
    expect(legacyConnectionEnv({ extraHeadersText: 'X-One: first\nX-Two: second' })
      .ANTHROPIC_CUSTOM_HEADERS).toBe('X-One: first\nX-Two: second');
  });
  it('rejects malformed headers before a child is spawned without echoing secrets', () => {
    for (const input of [{ extraHeadersText: '{bad secret' }, { extraHeadersText: '{"X":5}' },
      { apiKey: 'secret\nInjected: value', apiKeyHeader: 'Authorization' },
      { apiKey: 'secret', apiKeyHeader: 'invalid name' }]) {
      expect(() => legacyConnectionEnv(input)).toThrow(/请求头/);
      try { legacyConnectionEnv(input); } catch (error) { expect(String(error)).not.toContain('secret'); }
    }
  });
});
