import { previewKindFor } from '../preview/previewKind';
import type { StoredCodeRunResult, StoredWorkArtifact, StoredWorkRunDelta } from '../../results/conversation-result-types';
import { artifactCapabilityFor } from '../../work-artifact-dispatch';
export interface PreviewFileEntry { readonly path: string; readonly name?: string }
export function codePreviewFiles(result: Pick<StoredCodeRunResult, 'attribution' | 'changes' | 'outputs'>): readonly PreviewFileEntry[] {
  const files = result.outputs?.map((file) => ({ path: file.path })) ?? [];
  if (result.attribution === 'run_delta') files.push(...result.changes
    .filter((change) => change.kind !== 'deleted' && !['text', 'unsupported'].includes(previewKindFor(change.path)))
    .map((change) => ({ path: change.path })));
  return [...new Map(files.filter((file) => previewKindFor(file.path) !== 'unsupported').map((file) => [file.path, file])).values()];
}
/** Historical artifacts never become a new turn's delivery buttons. */
type WorkPreviewSource = {
  readonly latestRun?: Pick<StoredWorkRunDelta, 'createdIds' | 'updatedIds' | 'discoveredIds'>;
  readonly artifacts: readonly Pick<StoredWorkArtifact, 'id' | 'target' | 'displayName'>[];
};
export function workPreviewFiles(result: WorkPreviewSource): readonly PreviewFileEntry[] {
  const latest = result.latestRun;
  if (!latest) return [];
  const ids = new Set([...latest.createdIds, ...latest.updatedIds, ...latest.discoveredIds]);
  return workReviewFiles({ artifacts: result.artifacts.filter(artifact => ids.has(artifact.id)) });
}

/** A file picker is navigation, not an assertion that this turn produced it. */
export function workReviewFiles(result: Pick<WorkPreviewSource, 'artifacts'>): readonly PreviewFileEntry[] {
  return result.artifacts.flatMap((artifact) => artifact.target.kind === 'file'
    && previewKindFor(artifact.target.relativePath) !== 'unsupported'
    && artifactCapabilityFor(artifact.target.relativePath).kind !== 'host-open'
    ? [{ path: artifact.target.relativePath, name: artifact.displayName }] : []);
}

export function codeReviewFiles(result: Pick<StoredCodeRunResult, 'changes' | 'outputs'>): readonly PreviewFileEntry[] {
  const paths = [...(result.outputs?.map(file => file.path) ?? []),
    ...result.changes.filter(change => change.kind !== 'deleted').map(change => change.path)];
  return [...new Set(paths)].filter(path => previewKindFor(path) !== 'unsupported').map(path => ({ path }));
}
