/** A file already staged into this conversation's workspace attachment area. */
export interface StagedAttachmentDescriptor {
  readonly id: string;
  readonly name: string;
  readonly relativePath: string;
  readonly mediaType: string;
  readonly size: number;
}

/** Keep the established CLI attachment envelope separate from visible user text. */
export function formatAttachmentMessage(args: {
  userText: string;
  attachments?: readonly StagedAttachmentDescriptor[];
}): string {
  const attachments = args.attachments ?? [];
  if (attachments.length === 0) return args.userText;
  const lines: string[] = ['<trylo_attachments>'];
  for (const attachment of attachments) {
    lines.push(`- id: ${attachment.id}`);
    lines.push(`  name: ${attachment.name}`);
    lines.push(`  path: ${attachment.relativePath}`);
    lines.push(`  media_type: ${attachment.mediaType}`);
    lines.push(`  size: ${attachment.size}`);
  }
  lines.push('</trylo_attachments>');
  return `${args.userText}\n\n${lines.join('\n')}`;
}
