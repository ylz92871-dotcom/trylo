// Trylo Desktop — LspManager interface (re-export). See
// lsp-manager.ts for the full contract. This file is a barrel
// so consumers can `import { LspManager } from './lsp-manager'`
// without splitting the type from the impl.

export interface LspServerConfig {
  readonly command: string;
  readonly args: readonly string[];
  readonly languageId: string;
  readonly extensions: readonly string[];
}

export interface LspHandle {
  readonly id: string;
  readonly language: string;
  readonly workspaceRoot: string;
}

export interface LspManager {
  ensureServer(language: string, workspaceRoot: string): Promise<LspHandle>;
  send(handle: LspHandle, message: string): Promise<void>;
  onMessage(handle: LspHandle, cb: (msg: string) => void): () => void;
  stop(handle: LspHandle): Promise<void>;
  availableLanguages(): Promise<readonly LspLanguageInfo[]>;
}

export interface LspLanguageInfo {
  readonly id: string;
  readonly extensions: readonly string[];
  readonly command: string;
  readonly installed: boolean;
}
