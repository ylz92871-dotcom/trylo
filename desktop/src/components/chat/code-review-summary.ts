import type { StoredCodeRunResult } from '../../results/conversation-result-types';

export function codeReviewSummary(result: StoredCodeRunResult): { count: number; text?: string } {
  const count = new Set([
    ...result.changes.map(file => file.path),
    ...(result.outputs?.map(file => file.path) ?? []),
  ]).size;
  const parts: string[] = [];
  if (count > 0) parts.push(`${count} 个${result.truncated || result.outputsIncomplete ? '已记录' : ''}文件`);
  if (result.checkCountTotal > 0) parts.push(`${result.checkCountTotal} 项检查`);
  return { count, text: parts.length ? parts.join(' · ') : undefined };
}
