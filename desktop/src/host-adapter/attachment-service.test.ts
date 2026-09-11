// Trylo Desktop — attachment staging service boundary tests
// (P2-1 Work Package B). Pins the Tauri invoke contract:
// command names, camelCase argument keys (Tauri maps them onto the
// Rust snake_case parameters), snake_case→camelCase result
// normalization, and error propagation.

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { invoke } from '@tauri-apps/api/core';
import { tauriAttachmentService } from './attachment-service';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));

function setTauri(enabled: boolean): void {
  const w = window as unknown as Record<string, unknown>;
  if (enabled) w['__TAURI_INTERNALS__'] = {};
  else delete w['__TAURI_INTERNALS__'];
}

beforeEach(() => {
  setTauri(true);
  (invoke as ReturnType<typeof vi.fn>).mockReset();
});

describe('tauriAttachmentService', () => {
  it('invokes stage_attachment with camelCase args and normalizes the result', async () => {
    (invoke as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      relative_path: '.trylo/attachments/conv-1/att_1/spec.md',
      name: 'spec.md',
      size: 2048,
    });
    const staged = await tauriAttachmentService.stageAttachment({
      workspaceRoot: 'D:/proj',
      conversationId: 'conv-1',
      attachmentId: 'att_1',
      sourcePath: 'D:/ext/spec.md',
    });
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(invoke).toHaveBeenCalledWith('stage_attachment', {
      workspaceRoot: 'D:/proj',
      conversationId: 'conv-1',
      attachmentId: 'att_1',
      sourcePath: 'D:/ext/spec.md',
    });
    expect(staged).toEqual({
      relativePath: '.trylo/attachments/conv-1/att_1/spec.md',
      name: 'spec.md',
      size: 2048,
    });
  });

  it('propagates Rust staging errors untouched', async () => {
    (invoke as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      'attachment rejected: source is not a regular file',
    );
    await expect(tauriAttachmentService.stageAttachment({
      workspaceRoot: 'D:/proj',
      conversationId: 'conv-1',
      attachmentId: 'att_1',
      sourcePath: 'D:/ext/folder',
    })).rejects.toBe('attachment rejected: source is not a regular file');
  });

  it('invokes remove_conversation_attachments with camelCase args', async () => {
    (invoke as ReturnType<typeof vi.fn>).mockResolvedValueOnce(null);
    await tauriAttachmentService.removeConversationAttachments('D:/proj', 'conv-1');
    expect(invoke).toHaveBeenCalledWith('remove_conversation_attachments', {
      workspaceRoot: 'D:/proj',
      conversationId: 'conv-1',
    });
  });

  it('invokes remove_project_attachments with camelCase args', async () => {
    (invoke as ReturnType<typeof vi.fn>).mockResolvedValueOnce(null);
    await tauriAttachmentService.removeProjectAttachments('D:/proj');
    expect(invoke).toHaveBeenCalledWith('remove_project_attachments', {
      workspaceRoot: 'D:/proj',
    });
  });

  it('falls back to the in-memory dev service outside Tauri', async () => {
    setTauri(false);
    const staged = await tauriAttachmentService.stageAttachment({
      workspaceRoot: 'D:/proj',
      conversationId: 'conv-1',
      attachmentId: 'att_1',
      sourcePath: 'D:/ext/spec.md',
    });
    expect(invoke).not.toHaveBeenCalled();
    expect(staged.relativePath).toBe('.trylo/attachments/conv-1/att_1/spec.md');
    expect(staged.name).toBe('spec.md');
  });
});
