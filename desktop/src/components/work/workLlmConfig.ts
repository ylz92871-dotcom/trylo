import type { ControlPlaneClient } from '@trylo/work'
import type { TryloSettings } from '../../settings/settings-store'

export interface WorkLlmConfigureParams {
  readonly providerType: 'anthropic' | 'anthropic-compatible' | 'openai' | 'openai-compatible'
  readonly apiKey: string
  readonly model?: string
  readonly settings?: {
    readonly baseUrl: string
  }
}

function isOfficialAnthropicEndpoint(raw: string): boolean {
  try {
    return new URL(raw).hostname.toLowerCase() === 'api.anthropic.com'
  } catch {
    return false
  }
}

function isOfficialOpenAiEndpoint(raw: string): boolean {
  try {
    return new URL(raw).hostname.toLowerCase() === 'api.openai.com'
  } catch {
    return false
  }
}

/**
 * Translate Trylo's provider settings into the narrow Control Plane
 * capability Work needs. A custom endpoint using the Anthropic wire
 * format must use cowork's anthropic-compatible provider: unlike the
 * native Anthropic SDK path, it sends both x-api-key and Authorization.
 */
export function buildWorkLlmConfigureParams(settings: TryloSettings): WorkLlmConfigureParams {
  const apiKey = settings.apiKey.trim()
  if (!apiKey) {
    throw new Error('API key is not configured. Open Settings and add one first.')
  }

  const model = settings.apiModel.trim()
  const endpoint = settings.apiHost.trim()

  if (settings.apiFormat === 'anthropic') {
    const usesCustomGateway = endpoint.length > 0 && !isOfficialAnthropicEndpoint(endpoint)
    if (usesCustomGateway) {
      return {
        providerType: 'anthropic-compatible',
        apiKey,
        ...(model ? { model } : {}),
        settings: { baseUrl: endpoint },
      }
    }

    return {
      providerType: 'anthropic',
      apiKey,
      ...(model ? { model } : {}),
    }
  }

  const usesCustomGateway = endpoint.length > 0 && !isOfficialOpenAiEndpoint(endpoint)
  if (usesCustomGateway) {
    return {
      providerType: 'openai-compatible',
      apiKey,
      ...(model ? { model } : {}),
      settings: { baseUrl: endpoint },
    }
  }

  return {
    providerType: 'openai',
    apiKey,
    ...(model ? { model } : {}),
  }
}

export async function configureWorkLlm(
  client: ControlPlaneClient,
  settings: TryloSettings,
): Promise<void> {
  await client.send('llm.configure', buildWorkLlmConfigureParams(settings))
}
