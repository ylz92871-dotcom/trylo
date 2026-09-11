// Trylo Desktop — TauriLspManager. Wraps the four LSP Tauri
// commands (lsp_spawn / lsp_send / lsp_stop / lsp_list) in
// a class that the React side can use. Per-handle Channel
// subscriptions route server output to the matching callback.

import { Channel, invoke } from '@tauri-apps/api/core';
import type {
  LspHandle,
  LspLanguageInfo,
  LspManager,
} from './lsp-manager';

interface LspHandleDto {
  id: string;
  language: string;
  workspace_root: string;
}

export class TauriLspManager implements LspManager {
  /** Per-handle Channel subscriptions. We keep the channel
   *  alive for the lifetime of the manager so subscribers can
   *  re-register; the underlying Rust process is owned by
   *  the LspState, which `lsp_stop` releases. */
  private readonly channels = new Map<string, Channel<string>>();

  async ensureServer(language: string, workspaceRoot: string): Promise<LspHandle> {
    if (!this.channels.has(this.tempKey(language, workspaceRoot))) {
      const channel = new Channel<string>();
      this.channels.set(this.tempKey(language, workspaceRoot), channel);
    }
    const dto = await invoke<LspHandleDto>('lsp_spawn', {
      language,
      workspaceRoot,
      onMessage: this.channels.get(this.tempKey(language, workspaceRoot))!,
    });
    return {
      id: dto.id,
      language: dto.language,
      workspaceRoot: dto.workspace_root,
    };
  }

  async send(handle: LspHandle, message: string): Promise<void> {
    await invoke('lsp_send', { id: handle.id, message });
  }

  onMessage(handle: LspHandle, cb: (msg: string) => void): () => void {
    const channel = this.channels.get(this.tempKey(handle.language, handle.workspaceRoot));
    if (!channel) {
      return () => {};
    }
    // We override the existing onmessage handler with one that
    // calls our subscriber. The Channel API is single-subscriber;
    // our manager is the only owner in this architecture.
    const previous = channel.onmessage;
    channel.onmessage = (msg) => {
      previous?.(msg);
      cb(msg);
    };
    return () => {
      channel.onmessage = previous;
    };
  }

  async stop(handle: LspHandle): Promise<void> {
    await invoke('lsp_stop', { id: handle.id });
    // Drop the channel; ensureServer creates a new one if
    // the same (language, workspace) pair is requested again.
    this.channels.delete(this.tempKey(handle.language, handle.workspaceRoot));
  }

  async availableLanguages(): Promise<readonly LspLanguageInfo[]> {
    return invoke<LspLanguageInfo[]>('lsp_list');
  }

  private tempKey(language: string, workspaceRoot: string): string {
    return `${language}\0${workspaceRoot}`;
  }
}
