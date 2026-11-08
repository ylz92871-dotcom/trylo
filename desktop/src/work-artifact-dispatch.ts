import { previewExtOf, previewKindFor } from './preview/formats';

export type ArtifactCapability =
  | { readonly kind: 'text-preview' }
  | { readonly kind: 'image-preview' }
  | { readonly kind: 'rich-preview'; readonly preview: string }
  | { readonly kind: 'host-open'; readonly reason: string };

// Executable/opaque formats not otherwise known by the shared catalog.
const HOST_ONLY = new Set(['.pot', '.pps', '.blend1', '.f3d', '.f3z', '.tgz', '.bz2', '.xz', '.so', '.dylib', '.class', '.jar', '.war', '.o', '.a', '.lib', '.deb', '.rpm', '.dmg', '.iso']);
export const extOf = previewExtOf;

/** One format inventory for Code/Work opening and the actual renderer. */
export function artifactCapabilityFor(path: string): ArtifactCapability {
  const extension = previewExtOf(path);
  const kind = previewKindFor(path);
  if (kind === 'unsupported' || (HOST_ONLY.has(extension) && kind === 'text')) return { kind: 'host-open', reason: 'No in-app renderer for this file format.' };
  if (kind === 'image') return { kind: 'image-preview' };
  if (['text', 'code', 'markdown', 'html', 'csv'].includes(kind)) return { kind: 'text-preview' };
  return { kind: 'rich-preview', preview: kind };
}
