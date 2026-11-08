import type { RoutingReceipt as Receipt } from '../../domain/routing-receipt';

function pathLabel(path: string): string {
  if (path === 'whole') return '整文件读取';
  if (path === 'stream') return '流式读取';
  if (path === 'independent') return '独立上下文';
  if (path === 'fork') return '父对话上下文';
  return '既有执行路径';
}

function explanation(receipt: Receipt): string {
  if (receipt.selectedPath !== receipt.actualPath) return '所选路径未完成本次执行，已使用可用路径继续。';
  if (receipt.reason === 'learned_policy') return '当前任务条件符合已学策略，本次采用该策略。';
  if (receipt.reason === 'evidence_changed') return '策略依据已变化，本次使用既有可用路径。';
  if (receipt.reason === 'condition_mismatch') return '任务条件不在策略适用范围，本次使用既有可用路径。';
  if (receipt.reason === 'scope_mismatch') return '本次任务属于不同项目范围，使用既有可用路径。';
  if (receipt.reason === 'no_policy') return '尚无适用的已学策略，本次使用既有可用路径。';
  if (receipt.reason === 'unknown_conditions') return '本次任务条件尚不明确，使用既有可用路径。';
  if (receipt.reason === 'new_failure' || receipt.reason === 'path_failed') return '近期结果不再支持采用该策略，本次回到既有可用路径。';
  if (['catalog_changed', 'invalid_policy', 'routing_asset_invalid', 'routing_unavailable'].includes(receipt.reason)) return '策略或执行路径条件已变化，本次回到既有可用路径。';
  return '依据本次任务条件选择执行路径；具体选择依据见下方记录。';
}

/** Evidence only: no inferred usage, savings, confidence or learning progress. */
export function RoutingReceipt({ receipt }: { readonly receipt: Receipt }) {
  const fallback = receipt.selectedPath !== receipt.actualPath
    || ['evidence_changed', 'new_failure', 'path_failed', 'catalog_changed', 'invalid_policy', 'routing_asset_invalid', 'routing_unavailable'].includes(receipt.reason);
  const label = `${fallback ? '已回退至' : receipt.versionId ? '已采用' : '本次使用'}${pathLabel(receipt.actualPath)}`;
  return <details className="tool__routing-receipt">
    <summary>{label}</summary>
    <p>{explanation(receipt)}</p>
    <p><span>{receipt.cost?.tokens === undefined ? '模型用量：未回报' : `模型用量：${receipt.cost.tokens.toLocaleString()} tokens`}</span>
      {receipt.cost?.bytesRead !== undefined && ` · 读取 ${receipt.cost.bytesRead.toLocaleString()} bytes`}
      {receipt.cost?.latencyMs !== undefined && ` · 耗时 ${receipt.cost.latencyMs.toLocaleString()} ms`}</p>
    <dl>
      <dt>选择依据</dt><dd><code>{receipt.reason}</code></dd>
      <dt>选择点</dt><dd><code>{receipt.decisionPoint}</code></dd>
      <dt>实际路径</dt><dd><code>{receipt.actualPath}</code></dd>
      <dt>原选路径</dt><dd><code>{receipt.selectedPath}</code></dd>
      <dt>执行记录</dt><dd><code>{receipt.executionId}</code></dd>
      {receipt.versionId && <><dt>采用版本</dt><dd><code>{receipt.versionId}</code></dd></>}
      {receipt.outcome && <><dt>结果</dt><dd><code>{receipt.outcome}</code></dd></>}
      {receipt.diagnostics.length > 0 && <><dt>诊断</dt><dd>{receipt.diagnostics.map((entry, index) => <code key={index}>{entry}</code>)}</dd></>}
    </dl>
  </details>;
}
