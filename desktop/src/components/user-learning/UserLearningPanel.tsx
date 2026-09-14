import { useEffect, useRef, useState, type ReactElement } from 'react';
import { Virtuoso } from 'react-virtuoso';
import { cognitionMap, isWorkDimension } from '../../user-learning/cognition';
import type { EnforcementMode, UserLearningSnapshot, UserLearningSettings, PolicyDimension, EvidenceRecord, ProductSurface } from '../../user-learning/types';
import { dimensionLabel, eventTypeLabel } from '../../user-learning/labels';
import { inferDimension } from '../../user-learning/conclusion';
import type { LearningPort } from '../../learning/learning-port';
import { calculateLearningMetrics } from '../../user-learning/learning-metrics';
import { PendingProposals } from './PendingProposals';
import { ApprovedRecords } from './ApprovedRecords';
import {
  type InspectorPrefs,
  type SurfaceFilter,
  loadInspectorPrefs,
  saveInspectorPrefs,
  defaultSurfaceFilter,
  filterEvidence,
  evidenceSurface,
} from './inspector-prefs';

export interface UserLearningPanelProps {
  readonly open: boolean;
  readonly snapshot: UserLearningSnapshot;
  readonly settings: UserLearningSettings;
  readonly lastDecision?: string;
  /** Which surface opened the panel ('code' | 'work'). PR-4 (§4.1): opens to
   *  the 用户认知 module filtered to that surface, never an empty agent queue. */
  readonly openedFrom?: ProductSurface;
  /** Hermes learning port — powers the staged memory/skill approval tab. */
  readonly learningPort: LearningPort;
  readonly onClose: () => void;
  readonly onSettingsChange: (next: Partial<UserLearningSettings>) => void;
  readonly onCorrect?: () => void;
  readonly onOpenCognition?: () => void;
  readonly onExport?: () => void;
  readonly onDeleteUserData?: () => void;
}

const MODES: readonly EnforcementMode[] = ['shadow', 'enforced', 'off'];

/** Two top-level modules:
 *  - cognition: the desktop-side Evidence → Conclusion → User Model → Policy
 *    loop (the "learning shadow"), plus profile facts;
 *  - agent: the Hermes-side staged-write queue (memory/skills awaiting
 *    approval) and the committed records already written to Hermes. */

const SURFACES: readonly SurfaceFilter[] = ['all', 'code', 'work'];
const CHANNELS: readonly string[] = ['all', 'work', 'interaction', 'cognition'];

const WORK_KIND_LABEL: Readonly<Record<string, string>> = {
  artifact_promote: '提升产物',
  artifact_redo: '重做产物',
  artifact_praise: '称赞交付件',
  template_request: '做成模板',
};

export function UserLearningPanel(props: UserLearningPanelProps): ReactElement | null {
  const [prefs, setPrefs] = useState<InspectorPrefs>(() => {
    const loaded = loadInspectorPrefs();
    return { ...loaded, surfaceFilter: defaultSurfaceFilter(props.openedFrom, loaded.surfaceFilter) };
  });
  const [openModelId, setOpenModelId] = useState<string | null>(null);
  const [pendingCount, setPendingCount] = useState(0);
  const [approvedReloadKey, setApprovedReloadKey] = useState(0);

  // When the panel opens after being closed, reset active tabs so a re-open
  // doesn't land somewhere surprising. State (module/filters) is kept.
  const prevOpen = useRef(false);
  useEffect(() => {
    if (props.open && !prevOpen.current) {
      setPrefs((p) => ({ ...p, cognitionTab: 'status', agentTab: 'pending' }));
    }
    prevOpen.current = props.open;
  }, [props.open]);

  // Persist Inspector prefs (localStorage only — never into the User Learning JSON).
  useEffect(() => {
    saveInspectorPrefs(prefs);
  }, [prefs]);

  if (!props.open) return null;
  const { module, cognitionTab, agentTab, surfaceFilter, channelFilter, dimensionFilter, strengthFilter } = prefs;
  const set = (patch: Partial<InspectorPrefs>) => setPrefs((p) => ({ ...p, ...patch }));

  const models = props.snapshot.userModels.filter((m) => m.status === 'active');
  const map = cognitionMap(props.snapshot);
  const profile = props.snapshot.profileFacts.filter((p) => p.status === 'active');
  const conclusions = props.snapshot.conclusions.filter((c) => c.status === 'active');
  // Some host/test fixtures predate schema v5. The persisted migration fills
  // this field, but the inspector remains tolerant of an in-memory legacy prop.
  const learningReceipts = props.snapshot.learningReceipts ?? [];
  const last = props.snapshot.policyDecisions.at(-1);
  const activeRules = last?.active.length ?? 0;
  const metrics = calculateLearningMetrics(props.snapshot);
  const metricRate = (value: number | null): string => value === null ? '样本不足' : `${Math.round(value * 100)}%`;

  // Dual-surface Evidence list (spec §4.2): filtered → createdAt desc → slice(100).
  // Derived from props each render (R4: "list derived from props"), not a memo —
  // the whole panel is behind the `open` early return, so cost is negligible.
  const filteredEvidence = filterEvidence(props.snapshot.evidence, { surfaceFilter, channelFilter, dimensionFilter, strengthFilter }).slice(0, 100);

  // Work three-dimension coverage — grouped, always the three work dimensions,
  // gated by the surface filter (spec §4.3). Uses the shared cognitionMap.
  const workCoverage = map.filter((item) => isWorkDimension(item.dimension));

  // Available dimensions for the dimension filter (cognitionMap already ordered).
  const dimensionOptions = map.map((m) => m.dimension);

  return (
    <>
      <button
        type="button"
        className="learning-inspector-backdrop"
        aria-label="Close User Learning"
        onClick={props.onClose}
      />
      <aside className="learning-inspector" role="dialog" aria-label="User Learning">
        <header className="learning-inspector__header">
          <div>
            <p className="learning-inspector__kicker">Personal Agent</p>
            <h3 className="learning-inspector__title">学习</h3>
          </div>
          <button type="button" className="learning-inspector__close" onClick={props.onClose} aria-label="Close">×</button>
        </header>

        <nav className="learning-inspector__modules" aria-label="Learning modules">
          <button
            type="button"
            className={`learning-inspector__module${module === 'cognition' ? ' is-active' : ''}`}
            onClick={() => set({ module: 'cognition' })}
          >
            用户认知
            <span className="learning-inspector__module-sub">User Cognition</span>
          </button>
          <button
            type="button"
            className={`learning-inspector__module${module === 'agent' ? ' is-active' : ''}`}
            onClick={() => set({ module: 'agent' })}
          >
            代理学习
            <span className="learning-inspector__module-sub">Agent Learning</span>
            {pendingCount > 0 ? (
              <span className="learning-inspector__badge" aria-label={`${pendingCount} 条待审批`}>{pendingCount}</span>
            ) : null}
          </button>
        </nav>

        {module === 'cognition' ? (
          <nav className="learning-inspector__tabs" aria-label="User Cognition sections">
            {([
              ['status', '状态'],
              ['profile', 'Profile'],
              ['model', 'User Model'],
              ['evidence', 'Evidence'],
              ['decisions', 'Policy'],
            ] as const).map(([id, label]) => (
              <button
                key={id}
                type="button"
                className={`learning-inspector__tab${cognitionTab === id ? ' is-active' : ''}`}
                onClick={() => set({ cognitionTab: id })}
              >
                {label}
              </button>
            ))}
          </nav>
        ) : (
          <nav className="learning-inspector__tabs" aria-label="Agent Learning sections">
            <button
              type="button"
              className={`learning-inspector__tab${agentTab === 'pending' ? ' is-active' : ''}`}
              onClick={() => set({ agentTab: 'pending' })}
            >
              待审批
              {pendingCount > 0 ? (
                <span className="learning-inspector__badge" aria-label={`${pendingCount} 条待审批`}>{pendingCount}</span>
              ) : null}
            </button>
            <button
              type="button"
              className={`learning-inspector__tab${agentTab === 'approved' ? ' is-active' : ''}`}
              onClick={() => set({ agentTab: 'approved' })}
            >
              已批准记录
            </button>
          </nav>
        )}

        <div className="learning-inspector__body">
        {module === 'cognition' && cognitionTab === 'status' ? (
          <section className="learning-inspector__section">
            <div className="learning-inspector__modes">
              {MODES.map((mode) => (
                <button
                  key={mode}
                  type="button"
                  className={`learning-inspector__mode${props.settings.defaultMode === mode ? ' is-active' : ''}`}
                  onClick={() => props.onSettingsChange({ defaultMode: mode })}
                >
                  {mode}
                </button>
              ))}
            </div>
            <p className="learning-inspector__hint">
              这里是协作偏好：Trylo 怎么跟你干活。Shadow 只记录、不改变行为；Enforced 才会把短偏好写进 Prompt。聊天里告诉我的习惯会先被记下，不会立刻改成永久规则。
            </p>
            <ol className="learning-inspector__chain">
              <li><span>Evidence</span><strong>{props.snapshot.evidence.length}</strong></li>
              <li><span>Conclusion</span><strong>{conclusions.length}</strong></li>
              <li><span>User Model</span><strong>{models.length}</strong></li>
              <li><span>Policy</span><strong>{activeRules}</strong></li>
            </ol>
            <dl className="learning-inspector__stats">
              <div><dt>Mode</dt><dd>{props.settings.defaultMode}</dd></div>
              <div><dt>Last inject</dt><dd>{last?.injected ? 'yes' : 'no'}</dd></div>
              <div><dt>Storage</dt><dd>{
                props.snapshot.diagnostics?.incompatible
                  ? 'read-only incompatible'
                  : props.snapshot.diagnostics?.persistFailed
                    ? 'unpersisted'
                    : props.snapshot.persisted === false
                      ? 'unpersisted'
                      : 'ok'
              }</dd></div>
            </dl>
            <div className="learning-inspector__subhead">协作效果 · 仅本地聚合</div>
            <dl className="learning-inspector__stats">
              <div><dt>可比较机会</dt><dd>{metrics.comparableOpportunities}</dd></div>
              <div><dt>重复解释</dt><dd>{metrics.repeatedExplanations}</dd></div>
              <div><dt>重复解释率</dt><dd>{metricRate(metrics.repeatedExplanationRate)}</dd></div>
              <div><dt>实质返工率</dt><dd>{metricRate(metrics.materialReworkRate)}</dd></div>
              <div><dt>否定/回滚率</dt><dd>{metricRate(metrics.overrideRate)}</dd></div>
              <div><dt>无效提问率</dt><dd>{metricRate(metrics.unnecessaryAskRate)}</dd></div>
              <div><dt>跨范围污染</dt><dd>{metrics.crossScopeContaminationCount}</dd></div>
            </dl>
            {props.snapshot.diagnostics?.persistError ? (
              <p className="learning-inspector__hint">存储失败：{props.snapshot.diagnostics.persistError}</p>
            ) : null}

            <div className="learning-inspector__subhead">学习回执</div>
            {learningReceipts.length === 0 ? (
              <p className="learning-inspector__empty">尚无回执。只有形成新承诺或承诺发生实质变化时才会记录。</p>
            ) : (
              <ul className="learning-inspector__list">
                {[...learningReceipts].reverse().slice(0, 20).map((receipt) => (
                  <li key={receipt.id}>
                    <strong>{receipt.message}</strong>
                    <p>{receipt.scopeLabel} · {receipt.state}</p>
                    <p className="learning-inspector__raw">来源：{receipt.sourceSummary}</p>
                  </li>
                ))}
              </ul>
            )}

            {/* PR-4 (§4.3): Work three-dimension coverage, grouped, dimension labels. */}
            {surfaceFilter !== 'code' ? (
              <>
                <div className="learning-inspector__subhead">Work 三维度 {surfaceFilter === 'all' ? '· 全部表面' : '· Work 覆盖'}</div>
                <ul className="learning-inspector__work">
                  {workCoverage.map((item) => (
                    <li key={item.dimension}>
                      <span>{dimensionLabel(item.dimension)}</span>
                      <strong>{item.state}</strong>
                    </li>
                  ))}
                </ul>
              </>
            ) : null}

            <ul className="learning-inspector__list">
              {map.map((item) => (
                <li key={item.dimension}>
                  <strong>{dimensionLabel(item.dimension)}</strong>
                  <span> · {item.state}</span>
                  <div className="learning-inspector__modes">
                    {MODES.map((mode) => (
                      <button
                        key={mode}
                        type="button"
                        className={`learning-inspector__mode${(props.settings.dimensionMode[item.dimension] ?? props.settings.defaultMode) === mode ? ' is-active' : ''}`}
                        onClick={() => props.onSettingsChange({
                          dimensionMode: { ...props.settings.dimensionMode, [item.dimension]: mode },
                        })}
                      >
                        {mode}
                      </button>
                    ))}
                  </div>
                </li>
              ))}
            </ul>
            <div className="learning-inspector__actions">
              {props.onOpenCognition ? (
                <button type="button" className="cognition-card__primary" onClick={props.onOpenCognition}>聊聊你怎么工作</button>
              ) : null}
              {props.onCorrect ? (
                <button type="button" className="cognition-card__ghost" onClick={props.onCorrect}>纠正理解</button>
              ) : null}
              {props.onExport ? (
                <button type="button" className="cognition-card__ghost" onClick={props.onExport}>导出数据</button>
              ) : null}
              {props.onDeleteUserData ? (
                <button type="button" className="cognition-card__ghost" onClick={props.onDeleteUserData}>删除全部学习数据</button>
              ) : null}
            </div>
          </section>
        ) : null}

        {module === 'cognition' && cognitionTab === 'profile' ? (
          <section className="learning-inspector__section">
            {profile.length === 0 ? (
              <p className="learning-inspector__empty">还没有与 Code / Work 相关的身份事实。Cognition 里可以说你的专业和长期工作场景。</p>
            ) : (
              <ul className="learning-inspector__list">
                {profile.map((p) => (
                  <li key={p.id}>
                    <strong>{p.category}</strong>
                    <p>{p.statement}</p>
                  </li>
                ))}
              </ul>
            )}
          </section>
        ) : null}

        {module === 'cognition' && cognitionTab === 'model' ? (
          <section className="learning-inspector__section">
            {models.length === 0 ? (
              <p className="learning-inspector__empty">尚无稳定 User Model。Cognition 回答会先成为 Evidence，再经 Conclusion 推导。</p>
            ) : (
              <ul className="learning-inspector__list">
                {models.map((m) => {
                  const linked = props.snapshot.conclusions.filter((c) => m.derivedFrom.conclusionIds.includes(c.id));
                  const evidenceIds = linked.flatMap((c) => c.evidence.supporting);
                  const linkedEvidence = props.snapshot.evidence.filter((e) => evidenceIds.includes(e.id));
                  const open = openModelId === m.id;
                  return (
                    <li key={m.id}>
                      <button type="button" className="learning-inspector__tab" onClick={() => setOpenModelId(open ? null : m.id)}>
                        <strong>{dimensionLabel(m.dimension)}</strong>
                        <span> · {m.inference.distance} · {m.confidence.band} · effect={m.effectivenessState ?? 'unknown'}</span>
                      </button>
                      <p>{m.statement}</p>
                      {open ? (
                        <p className="learning-inspector__raw">
                          Conclusions: {linked.map((c) => c.statement).join(' / ') || '—'}
                          {' · '}Evidence: {linkedEvidence.map((e) => e.inference.claim).join(' / ') || '—'}
                        </p>
                      ) : null}
                    </li>
                  );
                })}
              </ul>
            )}
          </section>
        ) : null}

        {module === 'cognition' && cognitionTab === 'evidence' ? (
          <section className="learning-inspector__section learning-inspector__section--filters">
            {/* Surface filter row (spec §4.1). */}
            <div className="learning-inspector__filters">
              <span className="learning-inspector__filter-label">表面</span>
              {SURFACES.map((s) => (
                <button
                  key={s}
                  type="button"
                  className={`learning-inspector__filter-chip${surfaceFilter === s ? ' is-active' : ''}`}
                  onClick={() => set({ surfaceFilter: s })}
                >
                  {s === 'all' ? '全部' : s}
                </button>
              ))}
              <span className="learning-inspector__filter-label">渠道</span>
              {CHANNELS.map((c) => (
                <button
                  key={c}
                  type="button"
                  className={`learning-inspector__filter-chip${channelFilter === c ? ' is-active' : ''}`}
                  onClick={() => set({ channelFilter: c as InspectorPrefs['channelFilter'] })}
                >
                  {c === 'all' ? '全部' : c}
                </button>
              ))}
            </div>
            <div className="learning-inspector__filters">
              <span className="learning-inspector__filter-label">维度</span>
              <select
                className="learning-inspector__select"
                value={dimensionFilter}
                onChange={(e) => set({ dimensionFilter: e.target.value === 'all' ? 'all' : (e.target.value as PolicyDimension) })}
                aria-label="维度筛选"
              >
                <option value="all">全部维度</option>
                {dimensionOptions.map((dim) => (
                  <option key={dim} value={dim}>{dimensionLabel(dim)}</option>
                ))}
              </select>
              <span className="learning-inspector__filter-label">强度</span>
              {['weak', 'medium', 'strong', 'authoritative'].map((b) => (
                <button
                  key={b}
                  type="button"
                  className={`learning-inspector__filter-chip${strengthFilter === b ? ' is-active' : ''}`}
                  onClick={() => set({ strengthFilter: strengthFilter === b ? 'all' : (b as InspectorPrefs['strengthFilter']) })}
                >
                  {b}
                </button>
              ))}
            </div>

            {filteredEvidence.length === 0 ? (
              <p className="learning-inspector__empty">
                {surfaceFilter === 'work'
                  ? '还没有 Work 相关的 Evidence。提升或称赞一份产物（PPT / 周报），或"做成模板"会出现在这里。'
                  : surfaceFilter === 'code'
                    ? '还没有 Code 相关的 Evidence。真实任务里的纠正、选择、审批和 Cognition 回答会出现在这里。'
                    : '还没有 Evidence。真实任务里的纠正、选择、审批和 Cognition 回答，以及 Work 的产物提升 / 称赞，会出现在这里。'}
              </p>
            ) : (
              <Virtuoso
                className="learning-inspector__virtuoso"
                data={filteredEvidence}
                itemContent={(_i, e) => renderEvidenceRow(e)}
                computeItemKey={(_i, e) => e.id}
                initialItemCount={filteredEvidence.length}
                style={{ height: '100%' }}
              />
            )}
          </section>
        ) : null}

        {module === 'agent' ? (
          <>
            {/* Kept mounted (hidden when inactive) so the badge reflects the
                live queue count without an extra fetch on click. */}
            <div hidden={agentTab !== 'pending'}>
              <PendingProposals
                port={props.learningPort}
                onCountChange={setPendingCount}
                onSettled={() => setApprovedReloadKey((k) => k + 1)}
              />
            </div>
            {agentTab === 'approved' ? (
              <ApprovedRecords port={props.learningPort} reloadKey={approvedReloadKey} />
            ) : null}
          </>
        ) : null}

        {module === 'cognition' && cognitionTab === 'decisions' ? (
          <section className="learning-inspector__section">
            {last ? (
              <div className="learning-inspector__decision">
                <p>mode={last.mode} · injected={String(last.injected)} · rules={last.active.length}</p>
                {last.mode === 'shadow' && last.active.length > 0 ? (
                  <p className="learning-inspector__hint">若 Enforced，本会注入这 {last.active.length} 条。</p>
                ) : null}
                {last.impactCheck?.triggered ? (
                  <p className="learning-inspector__hint">Impact: {last.impactCheck.reason}</p>
                ) : null}
                {last.active.map((rule) => (
                  <p key={rule.policyId}>{rule.instruction}</p>
                ))}
              </div>
            ) : (
              <p className="learning-inspector__empty">还没有 Task-time Policy Decision。</p>
            )}
          </section>
        ) : null}
        </div>
      </aside>
    </>
  );
}

/** Renders one Evidence row using `dimensionLabel` / `eventTypeLabel` and the
 *  Work `structured.kind` mapping (spec §4.2). Dimmed at render time: `now`
 *  passed to keep the row pure. */
function renderEvidenceRow(e: EvidenceRecord): ReactElement {
  const dim = e.rawObservation?.structured?.dimension;
  const dimension = typeof dim === 'string' && dim && (dim as PolicyDimension).length > 0
    ? (dim as PolicyDimension)
    : inferDimension(e.inference.claim);
  const kind = typeof e.rawObservation?.structured?.kind === 'string'
    ? e.rawObservation.structured.kind
    : undefined;
  const kindLabel = kind ? WORK_KIND_LABEL[kind] : undefined;
  const surface = evidenceSurface(e);
  return (
    <li className={`learning-inspector__evidence-row${surface === 'work' ? ' is-work' : ''}`}>
      <div className="learning-inspector__evidence-meta">
        <strong>{eventTypeLabel(e.origin.eventType)}</strong>
        {kindLabel ? <span className="learning-inspector__kind">{kindLabel}</span> : null}
        <span> · {dimensionLabel(dimension)}</span>
        <span> · {surface}</span>
        <span> · {e.strength.band} · L{e.governance.level}</span>
      </div>
      <p className="learning-inspector__evidence-claim">{e.inference.claim}</p>
      <p className="learning-inspector__raw">{e.rawObservation.text}</p>
    </li>
  );
}
