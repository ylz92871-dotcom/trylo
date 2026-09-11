import { describe, expect, it, vi } from 'vitest'
import { settingsDefaults, type TryloSettings } from '../../settings/settings-store'
import { buildWorkLlmConfigureParams, configureWorkLlm } from './workLlmConfig'

function makeSettings(overrides: Partial<TryloSettings>): TryloSettings {
  return { ...settingsDefaults, ...overrides }
}

describe('buildWorkLlmConfigureParams', () => {
  it('uses the native provider for the official Anthropic endpoint', () => {
    expect(
      buildWorkLlmConfigureParams(
        makeSettings({
          apiFormat: 'anthropic',
          apiHost: 'https://api.anthropic.com/v1',
          apiKey: 'sk-ant-test',
          apiModel: 'claude-sonnet-4-6',
        }),
      ),
    ).toEqual({
      providerType: 'anthropic',
      apiKey: 'sk-ant-test',
      model: 'claude-sonnet-4-6',
    })
  })

  it('uses anthropic-compatible for a custom Claude gateway', () => {
    expect(
      buildWorkLlmConfigureParams(
        makeSettings({
          apiFormat: 'anthropic',
          apiHost: 'http://127.0.0.1:3456/v1',
          apiKey: 'gateway-token',
          apiModel: 'claude-desktop',
        }),
      ),
    ).toEqual({
      providerType: 'anthropic-compatible',
      apiKey: 'gateway-token',
      model: 'claude-desktop',
      settings: { baseUrl: 'http://127.0.0.1:3456/v1' },
    })
  })

  it('uses the native provider for the official OpenAI endpoint', () => {
    expect(
      buildWorkLlmConfigureParams(
        makeSettings({
          apiFormat: 'openai',
          apiHost: 'https://api.openai.com/v1',
          apiKey: 'sk-openai-test',
          apiModel: 'gpt-5',
        }),
      ),
    ).toEqual({
      providerType: 'openai',
      apiKey: 'sk-openai-test',
      model: 'gpt-5',
    })
  })

  it('preserves a custom OpenAI-compatible gateway', () => {
    expect(
      buildWorkLlmConfigureParams(
        makeSettings({
          apiFormat: 'openai',
          apiHost: 'http://127.0.0.1:11434/v1',
          apiKey: 'gateway-token',
          apiModel: 'local-code-model',
        }),
      ),
    ).toEqual({
      providerType: 'openai-compatible',
      apiKey: 'gateway-token',
      model: 'local-code-model',
      settings: { baseUrl: 'http://127.0.0.1:11434/v1' },
    })
  })

  it('rejects an empty API key before sending a control-plane request', () => {
    expect(() => buildWorkLlmConfigureParams(makeSettings({ apiKey: '  ' }))).toThrow(
      'API key is not configured',
    )
  })

  it('configures the daemon without logging or returning the secret', async () => {
    const send = vi.fn().mockResolvedValue({ llm: { currentProvider: 'anthropic-compatible' } })
    const client = { send } as unknown as Parameters<typeof configureWorkLlm>[0]
    const settings = makeSettings({
      apiFormat: 'anthropic',
      apiHost: 'http://localhost:3456/v1/messages',
      apiKey: 'gateway-token',
    })

    await expect(configureWorkLlm(client, settings)).resolves.toBeUndefined()
    expect(send).toHaveBeenCalledWith('llm.configure', {
      providerType: 'anthropic-compatible',
      apiKey: 'gateway-token',
      settings: { baseUrl: 'http://localhost:3456/v1/messages' },
    })
  })
})
