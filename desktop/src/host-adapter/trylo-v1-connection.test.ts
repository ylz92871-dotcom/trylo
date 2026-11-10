import { beforeEach, expect, it, vi } from 'vitest';
import type { SettingsForCodeRun } from '../runtime/runtime-types';
import { DEFAULT_MEDIA_GENERATION } from '../settings/media-generation';

const h = vi.hoisted(() => ({ providers: vi.fn(), status: vi.fn(), credential: vi.fn() }));

it('passes independent media credentials only through the child environment', async () => {
  const mediaGeneration = { ...DEFAULT_MEDIA_GENERATION, image: { ...DEFAULT_MEDIA_GENERATION.image, apiKey: 'MEDIA_KEY', model: 'media-model' } };
  const env = await ensureV1Connection({ ...settings, apiKey: 'CHAT_KEY', mediaGeneration }, { providerId: 'openai-compatible' });
  expect(env.TRYLO_OPENAI_API_KEY).toBe('CHAT_KEY');
  expect(JSON.parse(env.TRYLO_MEDIA_CONFIG!)).toEqual(mediaGeneration);
  expect(h.providers).not.toHaveBeenCalled();
});
vi.mock('./cli-auth-status', async importOriginal => ({
  ...await importOriginal<typeof import('./cli-auth-status')>(), readCliProviders: h.providers, readCliAuthStatus: h.status,
}));
vi.mock('./cli-provider-credential', () => ({ readCliProviderCredential: h.credential }));
const { ensureV1Connection, v1CredentialEnv } = await import('./trylo-v1-connection');
const settings = { cliPath: '/cli/main.js', cwd: '/project' } as SettingsForCodeRun;

beforeEach(() => {
  vi.clearAllMocks();
  h.providers.mockResolvedValue({ ok: true, providers: [
    { id: 'amd', kind: 'openai-compatible', auth: 'api_key' }, { id: 'openai-compatible', auth: 'api_key' },
  ] });
  h.status.mockResolvedValue({ ok: true, providers: [{ providerId: 'openai-compatible', loggedIn: true, layer: 'env' }] });
  h.credential.mockResolvedValue({ ok: true, loggedIn: true, layer: 'user' });
});

it('checks the named provider account rather than looking for its id in family status', async () => {
  await expect(ensureV1Connection(settings, { providerId: 'amd' })).resolves.toEqual({});
  expect(h.credential).toHaveBeenCalledWith(expect.objectContaining({ providerId: 'amd', cwd: '/project' }));
  expect(h.status).not.toHaveBeenCalled();
});

it('a logged-in family cannot authorize a missing named binding', async () => {
  h.credential.mockResolvedValue({ ok: true, loggedIn: false, layer: 'none' });
  await expect(ensureV1Connection(settings, { providerId: 'amd' })).rejects.toThrow(/未登录/);
});

it('hands an explicit builtin key straight to the run without spawning status commands', async () => {
  const env = { TRYLO_OPENAI_API_KEY: 'test-only-key' };
  await expect(ensureV1Connection({ ...settings, apiKey: ' test-only-key ' }, { providerId: 'openai-compatible' })).resolves.toEqual(env);
  expect(h.providers).not.toHaveBeenCalled();
  expect(h.status).not.toHaveBeenCalled();
  expect(h.credential).not.toHaveBeenCalled();
  expect(v1CredentialEnv('amd', 'test-only-key')).toEqual({});
});

it('still probes CLI-owned builtin credentials on every send', async () => {
  await ensureV1Connection(settings, { providerId: 'openai-compatible' });
  h.status.mockResolvedValue({ ok: true, providers: [{ providerId: 'openai-compatible', loggedIn: false, layer: 'none' }] });
  await expect(ensureV1Connection(settings, { providerId: 'openai-compatible' })).rejects.toThrow(/未登录/);
  expect(h.providers).toHaveBeenCalledTimes(2);
  expect(h.status).toHaveBeenCalledTimes(2);
});

it('a whitespace key does not bypass the CLI credential check', async () => {
  h.status.mockResolvedValue({ ok: true, providers: [{ providerId: 'openai-compatible', loggedIn: false, layer: 'none' }] });
  await expect(ensureV1Connection({ ...settings, apiKey: '  ' }, { providerId: 'openai-compatible' })).rejects.toThrow(/未登录/);
});

it('a Desktop key cannot authorize a named provider with a missing account', async () => {
  h.credential.mockResolvedValue({ ok: true, loggedIn: false, layer: 'none' });
  await expect(ensureV1Connection({ ...settings, apiKey: 'test-only-key' }, { providerId: 'amd' })).rejects.toThrow(/未登录/);
});

it('unknown providers fail before a task can run', async () => {
  await expect(ensureV1Connection(settings, { providerId: 'missing' })).rejects.toThrow(/未登记/);
});
