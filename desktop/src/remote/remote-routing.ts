// Trylo Desktop — Remote gateway router (migration spec §8.1, arch §7.2).
//
// Pure dispatch for the handlers the Desktop owns. The Service Host forwards
// every gateway invocation as `host.remoteRequest {requestId, name, payload}`
// and the Desktop answers via `remote.respond`; this module is the only place
// that maps name → authority. `fun` (猫箱) is a capability-unavailable 501
// (spec §1/§12). A failing authority (or unknown name) is answered with an
// error response — never a hang. No prompts / chat bodies / tokens ever cross
// these branches (spec §11).

import type { ApprovalService } from '../approval/approval-service';
import { chatConfigFromSettings } from '../companion/companion-controller';
import type { PetChatHandle } from '../companion/companion-port';
import type { TryloSettings } from '../settings/settings-store';
import type {
  PetChatRequestMessage,
  RemoteProjectSummary,
  RemoteRequestEvent,
  RemoteSessionSummary,
} from '../services-host/methods';

/** One routed handler's outcome — either a success result or an error. */
export interface RemoteRouteOutcome {
  readonly ok: boolean;
  readonly result?: unknown;
  readonly error?: { readonly code: string; readonly message: string; readonly statusCode?: number };
}

export type RemoteRouteHandler = (payload: unknown, requestId: string) => Promise<RemoteRouteOutcome>;

/** A file the mobile Chat mode attached to a message. Images arrive as a
 *  base64 data URL (already downscaled on the phone); text files inline
 *  their extracted content. Mirrors the mobile gateway payload. */
export interface RemoteChatAttachment {
  readonly kind: 'image' | 'text';
  readonly name: string;
  readonly mimeType: string;
  readonly size: number;
  /** base64 data URL for images (e.g. `data:image/jpeg;base64,…`). */
  readonly dataUrl?: string;
  /** Extracted text for text-like files. */
  readonly text?: string;
}

/** Everything the router needs from the Desktop authorities. */
export interface RemoteRouterContext {
  readonly workspaces: { list(): readonly RemoteProjectSummary[]; activeProjectId(): string; select(projectId: string): Promise<void> };
  readonly sessions: { list(): readonly RemoteSessionSummary[]; activeSessionId(): string; select(sessionId: string): Promise<{ switching: boolean }> };
  readonly sendTask: (req: { projectKey: string; conversationId: string; mode: string; surface: RemoteTaskSurface; text: string; requestId: string; attachments?: readonly RemoteChatAttachment[] }) => Promise<unknown>;
  readonly cancelTask: (projectKey: string, conversationId: string) => Promise<void>;
  readonly approvals: ApprovalService;
  /** Read-only Work deliverables (`.trylo/out` of the active workspace). */
  readonly artifacts: {
    list(): Promise<readonly RemoteArtifactSummary[]>;
    read(relativePath: string): Promise<RemoteArtifactContent>;
  };
  /** Reuse pet-chat (spec §8.1: chat → §6.4 pet-chat). Null ⇒ chat unavailable. */
  readonly chatHandle: PetChatHandle | null;
  readonly settings: () => TryloSettings;
  readonly projectKey: () => string;
  readonly conversationId: () => string;
  readonly mode: () => string;
  /** Called after a project/session selection so the caller re-projects. */
  readonly onSelectionChanged: () => void;
  /** Answer a forwarded invocation back to the Service Host. */
  readonly respond: (requestId: string, ok: boolean, result?: unknown, error?: { readonly code: string; readonly message: string; readonly statusCode?: number }) => Promise<unknown>;
}

/** Which Desktop surface a mobile task targets. The phone sends `surface`
 *  in POST /v1/chat/messages; anything else (or nothing) means Code. The
 *  vendored gateway forwards the body opaquely, so no gateway change is
 *  needed for this field. */
export type RemoteTaskSurface = 'code' | 'work';

function parseTaskSurface(value: unknown): RemoteTaskSurface {
  return String(value ?? '').toLowerCase() === 'work' ? 'work' : 'code';
}

/** A Work deliverable (`.trylo/out` entry) listed for the phone. */
export interface RemoteArtifactSummary {
  readonly id: string;
  readonly name: string;
  readonly kind: string;
  readonly size: number;
  readonly modifiedAt: number;
}

/** One deliverable's bytes as base64 (the gateway streams them raw). */
export interface RemoteArtifactContent {
  readonly name: string;
  readonly mimeType: string;
  readonly size: number;
  readonly data: string;
}

/** Workspace-relative deliverable path guard (mirrors the gateway-side
 *  check — defense in depth; the App authority additionally contains the
 *  resolved path inside `.trylo/out`). */
export function sanitizeArtifactRelPath(value: unknown): string | null {
  const rel = String(value ?? '');
  if (!rel || rel.length > 512) return null;
  if (rel.startsWith('/') || /^[a-zA-Z]:/.test(rel) || rel.includes('\\')) return null;
  const parts = rel.split('/');
  if (parts.some((part) => part === '' || part === '.' || part === '..')) return null;
  return parts.join('/');
}

const ARTIFACT_MIME_TYPES: Readonly<Record<string, string>> = {
  pdf: 'application/pdf',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  svg: 'image/svg+xml',
  html: 'text/html',
  md: 'text/markdown',
  txt: 'text/plain',
  json: 'application/json',
  csv: 'text/csv',
};

/** Closed-set content type for a deliverable name (unknown → octet-stream). */
export function mimeTypeForArtifactName(name: string): string {
  const ext = String(name.split('.').pop() || '').toLowerCase();
  return ARTIFACT_MIME_TYPES[ext] || 'application/octet-stream';
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};
}

export class RemoteRouter {
  constructor(private readonly ctx: RemoteRouterContext) {}

  private readonly handlers: Readonly<Record<string, RemoteRouteHandler>> = {
    projects: async () => ({
      ok: true,
      result: { projects: this.ctx.workspaces.list(), activeProjectId: this.ctx.workspaces.activeProjectId() },
    }),
    project: async (payload) => {
      const projectId = String(asRecord(payload).projectId ?? '');
      if (!projectId) throw new Error('missing projectId');
      await this.ctx.workspaces.select(projectId);
      this.ctx.onSelectionChanged();
      return { ok: true, result: { accepted: true, projectId } };
    },
    session: async (payload) => {
      const sessionId = String(asRecord(payload).sessionId ?? '');
      if (!sessionId) throw new Error('missing sessionId');
      const outcome = await this.ctx.sessions.select(sessionId);
      this.ctx.onSelectionChanged();
      return { ok: true, result: { accepted: true, switching: outcome.switching } };
    },
    task: async (payload, requestId) => {
      const record = asRecord(payload);
      const text = String(record.text ?? '');
      const surface = parseTaskSurface(record.surface);
      const rawAttachments = Array.isArray(record.attachments) ? record.attachments : [];
      const attachments: RemoteChatAttachment[] = rawAttachments
        .filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === 'object')
        .map(item => ({
          kind: item.kind === 'text' ? 'text' : 'image',
          name: String(item.name || 'file'),
          mimeType: String(item.mimeType || ''),
          size: Number.isFinite(Number(item.size)) ? Number(item.size) : 0,
          ...(typeof item.dataUrl === 'string' ? { dataUrl: item.dataUrl } : {}),
          ...(typeof item.text === 'string' ? { text: item.text } : {}),
        }));
      if (!text && attachments.length === 0) throw new Error('missing text');
      await this.ctx.sendTask({
        projectKey: this.ctx.projectKey(),
        conversationId: this.ctx.conversationId(),
        mode: this.ctx.mode(),
        surface,
        text,
        requestId,
        ...(attachments.length ? { attachments } : {}),
      });
      return { ok: true, result: { accepted: true, requestId } };
    },
    cancel: async () => {
      await this.ctx.cancelTask(this.ctx.projectKey(), this.ctx.conversationId());
      return { ok: true, result: { ok: true } };
    },
    permission: async (payload) => {
      const record = asRecord(payload);
      await this.ctx.approvals.decide(String(record.requestId ?? ''), record.decision === 'deny' ? 'deny' : 'allow');
      return { ok: true, result: { ok: true } };
    },
    artifacts: async () => ({
      ok: true,
      result: { artifacts: await this.ctx.artifacts.list() },
    }),
    artifact: async (payload) => {
      const path = sanitizeArtifactRelPath(asRecord(payload).path);
      if (!path) {
        return { ok: false, error: { code: 'INVALID_ARTIFACT_PATH', message: 'Invalid artifact path.', statusCode: 400 } };
      }
      try {
        return { ok: true, result: await this.ctx.artifacts.read(path) };
      } catch {
        return { ok: false, error: { code: 'ARTIFACT_UNAVAILABLE', message: 'Artifact is unavailable.', statusCode: 404 } };
      }
    },
    chat: async (payload) => {
      if (!this.ctx.chatHandle) return { ok: false, error: { code: 'CHAT_UNAVAILABLE', message: 'chat unavailable', statusCode: 501 } };
      await this.ctx.chatHandle(payload as PetChatRequestMessage, chatConfigFromSettings(this.ctx.settings()));
      return { ok: true, result: { ok: true } };
    },
    fun: async () => ({ ok: false, error: { code: 'CAPABILITY_UNAVAILABLE', message: '本版本不支持猫箱', statusCode: 501 } }),
  };

  /** Dispatch one forwarded invocation (arch §7.2). A failing authority or
   *  unknown name is answered with an error — never a hang (§8.1). */
  async handle(request: RemoteRequestEvent): Promise<void> {
    const { requestId, name, payload } = request;
    const handler = this.handlers[name];
    try {
      if (!handler) {
        await this.ctx.respond(requestId, false, undefined, { code: 'UNKNOWN_HANDLER', message: `unknown remote handler '${name}'`, statusCode: 404 });
        return;
      }
      const outcome = await handler(payload, requestId);
      await this.ctx.respond(requestId, outcome.ok, outcome.result, outcome.error);
    } catch {
      await this.ctx.respond(requestId, false, undefined, { code: 'HANDLER_ERROR', message: `remote handler '${name}' failed`, statusCode: 500 }).catch(() => {});
    }
  }
}
