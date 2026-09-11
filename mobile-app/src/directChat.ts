import { secureGet, secureRemove, secureSet } from './secureStorage';

export type ApiFormat = 'openai' | 'anthropic';

/**
 * A file the user attached to a message. Images are sent to the model as
 * base64; text-like files are inlined into the prompt as fenced blocks.
 *
 * `dataUrl` holds a small thumbnail only. Full-size bytes live in `sendData`,
 * which is deliberately NOT persisted: localStorage caps out around 5 MB, so
 * storing full images would break history after a couple of photos.
 */
export interface DirectAttachment {
  id: string;
  kind: 'image' | 'text';
  name: string;
  mimeType: string;
  size: number;
  /** Small preview kept in history (images only). */
  dataUrl?: string;
  /** Full payload for the outgoing request; dropped before persisting. */
  sendData?: string;
  /** Extracted text for text-like files. */
  text?: string;
}

export interface DirectProvider {
  id: string;
  label: string;
  endpoint: string;
  model: string;
  apiFormat: ApiFormat;
  apiKeyHeader: string;
  apiKeyPrefix: string;
  /** Region grouping shown in the provider picker. */
  group: ProviderGroup;
  /** Known model ids offered as one-tap presets. */
  models?: ModelPreset[];
  /** Docs page for finding an API key, shown as a hint. */
  docs?: string;
}

export type ProviderGroup = 'cn' | 'global' | 'custom';

export interface ModelPreset {
  id: string;
  /** Short note explaining when to pick this model. */
  note: string;
  /** Marks models that accept image input. */
  vision?: boolean;
}

export interface DirectConfig {
  providerId: string;
  endpoint: string;
  model: string;
  apiFormat: ApiFormat;
  apiKeyHeader: string;
  apiKeyPrefix: string;
  systemPrompt: string;
  temperature: number;
}

export interface DirectMessage {
  id: string;
  role: 'user' | 'assistant';
  text: string;
  at: number;
  status?: 'streaming' | 'done' | 'error';
  /**
   * Human-readable failure reason kept on the message itself. A toast alone is
   * too easy to miss (it self-dismisses), which left users staring at a chat
   * that silently dropped their question.
   */
  error?: string;
  /** Attachments included with this message (images, text files). */
  attachments?: DirectAttachment[];
  /** Marks an assistant message produced by the image generator (for retry). */
  isImage?: boolean;
}

export interface DirectConversation {
  id: string;
  title: string;
  updatedAt: number;
  messages: DirectMessage[];
}

/**
 * Most vendors expose an OpenAI-compatible `/chat/completions` route, so they
 * only differ by host, default model and the model ids they publish.
 */
function openAiCompatible(
  id: string,
  label: string,
  endpoint: string,
  model: string,
  group: ProviderGroup,
  models?: ModelPreset[],
  docs?: string,
): DirectProvider {
  return {
    id, label, endpoint, model, group, models, docs,
    apiFormat: 'openai',
    apiKeyHeader: 'Authorization',
    apiKeyPrefix: 'Bearer ',
  };
}

export const DIRECT_PROVIDERS: DirectProvider[] = [
  openAiCompatible('doubao', '豆包 · 火山方舟', 'https://ark.cn-beijing.volces.com/api/v3', 'doubao-seed-1-6-flash-250715', 'cn', [
    { id: 'doubao-seed-code-preview', note: '代码专用 · Coding Plan' },
    { id: 'doubao-seed-1-6-250615', note: '旗舰 · 支持图片', vision: true },
    { id: 'doubao-seed-1-6-flash-250715', note: '快而便宜 · 支持图片', vision: true },
    { id: 'doubao-seed-1-6-thinking-250715', note: '深度思考' },
    { id: 'doubao-1-5-vision-pro-32k-250115', note: '视觉理解', vision: true },
  ], 'https://console.volcengine.com/ark'),
  openAiCompatible('deepseek', 'DeepSeek 深度求索', 'https://api.deepseek.com/v1', 'deepseek-chat', 'cn', [
    { id: 'deepseek-chat', note: '通用对话' },
    { id: 'deepseek-reasoner', note: '深度推理 R1' },
  ], 'https://platform.deepseek.com/api_keys'),
  openAiCompatible('dashscope', '通义千问 · DashScope', 'https://dashscope.aliyuncs.com/compatible-mode/v1', 'qwen-plus', 'cn', [
    { id: 'qwen-plus', note: '均衡首选' },
    { id: 'qwen-max', note: '最强效果' },
    { id: 'qwen-turbo', note: '快而便宜' },
    { id: 'qwen-vl-plus', note: '图片理解', vision: true },
    { id: 'qwen3-coder-plus', note: '代码专用' },
  ], 'https://bailian.console.aliyun.com'),
  openAiCompatible('moonshot', 'Kimi · Moonshot', 'https://api.moonshot.cn/v1', 'kimi-k2-0905-preview', 'cn', [
    { id: 'kimi-k2-0905-preview', note: '最新 K2' },
    { id: 'moonshot-v1-8k', note: '短上下文' },
    { id: 'moonshot-v1-128k', note: '长文档' },
  ], 'https://platform.moonshot.cn/console/api-keys'),
  openAiCompatible('zhipu', '智谱清言 · GLM', 'https://open.bigmodel.cn/api/paas/v4', 'glm-4-flash', 'cn', [
    { id: 'glm-4-flash', note: '免费额度大' },
    { id: 'glm-4-plus', note: '旗舰' },
    { id: 'glm-4v-plus', note: '图片理解', vision: true },
  ], 'https://open.bigmodel.cn/usercenter/apikeys'),
  openAiCompatible('hunyuan', '腾讯混元', 'https://api.hunyuan.cloud.tencent.com/v1', 'hunyuan-turbos-latest', 'cn', [
    { id: 'hunyuan-turbos-latest', note: '最新 turbo' },
    { id: 'hunyuan-lite', note: '免费' },
    { id: 'hunyuan-vision', note: '图片理解', vision: true },
  ]),
  openAiCompatible('qianfan', '百度文心 · 千帆', 'https://qianfan.baidubce.com/v2', 'ernie-4.5-turbo-128k', 'cn', [
    { id: 'ernie-4.5-turbo-128k', note: '最新 4.5' },
    { id: 'ernie-4.0-8k', note: '旗舰 4.0' },
    { id: 'ernie-speed-128k', note: '快而便宜' },
  ]),
  openAiCompatible('stepfun', '阶跃星辰 · StepFun', 'https://api.stepfun.com/v1', 'step-2-mini', 'cn', [
    { id: 'step-2-mini', note: '轻量快速' },
    { id: 'step-1-8k', note: '通用' },
    { id: 'step-1v-8k', note: '图片理解', vision: true },
  ]),
  openAiCompatible('minimax', 'MiniMax 海螺', 'https://api.minimax.chat/v1', 'MiniMax-Text-01', 'cn', [
    { id: 'MiniMax-Text-01', note: '长上下文' },
  ]),
  openAiCompatible('lingyiwanwu', '零一万物 · Yi', 'https://api.lingyiwanwu.com/v1', 'yi-lightning', 'cn', [
    { id: 'yi-lightning', note: '快而便宜' },
    { id: 'yi-vision-v2', note: '图片理解', vision: true },
  ]),
  openAiCompatible('baichuan', '百川智能', 'https://api.baichuan-ai.com/v1', 'Baichuan4-Air', 'cn', [
    { id: 'Baichuan4-Air', note: '性价比' },
    { id: 'Baichuan4-Turbo', note: '更强' },
  ]),
  openAiCompatible('spark', '讯飞星火', 'https://spark-api-open.xf-yun.com/v1', 'generalv3.5', 'cn', [
    { id: 'generalv3.5', note: 'Spark Max' },
    { id: '4.0Ultra', note: '最强' },
    { id: 'lite', note: '免费' },
  ]),
  openAiCompatible('siliconflow', 'SiliconFlow 硅基流动', 'https://api.siliconflow.cn/v1', 'deepseek-ai/DeepSeek-V3', 'cn', [
    { id: 'deepseek-ai/DeepSeek-V3', note: 'DeepSeek V3' },
    { id: 'Qwen/Qwen2.5-Coder-32B-Instruct', note: '代码专用' },
    { id: 'Qwen/Qwen2.5-7B-Instruct', note: '免费' },
  ], 'https://cloud.siliconflow.cn/account/ak'),
  openAiCompatible('modelscope', '魔搭 ModelScope', 'https://api-inference.modelscope.cn/v1', 'Qwen/Qwen2.5-7B-Instruct', 'cn', [
    { id: 'Qwen/Qwen2.5-7B-Instruct', note: '免费额度' },
    { id: 'deepseek-ai/DeepSeek-V3', note: 'DeepSeek V3' },
  ]),
  openAiCompatible('openai', 'OpenAI', 'https://api.openai.com/v1', 'gpt-4o-mini', 'global', [
    { id: 'gpt-4o-mini', note: '便宜 · 支持图片', vision: true },
    { id: 'gpt-4o', note: '旗舰 · 支持图片', vision: true },
    { id: 'o4-mini', note: '推理模型' },
  ], 'https://platform.openai.com/api-keys'),
  {
    id: 'anthropic',
    label: 'Anthropic Claude',
    endpoint: 'https://api.anthropic.com',
    model: 'claude-sonnet-4-5',
    apiFormat: 'anthropic',
    apiKeyHeader: 'x-api-key',
    apiKeyPrefix: '',
    group: 'global',
    docs: 'https://console.anthropic.com/settings/keys',
    models: [
      { id: 'claude-sonnet-4-5', note: '均衡 · 支持图片', vision: true },
      { id: 'claude-opus-4-1', note: '最强 · 支持图片', vision: true },
      { id: 'claude-haiku-4-5', note: '最快 · 支持图片', vision: true },
    ],
  },
  openAiCompatible('gemini', 'Google Gemini', 'https://generativelanguage.googleapis.com/v1beta/openai', 'gemini-2.0-flash', 'global', [
    { id: 'gemini-2.0-flash', note: '快 · 支持图片', vision: true },
    { id: 'gemini-2.5-pro', note: '最强 · 支持图片', vision: true },
  ], 'https://aistudio.google.com/apikey'),
  openAiCompatible('xai', 'xAI Grok', 'https://api.x.ai/v1', 'grok-2-latest', 'global', [
    { id: 'grok-2-latest', note: '通用' },
    { id: 'grok-2-vision-latest', note: '图片理解', vision: true },
  ]),
  openAiCompatible('groq', 'Groq', 'https://api.groq.com/openai/v1', 'llama-3.3-70b-versatile', 'global', [
    { id: 'llama-3.3-70b-versatile', note: '极快' },
    { id: 'qwen-2.5-coder-32b', note: '代码专用' },
  ], 'https://console.groq.com/keys'),
  openAiCompatible('openrouter', 'OpenRouter 聚合', 'https://openrouter.ai/api/v1', 'deepseek/deepseek-chat', 'global', [
    { id: 'deepseek/deepseek-chat', note: 'DeepSeek' },
    { id: 'anthropic/claude-sonnet-4.5', note: 'Claude', vision: true },
    { id: 'google/gemini-2.0-flash-001', note: 'Gemini', vision: true },
  ], 'https://openrouter.ai/keys'),
  openAiCompatible('together', 'Together AI', 'https://api.together.xyz/v1', 'meta-llama/Llama-3.3-70B-Instruct-Turbo', 'global', [
    { id: 'meta-llama/Llama-3.3-70B-Instruct-Turbo', note: 'Llama 3.3' },
    { id: 'Qwen/Qwen2.5-Coder-32B-Instruct', note: '代码专用' },
  ]),

  openAiCompatible('custom', '自定义 · OpenAI 兼容', '', '', 'custom'),
  {
    id: 'custom-anthropic',
    label: '自定义 · Anthropic 兼容',
    endpoint: '',
    model: '',
    apiFormat: 'anthropic',
    apiKeyHeader: 'x-api-key',
    apiKeyPrefix: '',
    group: 'custom',
  },
];

export const PROVIDER_GROUP_LABELS: Record<ProviderGroup, { zh: string; en: string }> = {
  cn: { zh: '国内服务商', en: 'China' },
  global: { zh: '海外服务商', en: 'Global' },
  custom: { zh: '自定义', en: 'Custom' },
};

const DEFAULT_SYSTEM_PROMPT =
  '你是 Trylo Code 内置的 AI 助手，风格亲切、回答清晰。检测用户最新消息的语言并用相同语言回答；用户用中文或语言不明确时，全部使用简体中文。代码、命令、文件名、API 名称保持原文。';

const CONFIG_STORAGE_KEY = 'trylo.direct.config.v1';
const CONVERSATIONS_STORAGE_KEY = 'trylo.direct.conversations.v1';
const SECURE_STORAGE_PREFIX = 'trylo_direct_';
const LEGACY_SECRET_KEY = 'api_key';
const MAX_CONVERSATIONS = 40;
const MAX_MESSAGES_PER_CONVERSATION = 100;
const MAX_MESSAGE_CHARS = 120_000;
const MAX_CONTEXT_CHARS = 400_000;
const MAX_CONTEXT_MESSAGES = 60;
const MAX_SSE_BUFFER_CHARS = 250_000;
const MAX_SYSTEM_PROMPT_CHARS = 8_000;
const MAX_MODEL_CHARS = 200;
/** Images are downscaled to this longest edge before being sent. */
const MAX_IMAGE_EDGE = 1024;
/** JPEG quality used when re-encoding a downscaled image. */
const IMAGE_QUALITY = 0.82;
/** Thumbnail edge kept in localStorage so history stays small. */
const THUMB_EDGE = 160;
/** Refuse absurd source files outright (before downscaling). */
const MAX_ATTACHMENT_BYTES = 12 * 1024 * 1024;
/** Text files are truncated to keep the prompt manageable. */
const MAX_ATTACHMENT_TEXT_CHARS = 40_000;
/** Attachments allowed per message. */
export const MAX_ATTACHMENTS_PER_MESSAGE = 6;
const RESPONSE_TRUNCATED_NOTICE = '\n\n[回复过长，已在设备端截断]';
const REQUEST_TIMEOUT_MS = 120_000;
const REVEAL_STEPS = 90;
const REVEAL_INTERVAL_MS = 16;

export function makeId(prefix: string) {
  const randomPart = globalThis.crypto?.randomUUID?.() || Math.random().toString(36).slice(2, 12);
  return `${prefix}-${Date.now()}-${randomPart}`;
}

export function createConversation(): DirectConversation {
  return { id: makeId('c'), title: '', updatedAt: Date.now(), messages: [] };
}

function getProvider(providerId: string): DirectProvider {
  return DIRECT_PROVIDERS.find(item => item.id === providerId) || DIRECT_PROVIDERS[0];
}

/** True when the configured model is known to accept image input. */
export function modelSupportsVision(config: DirectConfig): boolean {
  const provider = getProvider(config.providerId);
  const preset = provider.models?.find(item => item.id === config.model);
  if (preset) return Boolean(preset.vision);
  // Unknown/custom model ids: fall back to common naming conventions rather
  // than blocking the user, since any OpenAI-compatible proxy may accept images.
  return /vision|vl|4o|gpt-5|gemini|claude|seed-1-[68]|omni/i.test(config.model);
}

/** Text-like files are inlined into the prompt instead of sent as images. */
function isTextLike(file: File): boolean {
  if (file.type.startsWith('text/')) return true;
  if (/^application\/(json|xml|x-yaml|yaml|javascript|typescript|sql|toml)$/.test(file.type)) return true;
  return /\.(txt|md|markdown|json|ya?ml|toml|ini|cfg|conf|csv|tsv|log|ts|tsx|js|jsx|mjs|cjs|py|java|kt|go|rs|c|h|cpp|hpp|cs|php|rb|swift|sql|sh|bash|ps1|html?|css|scss|xml|gradle|properties|env|diff|patch)$/i
    .test(file.name);
}

function readAsText(file: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ''));
    reader.onerror = () => reject(new Error('读取文件失败'));
    reader.readAsText(file);
  });
}

/**
 * Re-encodes an image at a bounded size. Phone photos are frequently 4000px
 * wide / several MB, which wastes tokens and can exceed request limits, so both
 * the outgoing copy and the stored thumbnail are downscaled here.
 */
async function downscaleImage(file: File, maxEdge: number, quality: number): Promise<string> {
  const sourceUrl = URL.createObjectURL(file);
  try {
    const image = await new Promise<HTMLImageElement>((resolve, reject) => {
      const element = new Image();
      element.onload = () => resolve(element);
      element.onerror = () => reject(new Error('无法解码图片'));
      element.src = sourceUrl;
    });
    const scale = Math.min(1, maxEdge / Math.max(image.width, image.height));
    const width = Math.max(1, Math.round(image.width * scale));
    const height = Math.max(1, Math.round(image.height * scale));
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext('2d');
    if (!context) throw new Error('无法处理图片');
    context.drawImage(image, 0, 0, width, height);
    // PNG screenshots with text stay sharper, but JPEG is far smaller for
    // photos; transparency is irrelevant for model input, so JPEG wins here.
    return canvas.toDataURL('image/jpeg', quality);
  } finally {
    URL.revokeObjectURL(sourceUrl);
  }
}

/**
 * Turns a picked file into an attachment. Images are downscaled twice: once for
 * the request and once as a tiny thumbnail for on-device history.
 */
export async function buildAttachment(file: File): Promise<DirectAttachment> {
  if (file.size > MAX_ATTACHMENT_BYTES) {
    throw new Error(`${file.name} 超过 12 MB，请压缩后再上传。`);
  }
  const base = {
    id: makeId('att'),
    name: file.name || 'file',
    mimeType: file.type || 'application/octet-stream',
    size: file.size,
  };

  if (file.type.startsWith('image/')) {
    const [sendData, dataUrl] = await Promise.all([
      downscaleImage(file, MAX_IMAGE_EDGE, IMAGE_QUALITY),
      downscaleImage(file, THUMB_EDGE, 0.7),
    ]);
    return { ...base, kind: 'image', mimeType: 'image/jpeg', sendData, dataUrl };
  }

  if (isTextLike(file)) {
    const raw = await readAsText(file);
    const text = raw.length > MAX_ATTACHMENT_TEXT_CHARS
      ? `${raw.slice(0, MAX_ATTACHMENT_TEXT_CHARS)}\n…[文件过长，已截断]`
      : raw;
    return { ...base, kind: 'text', text };
  }

  // Binary formats (PDF, Office, archives) cannot be understood by a plain
  // chat-completions call, so fail loudly rather than sending useless bytes.
  throw new Error(`${file.name} 暂不支持，请上传图片或文本文件。`);
}

/** Strips request-only payloads so history stays inside the storage quota. */
function stripAttachmentForStorage(attachment: DirectAttachment): DirectAttachment {
  const { sendData: _sendData, ...rest } = attachment;
  if (rest.kind === 'text' && rest.text && rest.text.length > 400) {
    // Only a short excerpt is needed to show what was attached.
    return { ...rest, text: `${rest.text.slice(0, 400)}…` };
  }
  return rest;
}

export function defaultConfig(): DirectConfig {
  const provider = getProvider('doubao');
  return {
    providerId: provider.id,
    endpoint: provider.endpoint,
    model: provider.model,
    apiFormat: provider.apiFormat,
    apiKeyHeader: provider.apiKeyHeader,
    apiKeyPrefix: provider.apiKeyPrefix,
    systemPrompt: DEFAULT_SYSTEM_PROMPT,
    temperature: 0.7,
  };
}

/**
 * Switching providers loads that vendor's defaults. Custom entries keep
 * whatever the user already typed so picking "custom" does not wipe their work.
 */
export function applyProviderConfig(config: DirectConfig, providerId: string): DirectConfig {
  const provider = getProvider(providerId);
  const wasCustom = isCustomProvider(config.providerId);
  const nowCustom = isCustomProvider(provider.id);
  return {
    ...config,
    providerId: provider.id,
    // Preserve typed values when moving between the two custom entries;
    // otherwise seed the vendor defaults, which stay fully editable.
    endpoint: nowCustom ? (wasCustom ? config.endpoint : '') : provider.endpoint,
    model: nowCustom ? (wasCustom ? config.model : '') : provider.model,
    apiFormat: provider.apiFormat,
    apiKeyHeader: provider.apiKeyHeader,
    apiKeyPrefix: provider.apiKeyPrefix,
  };
}

export function configComplete(config: DirectConfig): boolean {
  try {
    validateDirectConfig(config);
    return true;
  } catch {
    return false;
  }
}

function normalizeEndpoint(value: string): string {
  const parsed = new URL(value.trim());
  if (parsed.protocol !== 'https:') throw new Error('API 地址必须使用 HTTPS。');
  if (parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new Error('API 地址不能包含账号、密码、查询参数或片段。');
  }
  const cleanPath = parsed.pathname.replace(/\/+$/, '');
  return `${parsed.origin}${cleanPath === '/' ? '' : cleanPath}`;
}

function isCustomProvider(providerId: string): boolean {
  return providerId === 'custom' || providerId === 'custom-anthropic';
}

/**
 * Normalizes stored/edited settings. The endpoint and model are always taken
 * from the user's input (falling back to the vendor default only when blank),
 * so a self-hosted proxy or a region-specific host can be used with any
 * provider preset instead of being silently reset to the built-in URL.
 */
function normalizeConfig(candidate: Partial<DirectConfig> | null | undefined): DirectConfig {
  const fallback = defaultConfig();
  const requestedProvider = String(candidate?.providerId || fallback.providerId);
  const provider = getProvider(requestedProvider);
  const temperatureValue = Number(candidate?.temperature);
  const temperature = Number.isFinite(temperatureValue)
    ? Math.min(1.2, Math.max(0, temperatureValue))
    : fallback.temperature;
  const systemPrompt = String(candidate?.systemPrompt || fallback.systemPrompt).slice(0, MAX_SYSTEM_PROMPT_CHARS);
  const endpoint = String(candidate?.endpoint ?? '').trim().slice(0, 2_000) || provider.endpoint;
  const model = String(candidate?.model ?? '').trim().slice(0, MAX_MODEL_CHARS) || provider.model;

  return {
    providerId: provider.id,
    endpoint,
    model,
    // Wire format and auth header stay tied to the preset: they decide how the
    // request body and headers are built, and a wrong pick just breaks calls.
    apiFormat: provider.apiFormat,
    apiKeyHeader: provider.apiKeyHeader,
    apiKeyPrefix: provider.apiKeyPrefix,
    systemPrompt,
    temperature,
  };
}

export function validateDirectConfig(config: DirectConfig): string {
  const safeConfig = normalizeConfig(config);
  if (!safeConfig.endpoint) throw new Error('请填写 API 地址。');
  const endpoint = normalizeEndpoint(safeConfig.endpoint);
  if (!safeConfig.model) throw new Error('请填写模型名称。');
  return endpoint;
}

export function loadConfig(): DirectConfig {
  try {
    const parsed = JSON.parse(localStorage.getItem(CONFIG_STORAGE_KEY) || 'null') as Partial<DirectConfig> | null;
    return normalizeConfig(parsed);
  } catch {
    return defaultConfig();
  }
}

export function saveConfig(config: DirectConfig) {
  const safeConfig = normalizeConfig(config);
  validateDirectConfig(safeConfig);
  localStorage.setItem(CONFIG_STORAGE_KEY, JSON.stringify(safeConfig));
}

function apiKeyStorageKey(providerId: string): string {
  const provider = getProvider(providerId);
  return `api_key_${provider.id.replace(/[^a-z0-9_-]/gi, '_')}`;
}

export async function loadApiKey(providerId: string): Promise<string> {
  try {
    const keyName = apiKeyStorageKey(providerId);
    const stored = await secureGet(SECURE_STORAGE_PREFIX, keyName);
    if (stored) return stored;

    // One-time migration from the pre-1.0 global key into its current provider.
    const legacy = await secureGet(SECURE_STORAGE_PREFIX, LEGACY_SECRET_KEY);
    if (legacy) {
      await secureSet(SECURE_STORAGE_PREFIX, keyName, legacy);
      await secureRemove(SECURE_STORAGE_PREFIX, LEGACY_SECRET_KEY);
      return legacy;
    }
    return '';
  } catch {
    return '';
  }
}

export async function saveApiKey(providerId: string, apiKey: string) {
  await secureSet(SECURE_STORAGE_PREFIX, apiKeyStorageKey(providerId), apiKey.trim());
}

export async function clearApiKey(providerId: string) {
  await secureRemove(SECURE_STORAGE_PREFIX, apiKeyStorageKey(providerId));
}

export interface DirectImageConfig {
  enabled: boolean;
  /** OpenAI-compatible image base URL, e.g. https://api.openai.com/v1 */
  endpoint: string;
  /** Image model id, e.g. gpt-image-1 or dall-e-3 */
  model: string;
  size: string;
  /** `manual` only fires when the user taps the generate button; `auto` also
   *  triggers on messages that look like image requests. */
  mode: 'manual' | 'auto';
}

const IMAGE_CONFIG_STORAGE_KEY = 'trylo.direct.image.v1';
const IMAGE_API_KEY_NAME = 'image_api_key';
const IMAGE_SIZES = ['1024x1024', '1792x1024', '1024x1792'];

export function defaultImageConfig(): DirectImageConfig {
  return {
    enabled: false,
    endpoint: 'https://api.openai.com/v1',
    model: 'gpt-image-1',
    size: '1024x1024',
    mode: 'manual',
  };
}

function normalizeImageConfig(candidate: Partial<DirectImageConfig> | null | undefined): DirectImageConfig {
  const fallback = defaultImageConfig();
  return {
    enabled: candidate?.enabled === true,
    endpoint: String(candidate?.endpoint ?? '').trim() || fallback.endpoint,
    model: String(candidate?.model ?? '').trim() || fallback.model,
    size: IMAGE_SIZES.includes(String(candidate?.size)) ? String(candidate?.size) : fallback.size,
    mode: candidate?.mode === 'auto' ? 'auto' : 'manual',
  };
}

export function loadImageConfig(): DirectImageConfig {
  try {
    const parsed = JSON.parse(localStorage.getItem(IMAGE_CONFIG_STORAGE_KEY) || 'null') as Partial<DirectImageConfig> | null;
    return normalizeImageConfig(parsed);
  } catch {
    return defaultImageConfig();
  }
}

export function saveImageConfig(config: DirectImageConfig) {
  try {
    localStorage.setItem(IMAGE_CONFIG_STORAGE_KEY, JSON.stringify(normalizeImageConfig(config)));
  } catch {
    // Storage may be full; best effort.
  }
}

export function imageConfigComplete(config: DirectImageConfig): boolean {
  return Boolean(config.enabled && config.endpoint && config.model);
}

export async function loadImageApiKey(): Promise<string> {
  try {
    return (await secureGet(SECURE_STORAGE_PREFIX, IMAGE_API_KEY_NAME)) || '';
  } catch {
    return '';
  }
}

export async function saveImageApiKey(apiKey: string) {
  await secureSet(SECURE_STORAGE_PREFIX, IMAGE_API_KEY_NAME, apiKey.trim());
}

export async function clearImageApiKey() {
  await secureRemove(SECURE_STORAGE_PREFIX, IMAGE_API_KEY_NAME);
}

/**
 * Lightweight, offline heuristic for whether a message is asking the model to
 * produce an image. Used by "auto" mode so the image API is only hit when the
 * user clearly wants a picture, not for every message.
 */
const IMAGE_REQUEST_PATTERNS: RegExp[] = [
  /画[一了张幅个只件]/,
  /绘制/,
  /生成.*图(片|像)?/,
  /画图/,
  /出[一了]?张?图/,
  /配图/,
  /插画/,
  /海报/,
  /头像/,
  /壁纸/,
  /图标/,
  /生图/,
  /出图/,
  /帮我画/,
  /给我画/,
  /来一张.*图/,
  /一张.*的图/,
  /图片.*生成/,
  /卡通形象/,
  /表情包/,
  /封面图/,
  /\blogo\b/i,
  /\bdraw\b/i,
  /\bgenerate\b.*\b(image|picture|photo|illustration)\b/i,
  /\bcreate\b.*\b(image|picture|photo|illustration|artwork)\b/i,
  /\bmake\b.*\b(picture|image|illustration|drawing|art)\b/i,
  /\bpicture of\b/i,
  /\bimage of\b/i,
  /\billustrat(e|ion)\b/i,
  /\brender\b.*\b(image|scene|art)\b/i,
  /\bdesign\b.*\b(logo|poster|avatar|icon|cover)\b/i,
  /\ba photo of\b/i,
  /\ban image of\b/i,
  /\btext[- ]to[- ]image\b/i,
  /\bimage generation\b/i,
];

export function looksLikeImageRequest(text: string): boolean {
  const trimmed = text.trim();
  if (trimmed.length < 2) return false;
  const lower = trimmed.toLowerCase();
  return IMAGE_REQUEST_PATTERNS.some(pattern => pattern.test(lower));
}

function sanitizeAttachments(value: unknown): DirectAttachment[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const list = value
    .filter((item): item is Partial<DirectAttachment> => Boolean(item) && typeof item === 'object')
    .slice(0, MAX_ATTACHMENTS_PER_MESSAGE)
    .map(item => {
      const kind = item.kind === 'image' ? 'image' : 'text';
      // Only inline data URLs are allowed back in; a remote URL here would let
      // stored history trigger network requests when rendered.
      const dataUrl = typeof item.dataUrl === 'string' && item.dataUrl.startsWith('data:image/')
        ? item.dataUrl
        : undefined;
      return {
        id: String(item.id || makeId('att')).slice(0, 200),
        kind,
        name: String(item.name || 'file').slice(0, 200),
        mimeType: String(item.mimeType || '').slice(0, 100),
        size: Number.isFinite(Number(item.size)) ? Number(item.size) : 0,
        dataUrl,
        text: typeof item.text === 'string' ? item.text.slice(0, MAX_ATTACHMENT_TEXT_CHARS) : undefined,
      } satisfies DirectAttachment;
    });
  return list.length ? list : undefined;
}

function sanitizeMessage(message: Partial<DirectMessage>): DirectMessage | null {
  if (message.role !== 'user' && message.role !== 'assistant') return null;
  const text = String(message.text || '').slice(0, MAX_MESSAGE_CHARS);
  const attachments = sanitizeAttachments(message.attachments);
  // An interrupted stream is reloaded as a failure rather than a live one.
  const status = message.status === 'streaming' ? 'error' : message.status;
  const error = typeof message.error === 'string' ? message.error.slice(0, 300) : undefined;
  // A message with only attachments and no text is still meaningful, and so is
  // a failed turn: keeping it means the reason survives a reload.
  if (!text && !attachments && status !== 'error') return null;
  return {
    id: String(message.id || makeId('m')).slice(0, 200),
    role: message.role,
    text,
    at: Number.isFinite(Number(message.at)) ? Number(message.at) : Date.now(),
    status: status === 'done' || status === 'error' ? status : 'done',
    error: status === 'error' ? error : undefined,
    isImage: message.isImage === true ? true : undefined,
    // Full image bytes never reach localStorage; only the thumbnail survives.
    attachments: attachments?.map(stripAttachmentForStorage),
  };
}

function sanitizeConversations(conversations: DirectConversation[]): DirectConversation[] {
  return conversations
    .filter(item => item && typeof item === 'object')
    .map(item => ({
      id: String(item.id || makeId('c')).slice(0, 200),
      title: String(item.title || '').slice(0, 100),
      updatedAt: Number.isFinite(Number(item.updatedAt)) ? Number(item.updatedAt) : Date.now(),
      messages: Array.isArray(item.messages)
        ? item.messages.slice(-MAX_MESSAGES_PER_CONVERSATION).map(sanitizeMessage).filter((item): item is DirectMessage => Boolean(item))
        : [],
    }))
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .slice(0, MAX_CONVERSATIONS);
}

export function loadConversations(): DirectConversation[] {
  try {
    const parsed = JSON.parse(localStorage.getItem(CONVERSATIONS_STORAGE_KEY) || '[]') as DirectConversation[];
    if (!Array.isArray(parsed)) return [];
    return sanitizeConversations(parsed);
  } catch {
    return [];
  }
}

export function persistConversations(conversations: DirectConversation[]): DirectConversation[] {
  const safeConversations = sanitizeConversations(conversations);
  try {
    localStorage.setItem(CONVERSATIONS_STORAGE_KEY, JSON.stringify(safeConversations));
  } catch {
    // Storage may be full; best effort.
  }
  return safeConversations;
}

export function deriveTitle(text: string): string {
  const clean = text.replace(/\s+/g, ' ').trim();
  return clean.length > 22 ? `${clean.slice(0, 22)}…` : clean;
}

interface StreamOptions {
  config: DirectConfig;
  apiKey: string;
  messages: DirectMessage[];
  signal?: AbortSignal;
  onDelta: (delta: string) => void;
  /** Diagnostics surfaced in the UI so context transmission can be verified on-device. */
  onDebug?: (info: { rawCount: number; sentCount: number; roles: string[]; model: string }) => void;
}

export async function streamChat({ config, apiKey, messages, signal, onDelta, onDebug }: StreamOptions): Promise<string> {
  const safeConfig = normalizeConfig(config);
  const endpoint = validateDirectConfig(safeConfig);
  if (!apiKey.trim()) throw new Error('请先在设置中填写 API Key。');

  const contextMessages = selectContextMessages(messages);
  // Temporary diagnostics: proves exactly what the app sends so we can tell an
  // app-side context bug from a proxy/model issue. Remove once the cause is found.
  const debugInfo = {
    rawCount: messages.length,
    sentCount: contextMessages.length,
    roles: contextMessages.map(item => item.role),
    model: safeConfig.model,
  };
  try {
    // eslint-disable-next-line no-console
    console.debug('[directChat] outgoing', { ...debugInfo, apiFormat: safeConfig.apiFormat, endpoint });
  } catch { /* ignore */ }
  onDebug?.(debugInfo);
  if (safeConfig.apiFormat === 'anthropic') {
    return streamAnthropic({ endpoint, config: safeConfig, apiKey, messages: contextMessages, signal, onDelta });
  }
  return streamOpenAi({ endpoint, config: safeConfig, apiKey, messages: contextMessages, signal, onDelta });
}

/**
 * Picks the messages that actually reach the model. To stop long chats from
 * silently forgetting the facts stated at the very start (e.g. "A is B's
 * father"), the earliest message in the window is pinned as an anchor and
 * always kept; everything else is taken newest-first so the most recent turns
 * win the character budget, then re-ordered chronologically.
 */
function selectContextMessages(messages: DirectMessage[]): DirectMessage[] {
  const windowed = messages.slice(-MAX_CONTEXT_MESSAGES);
  if (windowed.length === 0) return [];

  const anchor = windowed[0];
  const tail = windowed.slice(1);

  const build = (list: DirectMessage[]): DirectMessage[] => {
    const out: DirectMessage[] = [];
    let characters = 0;
    for (const message of list) {
      const text = String(message.text || '').slice(0, MAX_MESSAGE_CHARS);
      const hasAttachments = Boolean(message.attachments?.length);
      if (!text && !hasAttachments) continue;
      const remaining = MAX_CONTEXT_CHARS - characters;
      if (remaining <= 0) break;
      out.push({ ...message, text: text.slice(Math.max(0, text.length - remaining)) });
      characters += Math.min(text.length, remaining);
    }
    return out;
  };

  // The anchor (conversation's first kept message) is always retained, capped
  // small so it never starves the recent context of the budget.
  const anchorText = String(anchor.text || '').slice(0, 4000);
  const anchorMsg = anchorText || anchor.attachments?.length
    ? [{ ...anchor, text: anchorText }]
    : [];

  const tailNewestFirst = build([...tail].reverse());
  const tailChrono = tailNewestFirst.reverse();

  return [...anchorMsg, ...tailChrono];
}

interface StreamDialect {
  url: string;
  headers: Record<string, string>;
  body: string;
  /** Reads one incremental delta out of a single SSE `data:` payload. */
  extractDelta: (payload: string) => string;
  /** Reads the whole answer when a provider ignores `stream: true`. */
  extractWhole: (raw: string) => string;
}

interface ResponseAccumulator {
  readonly value: string;
  /** Returns false once nothing more may be appended. */
  push: (delta: string) => boolean;
}

function createAccumulator(onDelta: (delta: string) => void): ResponseAccumulator {
  let text = '';
  let closed = false;

  const closeTruncated = () => {
    closed = true;
    text += RESPONSE_TRUNCATED_NOTICE;
    onDelta(RESPONSE_TRUNCATED_NOTICE);
  };

  return {
    get value() {
      return text;
    },
    push(delta: string) {
      if (closed) return false;
      if (!delta) return true;
      const remaining = MAX_MESSAGE_CHARS - RESPONSE_TRUNCATED_NOTICE.length - text.length;
      if (remaining <= 0) {
        closeTruncated();
        return false;
      }
      const accepted = delta.slice(0, remaining);
      if (accepted) {
        text += accepted;
        onDelta(accepted);
      }
      if (accepted.length < delta.length) {
        closeTruncated();
        return false;
      }
      return true;
    },
  };
}

function abortError(): Error {
  return new DOMException('Aborted', 'AbortError') as unknown as Error;
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
}

function delay(ms: number): Promise<void> {
  return new Promise(resolve => { window.setTimeout(resolve, ms); });
}

/**
 * Capacitor's native bridge replaces `window.fetch` with a buffered native
 * request when the CapacitorHttp plugin is enabled, which removes both
 * `ReadableStream` streaming and `AbortSignal` support. The bridge keeps the
 * untouched WebView implementation on `window.CapacitorWebFetch`, so we try
 * that first to get real token-by-token streaming and only fall back to the
 * native path when the provider refuses the WebView origin (CORS).
 */
function webViewFetch(): typeof fetch | null {
  const candidate = (globalThis as { CapacitorWebFetch?: typeof fetch }).CapacitorWebFetch;
  return typeof candidate === 'function' ? candidate : null;
}

function linkAbort(signal: AbortSignal | undefined, timeoutMs: number) {
  const controller = new AbortController();
  const state = { timedOut: false };
  const forward = () => controller.abort();

  if (signal) {
    if (signal.aborted) controller.abort();
    else signal.addEventListener('abort', forward, { once: true });
  }
  const timer = window.setTimeout(() => {
    state.timedOut = true;
    controller.abort();
  }, timeoutMs);

  return {
    signal: controller.signal,
    get timedOut() {
      return state.timedOut;
    },
    dispose() {
      window.clearTimeout(timer);
      signal?.removeEventListener('abort', forward);
    },
  };
}

function describeHttpError(status: number, detail: string): string {
  const trimmed = detail.trim();
  const suffix = trimmed ? `：${trimmed}` : '。';
  if (status === 401 || status === 403) {
    return `API Key 无效或没有访问权限（HTTP ${status}），请在设置里检查 Key${suffix}`;
  }
  if (status === 404) {
    return `接口地址或模型不存在（HTTP 404），请检查 API 地址与模型名${suffix}`;
  }
  if (status === 429) {
    return `请求过于频繁或额度不足（HTTP 429），请稍后再试${suffix}`;
  }
  if (status >= 500) {
    return `模型服务商暂时不可用（HTTP ${status}），请稍后再试${suffix}`;
  }
  return `接口返回 ${status}${suffix}`;
}

async function openStream(
  dialect: StreamDialect,
  signal: AbortSignal,
): Promise<{ response: Response; streamable: boolean }> {
  const init: RequestInit = { method: 'POST', signal, headers: dialect.headers, body: dialect.body };

  const direct = webViewFetch();
  if (direct) {
    try {
      const response = await direct(dialect.url, init);
      return { response, streamable: Boolean(response.body) };
    } catch (error) {
      // A refused CORS preflight lands here; the native bridge can still run it.
      if (isAbortError(error)) throw error;
    }
  }

  const response = await fetch(dialect.url, init);
  return { response, streamable: Boolean(response.body) && direct === null };
}

function parseSseChunk(
  buffer: string,
  dialect: StreamDialect,
  accumulator: ResponseAccumulator,
): { rest: string; open: boolean } {
  const lines = buffer.split('\n');
  const rest = lines.pop() || '';
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line.startsWith('data:')) continue;
    const payload = line.slice(5).trim();
    if (!payload || payload === '[DONE]') continue;
    let delta = '';
    try {
      delta = dialect.extractDelta(payload);
    } catch {
      continue; // Keep-alive comments and malformed frames are skipped.
    }
    if (delta && !accumulator.push(delta)) return { rest: '', open: false };
  }
  return { rest, open: true };
}

async function consumeLiveStream(
  response: Response,
  dialect: StreamDialect,
  accumulator: ResponseAccumulator,
): Promise<void> {
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      if (buffer.length > MAX_SSE_BUFFER_CHARS) {
        throw new Error('模型响应格式异常，已停止接收。');
      }
      const parsed = parseSseChunk(buffer, dialect, accumulator);
      buffer = parsed.rest;
      if (!parsed.open) return;
    }
    if (buffer.trim()) parseSseChunk(`${buffer}\n`, dialect, accumulator);
  } finally {
    await reader.cancel().catch(() => undefined);
  }
}

function collectBufferedText(raw: string, dialect: StreamDialect): string {
  let collected = '';
  for (const rawLine of raw.split('\n')) {
    const line = rawLine.trim();
    if (!line.startsWith('data:')) continue;
    const payload = line.slice(5).trim();
    if (!payload || payload === '[DONE]') continue;
    try {
      collected += dialect.extractDelta(payload);
    } catch {
      // Ignore malformed frames.
    }
  }
  if (collected) return collected;
  try {
    return dialect.extractWhole(raw);
  } catch {
    return '';
  }
}

/**
 * The native bridge hands back the finished body in one piece. Reveal it in
 * small slices so the bubble still animates instead of snapping into place.
 */
async function revealBufferedText(
  text: string,
  accumulator: ResponseAccumulator,
  signal: AbortSignal | undefined,
): Promise<void> {
  if (!text) return;
  const step = Math.max(2, Math.ceil(text.length / REVEAL_STEPS));
  for (let index = 0; index < text.length; index += step) {
    if (signal?.aborted) throw abortError();
    if (!accumulator.push(text.slice(index, index + step))) return;
    if (index + step < text.length) await delay(REVEAL_INTERVAL_MS);
  }
}

async function runChatStream(
  dialect: StreamDialect,
  signal: AbortSignal | undefined,
  onDelta: (delta: string) => void,
): Promise<string> {
  const accumulator = createAccumulator(onDelta);
  const link = linkAbort(signal, REQUEST_TIMEOUT_MS);

  try {
    const { response, streamable } = await openStream(dialect, link.signal);
    if (!response.ok) throw new Error(describeHttpError(response.status, await safeErrorText(response)));

    if (streamable) await consumeLiveStream(response, dialect, accumulator);
    else await revealBufferedText(collectBufferedText(await response.text(), dialect), accumulator, signal);
  } catch (error) {
    if (isAbortError(error)) {
      if (link.timedOut && !signal?.aborted) {
        throw new Error('请求超时，模型没有在 2 分钟内响应，请检查网络或稍后再试。');
      }
      if (accumulator.value) return accumulator.value;
      throw error;
    }
    if (error instanceof TypeError) {
      throw new Error('无法连接模型服务商，请检查手机网络和 API 地址。');
    }
    throw error;
  } finally {
    link.dispose();
  }

  if (!accumulator.value) throw new Error('接口没有返回任何内容，请检查模型名称是否正确。');
  return accumulator.value;
}


/**
 * Text attachments are inlined as fenced blocks so any model can read them,
 * including ones without vision support.
 */
function inlineTextAttachments(message: DirectMessage): string {
  const files = (message.attachments || []).filter(item => item.kind === 'text' && item.text);
  if (!files.length) return message.text;
  const blocks = files.map(file => `附件《${file.name}》内容：\n\`\`\`\n${file.text}\n\`\`\``);
  return [message.text, ...blocks].filter(Boolean).join('\n\n');
}

/** Splits a data URL into its media type and bare base64 payload. */
function splitDataUrl(dataUrl: string): { mediaType: string; data: string } | null {
  const match = /^data:([^;,]+);base64,(.+)$/.exec(dataUrl);
  return match ? { mediaType: match[1], data: match[2] } : null;
}

function imageAttachments(message: DirectMessage): DirectAttachment[] {
  return (message.attachments || []).filter(item => item.kind === 'image' && (item.sendData || item.dataUrl));
}

/**
 * OpenAI-compatible content: a parts array only when images are present.
 * Images are only attached to *user* turns — assistant turns with image
 * content (e.g. a generated picture) make the API reject the whole request,
 * which would otherwise look like the chat lost its context.
 */
function openAiContent(message: DirectMessage): unknown {
  const text = inlineTextAttachments(message);
  const images = message.role === 'user' ? imageAttachments(message) : [];
  if (!images.length) return text;
  return [
    ...(text ? [{ type: 'text', text }] : []),
    ...images.map(image => ({
      type: 'image_url',
      image_url: { url: image.sendData || image.dataUrl },
    })),
  ];
}

/** Anthropic wants base64 split out of the data URL into a source object.
 *  Like the OpenAI path, images are attached only to user turns so an
 *  assistant-generated picture never breaks the following request. */
function anthropicContent(message: DirectMessage): unknown {
  const text = inlineTextAttachments(message);
  const images = message.role === 'user' ? imageAttachments(message) : [];
  if (!images.length) return text;
  const blocks: unknown[] = [];
  for (const image of images) {
    const parts = splitDataUrl(image.sendData || image.dataUrl || '');
    if (!parts) continue;
    blocks.push({ type: 'image', source: { type: 'base64', media_type: parts.mediaType, data: parts.data } });
  }
  // Claude follows instructions better when the images precede the question.
  if (text) blocks.push({ type: 'text', text });
  return blocks.length ? blocks : text;
}

function streamOpenAi({ endpoint, config, apiKey, messages, signal, onDelta }: StreamOptions & { endpoint: string }) {
  const dialect: StreamDialect = {
    url: `${endpoint}/chat/completions`,
    headers: {
      'Content-Type': 'application/json',
      Accept: 'text/event-stream',
      [config.apiKeyHeader]: `${config.apiKeyPrefix}${apiKey}`,
    },
    body: JSON.stringify({
      model: config.model,
      stream: true,
      temperature: config.temperature,
      messages: [
        { role: 'system', content: config.systemPrompt || DEFAULT_SYSTEM_PROMPT },
        ...messages.map(message => ({ role: message.role, content: openAiContent(message) })),
      ],
    }),
    extractDelta: payload => {
      const parsed = JSON.parse(payload) as {
        choices?: Array<{ delta?: { content?: string }; message?: { content?: string } }>;
      };
      return parsed.choices?.[0]?.delta?.content ?? parsed.choices?.[0]?.message?.content ?? '';
    },
    extractWhole: raw => {
      const parsed = JSON.parse(raw) as { choices?: Array<{ message?: { content?: string } }> };
      return parsed.choices?.[0]?.message?.content ?? '';
    },
  };
  return runChatStream(dialect, signal, onDelta);
}

function streamAnthropic({ endpoint, config, apiKey, messages, signal, onDelta }: StreamOptions & { endpoint: string }) {
  const dialect: StreamDialect = {
    url: `${endpoint}/v1/messages`,
    headers: {
      'Content-Type': 'application/json',
      Accept: 'text/event-stream',
      'anthropic-version': '2023-06-01',
      [config.apiKeyHeader]: `${config.apiKeyPrefix}${apiKey}`,
    },
    body: JSON.stringify({
      model: config.model,
      max_tokens: 4096,
      stream: true,
      temperature: config.temperature,
      system: config.systemPrompt || DEFAULT_SYSTEM_PROMPT,
      messages: messages.map(message => ({ role: message.role, content: anthropicContent(message) })),
    }),
    extractDelta: payload => {
      const parsed = JSON.parse(payload) as { type?: string; delta?: { text?: string } };
      return parsed.type === 'content_block_delta' ? parsed.delta?.text ?? '' : '';
    },
    extractWhole: raw => {
      const parsed = JSON.parse(raw) as { content?: Array<{ text?: string }> };
      return (parsed.content || []).map(block => block.text || '').join('');
    },
  };
  return runChatStream(dialect, signal, onDelta);
}
async function safeErrorText(response: Response): Promise<string> {
  try {
    const raw = await response.text();
    if (!raw) return response.statusText;
    try {
      const parsed = JSON.parse(raw) as { error?: { message?: string } | { message?: string }; message?: string };
      if (parsed.error) {
        const error = parsed.error as { message?: string };
        return error.message || raw.slice(0, 300);
      }
      return parsed.message || raw.slice(0, 300);
    } catch {
      return raw.slice(0, 300);
    }
  } catch {
    return response.statusText;
  }
}

/**
 * Calls an OpenAI-compatible image API (`/images/generations`) and returns the
 * resulting picture as a data URL so it can be dropped straight into a chat
 * message as an attachment. Separate from the chat config on purpose: image
 * models usually live behind a different endpoint/key than the text model.
 */
export interface GeneratedImage {
  dataUrl: string;
  name: string;
}

export async function generateImage(options: {
  config: DirectImageConfig;
  apiKey: string;
  prompt: string;
  signal?: AbortSignal;
}): Promise<GeneratedImage> {
  const { config, apiKey, prompt, signal } = options;
  const base = normalizeImageEndpoint(config.endpoint);
  const url = `${base}/images/generations`;
  const body = JSON.stringify({
    model: config.model,
    prompt: prompt.slice(0, 4000),
    n: 1,
    size: config.size,
    response_format: 'b64_json',
  });

  const link = linkAbort(signal, REQUEST_TIMEOUT_MS);
  try {
    const fetchFn = webViewFetch() || fetch;
    const response = await fetchFn(url, {
      method: 'POST',
      signal: link.signal,
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        Authorization: `Bearer ${apiKey.trim()}`,
      },
      body,
    });
    if (!response.ok) {
      throw new Error(describeHttpError(response.status, await safeErrorText(response)));
    }
    const json = await response.json() as { data?: Array<{ b64_json?: string; url?: string }> };
    const item = json.data?.[0];
    if (!item) throw new Error('生图接口返回格式异常。');
    let dataUrl: string | undefined;
    if (item.b64_json) dataUrl = `data:image/png;base64,${item.b64_json}`;
    else if (item.url) dataUrl = await fetchUrlAsDataUrl(item.url);
    if (!dataUrl) throw new Error('生图接口没有返回可用的图片。');
    return { dataUrl, name: `trylo-image-${Date.now()}.png` };
  } catch (error) {
    if (isAbortError(error)) throw error;
    if (error instanceof TypeError) {
      throw new Error('无法连接生图服务商，请检查网络或 API 地址。');
    }
    throw error;
  } finally {
    link.dispose();
  }
}

function normalizeImageEndpoint(value: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value.trim());
  } catch {
    throw new Error('请填写有效的生图 API 地址。');
  }
  if (parsed.protocol !== 'https:') throw new Error('生图 API 地址必须使用 HTTPS。');
  const path = parsed.pathname.replace(/\/+$/, '').replace(/\/images\/generations$/i, '');
  return `${parsed.origin}${path === '/' ? '' : path}`;
}

async function fetchUrlAsDataUrl(url: string): Promise<string | undefined> {
  try {
    const fetchFn = webViewFetch() || fetch;
    const response = await fetchFn(url);
    if (!response.ok) return undefined;
    const blob = await response.blob();
    return await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result || ''));
      reader.onerror = () => reject(new Error('读取生图结果失败'));
      reader.readAsDataURL(blob);
    });
  } catch {
    return undefined;
  }
}
