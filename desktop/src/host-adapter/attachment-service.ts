// Trylo Desktop — attachment staging service (P2-1 Work
// Package B). See the architecture doc §2.2 (HostAdapter is the
// only entry point).
//
// Typed surface over the Rust `attachment_staging` commands.
// React code NEVER invokes Tauri directly for staging and
// NEVER touches arbitrary filesystem paths itself: it calls
// `hostAdapter.attachments.stageAttachment(...)` and receives
// a workspace-relative descriptor back. The security work
// (symlink/reparse rejection, containment, sanitization,
// post-copy validation) lives in Rust — this module is only
// the typed boundary + the non-Tauri dev fallback.
//
// The Rust side serializes `relative_path` (snake_case); this
// module normalizes to camelCase at the boundary, mirroring
// tauri-fs-commands.ts.

import { invoke } from '@tauri-apps/api/core';
import { isTauri } from './tauri-detect';
import type { FilePath } from './types';

/** Result of staging one external file into the workspace's
 *  `.trylo/attachments/<conversationId>/<attachmentId>/` area.
 *  `relativePath` is ALWAYS workspace-relative, forward-slashed,
 *  and safe to project into the Work prompt verbatim. */
export interface StagedAttachment {
  readonly relativePath: string;
  readonly name: string;
  readonly size: number;
}

interface RawStagedAttachment {
  relative_path: string;
  name: string;
  size: number;
}

export interface StageAttachmentArgs {
  readonly workspaceRoot: FilePath;
  readonly conversationId: string;
  readonly attachmentId: string;
  readonly sourcePath: FilePath;
}

export interface AttachmentService {
  /** Copy one external file into the workspace-controlled
   *  staging area. Rejects directories, symlinks/reparse
   *  points, special files, oversized files, and invalid ids
   *  (see attachment_staging.rs for the full checklist). */
  stageAttachment(args: StageAttachmentArgs): Promise<StagedAttachment>;
  /** Conversation-deletion cleanup: remove the conversation's
   *  staging directory. Idempotent. */
  removeConversationAttachments(
    workspaceRoot: FilePath,
    conversationId: string,
  ): Promise<void>;
  /** Workspace-close cleanup: remove the whole project staging
   *  area. Idempotent. */
  removeProjectAttachments(workspaceRoot: FilePath): Promise<void>;
}

function basenameOf(p: string): string {
  const m = p.match(/[^/\\]+$/);
  return m ? m[0] : p;
}

/** Browser-dev fallback (vite without a Tauri runtime). There
 *  is no real filesystem to copy into, so the stub fabricates
 *  a descriptor with the same shape — enough for the dev loop
 *  to exercise the UI pipeline. Tests inject their own fakes;
 *  this is ONLY for `pnpm dev`. */
const devStaged = new Map<string, StagedAttachment>();

const devAttachmentService: AttachmentService = {
  async stageAttachment(args) {
    const name = basenameOf(args.sourcePath) || 'attachment.bin';
    const relativePath =
      `.trylo/attachments/${args.conversationId}/${args.attachmentId}/${name}`;
    const staged: StagedAttachment = { relativePath, name, size: 0 };
    devStaged.set(relativePath, staged);
    return staged;
  },
  async removeConversationAttachments(workspaceRoot, conversationId) {
    for (const key of [...devStaged.keys()]) {
      if (key.includes(`/${conversationId}/`)) devStaged.delete(key);
    }
    void workspaceRoot;
  },
  async removeProjectAttachments(workspaceRoot) {
    devStaged.clear();
    void workspaceRoot;
  },
};

export const tauriAttachmentService: AttachmentService = {
  stageAttachment: async (args) => {
    if (!isTauri()) return devAttachmentService.stageAttachment(args);
    // camelCase invoke args — Tauri maps them onto the Rust
    // snake_case parameters (workspace_root, conversation_id,
    // attachment_id, source_path).
    const raw = await invoke<RawStagedAttachment>('stage_attachment', {
      workspaceRoot: args.workspaceRoot,
      conversationId: args.conversationId,
      attachmentId: args.attachmentId,
      sourcePath: args.sourcePath,
    });
    return {
      relativePath: raw.relative_path,
      name: raw.name,
      size: raw.size,
    };
  },
  removeConversationAttachments: async (workspaceRoot, conversationId) => {
    if (!isTauri()) {
      return devAttachmentService.removeConversationAttachments(
        workspaceRoot,
        conversationId,
      );
    }
    return invoke<void>('remove_conversation_attachments', {
      workspaceRoot,
      conversationId,
    });
  },
  removeProjectAttachments: async (workspaceRoot) => {
    if (!isTauri()) {
      return devAttachmentService.removeProjectAttachments(workspaceRoot);
    }
    return invoke<void>('remove_project_attachments', { workspaceRoot });
  },
};
