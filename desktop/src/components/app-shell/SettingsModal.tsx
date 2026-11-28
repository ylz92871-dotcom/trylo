import { ModelConnectionFields } from './ModelConnectionFields'
import { MediaGenerationSettings } from './MediaGenerationSettings'
import { mediaGenerationProblem } from '../../settings/media-generation'
import { ModelContextSettings } from './ModelContextSettings'
import { workflowLearningSettings } from '../../settings/workflow-learning'
import { agentLearningSettings } from '../../settings/agent-learning'
import { CentralLearningSettings } from './CentralLearningSettings'
import { controlCentralRuntime } from '../../agent-learning/central-runtime'
import { configureCentralRuntimeForSettings } from '../../agent-learning/central-runtime-configuration'
import { withoutSettingsNotice, type SettingsNotice } from '../../settings/settings-notices'
import { CheckLearningSettings } from './CheckLearningSettings'
import {
  DEFAULT_CHECK_LEARNING,
  checkLearningBudgetProblem,
  checkLearningSettings,
} from '../../settings/check-learning'
import { reasoningSelectionProblem } from '../../settings/reasoning-effort'
import {
  ArrowLeft,
  X,
  Search,
  Plug,
  Palette,
  SlidersHorizontal,
  Wrench,
  Smartphone,
  BookOpen,
  Library,
  type LucideIcon,
} from 'lucide-react'
import { AppearanceSettings } from './AppearanceSettings'
// Trylo Desktop — Settings modal. See v1.15-handoff §1.2.
//
// v1.15.2: full port of the legacy `tryloCode` config shape.
// Five groups: Provider, Auth, Behavior, Vision, Summary,
// Runtime. Sub-connections (vision / summary) collapse to
// "use primary" by default — flipping the switch reveals
// the per-group fields (mirrors extension.js's
// visionUsePrimaryConnection / summaryUsePrimaryConnection).
//
// Custom headers are validated before persistence. No
// test-connection beyond the per-host TCP probe. Phase 3
// features (encrypted secret store, full HTTP test,
// "auto-detect best model") belong in Phase 3.

import { useEffect, useRef, useState, type MouseEvent as ReactMouseEvent, type ReactElement } from 'react'
import { usePresenceTransition } from '../../utils/use-presence-transition'
import {
  applyProfile,
  dismissSettingsNotice,
  connectionFields,
  createProfileId,
  removeProfile,
  saveSettings,
  settingsForSave,
  settingsDefaults,
  upsertProfile,
  type ApiFormat,
  type ModelProfile,
  type PermissionMode,
  type SubConnection,
  type TryloSettings,
  type SettingsSaveIntent,
} from '../../settings/settings-store'
import { PERMISSION_LEVELS, type PermissionLevel } from '../../permission/permission-policy'
import { testConnection, type TestConnectionResult } from '../../host-adapter/test-connection'
import type { PetStatusSnapshot, RemoteStatusResult } from '../../services-host/methods'
import { petStatusDetail, petStatusHeadline, petStatusTone } from '../../companion/pet-status-text'
import { WorkToolsSettings } from './WorkToolsSettings'
import { collaborationLearningSettings } from '../../settings/collaboration-learning'
import { CollaborationLearningPanel } from './CollaborationLearningPanel'
import type { CollaborationLearningRuntime } from '../../collaboration-learning/cli'
import type { DesktopCollaborationResources } from '../../collaboration-learning/desktop-resources'
import { CollaborationIssuesPanel } from '../collaboration-learning/CollaborationIssuesPanel'
import { DesktopLibrariesPanel, type LibraryRequestFocus } from './DesktopLibrariesPanel'
import type { ChatMessage } from '../chat/types'
import type { DesktopAccountPort } from '../../account/desktop-account'
import { SkillsModal } from './SkillsModal'
import type { LearningPort } from '../../learning/learning-port'
import type { SkillLearningRuntime } from '../../skill-learning/cli'
import { derivePackageView, type ToolPlatformState } from '../../tooling/use-tool-platform-state'
import { isInteractiveTitlebarTarget, toggleNativeWindowZoom } from '../../host-adapter/native-shell'
import { MacosComputerSettings } from './MacosComputerSettings'
import type { ToolingFacade } from '../../tooling/tooling-facade'
import { formatShortcut, isMacPlatform, isWindowsPlatform } from '../../utils/platform'
import { isTauri } from '../../host-adapter/tauri-detect'
import { useLiquidIndicator } from '../../utils/use-liquid-indicator'

export type SettingsTab =
  | 'connection'
  | 'media'
  | 'appearance'
  | 'behavior'
  | 'tools'
  | 'libraries'
  | 'remote'
  | 'subconnections'
  | 'learning'

const SETTINGS_TABS: readonly {
  id: SettingsTab
  label: string
  description: string
  keywords: string
  Icon: LucideIcon
}[] = [
  {
    id: 'connection',
    label: '模型连接',
    description: '管理模型服务和常用连接配置。',
    keywords: 'api key endpoint host provider anthropic openai 协议 模型 密钥 连接 配置 推理 上下文 视觉 摘要',
    Icon: Plug,
  },
  {
    id: 'media',
    label: '图片与视频',
    description: '配置生成 API 与网页创作方式。',
    keywords: 'image video replicate 生成 图像 视频 网页创作',
    Icon: Plug,
  },
  {
    id: 'appearance',
    label: '外观',
    description: '调整界面主题，让工作更舒适。',
    keywords: 'theme light dark system 主题 浅色 深色 跟随系统 字体',
    Icon: Palette,
  },
  {
    id: 'behavior',
    label: '行为与运行',
    description: '设置任务权限与运行方式。',
    keywords: 'permission level system prompt companion pet 权限 系统提示词 桌面伙伴 桌宠',
    Icon: SlidersHorizontal,
  },
  {
    id: 'tools',
    label: '工具与控制',
    description: '管理工具能力与依赖包。',
    keywords: 'office playwright chrome devtools browser computer cad eda mcp 办公 浏览器 电脑控制',
    Icon: Wrench,
  },
  {
    id: 'libraries',
    label: '能力库',
    description: '查询工具与专家，审核和维护专项配置。',
    keywords: 'tool expert library 工具库 专家库 审批',
    Icon: Library,
  },
  {
    id: 'remote',
    label: '远程',
    description: '连接手机与远程工作环境。',
    keywords: 'remote pairing tunnel mobile 手机 配对 隧道 连接',
    Icon: Smartphone,
  },
  {
    id: 'learning',
    label: '学习',
    description: '管理学习偏好与已安装技能。',
    keywords: 'learning skills hermes user collaboration workflow check central team cognition 技能 团队 学习',
    Icon: BookOpen,
  },
]

export interface RelayAccountActions extends DesktopAccountPort {
  relayLogin(
    params: import('../../services-host/methods').RelayLoginParams,
  ): Promise<import('../../services-host/methods').RelayAccountStatus>
  relayStatus(): Promise<import('../../services-host/methods').RelayAccountStatus>
  relayLogout(): Promise<import('../../services-host/methods').RelayAccountStatus>
}

export interface SettingsModalProps {
  readonly initialTab?: SettingsTab
  readonly open: boolean
  readonly initial: TryloSettings
  readonly onClose: () => void
  readonly onSave?: (settings: TryloSettings, intent: SettingsSaveIntent) => void
  /** A committed UI notice acknowledgment must update the cached owner without saving this form. */
  readonly onNoticeDismissed?: (notice: SettingsNotice) => void
  /** Real pet state from the sidecar (audit §4.2 PET-P0-1). Optional so the
   *  modal stays usable outside the wired app; absent means "unknown". */
  readonly petStatus?: PetStatusSnapshot
  /** Real remote-gateway state (spec §8.1.4). Optional; absent means the
   *  remote domain is not wired into this host. */
  readonly remoteStatus?: RemoteStatusResult | null
  readonly relayAccount?: RelayAccountActions | null
  readonly onOpenRemote?: () => void
  /** P0-A (audit §3.3): the Work tool packages' health + install actions.
   *  Optional so the modal renders in tests without the Service Host. */
  readonly toolPlatform?: ToolPlatformState | null
  readonly toolingFacade?: ToolingFacade | null
  /** Hermes learning port — powers the Skills library modal (installed
   *  skills list + SKILL.md viewer). Optional so settings still renders
   *  before the Service Host is up. */
  readonly learningPort?: LearningPort | null
  readonly skillLearningRuntime?: SkillLearningRuntime
  readonly collaborationLearningRuntime?: CollaborationLearningRuntime
  readonly collaborationResources?: DesktopCollaborationResources
  readonly onDiscussCollaborationIssue?: (issueId: string) => void
  readonly onRequestTemporaryExpert?: () => void
  readonly libraryApprovals?: readonly ChatMessage[]
  readonly onRespondLibraryApproval?: (id: string, allow: boolean) => void
  /** Opens the Learning panel on the pending-approval tab (used by the
   *  Skills modal's "go to proposals" action). */
  readonly onOpenLearningPending?: () => void
}

type FormState = TryloSettings

function sameSettingsExceptNotices(previous: TryloSettings, next: TryloSettings): boolean {
  const before = new Map(Object.entries(previous).filter(([key]) => key !== 'settingsNotices'))
  const after = Object.entries(next).filter(([key]) => key !== 'settingsNotices')
  return (
    before.size === after.length && after.every(([key, value]) => Object.is(before.get(key), value))
  )
}

function toFormState(s: TryloSettings): FormState {
  return {
    ...s,
    vision: { ...s.vision },
    summary: { ...s.summary },
    workflowLearning: workflowLearningSettings(s.workflowLearning),
    agentLearning: agentLearningSettings(s.agentLearning),
    companion: { ...s.companion },
    remote: { ...s.remote },
    checkLearning: checkLearningSettings(s.checkLearning),
    collaborationLearning: collaborationLearningSettings(s.collaborationLearning),
    userLearning: {
      ...settingsDefaults.userLearning,
      ...s.userLearning,
      dimensionMode: {
        ...settingsDefaults.userLearning.dimensionMode,
        ...s.userLearning?.dimensionMode,
      },
    },
  }
}

const API_FORMATS: readonly { readonly value: ApiFormat; readonly label: string }[] = [
  { value: 'anthropic', label: 'Anthropic' },
  { value: 'openai', label: 'OpenAI-compatible' },
]

// P2 (spec §3.2 / §4.4): the legacy `chat | plan | agent` list is
// kept ONLY for the value migration at load time. The Settings UI
// no longer offers it as a control; the new four-level picker is
// the single source of truth.
const PERMISSION_MODES: readonly {
  readonly value: PermissionMode
  readonly label: string
  readonly hint: string
}[] = [
  { value: 'chat', label: 'Chat', hint: 'Standard mode, asks for tool permissions' },
  { value: 'plan', label: 'Plan', hint: 'Read-only — design before building' },
  { value: 'agent', label: 'Agent', hint: 'Full tool access, no prompts' },
]
void PERMISSION_MODES // legacy list kept for back-compat; see permission-policy.legacyPermissionMigration.

/** P0-A §3.3-4: a capability switch without its package is a lie. This hint
 *  shows the required package's REAL state inline and offers the install
 *  action directly, so enabling 电脑控制/浏览器调试 surfaces what is missing
 *  instead of silently degrading (audit acceptance A03/A04). */
function WorkCapabilityHint(props: {
  platform: ToolPlatformState
  packageId: string
}): ReactElement | null {
  const { platform, packageId } = props
  const pkg = platform.byId[packageId]
  if (!pkg) return null
  const core = ['officecli', 'playwright', 'windows-mcp', 'chrome-devtools'].includes(packageId)
  const view = derivePackageView(pkg, platform.actions[packageId])
  if (view.uiState === 'available') {
    return (
      <span className="settings-modal__hint">
        ✓ {pkg.displayName} {pkg.version} 已就绪。
      </span>
    )
  }
  return (
    <div className="work-tools__row work-tools__row--err">
      <div className="work-tools__row-head">
        <span className="work-tools__state work-tools__state--err">{view.message}</span>
        {!core &&
        (view.action === 'install' ||
          view.action === 'retry' ||
          view.action === 'install-browser') ? (
          <button
            type="button"
            className="work-tools__action"
            onClick={() => {
              if (view.action === 'install-browser') void platform.installBrowser(packageId)
              else void platform.install(packageId)
            }}
          >
            {view.action === 'install-browser'
              ? '安装浏览器'
              : view.action === 'retry'
                ? '重试'
                : '安装'}
          </button>
        ) : null}
      </div>
    </div>
  )
}

export function SettingsModal(props: SettingsModalProps): ReactElement | null {
  const isWindows = isWindowsPlatform()
  const isMac = isMacPlatform()
  const macosCompanion = isMac && isTauri()
  const [form, setForm] = useState<FormState>(() => toFormState(props.initial))
  const [editingProfileId, setEditingProfileId] = useState<string | null>(null)
  const centralThoughtEdited = useRef(false)
  useEffect(() => {
    centralThoughtEdited.current = false
  }, [props.collaborationLearningRuntime?.cwd, props.collaborationLearningRuntime?.cliPath])
  // Notice metadata must not reset an unsaved preference draft or cancel an active connection check.
  const initialPreferences = useRef(props.initial)
  if (!sameSettingsExceptNotices(initialPreferences.current, props.initial))
    initialPreferences.current = props.initial
  const formInitial = initialPreferences.current
  useEffect(() => { setEditingProfileId(null) }, [props.open, formInitial])
  const testGeneration = useRef(0)
  const [testing, setTesting] = useState(false)
  const [testResult, setTestResult] = useState<TestConnectionResult | null>(null)
  const [testError, setTestError] = useState<string | null>(null)
  const [saveError, setSaveError] = useState<string | null>(null)
  const dismissRoutingRetirementNotice = () => {
    try {
      dismissSettingsNotice('routing-learning-retired')
      setForm((current) => ({
        ...current,
        settingsNotices: withoutSettingsNotice(current.settingsNotices, 'routing-learning-retired'),
      }))
      props.onNoticeDismissed?.('routing-learning-retired')
    } catch (error) {
      setSaveError(error instanceof Error ? error.message : '提示确认未保存，请重试。')
    }
  }
  const [skillsOpen, setSkillsOpen] = useState(false)
  const [collaborationOpen, setCollaborationOpen] = useState(false)
  const [libraryFocus, setLibraryFocus] = useState<
    LibraryRequestFocus & { readonly scope: string }
  >()
  const [profileName, setProfileName] = useState('')
  const dialogRef = useRef<HTMLDivElement>(null)
  const toolSelectionRef = useRef<HTMLDetailsElement>(null)
  const onCloseRef = useRef(props.onClose)
  onCloseRef.current = props.onClose
  // Sidebar tab state
  const [settingsTab, setSettingsTab] = useState<SettingsTab>('connection')
  const [tabSearch, setTabSearch] = useState('')
  const navRef = useRef<HTMLElement>(null)
  const navIndicatorRef = useRef<HTMLSpanElement>(null)
  useLiquidIndicator({
    containerRef: navRef,
    indicatorRef: navIndicatorRef,
    activeKey: props.open ? (settingsTab === 'subconnections' ? 'connection' : settingsTab) : null,
    axis: 'y',
  })
  // Remote pairing QR moved to the TopBar "远程" button
  // (RemotePairingModal) — 2026-08-29. Settings keeps only
  // the gateway *configuration* (port / tunnel / URL).

  useEffect(() => {
    testGeneration.current += 1
    setTesting(false)
    if (props.open) {
      setSettingsTab(props.initialTab ?? 'connection')
      setTabSearch('')
      setForm(toFormState(formInitial))
      centralThoughtEdited.current = false
      setTestResult(null)
      setTestError(null)
      setSaveError(null)
      setProfileName('')
    }
    return () => {
      testGeneration.current += 1
    }
  }, [props.open, formInitial, props.initialTab])

  useEffect(() => {
    setForm((current) => ({ ...current, settingsNotices: props.initial.settingsNotices }))
  }, [props.open, props.initial.settingsNotices])

  useEffect(() => {
    if (!props.open || skillsOpen) return
    const previousFocus = document.activeElement
    const dialog = dialogRef.current
    dialog?.querySelector<HTMLElement>('button')?.focus()
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        event.preventDefault()
        onCloseRef.current()
        return
      }
      if ((event.metaKey || event.ctrlKey) && !event.shiftKey && !event.altKey && event.key === ',') {
        event.preventDefault()
        event.stopPropagation()
        onCloseRef.current()
        return
      }
      if (event.key !== 'Tab' || !dialog) return
      const focusable = Array.from(
        dialog.querySelectorAll<HTMLElement>(
          'button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), summary, [tabindex="0"]',
        ),
      ).filter((element) => element.getClientRects().length > 0)
      const first = focusable[0],
        last = focusable[focusable.length - 1]
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault()
        last?.focus()
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault()
        first?.focus()
      }
    }
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('keydown', onKeyDown)
      if (previousFocus instanceof HTMLElement && previousFocus.isConnected) previousFocus.focus()
    }
  }, [props.open, skillsOpen])

  const presence = usePresenceTransition(props.open, 130)

  if (!presence.mounted) return null
  const isExiting = presence.state === 'exiting'

  const set = <K extends keyof TryloSettings>(k: K, v: TryloSettings[K]): void => {
    testGeneration.current += 1
    setTesting(false)
    setTestResult(null)
    setTestError(null)
    setSaveError(null)
    setForm((f) => ({ ...f, [k]: v }))
  }

  const setSub = (
    which: 'vision' | 'summary',
    k: keyof SubConnection,
    v: SubConnection[typeof k],
  ): void => {
    setSaveError(null)
    setForm((f) => ({
      ...f,
      [which]: { ...f[which], [k]: v },
    }))
  }

  const onTest = async (): Promise<void> => {
    const generation = ++testGeneration.current
    setTesting(true)
    setTestError(null)
    setTestResult(null)
    try {
      const r = await testConnection({
        apiHost:
          form.apiHost ||
          (form.apiFormat === 'openai' ? 'https://api.openai.com/v1' : 'https://api.anthropic.com'),
        apiKey: form.apiKey,
        apiFormat: form.apiFormat,
      })
      if (generation === testGeneration.current) setTestResult(r)
    } catch (err) {
      if (generation === testGeneration.current)
        setTestError(err instanceof Error ? err.message : String(err))
    } finally {
      if (generation === testGeneration.current) setTesting(false)
    }
  }

  const onSave = async (e: { preventDefault(): void }): Promise<void> => {
    e.preventDefault()
    const mediaProblem = mediaGenerationProblem(form.mediaGeneration)
    if (mediaProblem) {
      setSettingsTab('media')
      setSaveError(mediaProblem)
      return
    }
    // The inline field owns its error; do not silently normalize an invalid draft at save time.
    if (checkLearningBudgetProblem((form.checkLearning ?? DEFAULT_CHECK_LEARNING).tokenBudget)) {
      setSettingsTab('learning')
      return
    }
    const invalid = Array.from(
      dialogRef.current?.querySelectorAll<
        HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement
      >('input,select,textarea') ?? [],
    ).find((field) => field.form === null && !field.checkValidity())
    if (invalid) {
      invalid.reportValidity()
      return
    }
    const reasoningProblem = reasoningSelectionProblem(form)
    if (reasoningProblem) {
      setSaveError(reasoningProblem)
      return
    }
    for (const [name, headers] of [
      ['主模型', form.extraHeadersText],
      ...(!form.vision.usePrimaryConnection ? [['视觉模型', form.vision.extraHeadersText]] : []),
      ...(!form.summary.usePrimaryConnection ? [['摘要模型', form.summary.extraHeadersText]] : []),
    ]) {
      try {
        const value: unknown = JSON.parse(headers || '{}')
        if (
          !value ||
          typeof value !== 'object' ||
          Array.isArray(value) ||
          Object.values(value).some((v) => typeof v !== 'string')
        )
          throw new Error()
      } catch {
        setSaveError(`${name}的额外请求头需要是 JSON 对象，且每个值都是文本。请检查高级连接选项。`)
        return
      }
    }
    const connectionChanged =
      JSON.stringify(connectionFields(form)) !== JSON.stringify(connectionFields(props.initial)) ||
      form.activeModelProfileId !== props.initial.activeModelProfileId
    const contextEdited =
      JSON.stringify([form.modelContextPreferences ?? {}, form.modelReasoningPreferences ?? {}]) !==
      JSON.stringify([
        props.initial.modelContextPreferences ?? {},
        props.initial.modelReasoningPreferences ?? {},
      ])
    // Context preferences belong to the selected target, not the active connection.
    const intent: SettingsSaveIntent =
      connectionChanged || (navigationTab === 'connection' && !contextEdited)
        ? 'connection'
        : 'preferences'
    const editedForm = editingProfileId ? {
      ...form,
      activeModelProfileId: editingProfileId,
      modelProfiles: form.modelProfiles.map(profile => profile.id === editingProfileId
        ? { ...profile, ...connectionFields(form) } : profile),
    } : form
    const next = settingsForSave(
      props.initial,
      intent === 'connection' ? { ...editedForm, poolModel: '' } : editedForm,
    )
    const previousCentral = agentLearningSettings(props.initial.agentLearning).centralEnabled
    const nextCentral = agentLearningSettings(next.agentLearning).centralEnabled
    const userLearningChanged = props.initial.userLearning.enabled !== next.userLearning.enabled
    const learningConnectionChanged =
      connectionChanged || props.initial.reasoningEffort !== next.reasoningEffort
    if (previousCentral !== nextCentral && !nextCentral) {
      if (props.collaborationLearningRuntime === undefined) {
        setSaveError('学习运行时尚未就绪，未确认工作区学习开关。')
        return
      }
      try {
        await controlCentralRuntime(props.collaborationLearningRuntime, 'stop')
      } catch (error) {
        setSaveError(error instanceof Error ? error.message : '未确认学习开关，请重试。')
        return
      }
    }
    if (centralThoughtEdited.current && props.collaborationLearningRuntime === undefined) {
      setSaveError('学习运行时尚未就绪，未确认中央思考包络。')
      return
    }
    if (
      props.collaborationLearningRuntime !== undefined &&
      (userLearningChanged || learningConnectionChanged || centralThoughtEdited.current)
    ) {
      try {
        await configureCentralRuntimeForSettings(props.collaborationLearningRuntime, next, {
          connection: learningConnectionChanged,
          userLearning: userLearningChanged,
          thought: centralThoughtEdited.current,
        })
      } catch (error) {
        if (!(error instanceof Error && error.message === 'runtime_not_enabled')) {
          setSaveError(error instanceof Error ? error.message : '后台学习配置交接未确认，请重试。')
          return
        }
      }
    }
    if (previousCentral !== nextCentral && nextCentral) {
      if (props.collaborationLearningRuntime === undefined) {
        setSaveError('学习运行时尚未就绪，未确认工作区学习开关。')
        return
      }
      try {
        await controlCentralRuntime(
          props.collaborationLearningRuntime,
          nextCentral ? 'resume' : 'stop',
        )
      } catch (error) {
        // A first activation has no saved intent yet; its explicit allowance starts at the next normal task.
        if (!(nextCentral && error instanceof Error && error.message === 'runtime_not_enabled')) {
          setSaveError(error instanceof Error ? error.message : '未确认学习开关，请重试。')
          return
        }
      }
    }
    try {
      saveSettings(next)
    } catch (error) {
      setSaveError(error instanceof Error ? error.message : '设置保存失败，请重试。')
      return
    }
    props.onSave?.(next, intent)
    props.onClose()
  }

  // ── Saved connection profiles (我的配置) ────────────────
  // Works on the modal's local FormState: 载入 loads a profile into the
  // current connection fields, 覆盖 overwrites it with the current fields,
  // 删除 removes it. All are committed when the modal is saved.
  const profileFromCurrent = (name: string): ModelProfile => ({
    id: createProfileId(),
    name,
    ...connectionFields(form),
  })

  const handleAddProfile = (): void => {
    const name = profileName.trim()
    if (!name) return
    setForm((f) => ({ ...f, modelProfiles: [...f.modelProfiles, profileFromCurrent(name)] }))
    setProfileName('')
  }

  const handleApplyProfile = (id: string): void => {
    setEditingProfileId(null)
    setSaveError(null)
    if (!id) {
      set('activeModelProfileId', '')
      return
    }
    const p = form.modelProfiles.find((x) => x.id === id)
    if (p) {
      testGeneration.current += 1
      setTesting(false)
      setTestResult(null)
      setTestError(null)
      setForm((f) => applyProfile(f, p))
    }
  }

  const handleOverwriteProfile = (id: string): void => {
    setForm((f) => {
      const p = f.modelProfiles.find((x) => x.id === id)
      if (!p) return f
      return upsertProfile(f, { ...p, ...connectionFields(f) })
    })
  }

  const handleRemoveProfile = (id: string): void => {
    if (editingProfileId === id) setEditingProfileId(null)
    setForm((f) => removeProfile(f, id))
  }

  const handleRenameProfile = (id: string, name: string): void => {
    setForm((f) => ({
      ...f,
      modelProfiles: f.modelProfiles.map((p) => (p.id === id ? { ...p, name } : p)),
    }))
  }

  // Render a sub-connection field set. Mirrors the Auth +
  // Provider section shape but uses setSub instead of set.
  const renderSubConnection = (
    which: 'vision' | 'summary',
    title: string,
    description: string,
  ): ReactElement => {
    const sub = form[which]
    return (
      <fieldset className="settings-modal__group">
        <legend className="settings-modal__legend">{title}</legend>
        <p className="settings-modal__desc">{description}</p>

        <label className="settings-modal__field settings-modal__field--inline">
          <input
            type="checkbox"
            checked={sub.usePrimaryConnection}
            onChange={(e) => setSub(which, 'usePrimaryConnection', e.target.checked)}
          />
          <span className="settings-modal__label">沿用主模型连接</span>
        </label>

        {!sub.usePrimaryConnection && (
          <>
            <label className="settings-modal__field">
              <span className="settings-modal__label">Model</span>
              <input
                type="text"
                autoComplete="off"
                spellCheck={false}
                className="settings-modal__input"
                value={sub.model}
                onChange={(e) => setSub(which, 'model', e.target.value)}
                placeholder="claude-3-5-sonnet-latest (or leave blank for default)"
              />
            </label>

            <label className="settings-modal__field">
              <span className="settings-modal__label">Endpoint</span>
              <input
                type="text"
                autoComplete="off"
                spellCheck={false}
                className="settings-modal__input"
                value={sub.endpoint}
                onChange={(e) => setSub(which, 'endpoint', e.target.value)}
                placeholder="https://api.example.com/v1"
              />
            </label>

            <label className="settings-modal__field">
              <span className="settings-modal__label">API key</span>
              <input
                type="password"
                autoComplete="off"
                spellCheck={false}
                className="settings-modal__input"
                value={sub.apiKey}
                onChange={(e) => setSub(which, 'apiKey', e.target.value)}
                placeholder="(separate key for this connection)"
              />
            </label>

            <label className="settings-modal__field">
              <span className="settings-modal__label">Format</span>
              <select
                className="settings-modal__input"
                value={sub.apiFormat}
                onChange={(e) => setSub(which, 'apiFormat', e.target.value as ApiFormat)}
              >
                {API_FORMATS.map((f) => (
                  <option key={f.value} value={f.value}>
                    {f.label}
                  </option>
                ))}
              </select>
            </label>

            <label className="settings-modal__field">
              <span className="settings-modal__label">Provider preset</span>
              <input
                type="text"
                autoComplete="off"
                spellCheck={false}
                className="settings-modal__input"
                value={sub.providerId}
                onChange={(e) => setSub(which, 'providerId', e.target.value)}
                placeholder="(optional)"
              />
            </label>

            <label className="settings-modal__field">
              <span className="settings-modal__label">Auth header</span>
              <input
                type="text"
                autoComplete="off"
                spellCheck={false}
                className="settings-modal__input"
                value={sub.apiKeyHeader}
                onChange={(e) => setSub(which, 'apiKeyHeader', e.target.value)}
                placeholder="Authorization"
              />
            </label>

            <label className="settings-modal__field">
              <span className="settings-modal__label">Auth prefix</span>
              <input
                type="text"
                autoComplete="off"
                spellCheck={false}
                className="settings-modal__input"
                value={sub.apiKeyPrefix}
                onChange={(e) => setSub(which, 'apiKeyPrefix', e.target.value)}
                placeholder="Bearer "
              />
            </label>

            <label className="settings-modal__field">
              <span className="settings-modal__label">Extra headers (JSON)</span>
              <input
                type="text"
                autoComplete="off"
                spellCheck={false}
                className="settings-modal__input"
                value={sub.extraHeadersText}
                onChange={(e) => setSub(which, 'extraHeadersText', e.target.value)}
                placeholder='{"X-Custom":"value"}'
              />
            </label>
          </>
        )}
      </fieldset>
    )
  }

  // ── Render content by selected tab ─────────────────────
  const renderSection = (tab: SettingsTab): ReactElement => {
    switch (tab) {
      case 'media':
        return <MediaGenerationSettings value={form.mediaGeneration} onChange={value => set('mediaGeneration', value)} />
      case 'appearance':
        return <AppearanceSettings />
      case 'connection':
        return (
          <>
            {form.modelProfiles.length > 0 && (
              <label className="settings-modal__field">
                <span className="settings-modal__label">已保存的配置</span>
                <select
                  className="settings-modal__input"
                  value={
                    form.modelProfiles.some(
                      (profile) =>
                        profile.id === form.activeModelProfileId &&
                        JSON.stringify(connectionFields(profile)) ===
                          JSON.stringify(connectionFields(form)),
                    )
                      ? form.activeModelProfileId
                      : ''
                  }
                  onChange={(event) => handleApplyProfile(event.target.value)}
                >
                  <option value="">自定义连接</option>
                  {form.modelProfiles.map((profile) => (
                    <option key={profile.id} value={profile.id}>
                      {profile.name} · {profile.apiModel || '默认模型'}
                    </option>
                  ))}
                </select>
                <span className="settings-modal__hint">选择后载入表单，点击“保存设置”应用。</span>
              </label>
            )}
            <ModelContextSettings
              form={form}
              onChange={(preferences) => set('modelContextPreferences', preferences)}
              onReasoningChange={(preferences) => set('modelReasoningPreferences', preferences)}
            />
            <ModelConnectionFields
              form={form}
              onChange={set}
              onTest={() => void onTest()}
              testing={testing}
              result={testResult}
              error={testError}
            />

            {/* ── Saved connection profiles (我的配置) ─────────── */}
            <fieldset className="settings-modal__group">
              <legend className="settings-modal__legend">我的配置</legend>
              <div className="settings-modal__profiles-add">
                <input
                  type="text"
                  autoComplete="off"
                  spellCheck={false}
                  className="settings-modal__input"
                  value={profileName}
                  onChange={(e) => setProfileName(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      e.preventDefault()
                      handleAddProfile()
                    }
                  }}
                  aria-label="新配置名称"
                  placeholder="为这组连接起个名字"
                />
                <button
                  type="button"
                  className="settings-modal__btn settings-modal__btn--ghost"
                  onClick={handleAddProfile}
                  disabled={!profileName.trim()}
                >
                  添加配置
                </button>
              </div>
              {form.modelProfiles.length === 0 ? (
                <span className="settings-modal__hint">
                  还没有配置。填写主模型连接后，命名并添加，方便下次切换。
                </span>
              ) : (
                <ul className="settings-modal__profiles-list">
                  {form.modelProfiles.map((p) => {
                    const isActive = p.id === form.activeModelProfileId
                    return (
                      <li key={p.id} className="settings-modal__profile">
                        <input
                          type="text"
                          autoComplete="off"
                          spellCheck={false}
                          className="settings-modal__input settings-modal__profile-name"
                          value={p.name}
                          onChange={(e) => handleRenameProfile(p.id, e.target.value)}
                          aria-label="配置名"
                        />
                        <span className="settings-modal__profile-hint">
                          {p.apiModel || '默认模型'}
                          {p.apiHost ? ` · ${p.apiHost}` : ''}
                          {isActive &&
                          JSON.stringify(connectionFields(p)) ===
                            JSON.stringify(connectionFields(form))
                            ? ' · 已载入表单'
                            : ''}
                        </span>
                        <span className="settings-modal__profile-actions">
                          <button
                            type="button"
                            className="settings-modal__btn settings-modal__btn--ghost"
                            aria-label={`编辑 ${p.name}`}
                            onClick={() => { handleApplyProfile(p.id); setEditingProfileId(p.id) }}
                            title="载入并编辑，保存设置后更新这个配置"
                          >
                            {editingProfileId === p.id ? '正在编辑' : '编辑'}
                          </button>
                          <button
                            type="button"
                            className="settings-modal__btn settings-modal__btn--ghost"
                            onClick={() => handleApplyProfile(p.id)}
                            title="把该配置载入为当前连接"
                          >
                            载入
                          </button>
                          <button
                            type="button"
                            className="settings-modal__btn settings-modal__btn--ghost"
                            onClick={() => handleOverwriteProfile(p.id)}
                            title="用当前表单的连接覆盖该配置"
                          >
                            覆盖
                          </button>
                          <button
                            type="button"
                            className="settings-modal__btn settings-modal__btn--danger"
                            onClick={() => handleRemoveProfile(p.id)}
                            title="删除该配置"
                          >
                            删除
                          </button>
                        </span>
                      </li>
                    )
                  })}
                </ul>
              )}
              <span className="settings-modal__hint">
                在输入框下方的模型按钮里也能一键切换这些配置
              </span>
            </fieldset>
          </>
        )

      case 'behavior':
        return (
          <>
            <fieldset className="settings-modal__group">
              <legend className="settings-modal__legend">任务与权限</legend>

              <label className="settings-modal__field">
                <span className="settings-modal__label">Permission level</span>
                <select
                  className="settings-modal__input"
                  value={form.permissionLevel}
                  onChange={(e) => set('permissionLevel', e.target.value as PermissionLevel)}
                >
                  {PERMISSION_LEVELS.map((l) => (
                    <option key={l.value} value={l.value}>
                      {l.label} — {l.hint}
                    </option>
                  ))}
                </select>
                <span className="settings-modal__hint">
                  应用于 Code 与 Work 双方；会话可在 composer 临时覆盖。
                </span>
              </label>

              <label className="settings-modal__field">
                <span className="settings-modal__label">系统提示词</span>
                <textarea
                  className="settings-modal__input settings-modal__textarea"
                  value={form.systemPrompt}
                  onChange={(e) => set('systemPrompt', e.target.value)}
                  placeholder="(appended to the default CLI system prompt)"
                  rows={3}
                />
                <span className="settings-modal__hint">Passed as --append-system-prompt</span>
              </label>
            </fieldset>

            <fieldset className="settings-modal__group">
              <legend className="settings-modal__legend">桌面伙伴</legend>

              <label className="settings-modal__field settings-modal__field--inline">
                <input
                  type="checkbox"
                  checked={isMac ? form.companion.macosEnabled === true : form.companion.enabled}
                  disabled={!isWindows && !macosCompanion}
                  onChange={(e) =>
                    set('companion', { ...form.companion, [isMac ? 'macosEnabled' : 'enabled']: e.target.checked })
                  }
                />
                <span className="settings-modal__label">启用桌面伙伴</span>
              </label>
              <span className="settings-modal__hint">
                {isWindows
                  ? '保存设置后启停桌面伙伴；下方显示实际运行状态。显示时机可在桌宠托盘菜单中调整。'
                  : macosCompanion
                    ? '保存后打开悬浮伙伴，查看任务进度和审批等待状态。'
                    : '请在受支持的 Trylo 桌面应用中启用桌面伙伴。'}
              </span>

              {(isWindows || macosCompanion) && props.petStatus ? (
                <div
                  className={`settings-modal__pet-status settings-modal__pet-status--${petStatusTone(props.petStatus)}`}
                  role="status"
                  aria-live="polite"
                >
                  <span className="settings-modal__pet-status-headline">
                    {petStatusHeadline(props.petStatus)}
                  </span>
                  {petStatusDetail(props.petStatus) ? (
                    <span className="settings-modal__hint">{petStatusDetail(props.petStatus)}</span>
                  ) : null}
                  {props.petStatus.exePath ? (
                    <span className="settings-modal__hint">
                      Pet binary: <code>{props.petStatus.exePath}</code>
                    </span>
                  ) : null}
                </div>
              ) : null}
            </fieldset>
          </>
        )

      case 'libraries':
        return (
          <DesktopLibrariesPanel
            resources={props.collaborationResources}
            approvals={props.libraryApprovals}
            onRespondApproval={props.onRespondLibraryApproval}
            {...(props.onRequestTemporaryExpert
              ? {
                  onRequestTemporaryExpert: () => {
                    props.onClose()
                    props.onRequestTemporaryExpert?.()
                  },
                }
              : {})}
            focus={
              libraryFocus?.scope === props.collaborationResources?.scope ? libraryFocus : undefined
            }
          />
        )

      case 'tools':
        return (
          <>
            <WorkToolsSettings
              platform={props.toolPlatform}
              selection={{
                computer: true,
                browserDebug: form.workBrowserDebug,
                cad: form.workCad,
              }}
              onSelectBrowser={(debug) => set('workBrowserDebug', debug)}
              onConfigure={() => {
                const details = toolSelectionRef.current
                if (!details) return
                details.open = true
                details.scrollIntoView({ block: 'start' })
                details.querySelector('input')?.focus({ preventScroll: true })
              }}
            />

            <details ref={toolSelectionRef} className="settings-modal__advanced" open>
              <summary>
                能力选择<span>选择后保存，用于后续 Work 任务</span>
              </summary>
              <div className="settings-modal__advanced-body">
                {isMac ? (
                  <MacosComputerSettings facade={props.toolingFacade} value={form.macosComputerUse}
                    onChange={value => set('macosComputerUse', value)} />
                ) : (
                  <fieldset className="settings-modal__group">
                    <legend className="settings-modal__legend">电脑控制 (Computer Use)</legend>

                    <label className="settings-modal__field settings-modal__field--inline">
                      <span className="settings-modal__label">
                        电脑控制默认启用，无需选用
                      </span>
                    </label>
                    <span className="settings-modal__hint">
                      {isWindows
                        ? '办公、浏览器和电脑控制是 Code 与 Work 的默认工具。读取屏幕、点击、键入等操作仍需遵循当前授权，不会因默认启用而自动执行。'
                        : '当前平台暂不支持电脑控制（仅 Windows 支持）。'}
                    </span>

                    {/* P0-A §3.3-4: flipping the switch only selects a Profile — the
                    REQUIRED package must exist. Surface its real state (install
                    action when missing) so the capability is not silently
                    pretending to be there. */}
                    {props.toolPlatform ? (
                      <WorkCapabilityHint platform={props.toolPlatform} packageId="windows-mcp" />
                    ) : null}
                  </fieldset>
                )}

                <fieldset className="settings-modal__group">
                  <legend className="settings-modal__legend">Work 工具面 (Tool Profiles)</legend>

                  <span className="settings-modal__hint">
                    {isMac
                      ? '办公文档与浏览器工具默认挂载。浏览器方案在列表顶部切换。'
                      : '办公文档、浏览器与电脑控制默认挂载。浏览器方案在列表顶部切换，下面只需配置可选扩展。'}
                  </span>

                  <span className="settings-modal__hint">
                    {isMac
                      ? 'Playwright 与 Chrome DevTools 均支持 macOS，可在工具列表顶部二选一，未使用的方案显示为备用。'
                      : '浏览器方案在工具列表顶部选择。Playwright 与 Chrome DevTools 二选一，未使用的方案显示为备用；CAD/EDA 可以同时启用。'}
                  </span>

                  {form.workBrowserDebug && props.toolPlatform ? (
                    <WorkCapabilityHint platform={props.toolPlatform} packageId="chrome-devtools" />
                  ) : null}

                  <label className="settings-modal__field settings-modal__field--inline">
                    <input
                      type="checkbox"
                      checked={form.workCad}
                      disabled={isMac}
                      onChange={(e) => set('workCad', e.target.checked)}
                    />
                    <span className="settings-modal__label">
                      在 Work 中启用 CAD/EDA 工具（SolidWorks / AutoCAD / KiCad / 嘉立创EDA /
                      FreeCAD / Blender）
                    </span>
                  </label>
                  <span className="settings-modal__hint">
                    {isWindows
                      ? '开启后为后续任务选用 CAD/EDA 适配器；还需要对应的软件与连接环境就绪。可以同时启用浏览器调试。工具包安装、实际可用与本次配置是否选用是不同状态，可在上方逐项查看。'
                      : isMac
                        ? '当前 macOS 版本暂不支持 CAD/EDA 适配器，计划在后续版本支持。'
                        : '当前平台暂不支持 CAD/EDA 适配器（仅 Windows 支持）。'}
                  </span>

                  {!isMac && form.workCad && props.toolPlatform ? (
                    <>
                      {(
                        [
                          ['solidworks-mcp', 'SolidWorks'],
                          ['autocad-mcp', 'AutoCAD'],
                          ['kicad-mcp', 'KiCad'],
                          ['jlceda-mcp', '嘉立创EDA专业版'],
                          ['freecad-mcp', 'FreeCAD'],
                          ['blender-mcp', 'Blender'],
                        ] as const
                      ).map(([packageId]) => (
                        <WorkCapabilityHint
                          key={packageId}
                          platform={props.toolPlatform!}
                          packageId={packageId}
                        />
                      ))}
                    </>
                  ) : null}
                </fieldset>
              </div>
            </details>
          </>
        )

      case 'remote':
        return (
          <fieldset className="settings-modal__group">
            <legend>远程与连接</legend>
            <p>账号登录、服务器与独立隧道切换、手机配对已集中到同一个窗口。</p>
            <button
              type="button"
              className="settings-modal__button"
              onClick={() => props.onOpenRemote?.()}
            >
              打开远程与连接
            </button>
          </fieldset>
        )

      case 'subconnections':
        return (
          <>
            {renderSubConnection(
              'vision',
              '视觉模型',
              '用于读取图片。默认沿用主模型，也可以配置独立的模型、地址和密钥。',
            )}
            {renderSubConnection(
              'summary',
              '摘要模型',
              '用于压缩长对话。默认沿用主模型，也可以单独配置。',
            )}
          </>
        )

      case 'learning':
        return (
          <>
            <CentralLearningSettings
              key={props.collaborationLearningRuntime?.cwd ?? ''}
              value={form.agentLearning}
              runtime={props.collaborationLearningRuntime}
              onChange={(value) => set('agentLearning', value)}
              onThoughtEdit={() => {
                centralThoughtEdited.current = true
              }}
            />
            <fieldset className="settings-modal__group">
              <legend className="settings-modal__legend">智能体学习</legend>
              <p className="settings-modal__desc">
                在正常任务中采用方法与经验、发现工具改进机会，并检索 Hermes
                技能。学习产物仍通过各自的审阅与反馈入口管理。
              </p>
              <label className="settings-modal__field settings-modal__field--inline">
                <input
                  type="checkbox"
                  checked={agentLearningSettings(form.agentLearning).enabled}
                  disabled={agentLearningSettings(form.agentLearning).centralEnabled}
                  onChange={(event) =>
                    set('agentLearning', {
                      ...agentLearningSettings(form.agentLearning),
                      enabled: event.target.checked,
                    })
                  }
                />
                <span className="settings-modal__label">启用方法、工具与技能学习</span>
              </label>
              <label className="settings-modal__field">
                <span className="settings-modal__label">每个任务的技能学习额度（总 token）</span>
                <select
                  className="settings-modal__input"
                  value={agentLearningSettings(form.agentLearning).skillTokens}
                  disabled={
                    !agentLearningSettings(form.agentLearning).enabled ||
                    agentLearningSettings(form.agentLearning).centralEnabled
                  }
                  onChange={(event) =>
                    set('agentLearning', {
                      ...agentLearningSettings(form.agentLearning),
                      skillTokens: Number(event.target.value),
                    })
                  }
                >
                  {[16000, 32000, 64000].map((tokens) => (
                    <option key={tokens} value={tokens}>
                      {tokens.toLocaleString()}
                    </option>
                  ))}
                  {![16000, 32000, 64000].includes(
                    agentLearningSettings(form.agentLearning).skillTokens,
                  ) && (
                    <option value={agentLearningSettings(form.agentLearning).skillTokens}>
                      {agentLearningSettings(form.agentLearning).skillTokens.toLocaleString()}
                    </option>
                  )}
                </select>
              </label>
              <label className="settings-modal__field">
                <span className="settings-modal__label">每个任务的技能学习调用上限</span>
                <select
                  className="settings-modal__input"
                  value={agentLearningSettings(form.agentLearning).skillCalls}
                  disabled={
                    !agentLearningSettings(form.agentLearning).enabled ||
                    agentLearningSettings(form.agentLearning).centralEnabled
                  }
                  onChange={(event) =>
                    set('agentLearning', {
                      ...agentLearningSettings(form.agentLearning),
                      skillCalls: Number(event.target.value),
                    })
                  }
                >
                  {Array.from({ length: 16 }, (_, index) => index + 1).map((calls) => (
                    <option key={calls} value={calls}>
                      {calls}
                    </option>
                  ))}
                </select>
              </label>
              <label className="settings-modal__field">
                <span className="settings-modal__label">显式 /learn 的输出 token 上限</span>
                <input
                  type="number"
                  min={1}
                  max={1000000}
                  className="settings-modal__input"
                  value={agentLearningSettings(form.agentLearning).skillOutputTokens}
                  disabled={
                    !agentLearningSettings(form.agentLearning).enabled ||
                    agentLearningSettings(form.agentLearning).centralEnabled
                  }
                  onChange={(event) =>
                    set('agentLearning', {
                      ...agentLearningSettings(form.agentLearning),
                      skillOutputTokens: Number(event.target.value),
                    })
                  }
                />
              </label>
              {agentLearningSettings(form.agentLearning).centralEnabled && (
                <p className="settings-modal__hint">
                  已使用工作区共享预算，任务不再单独领取技能学习额度。
                </p>
              )}
            </fieldset>
            <CheckLearningSettings
              value={form.checkLearning ?? DEFAULT_CHECK_LEARNING}
              onChange={(value) => set('checkLearning', value)}
            />
            <fieldset className="settings-modal__group">
              <legend className="settings-modal__legend">协作学习</legend>
              <p className="settings-modal__desc">
                从团队任务中的分工、交接、同步与复核学习协作做法，并在后续适用任务中试用、记录反馈。
                本轮关闭采集或使用无痕模式时停用。
              </p>
              <label className="settings-modal__field settings-modal__field--inline">
                <input
                  type="checkbox"
                  checked={collaborationLearningSettings(form.collaborationLearning).enabled}
                  disabled={agentLearningSettings(form.agentLearning).centralEnabled}
                  onChange={(e) =>
                    set('collaborationLearning', {
                      ...collaborationLearningSettings(form.collaborationLearning),
                      enabled: e.target.checked,
                    })
                  }
                />
                <span className="settings-modal__label">启用团队协作学习</span>
              </label>
              <label className="settings-modal__field">
                <span className="settings-modal__label">每个团队任务的学习额度</span>
                <select
                  className="settings-modal__input"
                  value={collaborationLearningSettings(form.collaborationLearning).tokenBudget}
                  disabled={
                    !collaborationLearningSettings(form.collaborationLearning).enabled ||
                    agentLearningSettings(form.agentLearning).centralEnabled
                  }
                  onChange={(e) =>
                    set('collaborationLearning', {
                      ...collaborationLearningSettings(form.collaborationLearning),
                      tokenBudget: Number(e.target.value),
                    })
                  }
                >
                  {[8000, 16000, 32000, 64000].map((tokens) => (
                    <option key={tokens} value={tokens}>
                      {tokens.toLocaleString()} tokens
                    </option>
                  ))}
                </select>
              </label>
              <p className="settings-modal__hint">
                {agentLearningSettings(form.agentLearning).centralEnabled
                  ? '当前由中央共享预算调度，团队任务不再独立领取学习额度。'
                  : '只分配额度，学习内容与步骤由协作学习子系统决定。恢复同一任务继续使用剩余额度。'}
              </p>
              <button
                type="button"
                className="settings-modal__btn settings-modal__btn--ghost"
                disabled={props.collaborationLearningRuntime === undefined}
                onClick={() => setCollaborationOpen((value) => !value)}
              >
                {collaborationOpen ? '收起协作学习状态' : '查看做法与纠正'}
              </button>
              {collaborationOpen && props.collaborationLearningRuntime !== undefined && (
                <CollaborationLearningPanel runtime={props.collaborationLearningRuntime} />
              )}
              {props.collaborationResources && (
                <CollaborationIssuesPanel
                  workspaceRoot={props.collaborationResources.scope}
                  client={props.collaborationResources.issues}
                  {...(props.onDiscussCollaborationIssue
                    ? {
                        onDiscuss: (issueId: string) => {
                          props.onClose()
                          props.onDiscussCollaborationIssue?.(issueId)
                        },
                      }
                    : {})}
                  onOpenDependency={(owner, requestId) => {
                    if (owner === 'skill') {
                      setSkillsOpen(true)
                      return
                    }
                    setLibraryFocus({
                      owner,
                      requestId,
                      scope: props.collaborationResources!.scope,
                    })
                    setSettingsTab('libraries')
                  }}
                />
              )}
            </fieldset>
            <fieldset className="settings-modal__group">
              <legend className="settings-modal__legend">用户学习</legend>
              <p className="settings-modal__desc">
                协作偏好学习：Evidence → Conclusion → User Model → Policy。 默认
                Shadow：计算并记录，不改变真实 Agent Prompt。 对话中明确保存的用户事实进入 Trylo
                正式用户记忆；用户学习开关控制其可用性。Hermes Skill 学习使用独立开关。
              </p>
              <label className="settings-modal__field settings-modal__field--inline">
                <input
                  type="checkbox"
                  checked={form.userLearning.enabled}
                  onChange={(e) =>
                    set('userLearning', { ...form.userLearning, enabled: e.target.checked })
                  }
                />
                <span className="settings-modal__label">Enable User Learning</span>
              </label>
              <label className="settings-modal__field settings-modal__field--inline">
                <input
                  type="checkbox"
                  checked={form.userLearning.cognitionEnabled}
                  onChange={(e) =>
                    set('userLearning', {
                      ...form.userLearning,
                      cognitionEnabled: e.target.checked,
                    })
                  }
                />
                <span className="settings-modal__label">Enable User Cognition</span>
              </label>
              <p className="settings-modal__hint">
                Team：打开后可从对话里「组一组」，或在团队表面选模板。默认关闭。
              </p>
              <label className="settings-modal__field settings-modal__field--inline">
                <input
                  type="checkbox"
                  checked={form.userLearning.teamAccessEnabled === true}
                  onChange={(e) =>
                    set('userLearning', {
                      ...form.userLearning,
                      teamAccessEnabled: e.target.checked,
                      teamComposerEnabled: e.target.checked,
                    })
                  }
                />
                <span className="settings-modal__label">启用 Team（团队）</span>
              </label>
              <label className="settings-modal__field">
                <span className="settings-modal__label">Policy mode</span>
                <select
                  className="settings-modal__input"
                  value={form.userLearning.defaultMode}
                  onChange={(e) =>
                    set('userLearning', {
                      ...form.userLearning,
                      defaultMode: e.target.value as TryloSettings['userLearning']['defaultMode'],
                    })
                  }
                >
                  <option value="shadow">Shadow (log only)</option>
                  <option value="enforced">Enforced (inject Active Policy)</option>
                  <option value="off">Off</option>
                </select>
              </label>
              <p className="settings-modal__hint">
                Per-dimension override (unset = use default mode)
              </p>
              {(
                [
                  'verification_audit',
                  'planning_direct_execution',
                  'reporting_information_density',
                ] as const
              ).map((dimension) => (
                <label key={dimension} className="settings-modal__field">
                  <span className="settings-modal__label">{dimension}</span>
                  <select
                    className="settings-modal__input"
                    value={form.userLearning.dimensionMode[dimension] ?? ''}
                    onChange={(e) => {
                      const value = e.target.value
                      const dimensionMode = { ...form.userLearning.dimensionMode }
                      if (!value) delete dimensionMode[dimension]
                      else
                        dimensionMode[dimension] =
                          value as TryloSettings['userLearning']['defaultMode']
                      set('userLearning', { ...form.userLearning, dimensionMode })
                    }}
                  >
                    <option value="">Default</option>
                    <option value="shadow">Shadow</option>
                    <option value="enforced">Enforced</option>
                    <option value="off">Off</option>
                  </select>
                </label>
              ))}
            </fieldset>

            <fieldset className="settings-modal__group">
              <legend className="settings-modal__legend">工作流学习</legend>
              <p className="settings-modal__desc">
                从实际步骤、产物和检查结果学习流程，在条件相符的后续任务中使用，并从失败与返工中修订。
              </p>
              <label className="settings-modal__field settings-modal__field--inline">
                <input
                  type="checkbox"
                  checked={form.workflowLearning?.enabled === true}
                  onChange={(event) =>
                    set('workflowLearning', {
                      ...workflowLearningSettings(form.workflowLearning),
                      enabled: event.target.checked,
                    })
                  }
                />
                <span className="settings-modal__label">学习和使用工作流</span>
              </label>
              <label className="settings-modal__field">
                <span className="settings-modal__label">每次任务的流程学习额度（token）</span>
                <select
                  className="settings-modal__input"
                  disabled={form.workflowLearning?.enabled !== true}
                  value={form.workflowLearning?.tokenBudget ?? 16000}
                  onChange={(event) =>
                    set(
                      'workflowLearning',
                      workflowLearningSettings({
                        ...workflowLearningSettings(form.workflowLearning),
                        tokenBudget: Number(event.target.value),
                      }),
                    )
                  }
                >
                  {[4096, 8000, 16000, 32000, 64000].map((budget) => (
                    <option key={budget} value={budget}>
                      {budget.toLocaleString()} token
                    </option>
                  ))}
                  {form.workflowLearning &&
                    ![4096, 8000, 16000, 32000, 64000].includes(
                      form.workflowLearning.tokenBudget,
                    ) && (
                      <option value={form.workflowLearning.tokenBudget}>
                        {form.workflowLearning.tokenBudget.toLocaleString()} token
                      </option>
                    )}
                </select>
              </label>
              <p className="settings-modal__hint">
                使用当前模型和独立学习额度。暂停采集或仅本次会话时不采集新经验；任务权限保持原有设置。
              </p>
            </fieldset>

            <fieldset className="settings-modal__group">
              <legend className="settings-modal__legend">任务学习（Hermes）</legend>
              <p className="settings-modal__desc">
                Work 任务结束后镜像会话并可能提出 Skill。关闭只影响 Work；Code 与 User Learning
                不变。
              </p>
              <label className="settings-modal__field settings-modal__field--inline">
                <input
                  type="checkbox"
                  checked={form.hermesWorkLearning !== false}
                  onChange={(e) => set('hermesWorkLearning', e.target.checked)}
                />
                <span className="settings-modal__label">Work Hermes 任务学习</span>
              </label>
            </fieldset>

            <fieldset className="settings-modal__group">
              <legend className="settings-modal__legend">技能 Skills</legend>
              <p className="settings-modal__desc">
                技能是代理的可复用工作手册（SOP）：任务中沉淀的方法、命令坑点、流程经验。
                新技能一律以「提案 → 你批准」的方式安装，已安装的技能可在技能库中查看全文。
              </p>
              <button
                type="button"
                className="settings-modal__btn settings-modal__btn--ghost settings-modal__skills-open"
                onClick={() => setSkillsOpen(true)}
                disabled={!props.learningPort && !props.skillLearningRuntime}
                title={props.learningPort ? '查看已安装技能' : '学习服务尚未就绪'}
              >
                打开技能库
              </button>
              <span className="settings-modal__hint">
                待审批的技能提案在顶栏「学习 → 代理学习 → 待审批」里批准后才会安装。
              </span>
            </fieldset>
          </>
        )
    }
  }

  const navigationTab = settingsTab === 'subconnections' ? 'connection' : settingsTab
  const normalizedTabSearch = tabSearch.trim().toLocaleLowerCase()
  const visibleTabs = normalizedTabSearch
    ? SETTINGS_TABS.filter((tab) =>
        `${tab.label} ${tab.description} ${tab.keywords}`
          .toLocaleLowerCase()
          .includes(normalizedTabSearch),
      )
    : SETTINGS_TABS
  const renderContent = (): ReactElement => {
    if (navigationTab === 'connection') {
      return (
        <>
          {renderSection('connection')}
          <details className="settings-modal__advanced" open={settingsTab === 'subconnections'}>
            <summary>
              视觉与摘要模型<span>默认沿用主模型连接</span>
            </summary>
            <div className="settings-modal__advanced-body">{renderSection('subconnections')}</div>
          </details>
        </>
      )
    }
    if (navigationTab === 'behavior') {
      return <>{renderSection('behavior')}</>
    }
    return renderSection(navigationTab)
  }

  const activeTabMeta = SETTINGS_TABS.find((tab) => tab.id === navigationTab)
  const onTitlebarDoubleClick = (event: ReactMouseEvent<HTMLElement>): void => {
    if (!isMac || isInteractiveTitlebarTarget(event.target)) return
    void toggleNativeWindowZoom()
  }

  return (
    <div
      className="settings-screen"
      data-motion-state={presence.state}
      role={isExiting ? undefined : 'dialog'}
      aria-modal={isExiting ? undefined : true}
      aria-label={isExiting ? undefined : '设置'}
      aria-hidden={isExiting ? true : undefined}
    >
      <div
        ref={dialogRef}
        className="settings-modal settings-screen__frame"
        onKeyDown={(event) => {
          if (
            event.key === 'Enter' &&
            event.target instanceof HTMLInputElement &&
            event.target.form === null &&
            event.target.dataset.settingsSearch !== 'true'
          )
            onSave(event)
        }}
      >
        <aside className="settings-screen__rail" aria-label="设置导航栏">
          <div
            className="settings-screen__rail-header"
            data-tauri-drag-region={isMac ? '' : undefined}
            onDoubleClick={onTitlebarDoubleClick}
          >
            <button
              type="button"
              className="settings-screen__back"
              onClick={props.onClose}
              data-tauri-drag-region={isMac ? 'false' : undefined}
              title={isMac ? `返回应用 (${formatShortcut(['Mod', ','])} / Esc)` : '返回应用 (Esc)'}
            >
              <ArrowLeft size={15} aria-hidden="true" />
              <span>返回应用</span>
            </button>
          </div>
          <nav ref={navRef} className="settings-modal__sidebar settings-screen__nav" aria-label="设置分类">
            <span ref={navIndicatorRef} className="settings-modal__sidebar-indicator" aria-hidden="true" />
            <div className="settings-screen__rail-title">设置</div>
            <div className="settings-modal__sidebar-search">
              <Search size={14} className="settings-modal__sidebar-search-icon" aria-hidden="true" />
              <input
                type="search"
                data-settings-search="true"
                className="settings-modal__sidebar-search-input"
                aria-label="搜索设置"
                placeholder="搜索设置"
                value={tabSearch}
                onChange={(event) => setTabSearch(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' && visibleTabs.length > 0 && !visibleTabs.some((tab) => tab.id === navigationTab)) {
                    event.preventDefault()
                    setSettingsTab(visibleTabs[0]!.id)
                  }
                }}
              />
              {tabSearch ? (
                <button
                  type="button"
                  className="settings-modal__sidebar-search-clear"
                  aria-label="清除搜索"
                  onClick={() => setTabSearch('')}
                >
                  <X size={12} aria-hidden="true" />
                </button>
              ) : null}
            </div>
            {visibleTabs.length === 0 ? (
              <p className="settings-modal__sidebar-empty" role="status">
                没有匹配的设置项
              </p>
            ) : (
              visibleTabs.map((tab) => (
                <button
                  key={tab.id}
                  type="button"
                  data-liquid-key={tab.id}
                  className={`settings-modal__sidebar-item${navigationTab === tab.id ? ' settings-modal__sidebar-item--active' : ''}`}
                  aria-current={navigationTab === tab.id ? 'page' : undefined}
                  onClick={() => setSettingsTab(tab.id)}
                >
                  <tab.Icon size={17} aria-hidden="true" />
                  {tab.label}
                </button>
              ))
            )}
          </nav>
        </aside>

        <div className="settings-screen__main">
          <header
            className="settings-screen__topbar"
            data-tauri-drag-region={isMac ? '' : undefined}
            onDoubleClick={onTitlebarDoubleClick}
          >
            <div
              className="settings-screen__breadcrumb"
              data-tauri-drag-region={isMac ? '' : undefined}
            >
              <span className="settings-screen__breadcrumb-root">Trylo 设置</span>
              <span className="settings-screen__breadcrumb-sep" aria-hidden="true">/</span>
              <h2 className="settings-modal__title settings-screen__breadcrumb-current">
                {activeTabMeta?.label ?? '设置'}
              </h2>
            </div>
            <button
              type="button"
              className="settings-modal__close settings-screen__close"
              onClick={props.onClose}
              aria-label="关闭设置"
              title="关闭设置 (Esc)"
              data-tauri-drag-region={isMac ? 'false' : undefined}
            >
              <X size={16} />
            </button>
          </header>

          <div className="settings-modal__content settings-screen__content" key={navigationTab}>
            <div className="settings-screen__container">
              {form.settingsNotices?.includes('routing-learning-retired') && (
                <div className="settings-modal__group" role="status">
                  <p>独立路由学习已退役，旧开关和额度配置已移除。正常执行路径与已有执行记录保持可用。</p>
                  <button
                    type="button"
                    className="settings-modal__button"
                    onClick={dismissRoutingRetirementNotice}
                  >
                    知道了
                  </button>
                </div>
              )}
              <div className="settings-modal__page-heading">
                <h3>{activeTabMeta?.label}</h3>
                <p>{activeTabMeta?.description}</p>
              </div>
              {renderContent()}
            </div>
          </div>

          <footer className="settings-modal__footer settings-screen__footer">
            <div className="settings-screen__footer-inner">
              <span className="settings-modal__footer-note">
                {navigationTab === 'appearance' ? '外观即时生效；其他修改需保存。' : '保存后应用修改。'}
              </span>
              {saveError && (
                <p
                  role="alert"
                  className="settings-modal__test-result settings-modal__test-result--err"
                >
                  {saveError}
                </p>
              )}
              <button
                type="button"
                className="settings-modal__btn settings-modal__btn--ghost"
                onClick={props.onClose}
              >
                取消
              </button>
              <button
                type="button"
                className="settings-modal__btn settings-modal__btn--primary"
                onClick={onSave}
              >
                保存设置
              </button>
            </div>
          </footer>
        </div>
      </div>

      {props.learningPort || props.skillLearningRuntime ? (
        <SkillsModal
          open={skillsOpen}
          port={props.learningPort ?? undefined}
          skillLearningRuntime={props.skillLearningRuntime}
          onClose={() => setSkillsOpen(false)}
          onOpenPending={props.onOpenLearningPending}
        />
      ) : null}
    </div>
  )
}
