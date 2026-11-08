import {
  attachmentKind, attachmentMediaType, buildAttachmentExcerpt,
  fileSizeFitsLimit, newAttachmentId,
  type Attachment, type FailedAttachment,
} from '../host-adapter/attachment-utils';
import type { StageAttachmentBytesArgs, StagedAttachment } from '../host-adapter/attachment-service';
import { joinToRoot, type AcquisitionResult, type CreateBlobUrlFn, type WorkAttachmentEntry } from './attachment-acquisition';
import type { AttachmentOwner } from './conversation-attachment-store';

function readFile(file: File): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => reader.result instanceof ArrayBuffer
      ? resolve(new Uint8Array(reader.result)) : reject(new Error('无法读取剪贴板文件'));
    reader.onerror = () => reject(reader.error ?? new Error('无法读取剪贴板文件'));
    reader.onabort = () => reject(new Error('已取消读取剪贴板文件'));
    reader.readAsArrayBuffer(file);
  });
}

/** Clipboard images have no stable filesystem path. Persist their bytes before
 * exposing an attachment to the sender; a blob URL alone cannot reach the CLI. */
export async function acquireClipboardFiles(args: {
  readonly owner: AttachmentOwner;
  readonly workspaceRoot: string | null;
  readonly files: readonly File[];
  readonly isCurrent: () => boolean;
  readonly stageBytes: (args: StageAttachmentBytesArgs) => Promise<StagedAttachment>;
  readonly createBlobUrl: CreateBlobUrlFn;
}): Promise<AcquisitionResult> {
  const additions: Attachment[] = [];
  const workAdditions: WorkAttachmentEntry[] = [];
  const failures: FailedAttachment[] = [];
  for (const file of args.files) {
    if (!args.isCurrent()) break;
    const id = newAttachmentId();
    const name = file.name || (file.type.startsWith('image/')
      ? `粘贴的图片.${file.type === 'image/jpeg' ? 'jpg' : 'png'}` : '粘贴的文件.bin');
    const kind = file.type.startsWith('image/') ? 'image' : attachmentKind(name);
    const mediaType = file.type || attachmentMediaType(name);
    try {
      if (!args.workspaceRoot) throw new Error('请先打开项目，再粘贴图片或文件');
      const limit = fileSizeFitsLimit(kind, file.size);
      if (!limit.ok) throw new Error(limit.reason);
      const bytes = await readFile(file);
      if (!args.isCurrent()) break;
      const staged = await args.stageBytes({
        workspaceRoot: args.workspaceRoot, conversationId: args.owner.conversationId,
        attachmentId: id, name, bytes,
      });
      if (!args.isCurrent()) break;
      const previewUrl = kind === 'image' ? args.createBlobUrl(bytes, mediaType) : undefined;
      const path = joinToRoot(args.workspaceRoot, staged.relativePath);
      const addedAt = Date.now();
      if (args.owner.surface === 'work') {
        workAdditions.push({ id, kind, name: staged.name, sourcePath: path,
          relativePath: staged.relativePath, size: staged.size, mediaType, addedAt, previewUrl });
      } else {
        additions.push({ id, kind, name: staged.name, path, size: staged.size, mediaType, addedAt, previewUrl,
          excerpt: buildAttachmentExcerpt(kind, staged.name, mediaType,
            kind === 'text' ? new TextDecoder().decode(bytes) : null) });
      }
    } catch (error) {
      failures.push({ id, name, path: '', reason: error instanceof Error ? error.message : String(error) });
    }
  }
  return { additions, workAdditions, failures, abandonedForNavigation: !args.isCurrent() };
}
