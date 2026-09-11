import { inferDimension } from './conclusion';
import { scopeCompatible } from './scope';
import type { EvidenceRecord } from './types';

/** Local candidate retrieval. No vector DB in v0.1: metadata + recency + dimension. */
export function retrieveCandidateEvidence(
  pool: readonly EvidenceRecord[],
  seed: readonly EvidenceRecord[],
  limit = 24,
): readonly EvidenceRecord[] {
  if (seed.length === 0) return [];
  const userId = seed[0]!.userId;
  const projectId = seed[0]!.context.projectId;
  const dims = new Set(seed.map((e) => inferDimension(e.inference.claim)));
  const tags = new Set(seed.flatMap((e) => e.context.scopeTags));
  const seedIds = new Set(seed.map((e) => e.id));
  const scored = pool
    .filter((item) => item.userId === userId && !seedIds.has(item.id))
    .map((item) => {
      let score = 0;
      if (!scopeCompatible(item.context, seed[0]!.context)) return { item, score: 0 };
      if (item.context.projectId === projectId) score += 3;
      if (dims.has(inferDimension(item.inference.claim))) score += 4;
      if (item.context.scopeTags.some((tag) => tags.has(tag))) score += 2;
      if (item.origin.channel !== seed[0]!.origin.channel) score += 1;
      score += Math.min(1, item.inference.engineeringRelevance);
      return { item, score };
    })
    .filter((row) => row.score > 0)
    .sort((a, b) => b.score - a.score || b.item.createdAt - a.item.createdAt);
  return [...seed, ...scored.slice(0, Math.max(0, limit - seed.length)).map((row) => row.item)];
}
