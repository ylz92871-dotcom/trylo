import { useEffect, useState } from 'react';
import type { ReactElement } from 'react';
import { loadToolLearningStatus, type ToolLearningLoad, type ToolLearningRuntime, type ToolLearningJobView, type ToolJobState } from '../../tool-learning/cli-status';
import './tool-learning-records.css';
import { ToolProductionPanel } from './ToolProductionPanel';

const labels: Readonly<Record<ToolJobState, string>> = { queued: '已排队', running: '处理中', waiting_approval: '候选待审核',
  waiting_evidence: '等待验证依据', succeeded: '已完成', failed: '处理失败', cancelled: '已取消', expired: '已结束' };
function stateLabel(job: ToolLearningJobView): string {
  if (job.outcomeCode === 'execution_authorization_required') return '等待执行授权';
  if (job.outcomeCode === 'manual_recipe') return '等待手动处理';
  return labels[job.state];
}

export function ToolLearningRecords(props: { readonly runtime?: ToolLearningRuntime }): ReactElement {
  const [load, setLoad] = useState<ToolLearningLoad>(), [refresh, setRefresh] = useState(0);
  const [view, setView] = useState<'production' | 'jobs'>('production');
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
      {view === 'jobs' ? <button type="button" disabled={load === undefined} onClick={() => setRefresh(value => value + 1)}>刷新记录</button> : null}
    </div>
    <div className="tool-learning-records__views" role="group" aria-label="工具学习视图"><button type="button" aria-pressed={view === 'production'} onClick={() => setView('production')}>工具管理</button><button type="button" aria-pressed={view === 'jobs'} onClick={() => setView('jobs')}>学习记录</button></div>
    </div>
    {view === 'production' ? <ToolProductionPanel runtime={props.runtime} /> : load === undefined ? <p role="status">正在读取工具学习记录…</p> : !load.ok ? <div role="alert">
      <p>暂时无法读取工具学习记录。请检查当前 CLI 是否支持工具学习，然后重试。</p>
      <details><summary>查看原因</summary><code>{load.reason}</code></details>
      <button type="button" onClick={() => setRefresh(value => value + 1)}>重试</button>
    </div> : load.status.jobs.length === 0 ? <p className="learning-inspector__empty">当前工作区还没有工具学习任务。开启工具学习后，有依据的工具缺口会进入这里。</p> : <>
      <p className="tool-learning-records__note">候选通过验证后仍需审核，尚未自动安装或启用。</p>
      <ul className="tool-learning-records__list">{load.status.jobs.map(job => <li key={job.jobId}>
        <div className="tool-learning-records__row"><h3>{job.capability}</h3><span className="tool-learning-records__state">{stateLabel(job)}</span></div>
        <p>{job.searchStatus === undefined ? '尚未检索' : `已检索到 ${job.discovered ?? 0} 个候选${job.searchStatus === 'partial' ? '，部分来源暂不可用' : job.searchStatus === 'failed' ? '，检索未成功' : ''}`}</p>
        {job.candidateVersionId === undefined ? null : <p>已生成候选，等待审核。</p>}
        <details><summary>查看依据标识</summary><dl><dt>任务</dt><dd><code>{job.jobId}</code></dd>
          <dt>处理次数</dt><dd>{job.attempt}</dd>{job.outcomeCode === undefined ? null : <><dt>处理结果</dt><dd><code>{job.outcomeCode}</code></dd></>}
          {job.candidateVersionId === undefined ? null : <><dt>候选版本</dt><dd><code>{job.candidateVersionId}</code></dd></>}</dl></details>
      </li>)}</ul>
      {load.status.truncated ? <p>显示最近 {load.status.jobs.length} 项，共 {load.status.totalJobs} 项。</p> : null}
    </>}
  </section>;
}
