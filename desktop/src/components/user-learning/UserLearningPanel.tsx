import { useEffect, useRef, useState, type ReactElement } from 'react'
import { Logo } from '../brand/Logo'
import {
  UserRound,
  BrainCircuit,
  LayoutDashboard,
  SlidersHorizontal,
  ContactRound,
  Fingerprint,
  Settings2,
  Database,
  BarChart3,
  Inbox,
  BookOpen,
  X,
  ShieldCheck,
  ChevronRight,
} from 'lucide-react'
import '../../styles/components/learning-center.css'
import { Virtuoso } from 'react-virtuoso'
import { CliMemoryRecords, type CliMemoryRecordsProps } from './CliMemoryRecords'
import { cognitionMap, isWorkDimension } from '../../user-learning/cognition'
import type {
  EnforcementMode,
  UserLearningSnapshot,
  UserLearningSettings,
  PolicyDimension,
  EvidenceRecord,
  ProductSurface,
  LearningReceipt,
} from '../../user-learning/types'
import { POLICY_DIMENSIONS } from '../../user-learning/types'
import { dimensionLabel, eventTypeLabel } from '../../user-learning/labels'
import { inferDimension } from '../../user-learning/conclusion'
import type { LearningPort } from '../../learning/learning-port'
import { calculateLearningMetrics } from '../../user-learning/learning-metrics'
import { PendingProposals } from './PendingProposals'
import { ApprovedRecords } from './ApprovedRecords'
import {
  type InspectorPrefs,
  type SurfaceFilter,
  loadInspectorPrefs,
  saveInspectorPrefs,
  defaultSurfaceFilter,
  filterEvidence,
  evidenceSurface,
} from './inspector-prefs'

export interface UserLearningPanelProps {
  readonly open: boolean
  readonly snapshot: UserLearningSnapshot
  readonly settings: UserLearningSettings
  readonly lastDecision?: string
  /** Which surface opened the panel ('code' | 'work'). PR-4 (§4.1): opens to
   *  the 用户认知 module filtered to that surface, never an empty agent queue. */
  readonly openedFrom?: ProductSurface
  /** Hermes learning port — powers the staged memory/skill approval tab. */
  readonly learningPort: LearningPort
  readonly onClose: () => void
  readonly onSettingsChange: (next: Partial<UserLearningSettings>) => void
  readonly onCorrect?: () => void
  readonly onOpenCognition?: () => void
  readonly onExport?: () => void
  readonly onDeleteUserData?: () => void
  readonly cliMemory?: CliMemoryRecordsProps
}

const MODE_LABELS = { shadow: '仅观察', enforced: '应用偏好', off: '停用偏好' }
const STATE_LABELS = { ok: '已了解', missing: '待了解', conflict: '有分歧', drift: '有变化' }
const PROFILE_LABELS = {
  role_identity: '角色与身份',
  domain_industry: '专业领域',
  capability_background: '能力背景',
  long_term_work_context: '长期工作场景',
}
const MODES: readonly EnforcementMode[] = ['shadow', 'enforced', 'off']

/** Two top-level modules:
 *  - cognition: the desktop-side Evidence → Conclusion → User Model → Policy
 *    loop (the "learning shadow"), plus profile facts;
 *  - agent: the Hermes-side staged-write queue (memory/skills awaiting
 *    approval) and the committed records already written to Hermes. */

const SURFACES: readonly SurfaceFilter[] = ['all', 'code', 'work']
const CHANNELS: readonly string[] = ['all', 'work', 'interaction', 'cognition']
const STRENGTHS: readonly InspectorPrefs['strengthFilter'][] = [
  'all',
  'weak',
  'medium',
  'strong',
  'authoritative',
]

const WORK_KIND_LABEL: Readonly<Record<string, string>> = {
  artifact_promote: '提升产物',
  artifact_redo: '重做产物',
  artifact_praise: '称赞交付件',
  template_request: '做成模板',
}

export function UserLearningPanel(props: UserLearningPanelProps): ReactElement | null {
  const [prefs, setPrefs] = useState<InspectorPrefs>(() => {
    const loaded = loadInspectorPrefs()
    let persisted: SurfaceFilter | undefined
    try {
      if (localStorage.getItem('trylo:learning:inspector:v1')) persisted = loaded.surfaceFilter
    } catch {
      /* unavailable storage */
    }
    return { ...loaded, surfaceFilter: defaultSurfaceFilter(props.openedFrom, persisted) }
  })
  const [aux, setAux] = useState<'data' | 'metrics' | null>(null)
  const [search, setSearch] = useState('')
  const [agentVisited, setAgentVisited] = useState(prefs.module === 'agent')
  const dialog = useRef<HTMLElement>(null)
  useEffect(() => {
    if (prefs.module === 'agent') setAgentVisited(true)
  }, [prefs.module])
  useEffect(() => {
    if (!props.open) return
    const previous = document.activeElement as HTMLElement | null
    const overflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    dialog.current?.focus()
    return () => {
      document.body.style.overflow = overflow
      previous?.isConnected && previous.focus()
    }
  }, [props.open])
  const [openModelId, setOpenModelId] = useState<string | null>(null)
  const [pendingCount, setPendingCount] = useState(0)
  const [approvedReloadKey, setApprovedReloadKey] = useState(0)

  // When the panel opens after being closed, reset active tabs so a re-open
  // doesn't land somewhere surprising. State (module/filters) is kept.
  const prevOpen = useRef(false)
  useEffect(() => {
    if (props.open && !prevOpen.current) {
      setPrefs((p) => ({ ...p, cognitionTab: 'status', agentTab: 'pending' }))
    }
    prevOpen.current = props.open
  }, [props.open])

  // Persist Inspector prefs (localStorage only — never into the User Learning JSON).
  useEffect(() => {
    saveInspectorPrefs(prefs)
  }, [prefs])

  if (!props.open) return null
  const {
    module,
    cognitionTab,
    agentTab,
    surfaceFilter,
    channelFilter,
    dimensionFilter,
    strengthFilter,
  } = prefs
  const set = (patch: Partial<InspectorPrefs>) => setPrefs((p) => ({ ...p, ...patch }))

  const models = props.snapshot.userModels.filter((m) => m.status === 'active')
  const cognition = cognitionMap(props.snapshot)
  const map = POLICY_DIMENSIONS.map(
    (dimension) =>
      cognition.find((item) => item.dimension === dimension) ?? {
        dimension,
        state: 'missing' as const,
      },
  )
  const cliIds = new Set(props.cliMemory?.facts.map((fact) => fact.id) ?? [])
  const profile = props.snapshot.profileFacts.filter(
    (p) => p.status === 'active' && !cliIds.has(p.id),
  )
  const conclusions = props.snapshot.conclusions.filter((c) => c.status === 'active')
  // Some host/test fixtures predate schema v5. The persisted migration fills
  // this field, but the inspector remains tolerant of an in-memory legacy prop.
  const learningReceipts = props.snapshot.learningReceipts ?? []
  const last = props.snapshot.policyDecisions.at(-1)
  const activeRules = last?.active.length ?? 0
  const metrics = calculateLearningMetrics(props.snapshot)
  const metricRate = (value: number | null): string =>
    value === null ? '样本不足' : `${Math.round(value * 100)}%`

  // Dual-surface Evidence list (spec §4.2): filtered → createdAt desc → slice(100).
  // Derived from props each render (R4: "list derived from props"), not a memo —
  // the whole panel is behind the `open` early return, so cost is negligible.
  const matchingEvidence = filterEvidence(props.snapshot.evidence, {
    surfaceFilter,
    channelFilter,
    dimensionFilter,
    strengthFilter,
  }).filter(
    (e) =>
      !search ||
      (e.inference.claim + e.rawObservation.text).toLowerCase().includes(search.toLowerCase()),
  )
  const filteredEvidence = matchingEvidence.slice(0, 100)
  const hasEvidenceFilters =
    Boolean(search) ||
    surfaceFilter !== 'all' ||
    channelFilter !== 'all' ||
    dimensionFilter !== 'all' ||
    strengthFilter !== 'all'
  const clearEvidenceFilters = () => {
    setSearch('')
    set({
      surfaceFilter: 'all',
      channelFilter: 'all',
      dimensionFilter: 'all',
      strengthFilter: 'all',
    })
  }

  // Work three-dimension coverage — grouped, always the three work dimensions,
  // gated by the surface filter (spec §4.3). Uses the shared cognitionMap.
  const workCoverage = map.filter((item) => isWorkDimension(item.dimension))

  // Available dimensions for the dimension filter (cognitionMap already ordered).
  const dimensionOptions = map.map((m) => m.dimension)

  const userNav = [
    ['status', '概览', LayoutDashboard],
    ['model', '协作偏好', SlidersHorizontal],
    ['profile', '个人资料', ContactRound],
    ['evidence', '学习依据', Fingerprint],
    ['decisions', '应用设置', Settings2],
  ] as const
  const title =
    aux === 'data'
      ? '数据管理'
      : aux === 'metrics'
        ? '协作效果'
        : userNav.find(([id]) => id === cognitionTab)?.[1]
  const storageIssue =
    props.snapshot.diagnostics?.persistFailed ||
    props.snapshot.persisted === false ||
    props.snapshot.diagnostics?.incompatible ||
    props.snapshot.diagnostics?.readOnly
  return (
    <>
      <button
        type="button"
        className="learning-inspector-backdrop"
        aria-label="Close User Learning"
        onClick={props.onClose}
      />
      <aside
        ref={dialog}
        tabIndex={-1}
        className="learning-inspector learning-center"
        role="dialog"
        aria-modal="true"
        aria-label="学习"
        onKeyDown={(event) => {
          if (event.key === 'Escape') props.onClose()
          if (event.key === 'Tab') {
            const controls = Array.from(
              dialog.current?.querySelectorAll<HTMLElement>(
                'button:not(:disabled), select, input, a[href], [tabindex="0"]',
              ) ?? [],
            ).filter((el) => el.getClientRects().length > 0 && !el.closest('[inert]'))
            const first = controls[0]
            const lastControl = controls.at(-1)
            if (
              event.shiftKey &&
              (document.activeElement === first || document.activeElement === dialog.current)
            ) {
              event.preventDefault()
              lastControl?.focus()
            } else if (
              !event.shiftKey &&
              (document.activeElement === lastControl || document.activeElement === dialog.current)
            ) {
              event.preventDefault()
              first?.focus()
            }
          }
        }}
      >
        <header className="learning-center__header">
          <div>
            <Logo size={34} withBg tone="cream" variant="solid" decorative />
            <h1>学习</h1>
          </div>
          <div>
            {module === 'cognition' ? (
              <button
                type="button"
                className="learning-mode-chip"
                onClick={() => {
                  setAux(null)
                  set({ cognitionTab: 'decisions' })
                }}
              >
                <ShieldCheck size={14} />
                {props.settings.enabled ? MODE_LABELS[props.settings.defaultMode] : '已停用'}
              </button>
            ) : (
              <span className="learning-approval-note">
                <ShieldCheck size={14} />
                每项写入由你批准
              </span>
            )}
            <button
              type="button"
              className="learning-icon-button"
              aria-label="数据管理"
              onClick={() => {
                set({ module: 'cognition' })
                setAux('data')
              }}
            >
              <Settings2 size={18} />
            </button>
            <button
              type="button"
              className="learning-icon-button"
              aria-label="Close"
              onClick={props.onClose}
            >
              <X size={19} />
            </button>
          </div>
        </header>
        <nav className="learning-center__modules" aria-label="学习模块">
          <button
            type="button"
            aria-pressed={module === 'cognition'}
            onClick={() => set({ module: 'cognition' })}
          >
            <UserRound size={18} />
            <strong>用户学习</strong>
            <small>理解你的工作方式</small>
          </button>
          <button
            type="button"
            aria-pressed={module === 'agent'}
            onClick={() => {
              setAux(null)
              set({ module: 'agent' })
            }}
          >
            <BrainCircuit size={18} />
            <strong>智能体学习</strong>
            <small>积累记忆与技能</small>
            {pendingCount > 0 ? (
              <em aria-label={`${pendingCount} 条待审批`}>{pendingCount}</em>
            ) : null}
          </button>
        </nav>
        <div className="learning-center__layout">
          <nav className="learning-center__sidebar" aria-label="学习分区">
            <div>
              {module === 'cognition' ? (
                userNav.map(([id, label, Icon]) => (
                  <button
                    type="button"
                    key={id}
                    aria-current={!aux && cognitionTab === id ? 'page' : undefined}
                    onClick={() => {
                      setAux(null)
                      set({ cognitionTab: id })
                    }}
                  >
                    <Icon size={16} />
                    {label}
                  </button>
                ))
              ) : (
                <>
                  <button
                    type="button"
                    aria-current={agentTab === 'pending' ? 'page' : undefined}
                    onClick={() => set({ agentTab: 'pending' })}
                  >
                    <Inbox size={16} />
                    待审批
                  </button>
                  <button
                    type="button"
                    aria-current={agentTab === 'approved' ? 'page' : undefined}
                    onClick={() => set({ agentTab: 'approved' })}
                  >
                    <BookOpen size={16} />
                    已批准记录
                  </button>
                </>
              )}
            </div>
            <div>
              <button
                type="button"
                aria-current={aux === 'data' ? 'page' : undefined}
                onClick={() => {
                  set({ module: 'cognition' })
                  setAux('data')
                }}
              >
                <Database size={16} />
                数据管理
              </button>
            </div>
          </nav>
          <main className="learning-center__main">
            <div className="learning-center__content">
              {module === 'cognition' ? (
                <header className="learning-center__heading">
                  <div>
                    <h2>{!aux && cognitionTab === 'status' ? '理解你的工作方式' : title}</h2>
                    <p>
                      {aux === 'metrics'
                        ? '仅使用本地记录计算；样本不足时不推断效果。'
                        : aux === 'data'
                          ? '查看本地存储状态，管理你的学习数据。'
                          : cognitionTab === 'status'
                            ? '从你的选择与纠正中，逐步形成更合适的协作方式。'
                            : cognitionTab === 'decisions'
                              ? '决定偏好如何参与任务。智能体的记忆和技能仍需逐项批准。'
                              : cognitionTab === 'model'
                                ? '有依据、可追溯，也随时可以纠正。'
                                : cognitionTab === 'profile'
                                  ? '帮助 Trylo 理解你的专业背景与工作场景。'
                                  : '查看结论来自哪些真实选择与反馈。'}
                    </p>
                  </div>
                  {props.onOpenCognition && !aux ? (
                    <button
                      type="button"
                      className="learning-text-button"
                      onClick={props.onOpenCognition}
                    >
                      聊聊我的工作方式
                    </button>
                  ) : null}
                </header>
              ) : null}
              {storageIssue && module === 'cognition' && aux !== 'data' ? (
                <div className="learning-storage-alert" role="alert">
                  <strong>学习数据尚未正常保存</strong>
                  <button type="button" onClick={() => setAux('data')}>
                    查看详情
                  </button>
                </div>
              ) : null}

              {module === 'cognition' && !aux && cognitionTab === 'status' ? (
                <section className="learning-inspector__section">
                  <ol className="learning-inspector__chain">
                    <li>
                      <span>学习依据</span>
                      <strong>{props.snapshot.evidence.length}</strong>
                    </li>
                    <li>
                      <span>形成结论</span>
                      <strong>{conclusions.length}</strong>
                    </li>
                    <li>
                      <span>协作偏好</span>
                      <strong>{models.length}</strong>
                    </li>
                    <li>
                      <span>最近决策规则</span>
                      <strong>{activeRules}</strong>
                    </li>
                  </ol>
                  <div className="learning-overview-preferences">
                    <h3>最近理解的偏好</h3>
                    {models.length ? (
                      models
                        .slice(-2)
                        .reverse()
                        .map((model) => (
                          <button
                            type="button"
                            key={model.id}
                            onClick={() => set({ cognitionTab: 'model' })}
                          >
                            <strong>{model.statement}</strong>
                            <small>
                              {dimensionLabel(model.dimension)}
                              <ChevronRight size={14} />
                            </small>
                          </button>
                        ))
                    ) : (
                      <p className="learning-inspector__empty">
                        还没有形成稳定偏好。你在真实任务中的选择与纠正，会帮助 Trylo 逐步了解你。
                      </p>
                    )}
                  </div>
                  <div className="learning-overview-support">
                    <div className="learning-receipts">
                      <div className="learning-inspector__subhead">最近回执</div>
                      {learningReceipts.length === 0 ? (
                        <p className="learning-inspector__empty">
                          尚无回执。只有形成新承诺或承诺发生实质变化时才会记录。
                        </p>
                      ) : (
                        <ul className="learning-inspector__list">
                          {[...learningReceipts]
                            .reverse()
                            .slice(0, 1)
                            .map((receipt) => (
                              <Receipt key={receipt.id} receipt={receipt} />
                            ))}
                        </ul>
                      )}
                      {learningReceipts.length > 1 ? (
                        <details className="learning-receipt-history">
                          <summary>查看历史回执</summary>
                          <ul className="learning-inspector__list">
                            {[...learningReceipts]
                              .reverse()
                              .slice(1, 20)
                              .map((receipt) => (
                                <Receipt key={receipt.id} receipt={receipt} />
                              ))}
                          </ul>
                        </details>
                      ) : null}
                    </div>

                    {/* PR-4 (§4.3): Work three-dimension coverage, grouped, dimension labels. */}
                    {surfaceFilter !== 'code' ? (
                      <div className="learning-coverage">
                        <div className="learning-inspector__subhead">
                          Work 三维度 {surfaceFilter === 'all' ? '· 全部表面' : '· Work 覆盖'}
                        </div>
                        <ul className="learning-inspector__work">
                          {workCoverage.map((item) => (
                            <li key={item.dimension}>
                              <span>{dimensionLabel(item.dimension)}</span>
                              <small>{STATE_LABELS[item.state]}</small>
                            </li>
                          ))}
                        </ul>
                      </div>
                    ) : null}
                  </div>
                </section>
              ) : null}

              {module === 'cognition' && !aux && cognitionTab === 'profile' ? (
                <section className="learning-inspector__section">
                  {props.cliMemory ? <CliMemoryRecords {...props.cliMemory} /> : null}
                  {profile.length === 0 && (props.cliMemory?.facts.length ?? 0) === 0 ? (
                    <p className="learning-inspector__empty">
                      还没有个人资料。可以补充你的专业背景和长期工作场景。
                    </p>
                  ) : (
                    <ul className="learning-inspector__list">
                      {profile.map((p) => (
                        <li key={p.id}>
                          <strong>{PROFILE_LABELS[p.category] ?? p.category}</strong>
                          <p>{p.statement}</p>
                        </li>
                      ))}
                    </ul>
                  )}
                </section>
              ) : null}

              {module === 'cognition' && !aux && cognitionTab === 'model' ? (
                <section className="learning-inspector__section">
                  {models.length === 0 ? (
                    <p className="learning-inspector__empty">
                      还没有稳定的协作偏好。聊聊你的工作方式，Trylo 会结合依据逐步形成理解。
                    </p>
                  ) : (
                    <ul className="learning-inspector__list">
                      {models.map((m) => {
                        const linked = props.snapshot.conclusions.filter((c) =>
                          m.derivedFrom.conclusionIds.includes(c.id),
                        )
                        const evidenceIds = linked.flatMap((c) => c.evidence.supporting)
                        const linkedEvidence = props.snapshot.evidence.filter((e) =>
                          evidenceIds.includes(e.id),
                        )
                        const open = openModelId === m.id
                        return (
                          <li key={m.id}>
                            <button
                              type="button"
                              className="learning-inspector__tab"
                              onClick={() => setOpenModelId(open ? null : m.id)}
                            >
                              <strong>{dimensionLabel(m.dimension)}</strong>
                              <span>
                                {' '}
                                · 置信度{
                                  { low: '低', medium: '中', high: '高' }[m.confidence.band]
                                }{' '}
                                ·{' '}
                                {
                                  {
                                    unknown: '效果待验证',
                                    helpful: '有帮助',
                                    harmful: '需调整',
                                    mixed: '效果不一',
                                  }[m.effectivenessState ?? 'unknown']
                                }
                              </span>
                            </button>
                            <p>{m.statement}</p>
                            {open ? (
                              <p className="learning-inspector__raw">
                                推断距离：{m.inference.distance} · 相关结论：
                                {linked.map((c) => c.statement).join(' / ') || '—'}
                                {' · '}支持依据：{' '}
                                {linkedEvidence.map((e) => e.inference.claim).join(' / ') || '—'}
                              </p>
                            ) : null}
                          </li>
                        )
                      })}
                    </ul>
                  )}
                </section>
              ) : null}

              {module === 'cognition' && !aux && cognitionTab === 'evidence' ? (
                <section className="learning-inspector__section learning-inspector__section--filters">
                  <input
                    className="learning-search"
                    aria-label="搜索学习依据"
                    placeholder="搜索依据…"
                    value={search}
                    onChange={(event) => setSearch(event.target.value)}
                  />
                  {/* Surface filter row (spec §4.1). */}
                  <div className="learning-inspector__filters">
                    <span className="learning-inspector__filter-label">表面</span>
                    {SURFACES.map((s) => (
                      <button
                        key={s}
                        type="button"
                        className={`learning-inspector__filter-chip${surfaceFilter === s ? ' is-active' : ''}`}
                        aria-pressed={surfaceFilter === s}
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
                        aria-pressed={channelFilter === c}
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
                      onChange={(e) =>
                        set({
                          dimensionFilter:
                            e.target.value === 'all' ? 'all' : (e.target.value as PolicyDimension),
                        })
                      }
                      aria-label="维度筛选"
                    >
                      <option value="all">全部维度</option>
                      {dimensionOptions.map((dim) => (
                        <option key={dim} value={dim}>
                          {dimensionLabel(dim)}
                        </option>
                      ))}
                    </select>
                    <span className="learning-inspector__filter-label">强度</span>
                    {STRENGTHS.map((b) => (
                      <button
                        key={b}
                        type="button"
                        className={`learning-inspector__filter-chip${strengthFilter === b ? ' is-active' : ''}`}
                        aria-pressed={strengthFilter === b}
                        onClick={() =>
                          set({
                            strengthFilter: strengthFilter === b ? 'all' : b,
                          })
                        }
                      >
                        {b === 'all' ? '全部强度' : b}
                      </button>
                    ))}
                  </div>

                  <div className="learning-inspector__filters">
                    <span className="learning-inspector__hint" role="status">
                      匹配 {matchingEvidence.length} / {props.snapshot.evidence.length} 条依据
                      {matchingEvidence.length > 100 ? '，显示最新 100 条' : ''}
                    </span>
                    {hasEvidenceFilters ? (
                      <button
                        type="button"
                        className="learning-inspector__filter-chip"
                        onClick={clearEvidenceFilters}
                      >
                        清除筛选
                      </button>
                    ) : null}
                  </div>
                  {filteredEvidence.length === 0 ? (
                    <p className="learning-inspector__empty">
                      {props.snapshot.evidence.length > 0
                        ? '没有符合当前筛选条件的学习依据，可清除筛选查看全部。'
                        : surfaceFilter === 'work'
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
                      style={{ height: 'min(520px, 55vh)' }}
                    />
                  )}
                </section>
              ) : null}

              {agentVisited || module === 'agent' ? (
                <>
                  {/* Kept mounted (hidden when inactive) so the badge reflects the
                live queue count without an extra fetch on click. */}
                  <div hidden={module !== 'agent' || agentTab !== 'pending'}>
                    <PendingProposals
                      port={props.learningPort}
                      onCountChange={setPendingCount}
                      onSettled={() => setApprovedReloadKey((k) => k + 1)}
                    />
                  </div>
                  {module === 'agent' && agentTab === 'approved' ? (
                    <ApprovedRecords port={props.learningPort} reloadKey={approvedReloadKey} />
                  ) : null}
                </>
              ) : null}

              {module === 'cognition' && !aux && cognitionTab === 'decisions' ? (
                <section className="learning-inspector__section">
                  <div className="learning-inspector__modes">
                    {MODES.map((mode) => (
                      <button
                        key={MODE_LABELS[mode]}
                        type="button"
                        className={`learning-inspector__mode${props.settings.defaultMode === mode ? ' is-active' : ''}`}
                        onClick={() => props.onSettingsChange({ defaultMode: mode })}
                      >
                        {MODE_LABELS[mode]}
                      </button>
                    ))}
                  </div>
                  <p className="learning-inspector__hint">
                    “仅观察”会记录学习结果；“应用偏好”会将符合条件的偏好用于任务；“停用偏好”只停止应用偏好。正式用户记忆与学习采集由设置中的
                    Enable User Learning 开关控制。
                    聊天里表达的习惯会先作为依据记录，再逐步形成偏好。
                  </p>
                  <ul className="learning-inspector__list">
                    {map.map((item) => (
                      <li key={item.dimension}>
                        <strong>{dimensionLabel(item.dimension)}</strong>
                        <span> · {STATE_LABELS[item.state]}</span>
                        <div className="learning-inspector__modes">
                          {MODES.map((mode) => (
                            <button
                              key={MODE_LABELS[mode]}
                              type="button"
                              className={`learning-inspector__mode${(props.settings.dimensionMode[item.dimension] ?? props.settings.defaultMode) === mode ? ' is-active' : ''}`}
                              onClick={() =>
                                props.onSettingsChange({
                                  dimensionMode: {
                                    ...props.settings.dimensionMode,
                                    [item.dimension]: mode,
                                  },
                                })
                              }
                            >
                              {MODE_LABELS[mode]}
                            </button>
                          ))}
                        </div>
                      </li>
                    ))}
                  </ul>

                  <h3>最近应用</h3>
                  {last ? (
                    <div className="learning-inspector__decision">
                      <p>
                        {MODE_LABELS[last.mode]} · {last.injected ? '已应用' : '未应用'} ·{' '}
                        {last.active.length} 条规则
                      </p>
                      {last.mode === 'shadow' && last.active.length > 0 ? (
                        <p className="learning-inspector__hint">
                          切换到“应用偏好”后，符合条件时可使用这 {last.active.length} 条规则。
                        </p>
                      ) : null}
                      {last.impactCheck?.triggered ? (
                        <p className="learning-inspector__hint">
                          Impact: {last.impactCheck.reason}
                        </p>
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
              {module === 'cognition' && aux === 'metrics' ? (
                <section className="learning-inspector__section">
                  {' '}
                  <div className="learning-inspector__subhead">协作效果 · 仅本地聚合</div>
                  <dl className="learning-inspector__stats">
                    <div>
                      <dt>可比较机会</dt>
                      <dd>{metrics.comparableOpportunities}</dd>
                    </div>
                    <div>
                      <dt>重复解释</dt>
                      <dd>{metrics.repeatedExplanations}</dd>
                    </div>
                    <div>
                      <dt>重复解释率</dt>
                      <dd>{metricRate(metrics.repeatedExplanationRate)}</dd>
                    </div>
                    <div>
                      <dt>实质返工率</dt>
                      <dd>{metricRate(metrics.materialReworkRate)}</dd>
                    </div>
                    <div>
                      <dt>否定/回滚率</dt>
                      <dd>{metricRate(metrics.overrideRate)}</dd>
                    </div>
                    <div>
                      <dt>无效提问率</dt>
                      <dd>{metricRate(metrics.unnecessaryAskRate)}</dd>
                    </div>
                    <div>
                      <dt>跨范围污染</dt>
                      <dd>{metrics.crossScopeContaminationCount}</dd>
                    </div>
                  </dl>
                </section>
              ) : null}
              {module === 'cognition' && aux === 'data' ? (
                <section className="learning-inspector__section">
                  {' '}
                  <dl className="learning-inspector__stats">
                    <div>
                      <dt>默认模式</dt>
                      <dd>{MODE_LABELS[props.settings.defaultMode]}</dd>
                    </div>
                    <div>
                      <dt>最近决策</dt>
                      <dd>{last ? (last.injected ? '已应用' : '未应用') : '暂无记录'}</dd>
                    </div>
                    <div>
                      <dt>存储状态</dt>
                      <dd>
                        {props.snapshot.diagnostics?.incompatible
                          ? '版本不兼容 · 只读'
                          : props.snapshot.diagnostics?.persistFailed
                            ? '保存失败'
                            : props.snapshot.persisted === false
                              ? '尚未保存'
                              : props.snapshot.diagnostics?.readOnly
                                ? '只读'
                                : '正常'}
                      </dd>
                    </div>
                  </dl>
                  {props.snapshot.diagnostics?.persistError ? (
                    <details className="learning-diagnostics">
                      <summary>存储错误详情</summary>
                      <pre>{props.snapshot.diagnostics.persistError}</pre>
                    </details>
                  ) : null}
                  <p className="learning-inspector__hint">导出与删除沿用当前学习数据管理流程。</p>{' '}
                  <div className="learning-inspector__actions">
                    {props.onOpenCognition ? (
                      <button
                        type="button"
                        className="cognition-card__primary"
                        onClick={props.onOpenCognition}
                      >
                        聊聊你怎么工作
                      </button>
                    ) : null}
                    {props.onCorrect ? (
                      <button
                        type="button"
                        className="cognition-card__ghost"
                        onClick={props.onCorrect}
                      >
                        纠正理解
                      </button>
                    ) : null}
                    {props.onExport ? (
                      <button
                        type="button"
                        className="cognition-card__ghost"
                        onClick={props.onExport}
                      >
                        导出数据
                      </button>
                    ) : null}
                    {props.onDeleteUserData ? (
                      <button
                        type="button"
                        className="cognition-card__ghost"
                        onClick={props.onDeleteUserData}
                      >
                        删除全部学习数据
                      </button>
                    ) : null}
                  </div>
                </section>
              ) : null}

              {module === 'cognition' &&
              !aux &&
              (cognitionTab === 'model' || cognitionTab === 'profile') &&
              props.onCorrect ? (
                <button type="button" className="learning-text-button" onClick={props.onCorrect}>
                  纠正理解
                </button>
              ) : null}
            </div>
          </main>
        </div>
        <footer className="learning-center__footer">
          <button
            type="button"
            onClick={() => {
              set({ module: 'cognition' })
              setAux('data')
            }}
          >
            <span className={storageIssue ? 'is-warning' : 'is-ok'} />
            {storageIssue ? '存储需要处理' : '本地学习数据'}
          </button>
          {module === 'cognition' ? (
            <button type="button" onClick={() => setAux('metrics')}>
              <BarChart3 size={13} />
              协作效果
            </button>
          ) : (
            <span>记忆与技能仅在你批准后写入</span>
          )}
        </footer>
      </aside>
    </>
  )
}

/** Renders one Evidence row using `dimensionLabel` / `eventTypeLabel` and the
 *  Work `structured.kind` mapping (spec §4.2). Dimmed at render time: `now`
 *  passed to keep the row pure. */
function Receipt({ receipt }: { receipt: LearningReceipt }): ReactElement {
  const states = {
    pending: '待展示',
    shown: '已展示',
    acknowledged: '已确认',
    corrected: '已纠正',
    dismissed: '已忽略',
  }
  return (
    <li>
      <strong>{receipt.message}</strong>
      <p>
        {receipt.scopeLabel} · {states[receipt.state] ?? receipt.state}
      </p>
      <p className="learning-inspector__raw">来源：{receipt.sourceSummary}</p>
      {receipt.createdAt ? (
        <time dateTime={new Date(receipt.createdAt).toISOString()}>
          {new Date(receipt.createdAt).toLocaleDateString()}
        </time>
      ) : null}
    </li>
  )
}

function renderEvidenceRow(e: EvidenceRecord): ReactElement {
  const dim = e.rawObservation?.structured?.dimension
  const dimension =
    typeof dim === 'string' && dim && (dim as PolicyDimension).length > 0
      ? (dim as PolicyDimension)
      : inferDimension(e.inference.claim)
  const kind =
    typeof e.rawObservation?.structured?.kind === 'string'
      ? e.rawObservation.structured.kind
      : undefined
  const kindLabel = kind ? WORK_KIND_LABEL[kind] : undefined
  const surface = evidenceSurface(e)
  return (
    <li className={`learning-inspector__evidence-row${surface === 'work' ? ' is-work' : ''}`}>
      <div className="learning-inspector__evidence-meta">
        <strong>{eventTypeLabel(e.origin.eventType)}</strong>
        {kindLabel ? <span className="learning-inspector__kind">{kindLabel}</span> : null}
        <span> · {dimensionLabel(dimension)}</span>
        <span> · {surface}</span>
        <span>
          {' '}
          · {e.strength.band} · L{e.governance.level}
        </span>
      </div>
      <p className="learning-inspector__evidence-claim">{e.inference.claim}</p>
      <p className="learning-inspector__raw">{e.rawObservation.text}</p>
    </li>
  )
}
