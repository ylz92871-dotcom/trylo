import { describe, expect, it } from 'vitest';
import { formatAttachmentMessage, type StagedAttachmentDescriptor } from './attachment-message';

const file: StagedAttachmentDescriptor = {
  id: 'attachment-a',
  name: '需求.docx',
  relativePath: '.trylo/attachments/conversation-a/attachment-a/需求.docx',
  mediaType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  size: 128430,
};

describe('CLI attachment message projection', () => {
  it('preserves user text verbatim without attachments', () => {
    const text = '你好\n\n不要改写这段输入';
    expect(formatAttachmentMessage({ userText: text })).toBe(text);
    expect(formatAttachmentMessage({ userText: text, attachments: [] })).toBe(text);
  });

  it('keeps the staged path and every descriptor field in the existing envelope', () => {
    expect(formatAttachmentMessage({ userText: '分析附件', attachments: [file] })).toBe(
      '分析附件\n\n<trylo_attachments>\n' +
      '- id: attachment-a\n' +
      '  name: 需求.docx\n' +
      '  path: .trylo/attachments/conversation-a/attachment-a/需求.docx\n' +
      '  media_type: application/vnd.openxmlformats-officedocument.wordprocessingml.document\n' +
      '  size: 128430\n' +
      '</trylo_attachments>',
    );
  });

  it('retains attachment order independently of display names', () => {
    const second = { ...file, id: 'attachment-b', name: 'data.xlsx' };
    const message = formatAttachmentMessage({ userText: '比较', attachments: [file, second] });
    expect(message.indexOf('- id: attachment-a')).toBeLessThan(message.indexOf('- id: attachment-b'));
  });
});
