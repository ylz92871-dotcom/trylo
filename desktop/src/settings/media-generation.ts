export type ImageGenerationProtocol = 'openai-images' | 'dashscope-images' | 'gemini-images'
export type VideoGenerationProtocol = 'ark-video' | 'dashscope-video' | 'replicate-video'
export interface MediaConnectionSettings {
  readonly enabled: boolean
  readonly protocol: ImageGenerationProtocol | VideoGenerationProtocol
  readonly endpoint: string
  readonly model: string
  readonly apiKey: string
}
export interface MediaGenerationSettings {
  readonly version: 1
  readonly browserFallback: boolean
  readonly image: MediaConnectionSettings
  readonly video: MediaConnectionSettings
}
export const DEFAULT_MEDIA_GENERATION: MediaGenerationSettings = {
  version: 1, browserFallback: true,
  image: { enabled: false, protocol: 'openai-images', endpoint: '', model: '', apiKey: '' },
  video: { enabled: false, protocol: 'ark-video', endpoint: '', model: '', apiKey: '' },
}
export const IMAGE_GENERATION_PROTOCOLS: readonly { value: ImageGenerationProtocol; label: string; endpoint: string }[] = [
  { value: 'openai-images', label: 'OpenAI 兼容 · 火山方舟及其他兼容服务', endpoint: 'https://ark.cn-beijing.volces.com/api/v3' },
  { value: 'dashscope-images', label: '阿里百炼 · 通义千问图像', endpoint: 'https://dashscope.aliyuncs.com/api/v1' },
  { value: 'gemini-images', label: 'Google Gemini 原生图像', endpoint: 'https://generativelanguage.googleapis.com/v1beta' },
]
export const VIDEO_GENERATION_PROTOCOLS: readonly { value: VideoGenerationProtocol; label: string; endpoint: string }[] = [
  { value: 'ark-video', label: '火山方舟 · Seedance', endpoint: 'https://ark.cn-beijing.volces.com/api/v3' },
  { value: 'dashscope-video', label: '阿里百炼 · 通义万相', endpoint: 'https://dashscope.aliyuncs.com/api/v1' },
  { value: 'replicate-video', label: 'Replicate · 官方视频模型', endpoint: 'https://api.replicate.com/v1' },
]
function connection(value: unknown, fallback: MediaConnectionSettings, allowed: readonly string[]): MediaConnectionSettings {
  if (!value || typeof value !== 'object') return fallback
  const input = value as Record<string, unknown>
  return { enabled: input.enabled === true,
    protocol: typeof input.protocol === 'string' && allowed.includes(input.protocol) ? input.protocol as MediaConnectionSettings['protocol'] : fallback.protocol,
    endpoint: typeof input.endpoint === 'string' ? input.endpoint : '', model: typeof input.model === 'string' ? input.model : '',
    apiKey: typeof input.apiKey === 'string' ? input.apiKey : '' }
}
export function mediaGenerationSettings(value: unknown): MediaGenerationSettings {
  const input = value && typeof value === 'object' ? value as Record<string, unknown> : {}
  return { version: 1, browserFallback: input.browserFallback !== false,
    image: connection(input.image, DEFAULT_MEDIA_GENERATION.image, IMAGE_GENERATION_PROTOCOLS.map(item => item.value)),
    video: connection(input.video, DEFAULT_MEDIA_GENERATION.video, VIDEO_GENERATION_PROTOCOLS.map(item => item.value)) }
}

export function mediaGenerationProblem(value: MediaGenerationSettings | undefined): string | undefined {
  if (!value) return undefined
  for (const [kind, title] of [['image', '图片生成'], ['video', '视频生成']] as const) {
    const connection = value[kind]
    if (!connection.enabled) continue
    try {
      const url = new URL(connection.endpoint)
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error('Invalid endpoint')
    } catch { return `${title}服务地址需要是 HTTP(S) 根地址，密钥请填写在独立密钥栏。` }
    if (!connection.model.trim()) return `请填写${title}模型 ID。`
    if (connection.protocol === 'replicate-video' && !/^[\w.-]+\/[\w.-]+$/.test(connection.model.trim())) return 'Replicate 模型 ID 需要填写 owner/model。'
  }
  return undefined
}
