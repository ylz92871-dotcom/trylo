// Trylo Desktop — HostAdapter barrel + concrete impl. See
// the architecture doc §2.2 (HostAdapter is the only entry point).
//
// The barrel re-exports all the interface types so component code has
// a single import path: `import { hostAdapter, type FsCommands } from
// './host-adapter'`. Concrete impls (this file) are the only places
// that know about @tauri-apps/api.

import { tauriFsCommands } from './tauri-fs-commands';
import { tauriAttachmentService } from './attachment-service';
import { TauriChannelWorkspaceWatcher } from './tauri-workspace-watcher';
import { StubWorkspaceWatcher } from './stub-workspace-watcher';
import { tauriSearchService } from './tauri-search-service';
import { tauriPtyService } from './tauri-pty-service';
import { tauriGitService } from './tauri-git-service';
import { TauriLspManager } from './tauri-lsp-manager';
import { tauriSettingsService } from './tauri-settings-service';
import { tauriProcessService } from './tauri-process-service';

export type { FsCommands, FsCommandsBackend } from './commands';
// P2-1 Work Package B: the typed attachment staging surface
// (Rust `attachment_staging` commands). React never invokes
// Tauri directly for staging.
export type {
  AttachmentService,
  StagedAttachment,
  StageAttachmentArgs,
} from './attachment-service';
export type { LspChannel, PtyChannel, StreamBackend, WatchChannel, WatchSubscription } from './channels';
export type {
  WorkspaceWatcher,
  WatchOptions,
  WatchHandle,
} from './workspace-watcher';
export type {
  LspManager,
  LspServerConfig,
  LspLanguageInfo,
} from './lsp-manager';
export type {
  EditorBridge,
  ConflictEvent,
  ConflictKind,
} from './editor-bridge';
export type { SearchService, SearchMatch } from './search-service';
export type { PtyService, PtySpawnResult } from './pty-service';
export type { GitService, GitSnapshotEntry, GitWorkspaceSnapshot, GitFileDiff, GitDiffStat } from './git-service';
export type { SettingsService, AppSettings, Theme } from './settings-service';
export { DEFAULT_SETTINGS } from './settings-service';
// Phase 2 (Trylo Alpha): sidecar process bridge.
export type { ProcessService, ProcessHandle, ProcessOutputEvent } from './process-service';
export type {
  DirEntry,
  FileChangeEvent,
  FileChangeKind,
  FilePath,
  FileStat,
  LanguageId,
  LspMessage,
  ProcessId,
  ProcessInfo,
  PtyId,
  PtyStartRequest,
  SpawnRequest,
} from './types';
// Phase 2 (Trylo Alpha, arch §3) — Trylo API for the legacy 4-mode
// webview running in an iframe. See trylo-api.ts.
export type {
  TryloApi,
  TryloMode,
  TryloPushEvent,
  TryloRequest,
  TryloResponse,
  TryloSession,
} from './trylo-api';
export {
  handleTryloRequest,
  type TryloHandlerContext,
} from './trylo-message-types';
export {
  createTryloContext,
  getSessionStore,
  resetSessionStore,
  snapshotForWorkspace,
  persistForWorkspace,
} from './trylo-context';
export { startTrylo, stopTryloProcess, sendPromptToProcess, tailTryloEvents } from './trylo-runner';
export type { StartTryloArgs, TailEventsArgs, TailHandle } from './trylo-runner';
export { parseLoopEvent } from './loop-events';
export type { LoopEvent, LoopEventType, OtherLoopEvent } from './loop-events';

export const hostAdapter = {
  fs: tauriFsCommands,
  // P2-1 Work Package B: workspace-controlled attachment
  // staging for Work conversations (copy-in + cleanup).
  attachments: tauriAttachmentService,
  watcher: new TauriChannelWorkspaceWatcher(),
  search: tauriSearchService,
  pty: tauriPtyService,
  // P2-1 (spec §7.3): the typed Git surface used by the Code result
  // projector for run baseline/final snapshots and HEAD diffs.
  git: tauriGitService,
  lsp: new TauriLspManager(),
  settings: tauriSettingsService,
  process: tauriProcessService,
} as const;

export const stubWorkspaceWatcher = new StubWorkspaceWatcher();


export { createLspConnection } from './lsp-connection';
