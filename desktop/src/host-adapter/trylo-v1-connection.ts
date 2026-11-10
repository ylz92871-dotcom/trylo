import { describeCliAuthProblem, readCliAuthStatus, readCliProviders, type ProviderArgs } from './cli-auth-status';
import { readCliProviderCredential } from './cli-provider-credential';
import type { SettingsForCodeRun } from '../runtime/runtime-types';

/** Existing Desktop OpenAI credentials are ephemeral child input, never a second ledger. */
export function v1CredentialEnv(providerId: string | undefined, apiKey: string | undefined): Readonly<Record<string, string>> {
  return providerId === 'openai-compatible' && apiKey?.trim()
    ? { TRYLO_OPENAI_API_KEY: apiKey.trim() } : {};
}

export async function ensureV1Connection(settings: SettingsForCodeRun, provider: ProviderArgs): Promise<Readonly<Record<string, string>>> {
  const env: Readonly<Record<string, string>> = { ...v1CredentialEnv(provider.providerId, settings.apiKey),
    ...(settings.mediaGeneration === undefined ? {} : { TRYLO_MEDIA_CONFIG: JSON.stringify(settings.mediaGeneration) }) };
  if (!provider.providerId) {
    if (settings.apiKey?.trim() || settings.apiHost?.trim()) {
      throw new Error('新 CLI 需要显式 provider：当前 Anthropic 格式连接无法映射到新 CLI。请配置 provider，或选择 OpenAI 格式。');
    }
    return env;
  }
  // The builtin provider cannot be removed, and this exact environment is
  // handed to the run process. Asking two additional CLI processes whether
  // they can see a key we just supplied adds a full cold start twice per
  // turn. The run still resolves its config and validates the connection;
  // CLI-owned credentials and named provider bindings must be probed below.
  if (provider.providerId === 'openai-compatible' && env.TRYLO_OPENAI_API_KEY) return env;
  const probeArgs = { cliPath: settings.cliPath, nodeProgram: settings.cliNodeProgram, env, cwd: settings.cwd };
  const providers = await readCliProviders(probeArgs);
  if (!providers.ok) throw new Error(`无法读取新 CLI 的 provider 列表（${providers.reason}：${providers.detail}）。`);
  const descriptor = providers.providers.find(p => p.id === provider.providerId);
  if (!descriptor) throw new Error(`新 CLI 未登记 provider「${provider.providerId}」。`);
  if (descriptor.auth === 'api_key') {
    // The built-in has no declared model until run argv supplies one. Its
    // credential family can be queried without resolving that missing model.
    if (provider.providerId === 'openai-compatible') {
      const problem = describeCliAuthProblem(await readCliAuthStatus(probeArgs), provider.providerId);
      if (problem) throw new Error(problem);
      return env;
    }
    const status = await readCliProviderCredential({ ...probeArgs, providerId: provider.providerId });
    if (!status.ok) throw new Error(`无法查询 provider「${provider.providerId}」的凭据：${status.detail}`);
    if (!status.loggedIn) throw new Error(`新 CLI 的 provider「${provider.providerId}」未登录（当前解析层：${status.layer || 'none'}）。请先配置凭据。`);
  }
  return env;
}
