import { useEffect, useState } from 'react';
import type { ReactElement } from 'react';
import { loadToolLearningStatus, type ToolLearningLoad, type ToolLearningRuntime, type ToolLearningJobView, type ToolJobState } from '../../tool-learning/cli-status';
import './tool-learning-records.css';
import { ToolProductionPanel } from './ToolProductionPanel';
import { ToolAcquisitionReview } from './ToolAcquisitionReview';
import { productionVersion } from '../../tool-learning/wire';

const labels: Readonly<Record<ToolJobState, string>> = { queued: '已排队', running: '处理中', waiting_approval: '候选待审核',
  waiting_evidence: '等待验证依据', succeeded: '处理结束', failed: '处理失败', cancelled: '已取消', expired: '已结束' };
function stateLabel(job: ToolLearningJobView): string {
  if (job.cleanupCode === 'worker_retirement_unconfirmed') return '后台停止待确认';
  if (job.cleanupCode === 'cleanup_unconfirmed') return '清理结果待确认';
  if (job.cleanupCode === 'allowance_release_failed') return '额度结算待检查';
  const continuation = job.acquisition?.continuation;
  if (continuation?.versionId !== undefined) return '适配候选已保存';
  if (continuation?.state === 'running') return '适配处理中';
  if (continuation?.state === 'queued') return '适配已排队';
  if (continuation?.state === 'waiting_evidence') return '适配等待补充依据';
  if (continuation !== undefined) return '本次适配处理已结束';
  if (job.acquisition?.installed === true) return '等待准备适配';
  if (job.acquisition?.failure !== undefined) return job.acquisition.failure.recovery === 'await_stop' ? '获取停止待确认' : '获取遇到阻碍';
  const outcomes: Readonly<Record<string, string>> = {
    existing_capability_reused: '已选择现有工具', usage_revision_proposed: '已整理条件用法',
    not_worthwhile: '保留现状', more_evidence: '等待任务依据', acquisition_approval_required: '获取方案待授权',
    learning_allowance_required: '等待学习额度', learning_budget_exhausted: '学习额度已用完',
    planning_context_exceeds_allowance: '任务依据超过本次额度', allowance_release_failed: '清理结果待确认',
    npm_candidate_pending_review: '适配候选待审核', npm_contract_revision_required: '检查契约需要修订',
    production_candidate_pending_review: '生产候选待检查与审核',
    contract_revision_approval_required: '契约修订待授权', acquisition_runtime_unsupported: '所需运行方式尚未接入',
    npm_contract_research_budget_exhausted: '本次调查额度已用完',
  };
  const outcome = job.outcomeCode === undefined ? undefined : outcomes[job.outcomeCode];
  if (outcome !== undefined) return outcome;
  if (job.outcomeCode === 'execution_authorization_required') return '等待执行授权';
  if (job.outcomeCode === 'manual_recipe') return '等待手动处理';
  return labels[job.state];
}

export function ToolLearningRecords(props: { readonly runtime?: ToolLearningRuntime }): ReactElement {
  const [load, setLoad] = useState<ToolLearningLoad>(), [refresh, setRefresh] = useState(0);
  const [view, setView] = useState<'production' | 'jobs'>('production');
  const [acquisition, setAcquisition] = useState<string>();
  const [acquisitionBusy, setAcquisitionBusy] = useState(false);
  useEffect(() => {
    const controller = new AbortController();
    setLoad(undefined);
    if (props.runtime === undefined) { setLoad({ ok: false, reason: 'cli_unavailable' }); return; }
    void loadToolLearningStatus({ ...props.runtime, signal: controller.signal }).then(result => {
      if (!controller.signal.aborted) setLoad(result);
    });
    return () => controller.abort();
  }, [props.runtime, refresh]);
  return <section className="tool-learning-records" aria-label="工具学习记录" aria-busy={load === undefined}>
    <div className="tool-learning-records__topbar">
    <div className="tool-learning-records__heading">
      <div><h2>工具学习</h2><p>先看工具能帮你完成什么，再决定是否允许使用。</p></div>
      {view === 'jobs' ? <button type="button" disabled={load === undefined || acquisitionBusy} onClick={() => setRefresh(value => value + 1)}>刷新记录</button> : null}
    </div>
    <div className="tool-learning-records__views" role="group" aria-label="工具学习视图"><button type="button" disabled={acquisitionBusy} aria-pressed={view === 'production'} onClick={() => setView('production')}>工具管理</button><button type="button" disabled={acquisitionBusy} aria-pressed={view === 'jobs'} onClick={() => setView('jobs')}>学习记录</button></div>
    </div>
    {view === 'production' ? <ToolProductionPanel runtime={props.runtime} /> : load === undefined ? <p role="status">正在读取工具学习记录…</p> : !load.ok ? <div role="alert">
      <p>暂时无法读取工具学习记录。请检查当前 CLI 是否支持工具学习，然后重试。</p>
      <details><summary>查看原因</summary><code>{load.reason}</code></details>
      <button type="button" onClick={() => setRefresh(value => value + 1)}>重试</button>
    </div> : load.status.jobs.length === 0 ? <p className="learning-inspector__empty">当前工作区还没有工具学习任务。开启工具学习后，有依据的工具缺口会进入这里。</p> : <>
      <p className="tool-learning-records__note">获取方案需显式授权；准备好的候选仍需验证与审核。</p>
      <ul className="tool-learning-records__list">{load.status.jobs.map(job => <li key={job.jobId}>
        <div className="tool-learning-records__row"><h3>{job.capability}</h3><span className="tool-learning-records__state">{stateLabel(job)}</span></div>
        <p>{job.searchStatus === undefined ? '尚未检索' : `已检索到 ${job.discovered ?? 0} 个候选${job.searchStatus === 'partial' ? '，部分来源暂不可用' : job.searchStatus === 'failed' ? '，检索未成功' : ''}`}</p>
        {job.acquisition ? <p>{job.acquisition.continuation?.versionId ? '准备结果可在工具管理中查看。'
          : job.acquisition.continuation?.state === 'running' ? '隔离获取已进入适配阶段。'
            : job.acquisition.installed === true ? '隔离获取已完成，适配进度可展开查看。'
              : job.acquisition.failure ? `已保存获取阻碍：${job.acquisition.failure.code}。`
              : job.acquisition.installationId ? '依赖清单已冻结，获取进度可展开查看。' : '获取方案等待审阅与授权。'}</p> : null}
        {job.candidateVersionId === undefined ? null : <p>候选已保存，可查看依据标识。</p>}
        {job.outcomeCode === 'acquisition_approval_required' || job.acquisition ? <button type="button" disabled={acquisitionBusy} aria-expanded={acquisition === job.jobId} onClick={() => setAcquisition(value => value === job.jobId ? undefined : job.jobId)}>
          {acquisition === job.jobId ? '收起获取审阅' : job.acquisition?.installationId ? '查看获取进度' : '审阅获取方案'}
        </button> : null}
        {productionVersion(job.candidateVersionId) && acquisition !== job.jobId ? <button type="button" disabled={acquisitionBusy} onClick={() => setView('production')}>查看工具管理</button> : null}
        {job.contractProposalId ? <details><summary>契约修订需要审阅</summary><p>请在 CLI 查看具体更正，再显式批准对应审阅标识。</p>
          <code>trylo tools contract-show {job.contractProposalId} --json</code></details> : null}
        {acquisition === job.jobId ? <ToolAcquisitionReview runtime={props.runtime} jobId={job.jobId} workspaceId={load.status.workspaceId}
          onClose={() => setAcquisition(undefined)} onOpenProduction={() => setView('production')} onBusyChange={setAcquisitionBusy} /> : null}
        <details><summary>查看依据标识</summary><dl><dt>任务</dt><dd><code>{job.jobId}</code></dd>
          <dt>处理次数</dt><dd>{job.attempt}</dd>{job.outcomeCode === undefined ? null : <><dt>处理结果</dt><dd><code>{job.outcomeCode}</code></dd></>}
          {job.candidateVersionId === undefined ? null : <><dt>候选版本</dt><dd><code>{job.candidateVersionId}</code></dd></>}</dl></details>
      </li>)}</ul>
      {load.status.truncated ? <p>显示最近 {load.status.jobs.length} 项，共 {load.status.totalJobs} 项。</p> : null}
    </>}
  </section>;
}
