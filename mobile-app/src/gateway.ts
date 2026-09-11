import { secureGet, secureRemove, secureSet } from './secureStorage';
import type { DirectAttachment } from './directChat';

export type AgentStatus = 'idle' | 'thinking' | 'running' | 'waiting' | 'done' | 'failed';
/** Code modes the Desktop supervisor understands. `office` is a legacy alias
 *  kept for old snapshots (the Desktop has no Office mode anymore — its top
 *  level is Code / Work and Code modes are agent / plan / chat / cognition).
 *  The frozen gateway normalizes unknown modes to `agent`, so `cognition`
 *  survives the phone's local echo but arrives back normalized. */
export type AgentMode = 'agent' | 'plan' | 'chat' | 'cognition' | 'office';
export type TimelineKind = 'thinking' | 'inspect' | 'change' | 'command' | 'approval' | 'progress';

/** Which Desktop surface a remote message targets. Code runs through the
 *  supervisor; Work runs through the Work chat adapter (CLI single-core).
 *  Sent as `surface` in POST /v1/chat/messages — the vendored gateway
 *  forwards the body opaquely to the Desktop `task` handler. */
export type RemoteSurface = 'code' | 'work';

export interface TimelineEvent {
  id: string;
  title: string;
  detail: string;
  state: 'done' | 'active' | 'queued';
  at: string;
  kind?: TimelineKind;
}

export interface RemoteSnapshot {
  device: {
    id: string;
    name: string;
    workspace: string;
    online: boolean;
    latencyMs: number;
    lastSeenAt: number;
  };
  agent: {
    status: AgentStatus;
    title: string;
    detail: string;
    progress: number;
    elapsed: string;
    mode: AgentMode;
    phase: string;
    finalResponse: { text: string; at: number } | null;
    technicalEventCount: number;
    timeline: TimelineEvent[];
  };
  activeSessionId: string;
  conversation: RemoteChatMessage[];
  activeProjectId: string;
  projects: Array<{
    id: string;
    name: string;
    lastSeenAt: number;
    path?: string;
  }>;
  sessions: Array<{
    id: string;
    title: string;
    preview: string;
    updatedAt: string | number;
    active?: boolean;
    workspace?: {
      id: string;
      name: string;
      path?: string;
    } | null;
  }>;
  approvals: Array<{
    id: string;
    category: 'command' | 'write' | 'network';
    title: string;
    detail: string;
    description?: string;
    toolName?: string;
    blockedPath?: string;
    decisionReason?: string;
    risk: 'low' | 'medium' | 'high';
    requestedAt: string | number;
  }>;
}

export interface GatewayConfig {
  baseUrl: string;
  token?: string;
  demo?: boolean;
  deviceId?: string;
  deviceName?: string;
}

export interface PairingData {
  protocol: number;
  service: string;
  deviceId: string;
  deviceName: string;
  workspaceName: string;
  baseUrl: string;
  token: string;
}

export type GatewayConnectionState = 'connecting' | 'connected' | 'reconnecting' | 'offline';

/** @deprecated Fun (猫箱) is not supported by the current Desktop — the
 *  fun gateway handler answers 501 (see desktop remote-routing). These
 *  types and the fun client methods below stay only so old demo code keeps
 *  compiling; the remote UI no longer calls them. */
export interface FunCharacter {
  id: string;
  name: string;
  avatar: string;
  avatarImage?: string;
  accent: string;
  intro: string;
  opening: string;
  custom?: boolean;
}

export interface FunMessage {
  id: string;
  role: 'user' | 'assistant';
  text: string;
  at: number;
  status?: 'streaming' | 'done';
}

export interface FunMemory {
  impression: string;
  facts: Array<{ text: string; time?: number }>;
}

export interface FunState {
  characters: FunCharacter[];
  histories: Record<string, FunMessage[]>;
}

export interface FunChatEvent {
  type: 'chat_started' | 'chat_delta' | 'chat_complete' | 'chat_error' | 'fun_history_cleared' | 'funHistoryState';
  requestId: string;
  characterId?: string;
  delta?: string;
  text?: string;
  error?: string;
  messages?: FunMessage[];
  at?: number;
}

export interface RemoteChatMessage {
  id: string;
  role: 'user' | 'assistant' | 'thinking';
  title?: string;
  text: string;
  at: string | number;
  status?: 'streaming' | 'done';
  mode?: AgentMode;
  turnId?: string;
  /** Files (images / text) the user attached on the phone; not persisted
   *  in history and only meaningful for the local echo of an outgoing turn. */
  attachments?: DirectAttachment[];
}

export interface RemoteChatEvent {
  type: 'chat_started' | 'chat_delta' | 'chat_complete' | 'chat_error';
  requestId: string;
  delta?: string;
  text?: string;
  error?: string;
  at?: number;
}

/** A Work deliverable (`.trylo/out` entry) listed by GET /v1/artifacts. */
export interface RemoteArtifact {
  id: string;
  name: string;
  kind: string;
  size: number;
  modifiedAt: number;
}

/** One deliverable's bytes (GET /v1/artifacts/content?path=). */
export interface RemoteArtifactContent {
  name: string;
  mimeType: string;
  blob: Blob;
}

const LEGACY_STORAGE_KEY = 'trylo-remote.gateway.v1';
const METADATA_KEY = 'trylo-remote.gateway.metadata.v1';
const SECRET_KEY = 'gateway_token';
const SECURE_STORAGE_PREFIX = 'trylo_remote_';

type GatewayMetadata = Pick<GatewayConfig, 'baseUrl' | 'deviceId' | 'deviceName'>;

const demoSnapshot: RemoteSnapshot = {
  device: {
    id: 'dev-mainboard',
    name: 'DESKTOP-MAINBOARD',
    workspace: 'mini-vscode-agent · 主板',
    online: true,
    latencyMs: 38,
    lastSeenAt: Date.now(),
  },
  agent: {
    status: 'running',
    title: '正在构建 Trylo Remote',
    detail: '正在验证移动端界面与 Gateway 协议',
    progress: 68,
    elapsed: '02:41',
    mode: 'agent',
    phase: 'running',
    finalResponse: null,
    technicalEventCount: 3,
    timeline: [
      { id: 'e1', title: '理解任务', detail: '确定 Ionic + Capacitor 技术路线', kind: 'thinking', state: 'done', at: '14:08' },
      { id: 'e2', title: '读取项目', detail: '确认现有状态与权限通信接口', kind: 'inspect', state: 'done', at: '14:09' },
      { id: 'e3', title: '编写文件', detail: '生成手机端组件与主题', kind: 'change', state: 'active', at: '现在' },
      { id: 'e4', title: '构建验证', detail: '等待执行', kind: 'command', state: 'queued', at: '稍后' },
    ],
  },
  activeSessionId: 's1',
  activeProjectId: 'project-mainboard',
  projects: [
    { id: 'project-mainboard', name: 'mini-vscode-agent · 主板', lastSeenAt: Date.now() },
    { id: 'project-website', name: 'Trylo Website', lastSeenAt: Date.now() - 86_400_000 },
  ],
  conversation: [
    { id: 'c1', role: 'user', text: '把手机端执行过程整理得更清楚。', at: Date.now() - 90_000, mode: 'agent' },
    { id: 'c2', role: 'thinking', title: '正在整理界面层级', text: '先分离任务状态、关键步骤和最终回复，再减少内部诊断信息。', at: Date.now() - 70_000, mode: 'agent', status: 'done' },
    {
      id: 'c3',
      role: 'assistant',
      text: '已经整理好移动端渲染：\n\n| 内容 | 支持情况 |\n| --- | --- |\n| 表格 | 支持横向滚动 |\n| 代码 | 支持一键复制 |\n\n```ts\nconst project = await gateway.selectProject(projectId);\n```',
      at: Date.now() - 40_000,
      mode: 'agent',
    },
  ],
  sessions: [
    { id: 's1', title: '远程功能方案', preview: '先完成 App，再接入电脑端 Gateway…', updatedAt: '刚刚', active: true },
    { id: 's2', title: 'Agent 时间线优化', preview: '工具调用现在按真实执行顺序呈现。', updatedAt: '昨天' },
    { id: 's3', title: 'Office 模式', preview: '完成附件预览和文档生成验证。', updatedAt: '8 月 10 日' },
  ],
  approvals: [
    {
      id: 'p1',
      category: 'command',
      title: '执行构建命令',
      detail: 'npm.cmd run build',
      description: '构建最新的 Trylo Remote 前端资源并检查 TypeScript 类型。',
      toolName: 'shell_command',
      blockedPath: '[workspace]/mobile-app',
      risk: 'low',
      requestedAt: '刚刚',
    },
  ],
};

const demoFunCharacters: FunCharacter[] = [
  { id: 'gentle-sister', name: '温柔邻家姐姐', avatar: '👩‍🦰', accent: '#f1a7bd', intro: '从小陪你长大的温柔姐姐，总是耐心听你说话', opening: '今天过得怎么样？慢慢说，我在听。' },
  { id: 'cool-classmate', name: '高冷学霸同桌', avatar: '📚', accent: '#8aa8ff', intro: '嘴上嫌你笨，其实一直在偷偷帮你', opening: '又卡在哪里了？把问题发来，别浪费时间。' },
  { id: 'childhood-friend', name: '青梅竹马', avatar: '🌻', accent: '#f0c966', intro: '从小打打闹闹，却最懂你的人', opening: '怎么突然找我？先说好，太离谱的事我可要笑你。' },
  { id: 'senior-mentor', name: '靠谱学长', avatar: '🎓', accent: '#63d3b2', intro: '温柔可靠，擅长把复杂的事讲明白', opening: '有烦心事还是遇到难题了？我们一起理一理。' },
  { id: 'mysterious-stranger', name: '神秘陌生人', avatar: '🌙', accent: '#a78bfa', intro: '深夜咖啡馆里，那个捉摸不透的人', opening: '这个时间还没睡的人，通常都藏着一个故事。你的呢？' },
  { id: 'tsundere-cat', name: '傲娇猫娘', avatar: '🐱', accent: '#ff927e', intro: '才不是特意等你，只是刚好还没睡', opening: '你终于来了？我、我才没有一直等你呢，喵。' },
  { id: 'trylo-guide', name: 'Trylo 向导', avatar: '✦', accent: '#dcc97e', intro: '熟悉 Trylo 的每个角落，随时陪你探索', opening: '你好，我是 Trylo 向导。想聊聊产品，还是需要我陪你放松一下？' },
];

const demoFunState: FunState = {
  characters: demoFunCharacters,
  histories: Object.fromEntries(demoFunCharacters.map(character => [character.id, []])),
};

function validateGatewayBaseUrl(value: string, allowLocalHttp = false): string {
  const parsed = new URL(value.trim());
  const localHttp = allowLocalHttp
    && parsed.protocol === 'http:'
    && (parsed.hostname === '127.0.0.1' || parsed.hostname === 'localhost');
  if (parsed.protocol !== 'https:' && !localHttp) throw new Error('远程 Gateway 必须使用 HTTPS。');
  if (parsed.username || parsed.password || parsed.search || parsed.hash || (parsed.pathname && parsed.pathname !== '/')) {
    throw new Error('Gateway 地址必须是干净的站点根地址。');
  }
  return parsed.origin;
}

function normalizeBaseUrl(value: string) {
  return value.trim().replace(/\/+$/, '');
}

function loadMetadata(): GatewayMetadata | null {
  try {
    const parsed = JSON.parse(localStorage.getItem(METADATA_KEY) || 'null') as GatewayMetadata | null;
    if (!parsed?.baseUrl) return null;
    return { ...parsed, baseUrl: validateGatewayBaseUrl(parsed.baseUrl) };
  } catch {
    return null;
  }
}

function loadLegacyConfig(): GatewayConfig | null {
  try {
    const parsed = JSON.parse(localStorage.getItem(LEGACY_STORAGE_KEY) || 'null') as GatewayConfig | null;
    if (!parsed?.baseUrl || !parsed.token) return null;
    return { ...parsed, baseUrl: validateGatewayBaseUrl(parsed.baseUrl), demo: false };
  } catch {
    return null;
  }
}

function developmentConfig(): GatewayConfig | null {
  if (!import.meta.env.DEV) return null;
  const environmentUrl = String(import.meta.env.VITE_GATEWAY_URL || '').trim();
  const environmentToken = String(import.meta.env.VITE_GATEWAY_TOKEN || '').trim();
  if (environmentUrl && environmentToken && import.meta.env.VITE_GATEWAY_DEMO === 'false') {
    return { baseUrl: validateGatewayBaseUrl(environmentUrl, true), token: environmentToken, demo: false };
  }
  return null;
}

export function parsePairingData(raw: string): PairingData {
  let value: unknown;
  try {
    value = JSON.parse(raw.trim());
  } catch {
    throw new Error('配对数据不是有效的 JSON。');
  }
  if (!value || typeof value !== 'object') throw new Error('配对数据格式不正确。');
  const pairing = value as Partial<PairingData>;
  if (pairing.service !== 'trylo-remote' || pairing.protocol !== 1) {
    throw new Error('这不是受支持的 Trylo Remote 配对数据。');
  }
  let baseUrl = '';
  try {
    baseUrl = validateGatewayBaseUrl(String(pairing.baseUrl || ''), import.meta.env.DEV);
  } catch (cause) {
    throw new Error(cause instanceof Error ? cause.message : '远程 Gateway 地址无效。');
  }
  const token = String(pairing.token || '');
  if (token.length < 32) throw new Error('配对密钥不完整。');
  return {
    protocol: 1,
    service: 'trylo-remote',
    deviceId: String(pairing.deviceId || ''),
    deviceName: String(pairing.deviceName || 'Trylo computer'),
    workspaceName: String(pairing.workspaceName || 'Trylo Code'),
    baseUrl,
    token,
  };
}

export class RemoteGatewayClient {
  private config: GatewayConfig;
  private initialized = false;
  private lastLatencyMs = 0;

  constructor(config: GatewayConfig = { baseUrl: 'http://127.0.0.1:49380', demo: true }) {
    this.config = config;
  }

  async initialize() {
    if (this.initialized) return;

    let metadata = loadMetadata();
    let token = await secureGet(SECURE_STORAGE_PREFIX, SECRET_KEY);
    const legacy = loadLegacyConfig();

    if ((!metadata || !token) && legacy?.token) {
      metadata = {
        baseUrl: legacy.baseUrl,
        deviceId: legacy.deviceId,
        deviceName: legacy.deviceName,
      };
      token = legacy.token;
      await secureSet(SECURE_STORAGE_PREFIX, SECRET_KEY, token);
      localStorage.setItem(METADATA_KEY, JSON.stringify(metadata));
    }
    localStorage.removeItem(LEGACY_STORAGE_KEY);

    if (metadata && token) {
      this.config = { ...metadata, token, demo: false };
    } else {
      this.config = developmentConfig() || { baseUrl: 'http://127.0.0.1:49380', demo: true };
    }
    this.initialized = true;
  }

  get currentConfig() {
    return { ...this.config };
  }

  get isDemo() {
    return this.config.demo !== false;
  }

  async configureFromPairing(pairing: PairingData) {
    const metadata: GatewayMetadata = {
      baseUrl: pairing.baseUrl,
      deviceId: pairing.deviceId,
      deviceName: pairing.deviceName,
    };
    await secureSet(SECURE_STORAGE_PREFIX, SECRET_KEY, pairing.token);
    localStorage.setItem(METADATA_KEY, JSON.stringify(metadata));
    localStorage.removeItem(LEGACY_STORAGE_KEY);
    this.config = { ...metadata, token: pairing.token, demo: false };
    this.initialized = true;
  }

  async useDemo() {
    await secureRemove(SECURE_STORAGE_PREFIX, SECRET_KEY);
    localStorage.removeItem(METADATA_KEY);
    localStorage.removeItem(LEGACY_STORAGE_KEY);
    this.config = { baseUrl: 'http://127.0.0.1:49380', demo: true };
    this.initialized = true;
  }

  private async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const controller = new AbortController();
    const abortFromCaller = () => controller.abort();
    init.signal?.addEventListener('abort', abortFromCaller, { once: true });
    const timeout = window.setTimeout(() => controller.abort(), 45_000);
    try {
      const response = await fetch(`${normalizeBaseUrl(this.config.baseUrl)}${path}`, {
        ...init,
        signal: controller.signal,
        headers: {
          ...(init.body ? { 'Content-Type': 'application/json' } : {}),
          ...(this.config.token ? { Authorization: `Bearer ${this.config.token}` } : {}),
          ...(init.headers || {}),
        },
      });
      const payload = await response.json().catch(() => ({})) as { error?: string };
      if (!response.ok) throw new Error(payload.error || `Gateway request failed (${response.status})`);
      return payload as T;
    } finally {
      window.clearTimeout(timeout);
      init.signal?.removeEventListener('abort', abortFromCaller);
    }
  }

  async getSnapshot(): Promise<RemoteSnapshot> {
    if (this.isDemo) {
      await new Promise(resolve => window.setTimeout(resolve, 180));
      return structuredClone(demoSnapshot);
    }
    const startedAt = performance.now();
    const snapshot = await this.request<RemoteSnapshot>('/v1/snapshot');
    this.lastLatencyMs = Math.max(1, Math.round(performance.now() - startedAt));
    snapshot.device.latencyMs = this.lastLatencyMs;
    return snapshot;
  }

  async getProjects(): Promise<Pick<RemoteSnapshot, 'projects' | 'activeProjectId'>> {
    if (this.isDemo) {
      return {
        projects: structuredClone(demoSnapshot.projects),
        activeProjectId: demoSnapshot.activeProjectId,
      };
    }
    return this.request<Pick<RemoteSnapshot, 'projects' | 'activeProjectId'>>('/v1/projects');
  }

  /** Slimmed attachment shape sent to the gateway. Images travel as base64
   *  data URLs (already downscaled by `buildAttachment`); text files inline
   *  their extracted content. `sendData`/`text` are the full payloads. */
  async sendChat(text: string, attachments?: DirectAttachment[], opts?: { surface?: RemoteSurface }) {
    const payload = attachments?.length
      ? attachments.map(item => ({
        kind: item.kind,
        name: item.name,
        mimeType: item.mimeType,
        size: item.size,
        ...(item.kind === 'image' ? { dataUrl: item.sendData || item.dataUrl } : {}),
        ...(item.kind === 'text' ? { text: item.text } : {}),
      }))
      : undefined;
    if (this.isDemo) return { accepted: true, requestId: `demo-${Date.now()}` };
    return this.request<{ accepted: boolean; requestId: string }>('/v1/chat/messages', {
      method: 'POST',
      body: JSON.stringify({
        text,
        ...(payload ? { attachments: payload } : {}),
        ...(opts?.surface ? { surface: opts.surface } : {}),
      }),
    });
  }

  async selectProject(projectId: string) {
    if (this.isDemo) return { accepted: true, projectId };
    return this.request<{ accepted: boolean; projectId: string }>(`/v1/projects/${encodeURIComponent(projectId)}/select`, {
      method: 'POST',
    });
  }

  async selectSession(sessionId: string) {
    if (this.isDemo) return { accepted: true, sessionId, switching: false };
    return this.request<{ accepted: boolean; sessionId: string; switching?: boolean }>(`/v1/sessions/${encodeURIComponent(sessionId)}/select`, {
      method: 'POST',
    });
  }

  async getChatHistory(): Promise<RemoteChatMessage[]> {
    if (this.isDemo) return structuredClone(demoSnapshot.conversation);
    const result = await this.request<{ conversation?: Array<Partial<RemoteChatMessage>> }>(
      '/v1/chat/history',
    );
    const history = result.conversation || [];
    return history
      .filter(message => message.role === 'user' || message.role === 'assistant' || message.role === 'thinking')
      .map((message, index) => ({
        id: String(message.id || `history-${index}-${String(message.at || '')}`),
        role: message.role as 'user' | 'assistant' | 'thinking',
        title: message.title ? String(message.title) : undefined,
        text: String(message.text || ''),
        at: message.at || Date.now(),
        status: message.status === 'streaming' ? 'streaming' : 'done',
        mode: message.mode,
        turnId: message.turnId,
      }));
  }

  async getFunState(): Promise<FunState> {
    if (this.isDemo) return structuredClone(demoFunState);
    return this.request<FunState>('/v1/fun');
  }

  async upsertFunCharacter(character: Pick<FunCharacter, 'name' | 'intro' | 'opening'> & { id?: string; system: string; accent?: string }) {
    if (this.isDemo) {
      return {
        character: {
          id: character.id || `custom-${Date.now()}`,
          name: character.name,
          avatar: '✦',
          accent: character.accent || '#e9a0ba',
          intro: character.intro,
          opening: character.opening,
          custom: true,
        } as FunCharacter,
      };
    }
    return this.request<{ character: FunCharacter }>('/v1/fun/characters', {
      method: 'POST',
      body: JSON.stringify({ character }),
    });
  }

  async getFunHistory(characterId: string): Promise<FunMessage[]> {
    if (this.isDemo) return structuredClone(demoFunState.histories[characterId] || []);
    const result = await this.request<{ messages?: FunMessage[] }>(`/v1/fun/${encodeURIComponent(characterId)}/history`);
    return result.messages || [];
  }

  async getFunMemory(characterId: string): Promise<FunMemory> {
    if (this.isDemo) return { impression: '', facts: [] };
    const result = await this.request<{ memories?: FunMemory }>(`/v1/fun/${encodeURIComponent(characterId)}/memory`);
    return result.memories || { impression: '', facts: [] };
  }

  async sendFunMessage(characterId: string, text: string, thinkMode: boolean) {
    if (this.isDemo) return { accepted: true, requestId: `demo-fun-${Date.now()}` };
    return this.request<{ accepted: boolean; requestId: string }>(`/v1/fun/${encodeURIComponent(characterId)}/messages`, {
      method: 'POST',
      body: JSON.stringify({ text, thinkMode }),
    });
  }

  async clearFunHistory(characterId: string) {
    if (this.isDemo) return;
    await this.request(`/v1/fun/${encodeURIComponent(characterId)}/clear`, { method: 'POST' });
  }

  async getFunSpeech(characterId: string, text: string) {
    if (this.isDemo) return { audio: '', mimeType: 'audio/mpeg' };
    return this.request<{ audio: string; mimeType: string }>(`/v1/fun/${encodeURIComponent(characterId)}/speech`, {
      method: 'POST',
      body: JSON.stringify({ text }),
    });
  }

  async cancelCurrentTask() {
    if (this.isDemo) return;
    await this.request('/v1/tasks/current/cancel', { method: 'POST' });
  }

  /** Read-only Work deliverables of the active workspace (Trylo P3 patch).
   *  Demo mode has no computer, so there is nothing to list. */
  async getArtifacts(): Promise<RemoteArtifact[]> {
    if (this.isDemo) return [];
    const result = await this.request<{ artifacts?: Array<Partial<RemoteArtifact>> }>('/v1/artifacts');
    return (result.artifacts || [])
      .filter(item => item && typeof item.id === 'string' && item.id)
      .map(item => ({
        id: String(item.id),
        name: String(item.name || item.id),
        kind: String(item.kind || 'file'),
        size: Number.isFinite(Number(item.size)) ? Number(item.size) : 0,
        modifiedAt: Number.isFinite(Number(item.modifiedAt)) ? Number(item.modifiedAt) : Date.now(),
      }));
  }

  /** Fetch one deliverable's bytes. 12MB gateway cap; the caller decides
   *  whether the mime type is previewable on-device. */
  async getArtifactContent(path: string): Promise<RemoteArtifactContent> {
    if (this.isDemo) throw new Error('演示模式没有电脑端产物。');
    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), 45_000);
    try {
      const response = await fetch(
        `${normalizeBaseUrl(this.config.baseUrl)}/v1/artifacts/content?path=${encodeURIComponent(path)}`,
        {
          signal: controller.signal,
          headers: this.config.token ? { Authorization: `Bearer ${this.config.token}` } : {},
        },
      );
      if (!response.ok) {
        const detail = await response.text().catch(() => '');
        throw new Error(detail || `产物下载失败（${response.status}）`);
      }
      const blob = await response.blob();
      const disposition = response.headers.get('content-disposition') || '';
      const dispositionName = /filename\*?=(?:UTF-8''|")?([^";]+)/i.exec(disposition)?.[1];
      return {
        name: dispositionName ? decodeURIComponent(dispositionName) : path.split('/').pop() || 'file',
        mimeType: response.headers.get('content-type')?.split(';')[0]?.trim() || 'application/octet-stream',
        blob,
      };
    } finally {
      window.clearTimeout(timeout);
    }
  }

  async decidePermission(requestId: string, decision: 'allow' | 'deny') {
    if (this.isDemo) return;
    await this.request(`/v1/permissions/${encodeURIComponent(requestId)}/decision`, {
      method: 'POST',
      body: JSON.stringify({ decision }),
    });
  }

  async subscribe(
    onSnapshot: (snapshot: RemoteSnapshot) => void,
    onConnectionState: (state: GatewayConnectionState) => void,
    onChatEvent?: (event: RemoteChatEvent) => void,
    onFunEvent?: (event: FunChatEvent) => void,
  ): Promise<() => void> {
    if (this.isDemo) {
      onConnectionState('connected');
      return () => {};
    }

    let closed = false;
    let socket: WebSocket | null = null;
    let reconnectTimer: number | null = null;
    let reconnectAttempt = 0;

    const connect = async () => {
      if (closed) return;
      onConnectionState(reconnectAttempt ? 'reconnecting' : 'connecting');
      try {
        const ticketStartedAt = performance.now();
        const { ticket } = await this.request<{ ticket: string }>('/v1/socket-ticket', { method: 'POST' });
        this.lastLatencyMs = Math.max(1, Math.round(performance.now() - ticketStartedAt));
        if (closed) return;
        const socketUrl = new URL(`${normalizeBaseUrl(this.config.baseUrl)}/v1/events`);
        socketUrl.protocol = socketUrl.protocol === 'https:' ? 'wss:' : 'ws:';
        socketUrl.searchParams.set('ticket', ticket);
        socket = new WebSocket(socketUrl.toString());
        socket.addEventListener('open', () => {
          reconnectAttempt = 0;
          onConnectionState('connected');
        });
        socket.addEventListener('message', event => {
          try {
            const message = JSON.parse(String(event.data || '{}')) as {
              snapshot?: RemoteSnapshot;
              type?: string;
              action?: string;
              payload?: RemoteChatEvent;
            };
            if (message.snapshot) {
              message.snapshot.device.latencyMs = this.lastLatencyMs;
              onSnapshot(message.snapshot);
            }
            if (message.type === 'action_event' && message.action === 'chat' && message.payload) {
              onChatEvent?.(message.payload);
            }
            if (message.type === 'action_event' && message.action === 'fun' && message.payload) {
              onFunEvent?.(message.payload as FunChatEvent);
            }
          } catch {}
        });
        socket.addEventListener('close', () => {
          socket = null;
          if (closed) return;
          onConnectionState('reconnecting');
          reconnectAttempt += 1;
          const delay = Math.min(15000, 800 * 2 ** Math.min(reconnectAttempt, 5));
          reconnectTimer = window.setTimeout(() => void connect(), delay);
        });
        socket.addEventListener('error', () => socket?.close());
      } catch {
        if (closed) return;
        onConnectionState('offline');
        reconnectAttempt += 1;
        const delay = Math.min(15000, 800 * 2 ** Math.min(reconnectAttempt, 5));
        reconnectTimer = window.setTimeout(() => void connect(), delay);
      }
    };

    void connect();
    return () => {
      closed = true;
      if (reconnectTimer !== null) window.clearTimeout(reconnectTimer);
      socket?.close(1000, 'App closed subscription');
    };
  }
}

export const gatewayClient = new RemoteGatewayClient();
