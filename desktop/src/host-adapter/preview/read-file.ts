import { previewExtOf, previewKindFor, previewKindNeedsBytes, type PreviewKind } from '../../preview/formats';
import { sniffPreviewKind } from '../../preview/sniff';
import { sourceLanguageFor } from '../../preview/languages';
import { readPreviewHead, readPreviewText } from './resources';

export interface LoadedPreviewFile { readonly resolvedKind: PreviewKind; readonly content: string }
export async function loadPreviewFile(filePath: string, allowedRoot: string, io = { head: readPreviewHead, text: readPreviewText }): Promise<LoadedPreviewFile> {
  let kind = previewKindFor(filePath);
  const extension = previewExtOf(filePath);
  if (kind === 'text' || extension === '.ts' || extension === '.mts') kind = sniffPreviewKind(filePath, await io.head(filePath, allowedRoot));
  const content = previewKindNeedsBytes(kind) ? '' : await io.text(filePath, allowedRoot);
  if (kind === 'text' && sourceLanguageFor(filePath, content).id !== 'plaintext') kind = 'code';
  return { resolvedKind: kind, content };
}
