import type { ReactElement, ReactNode } from 'react';
import type { AgentLearningDomain } from '../../agent-learning/client';
import './agent-domain-content.css';

type ObjectValue = Readonly<Record<string, unknown>>;
export type AgentDomainContentProps = {
  readonly domain: AgentLearningDomain;
  readonly content: ObjectValue;
  readonly related?: readonly ObjectValue[];
};
const object = (value: unknown): ObjectValue => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as ObjectValue : {};
const text = (value: unknown): string => typeof value === 'string' ? value : '';
const objects = (value: unknown): ObjectValue[] => Array.isArray(value) ? value.filter(item => item !== null && typeof item === 'object' && !Array.isArray(item)) : [];
const strings = (value: unknown): string[] => Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : typeof value === 'string' ? [value] : [];
const labels: Readonly<Record<string, string>> = { tools: '涉及工具', failureFamily: '失败类型', labels: '情境标签', sameSession: '同一会话',
  surface: '工作界面', taskFamily: '任务类型', dependency: '依赖关系', responsibility: '职责', intentClass: '任务意图', checkKind: '检查类型' };
function scalarText(value: unknown): string {
  if (typeof value === 'string' || typeof value === 'number') return String(value);
  if (typeof value === 'boolean') return value ? '是' : '否';
  return strings(value).join('、');
}
function valueText(value: unknown): string {
  return scalarText(value) || Object.entries(object(value)).flatMap(([key, item]) => scalarText(item) ? [`${labels[key] ?? key}：${scalarText(item)}`] : []).join('；');
}
function Section({ title, children }: { readonly title: string; readonly children: ReactNode }): ReactElement {
  return <section className="agent-domain-content__section"><h4>{title}</h4>{children}</section>;
}
function Conditions({ value }: { readonly value: unknown }): ReactElement | null {
  const rows = Object.entries(object(value)).flatMap(([key, item]) => valueText(item) ? [[labels[key] ?? key, valueText(item)]] : []);
  return rows.length ? <dl className="agent-domain-content__conditions">{rows.map(([key, item], index) => <div key={index}><dt>{key}</dt><dd>{item}</dd></div>)}</dl> : null;
}
function TextList({ items }: { readonly items: readonly string[] }): ReactElement | null {
  return items.length ? <ul>{items.map((item, index) => <li key={index}>{item}</li>)}</ul> : null;
}
function RelatedFacts({ rows }: { readonly rows: readonly ObjectValue[] }): ReactElement | null {
  const visible = rows.flatMap(row => {
    const use = object(row.use), boundary = object(row.boundary), observation = object(row.observation);
    const task = text(row.turnId) || text(row.sessionId) || text(boundary.taskId);
    const summary = text(row.summary) || text(row.explanation) || text(observation.explanation) || text(row.instruction);
    const identity = text(row.factId) || text(row.receiptId) || text(row.exposureId) || text(use.useId);
    const phase = text(row.phase) || text(row.kind);
    const phaseLabels: Readonly<Record<string, string>> = { loaded: '已加载', dispatched: '已发送', use_feedback: '采用反馈',
      exposure: '展示记录', adoption: '采用记录', outcome: '结果记录', correction: '纠正记录' };
    const event = phaseLabels[phase] || phase || (text(use.useId) ? '采用记录' : typeof row.helped === 'boolean' ? '反馈记录' : text(row.requestId) ? '展示记录' : '');
    const result = typeof row.helped === 'boolean' ? row.helped ? '反馈：有帮助' : '反馈：未帮助' : text(row.outcome);
    const time = text(row.recordedAt);
    if (!task && !summary && !identity && !result && !time) return [];
    return [{ task, summary, identity, result, time, event }];
  });
  return visible.length ? <Section title="采用与反馈"><ol className="agent-domain-content__facts">{visible.map((fact, index) => <li key={index}>
    {fact.event ? <p className="agent-domain-content__meta">{fact.event}</p> : null}
    {fact.task ? <p>任务 <code>{fact.task}</code></p> : null}{fact.summary ? <p>{fact.summary}</p> : null}
    {fact.result ? <p>{fact.result}</p> : null}{fact.time || fact.identity ? <p className="agent-domain-content__meta">{[fact.time, fact.identity].filter(Boolean).join(' · ')}</p> : null}
  </li>)}</ol></Section> : null;
}
function MethodContent({ content, related = [] }: Omit<AgentDomainContentProps, 'domain'>): ReactElement {
  const card = object(content.card), source = Object.keys(card).length ? card : content;
  const lineage = object(source.lineage), created = object(lineage.createdFrom), ledger = object(content.ledger);
  const counts = ([['uses', '上场'], ['supports', '支持'], ['counterexamples', '反例']] as const).flatMap(([key, label]) => typeof ledger[key] === 'number' ? [`${label} ${ledger[key]}`] : []);
  return <>
    {text(source.hint) ? <Section title="当前做法"><p className="agent-domain-content__lead">{text(source.hint)}</p></Section> : null}
    {Object.keys(object(source.appliesWhen)).length ? <Section title="适用条件"><Conditions value={source.appliesWhen} /></Section> : null}
    {text(created.turnId) ? <Section title="形成依据"><p>来自任务 <code>{text(created.turnId)}</code>{typeof created.beat === 'number' ? ` · 第 ${created.beat} 轮` : ''}</p>
      {text(created.reason) ? <p className="agent-domain-content__meta">{text(created.reason)}</p> : null}</Section> : null}
    {counts.length ? <p className="agent-domain-content__counts">{counts.join(' · ')}</p> : null}
    <RelatedFacts rows={related} />
  </>;
}
function StepIO({ label, value }: { readonly label: string; readonly value: unknown }): ReactElement | null {
  const items = strings(value);
  return items.length ? <div className="agent-domain-content__io"><span>{label}</span><div>{items.map((item, index) => <p key={index}>{item}</p>)}</div></div> : null;
}
function Failure({ value }: { readonly value: unknown }): ReactElement | null {
  const failure = object(value), reason = text(failure.reason), action = text(failure.action);
  if (!reason && !action) return null;
  const behavior = action === 'goto' ? `返回 ${text(failure.target)}${typeof failure.maxAttempts === 'number' ? `，至多 ${failure.maxAttempts} 次` : ''}`
    : action === 'stop' ? '停止' : action === 'replan' ? '重新规划' : action;
  return <p className="agent-domain-content__recovery">失败处理：{[behavior, reason].filter(Boolean).join(' · ')}</p>;
}
function WorkflowContent({ content, related = [] }: Omit<AgentDomainContentProps, 'domain'>): ReactElement {
  const procedure = object(object(content.proposal).procedure), opportunity = object(content.opportunity);
  const nodes = objects(procedure.steps).length ? objects(procedure.steps) : objects(content.nodes);
  const recovery = objects(content.recovery);
  return <>
    {text(opportunity.problem) ? <Section title="要改善的问题"><p>{text(opportunity.problem)}</p>{text(opportunity.desiredOutcome) ? <p className="agent-domain-content__meta">期望：{text(opportunity.desiredOutcome)}</p> : null}</Section> : null}
    {nodes.length ? <Section title="步骤与产物"><ol className="agent-domain-content__steps">{nodes.map((node, index) => <li key={text(node.id) || index}>
      <div className="agent-domain-content__step-number" aria-hidden="true">{index + 1}</div><div>
        <h5>{text(node.action) || text(node.id)}</h5>
        <StepIO label="输入" value={node.inputs ?? node.input} /><StepIO label="输出" value={node.outputs ?? node.output} />
        {strings(node.dependsOn).length ? <p className="agent-domain-content__meta">依赖：{strings(node.dependsOn).join('、')}</p> : null}
        {text(node.verify) || text(node.check) ? <p className="agent-domain-content__check">检查：{text(node.verify) || text(node.check)}</p> : null}
        <Failure value={node.onFailure} />
      </div></li>)}</ol></Section> : null}
    {Object.keys(object(procedure.requiredConditions ?? content.conditions)).length ? <Section title="适用条件"><Conditions value={procedure.requiredConditions ?? content.conditions} /></Section> : null}
    {recovery.length ? <Section title="恢复与经验"><ul>{recovery.map((item, index) => <li key={index}>{text(item.afterNode) ? `在 ${text(item.afterNode)} 之后：` : ''}{text(item.lesson)}{text(item.goto) ? `；返回 ${text(item.goto)}` : ''}</li>)}</ul></Section> : null}
    {strings(procedure.stopRules).length ? <Section title="停止条件"><TextList items={strings(procedure.stopRules)} /></Section> : null}
    <RelatedFacts rows={related} />
  </>;
}
function CollaborationContent({ content, related = [] }: Omit<AgentDomainContentProps, 'domain'>): ReactElement {
  const actions = [...objects(content.adjustments), ...objects(content.actions)];
  const sources = [...strings(content.sourceRefs), ...strings(content.sourceEventIds), ...strings(content.sourceEpisodeIds), ...strings(content.sourceOutcomeIds)];
  return <>
    {text(content.situation) || text(content.summary) || text(content.hypothesis) ? <Section title="情境与问题"><p className="agent-domain-content__lead">{text(content.situation) || text(content.summary) || text(content.hypothesis)}</p></Section> : null}
    {text(content.practice) ? <Section title="形成的做法"><p>{text(content.practice)}</p></Section> : null}
    {strings(content.responsibilities).length ? <Section title="职责"><TextList items={strings(content.responsibilities)} /></Section> : null}
    {actions.length ? <Section title="协作调整"><ol className="agent-domain-content__facts">{actions.map((item, index) => <li key={text(item.actionId) || index}>
      {text(item.memberId) ? <p className="agent-domain-content__meta">成员 {text(item.memberId)}</p> : null}<p>{text(item.instruction)}</p>
      {text(item.expectedObservable) ? <p className="agent-domain-content__meta">观察：{text(item.expectedObservable)}</p> : null}
    </li>)}</ol></Section> : null}
    {Object.keys(object(content.conditions)).length ? <Section title="适用条件"><Conditions value={content.conditions} /></Section> : null}
    {strings(content.failureConditions).length ? <Section title="不适用情况"><TextList items={strings(content.failureConditions)} /></Section> : null}
    {sources.length ? <Section title="形成依据"><ul className="agent-domain-content__sources">{sources.map((source, index) => <li key={index}><code>{source}</code></li>)}</ul></Section> : null}
    <RelatedFacts rows={related} />
  </>;
}

/** Domain objects lead the detail; the parent retains full raw/Markdown reading and identity. */
export function AgentDomainContent(props: AgentDomainContentProps): ReactElement {
  return <div className={`agent-domain-content agent-domain-content--${props.domain}`}>
    {props.domain === 'method' ? <MethodContent {...props} /> : props.domain === 'workflow' ? <WorkflowContent {...props} /> : <CollaborationContent {...props} />}
  </div>;
}
