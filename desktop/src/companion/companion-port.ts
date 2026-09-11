// Trylo Desktop — Companion port (architecture doc §4.3).
//
// `CompanionPort` is the Desktop's stable boundary for the desktop pet:
// interface + adapter only. The implementation forwards to the Service
// Host's pet domain, which drives the byte-identical legacy bridge. The
// WPF pet keeps its own state names and animation selection — this side
// only publishes protocol payloads (spec §6.3).

import type { ServiceManager } from '../services-host/service-manager';
import type {
  ChatClientConfig,
  PetChatRequestMessage,
  PetStatusSnapshot,
} from '../services-host/methods';

/** One pending permission, taken verbatim from the approval request itself
 *  (spec §6.3: requestId 必须来自审批请求本身). */
export interface PetPermissionRequest {
  readonly requestId: string;
  readonly title: string;
  readonly detail?: string;
  readonly description?: string;
  readonly category?: string;
  readonly approvalState: string;
}

/** The five payload types the legacy bridge.publish accepts — nothing
 *  else may be sent (vendor validation silently drops unknown types). */
export type CompanionPublishPayload =
  | {
      readonly type: 'agentState';
      readonly state: string;
      readonly detail?: string;
      readonly level?: string;
      readonly meta?: { readonly progress?: number };
    }
  | { readonly type: 'permissionRequestState'; readonly requests: readonly PetPermissionRequest[] }
  | { readonly type: 'assistant' }
  | { readonly type: 'stopped' }
  | { readonly type: 'error'; readonly message: string };

/** Queryable pet state (audit §4.2 PET-P0-1). A QUERY, not an inference:
 *  the sidecar answers from the vendor bridge's own launch bookkeeping, so
 *  "the pet did not appear" becomes a real reason code instead of silence. */
export interface CompanionPort {
  /** Resolves with the REAL post-enable status (audit §4.2 PET-P0-1). */
  start(): Promise<PetStatusSnapshot>;
  stop(): Promise<void>;
  publish(event: CompanionPublishPayload): Promise<void>;
  openChat(): Promise<void>;
  status(): Promise<PetStatusSnapshot>;
}

/** Every field present, nothing launched. Used before the first successful
 *  query and after shutdown, so the UI never renders `undefined`. */
export const EMPTY_PET_STATUS: PetStatusSnapshot = {
  enabled: false,
  exeFound: false,
  launchAttempted: false,
  launched: false,
  chatConnected: false,
  exePath: '',
  reasonCode: 'not_attempted',
};

/** Drives a chat request inside the sidecar (chat store + LLM), injecting
 *  the per-request config from Desktop settings (spec §6.4). */
export type PetChatHandle = (
  message: PetChatRequestMessage,
  chat?: ChatClientConfig,
) => Promise<{ ok: boolean; error?: string }>;

/** Paths only the Tauri shell knows (resource dir vs repo layout). */
export interface CompanionPaths {
  readonly sidecarsDir: string;
  readonly appDataDir: string;
}

export type CompanionPathsProvider = () => Promise<CompanionPaths>;

export class ServicesCompanionPort implements CompanionPort {
  chatHandle: PetChatHandle = async (message, chat) => {
    return this.manager.client.request('pet.chatHandle', { message, chat });
  };

  constructor(
    private readonly manager: ServiceManager,
    private readonly paths: CompanionPathsProvider,
    private readonly workspacePath: () => string,
  ) {}

  /** Ensures the sidecar is up and the pet enabled (idempotent). Returns the
   *  REAL post-enable status so the caller never has to guess (PET-P0-1). */
  async start(): Promise<PetStatusSnapshot> {
    const { sidecarsDir, appDataDir } = await this.paths();
    await this.manager.ensureRunning({ sidecarsDir, appDataDir });
    return this.enableChannel();
  }

  /** Rebind the pet domain after Service Host restarts. The manager is
   *  already ready at this point, so this must not spawn another process.
   *  Returns `pet.enable`'s own status projection — the launch is
   *  synchronous inside the sidecar, so this is a fact, not a hope. */
  async enableChannel(): Promise<PetStatusSnapshot> {
    const result = await this.manager.client.request('pet.enable', {
      workspacePath: this.workspacePath(),
    });
    return normalizePetStatus(result);
  }

  /** Explicit query — no side effects, safe to poll. */
  async status(): Promise<PetStatusSnapshot> {
    try {
      const result = await this.manager.client.request('pet.status');
      return normalizePetStatus(result);
    } catch {
      // The sidecar is gone; "not attempted" is the honest answer and the
      // renderer shows the service-host state alongside it.
      return EMPTY_PET_STATUS;
    }
  }

  /** pet.disable only (sends detach). Stopping the service host itself is
   *  the controller's exit sequence (spec §6.5). */
  async stop(): Promise<void> {
    await this.manager.client.request('pet.disable');
  }

  async publish(event: CompanionPublishPayload): Promise<void> {
    await this.manager.client.request('pet.publish', event);
  }

  async openChat(): Promise<void> {
    await this.manager.client.request('pet.openChat');
  }
}

/** Coerce an arbitrary wire result into the full snapshot. Every field is
 *  always present, so the UI can destructure straight away. */
export function normalizePetStatus(raw: Partial<PetStatusSnapshot> | null | undefined): PetStatusSnapshot {
  return {
    enabled: Boolean(raw?.enabled),
    exeFound: Boolean(raw?.exeFound),
    launchAttempted: Boolean(raw?.launchAttempted),
    launched: Boolean(raw?.launched),
    chatConnected: Boolean(raw?.chatConnected),
    exePath: String(raw?.exePath ?? ''),
    reasonCode: String(raw?.reasonCode ?? ''),
  };
}

/** Real path provider: asks the Tauri shell (single source of truth for
 *  packaged vs dev resource layouts). */
export function createTauriCompanionPaths(): CompanionPathsProvider {
  return async () => {
    const { invoke } = await import('@tauri-apps/api/core');
    const paths = await invoke<CompanionPaths>('servicehost_paths');
    return { sidecarsDir: paths.sidecarsDir, appDataDir: paths.appDataDir };
  };
}
