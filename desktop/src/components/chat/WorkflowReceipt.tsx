import { useState } from 'react';
import { ChevronRight } from 'lucide-react';
import { workflowStateLabel, type WorkflowState } from '../../domain/workflow-state';

export function WorkflowReceipt({ workflow }: { readonly workflow: WorkflowState }) {
  const [visibleSteps, setVisibleSteps] = useState(6);
  const start = Math.max(0, workflow.steps.length - visibleSteps);
  const failedAttempts = workflow.steps.filter(step => step.status === 'failed').length;
  const budget = workflow.budgetReceipt;
  return <details className="workflow-receipt">
    <summary><ChevronRight className="workflow-receipt__chevron" size={14} aria-hidden="true" /><span>{workflowStateLabel(workflow)}</span><code title={workflow.workflowVersionId} className="workflow-receipt__version">{workflow.workflowVersionId}</code></summary>
    <p className="workflow-receipt__scope">检查结果：{workflow.outcome === 'success' ? '已通过' : workflow.outcome === 'failure' ? '未通过' : '尚未确认'} · {workflow.steps.length} 条检查记录{failedAttempts > 0 ? `，其中 ${failedAttempts} 次失败` : ''}</p>
    {workflow.branchId && <p className="workflow-receipt__scope">采用分支 <code>{workflow.branchId}</code></p>}
    {budget && <div className="workflow-receipt__budget">
      <dl><div><dt>初始输出额度</dt><dd>{budget.initialTokens.toLocaleString()}</dd></div>
        {budget.grantedTokens > 0 && <div><dt>已追加额度</dt><dd>{budget.grantedTokens.toLocaleString()}</dd></div>}
        <div><dt>已观测输出</dt><dd>{budget.observedOutputTokens.toLocaleString()}</dd></div>
        <div><dt>待核实占用</dt><dd>{budget.reservedUnknownTokens.toLocaleString()}</dd></div>
        <div><dt>剩余输出额度</dt><dd>{budget.remainingTokens.toLocaleString()}</dd></div></dl>
      <p className="workflow-receipt__scope">单位：token{budget.usageUncertain ? '。部分用量尚未核实，已保留对应额度。' : '。'}</p>
    </div>}
    {workflow.steps.length === 0 ? <p>尚无已验证检查点。后续执行结果会在这里更新。</p> : <ol>
      {workflow.steps.slice(start).map((step, index) => <Checkpoint key={`${start + index}:${step.nodeId}`} step={step} index={start + index} />)}
    </ol>}
    {start > 0 && <button type="button" className="workflow-receipt__more" onClick={() => setVisibleSteps(count => count + 12)}>显示更早的检查记录（还有 {start} 条）</button>}
    <p className="workflow-receipt__scope">{workflow.cost ? `累计已记录：${workflow.cost.tokens.toLocaleString()} token · ${(workflow.cost.wallMs / 1000).toFixed(1)} 秒` : '累计用量尚未提供。'}</p>
  </details>;
}

function Checkpoint({ step, index }: { readonly step: WorkflowState['steps'][number]; readonly index: number }) {
  const [visibleRefs, setVisibleRefs] = useState(8);
  return <li value={index + 1}>
    <span className="workflow-receipt__node"><code>{step.nodeId}</code><span data-status={step.status}>{step.status === 'passed' ? '检查通过' : '检查失败'}</span></span>
    <dl className="workflow-receipt__artifacts"><div><dt>输入</dt><dd><code>{step.input}</code></dd></div><div><dt>产物</dt><dd><code>{step.output}</code></dd></div></dl>
    {step.recoveryTo && <p className="workflow-receipt__scope">恢复到 <code>{step.recoveryTo}</code> 后重新检查。</p>}
    <details><summary>查看检查依据（{step.evidenceRefs.length}）</summary>
      {step.dependsOn && step.dependsOn.length > 0 && <p className="workflow-receipt__scope">依赖：{step.dependsOn.join('、')}</p>}
      {step.inputBindings && Object.entries(step.inputBindings).map(([node, output]) => <p key={node} className="workflow-receipt__scope"><code>{node}</code> 的已检查产物：<code>{output}</code></p>)}
      {step.outputDigest && <p className="workflow-receipt__scope">产物摘要 <code>{step.outputDigest}</code></p>}
      {step.evidenceRefs.slice(0, visibleRefs).map(ref => <code key={ref} className="workflow-receipt__evidence">{ref}</code>)}
      {step.evidenceRefs.length > visibleRefs && <button type="button" className="workflow-receipt__more" onClick={() => setVisibleRefs(count => count + 16)}>显示更多依据（还有 {step.evidenceRefs.length - visibleRefs} 条）</button>}
    </details>
  </li>;
}
