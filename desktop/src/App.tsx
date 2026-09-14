// Trylo Desktop — App entry. See spike-results/phase-2-ui-redesign.md.
//
// v1.15.7: Cursor-style 3-section sidebar.
//
// State model (after this refactor):
//   workspaces:        Workspace[]              — all opened folders
//   currentWorkspaceId: string                  — the one that's "active"
//   sessionWorkspace:  Record<id, workspaceId>  — which workspace each
//                                                  session belongs to
//   allSessions:       TryloSession[]           — global session list
//   activeSessionId:   string | null            — active within the
//                                                  current workspace
//
// Derived (computed each render):
//   currentWorkspace  = workspaces.find(currentWorkspaceId)
//   currentSessions   = allSessions.filter(s => sessionWorkspace[s.id] === currentWorkspaceId)
//   currentActive     = currentSessions.find(activeSessionId) ?? currentSessions[0]
//
// Switching workspace: change currentWorkspaceId. The file
// tree (LeftRail's FILES section) and the sessions list
// (LeftRail's SESSIONS section) both re-derive. No state
// is reset; switching back to a previous workspace shows
// its files and its sessions again.
//
// Opening a new folder: if no workspace matches the path,
// create one and switch to it. If a workspace already
// exists for that path, just switch to it.

import {
  useCallback,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
  type CSSProperties,
  type ReactElement,
  useSyncExternalStore,
} from 'react'
import { PanelRight } from 'lucide-react'
import { createTryloContext, hostAdapter, sendPromptToProcess } from './host-adapter'
import { isTauri } from './host-adapter/tauri-detect'
import type { FilePath, CodeMode, TopLevelMode } from './host-adapter/types'
// v1.16.6 (M4-A runtime ownership): the ConversationRunSupervisor
// owns every Code run. React only reads the ViewState of the
// VISIBLE conversation — it no longer holds global
// running/sendingDisabled/activeProcessId/error.
import {
  ConversationRunSupervisor,
  settingsForCodeRun,
  useConversationRunViewState,
} from './runtime/conversation-run-supervisor'
// M4-C5: unified Code/Work run timing (spec §7.2). Created per send
// in `onSend`; derived latencies let cold vs warm be measured without
// any real-model cost (P1-3 — this is the production call site).
import {
  RunTelemetry,
  type DerivedLatencies,
  type RunTelemetrySnapshot,
} from './runtime/run-telemetry'
import { contextWindowFor } from './host-adapter/context-windows'
import { buildAttachmentPromptContext, type Attachment } from './host-adapter/attachment-utils'
// P2-1 Work Package B: the partitioned attachment domain. App.tsx no
// longer holds ANY attachment state — the store owns partitions,
// acquisition, blob lifecycle and caps; App only wires owners, the
// runtime providers (live identity / workspace root / Work
// persistence hook) and the native drop listener.
import {
  conversationAttachmentStore,
  type AttachmentOwner,
} from './attachments/conversation-attachment-store'
import { useConversationAttachments } from './attachments/use-conversation-attachments'
import { toWorkDescriptor } from './attachments/attachment-acquisition'
import { applyEvents, finalizeLatestTurnTimer } from './components/chat/events'
// 2026-08-30 (routing-fix step 7): the Work conversation adapter —
// routes ordinary chat through the stable Code runtime, never the workd
// task pipeline.
import { sendWorkChat } from './work-chat/work-chat-adapter'
import { AppShell } from './components/app-shell/AppShell'
import { ChatPanel } from './components/chat/ChatPanel'
import {
  beginConversationTurn,
  isUserMessage,
  latestContextTokens,
  type ChatMessage,
  type SentAttachment,
} from './components/chat/types'
// P2 (spec §4.4): the unified permission domain. The level is
// the only thing the runtimes see; legacy chat/plan/agent is
// migrated to the new four-level shape at settings load.
import {
  DEFAULT_PERMISSION_LEVEL,
  resolveEffectivePermission,
  type PermissionLevel,
} from './permission/permission-policy'
// P3 (spec §4.6): the safe approval-preview builder. The card
// routes every raw tool input through this; nothing else in the
// React tree ever sees it.
import { buildApprovalPreview } from './approval/approval-preview'
// P2-1 (spec §10.4): App only orchestrates the result pipeline — the
// repository + the Code projector own Git parsing and finalization, and the
// shared ResultDock shell + Code content are the only UI surface.
import { ConversationResultRepository } from './results/conversation-result-repository'
import { CodeResultProjector } from './results/code-result-projector'
import type { StoredCodeRunResult } from './results/conversation-result-types'
import type { ResultDockStatus } from './components/chat/ResultDock'
import { ResultDock } from './components/chat/ResultDock'
import { CodeResultContent } from './components/chat/CodeResultContent'
import { WorkResultContent, latestRunArtifactCount } from './components/chat/WorkResultContent'
import { resultDockPrefsStore, type ResultDockKey } from './result-dock/result-dock-prefs'
import { useResultDockOpen } from './result-dock/use-result-dock-prefs'
import { applyRecovery } from './recovery/persisted-state-recovery'
// P2-1 (spec §5.1 / §8): the scoped Work result projection owns artifact
// merge/version; App only orchestrates lifecycle + subscribes to the snapshot.
// 2026-09-04 (CLI 单核): the workd ControlPlane / WorkRuntime dual-core chain
// is retired — Work runs entirely through the CLI supervisor (sendWorkChat →
// runCode) and the file-scanning WorkResultProjector, so the daemon lifecycle,
// its connection status UI (「执行端启动失败」) and the registry-derived state
// are gone.
import { WorkResultProjector } from './results/work-result-projector'
import { DiffRequestTracker, type DiffRequestIdentity } from './results/diff-request-tracker'
import type { StoredWorkResult } from './results/conversation-result-types'
// 2026-09-04 (CLI 单核): workd ControlPlane imports retired with the daemon.
import { buildWorkProfilePrompt, formatWorkMessage } from '@trylo/work'
import { createTryloHostAdapter } from './components/work/tryloHostAdapter'
import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import {
  applyProfile,
  loadSettings,
  saveSettings,
  type ModelProfile,
  type TryloSettings,
} from './settings/settings-store'
import {
  effectiveModelForConversation,
  getConversationChoice,
  loadConversationModels,
  resolveRunConnection,
  saveConversationModels,
  setConversationChoice,
  type ConversationModelChoice,
  type ConversationModelMap,
} from './settings/conversation-models'
import { ServiceManager } from './services-host/service-manager'
import type { PetStatusSnapshot, RemoteStatusResult } from './services-host/methods'
import { ServicesCompanionPort, createTauriCompanionPaths } from './companion/companion-port'
import { CompanionController, composeLifecycleObservers } from './companion/companion-controller'
import { RemoteController } from './remote/remote-controller'
import { ServicesRemotePort } from './remote/remote-port'
import { mimeTypeForArtifactName, sanitizeArtifactRelPath } from './remote/remote-routing'
// Hermes learning (migration spec §7, Phase 3): the port is the only way the
// UI touches Hermes; the facade implements it over the Service Host.
import { createNullLearningPort, type LearningPort } from './learning/learning-port'
import { createLearningFacade, resolveHermesMcpArgs } from './learning/learning-facade'
import { createToolingFacade, type ToolingFacade } from './tooling/tooling-facade'
import type { ResolvedToolRuntime } from './services-host/methods'
// P0-A (audit §3.3): the tool platform health state machine + the pre-send
// capability gate (缺失不再静默 — §3.2).
import { decideSendCapabilityGate, useToolPlatformState } from './tooling/use-tool-platform-state'
// The IDE-style embedded browser panel (fork of vscode-browser-preview).
import { useBrowserPreview } from './tooling/use-browser-preview'
import { createToolRiskClassifier } from './tooling/tool-risk-classifier'
import { officecliClassifier } from './tooling/classifiers/officecli-classifier'
import {
  createPlaywrightClassifier,
  BrowserOriginLeases,
} from './tooling/classifiers/playwright-classifier'
import {
  createSensitiveWindowWatcher,
  createWindowsClassifier,
  escalateOnTakeover,
  revokeOnForegroundChange,
  ScreenConsentLeases,
  TakeoverEscalations,
} from './tooling/classifiers/windows-mcp-classifier'
import { createChromeDevtoolsClassifier } from './tooling/classifiers/chrome-devtools-classifier'
import { CAD_EDA_CLASSIFIERS } from './tooling/classifiers/cad-eda-classifier'
// WCC-P2-03: the DesktopActionProvider host wiring. The registry is the
// pinned provider catalog; the watcher turns the model's own CDP tool
// results into provider observation + verification evidence (observe/verify
// only — it never dispatches an MCP call).
import { createProviderRegistry } from './tooling/providers/provider-registry'
import { createProviderObservationWatcher } from './tooling/providers/provider-observation-watcher'
import {
  DesktopDispatchMetrics,
  createWrongWindowDispatchWatcher,
} from './tooling/desktop-dispatch-metrics'
// PR-3 偏差④收口: the static manifests are the single source of truth for
// the classifiers' origin lists. Cross-package imports are the established
// drift-alarm pattern (tool-risk-classifier.test.ts); the .d.mts
// declarations keep tsc happy without allowJs.
import { PLAYWRIGHT_MANIFEST } from '../../desktop-services/src/tooling/manifests/playwright.mjs'
import { createLearningMirrorObserver } from './learning/session-mirror'
import { createLearningTriggerObserver } from './learning/learning-trigger'
import { planPostTerminal } from './learning/learning-balance'
import {
  cognitionPromptMessage,
  conversationTraceKey,
  createLearningLlm,
  createUserLearningRuntime,
  discoverProjectFacts,
  eventFromApproval,
  eventFromArtifact,
  eventFromLeaseGrant,
  eventFromSteer,
  eventFromStop,
  eventFromWorkStop,
  learningImpactMessage,
  prepareLearningInteraction,
  type UserLearningRuntime,
} from './user-learning'
import { contractFilePath, serializeContractForDisk } from './user-learning/team-access/persist'
import { parsePersonSeatOutput } from './user-learning/team-access/person-output'
import { contractSummaryFromContract } from './user-learning/team-access/contract-summary'
import {
  teamEvidenceProvenance,
  withTeamProvenance,
  type TeamEvidenceProvenance,
} from './user-learning/team-access/evidence-map'
import type { EngineeringContract } from './user-learning/team-access/contract-types'
import type { ContractSummaryLike } from './surfaces/shared/engineering-contract'
import type { TeamEventExtras } from './surfaces/team/team-projection'
import {
  createFileUserLearningStore,
  createLocalStorageFileIO,
} from './user-learning/repository-file'
import type {
  CognitionDismissKind,
  CognitionQuestion,
  CognitionSession,
  PolicyDimension,
  ProductSurface,
  LearningDirective,
} from './user-learning/types'
import { UserLearningPanel } from './components/user-learning/UserLearningPanel'
import { CognitionBadge } from './components/user-learning/CognitionBadge'
import { LearningReceiptPill } from './components/user-learning/LearningReceiptPill'
import { projectIdFromRoot, workspaceIdFromRoot } from './user-learning/ids'
import {
  consumeLearningDirectiveForProduct,
  setLearningDirectiveForProduct,
  type LearningDirectiveByProduct,
} from './user-learning/learning-directive-state'
import { CognitionSurface } from './components/cognition/CognitionSurface'
import type { CodeRunLifecycleObserver } from './runtime/code-run-lifecycle'
import { pickFolder } from './host-adapter/pick-folder'
// Person | Team surface (spec §1.2, §3): a second segmented control
// on the right of the TopBar. Person keeps the current Code/Work UI
// untouched; Team renders a distributed task board under surfaces/.
import {
  CollaborationSwitch,
  PersonTeamStatusBar,
  PersonTeamComposeHint,
  SurfaceHost,
  applyTeamEvents,
  cancelTeamSeat,
  clearComposerDraft,
  clearDismissedTeamRun,
  getComposerDraft,
  isTeamRunActive,
  seedComposerDraft,
  setComposerLaunchError,
  selectSeat,
  summarizeTeam,
  teamModelChoices,
  type CollaborationSurface,
  type TeamRun,
} from './surfaces'
import {
  builtinTemplatesForSurface,
  mapSignalsToTemplate,
} from './user-learning/team-access/profiles/templates'
import { startTeamTurn } from './user-learning/team-access/profiles/host-launch'
import type { LoopEvent } from './host-adapter/loop-events'
import {
  configureTeamRunsCache,
  loadTeamRunsForWorkspace,
  selectRunForConversation,
  subscribeTeamRuns,
  teamMarksFromRuns,
  teamRunsSnapshot,
  teamRunsVersion,
  toPersistableTeamRun,
  upsertTeamRun,
} from './user-learning/team-access/profiles/team-runs-cache'
import {
  configureTeamProfilesCache,
  guardSave,
  loadTeamProfilesForWorkspace,
  removeTeamProfile,
  subscribeTeamProfiles,
  teamProfilesSnapshot,
  teamProfilesVersion,
  upsertTeamProfile,
} from './user-learning/team-access/profiles/profiles-cache'
import { buildProfileFromDraft } from './surfaces/team/composer/composer-store'
import {
  archiveConversation,
  createConversation,
  deleteConversation,
  emptyWorkspaceHistory,
  ensureConversation,
  forceFlushHistory,
  flushAllPendingSaves,
  listConversationSessions,
  loadWorkspaceHistory,
  loadWorkspaceIndex,
  registerUnloadHistoryFlush,
  renameConversation,
  saveWorkspaceIndex,
  scheduleWorkspaceHistorySave,
  selectConversation,
  unarchiveConversation,
  updateConversationAttachments,
  updateConversationCodeMode,
  updateConversationDraft,
  updateConversationMessages,
  updateConversationResults,
  workspaceKey,
  type ConversationSession,
  type WorkspaceConversationHistory,
  type WorkspaceIndex,
} from './host-adapter/conversation-history'

const DEFAULT_WORKSPACE_ROOT = 'C:/work/demo-ws' as const
const isTauriFn = isTauri
const EMPTY_CHAT_MESSAGES: readonly ChatMessage[] = []

interface PendingCognitionView {
  readonly sessionId: string
  readonly conversationId: string
  readonly product: ProductSurface
  readonly dimension: PolicyDimension
  readonly prompt: string
  readonly options: readonly string[]
}

function cognitionViewKey(product: ProductSurface, conversationId: string): string {
  return `${product}:${conversationId}`
}

function pendingCognitionView(session: CognitionSession): PendingCognitionView | null {
  if (!session.conversationId || session.status !== 'open') return null
  const card = cognitionPromptMessage(session)
  return {
    sessionId: session.id,
    conversationId: session.conversationId,
    product: session.product ?? 'code',
    dimension: session.dimension,
    prompt: card.prompt,
    options: card.options,
  }
}
/** Queue key for a Code run's pending message queue (run-controls §UI-B). */
function queueConversationKey(projectKey: string, conversationId: string): string {
  return `${projectKey}::${conversationId}`
}

/** Project five-seat `subagent` events into the Team surface store.
 *  PR-8 (spec §10.4): App is the only legal wiring layer between the
 *  user-learning parser and the surfaces projection — it parses the
 *  Person end result here and hands the projection a veto verdict; the
 *  projection itself never parses seat output. */
function feedTeamEvents(
  setRun: (updater: (prev: TeamRun | null) => TeamRun | null) => void,
  ctx: { workspaceId: string; personConversationId: string },
  events: readonly unknown[],
  opts?: {
    readonly contractSummary?: ContractSummaryLike
    readonly onVeto?: (reason: string) => void
    /** PR-12: Person `User questions` bubble up to the Cognition path. */
    readonly onClarify?: (payload: {
      readonly personConversationId: string
      readonly questions: readonly string[]
      readonly unknown: readonly string[]
    }) => void
  },
): void {
  if (
    !events.some((e) => {
      if (!e || typeof e !== 'object') return false
      const type = (e as { type?: unknown }).type
      return type === 'subagent' || type === 'tool_use' || type === 'tool_result'
    })
  ) {
    return
  }
  let vetoActive = false
  let vetoReason = ''
  let questions: readonly string[] = []
  let unknown: readonly string[] = []
  for (const e of events) {
    if (!e || typeof e !== 'object') continue
    const ev = e as { type?: unknown; kind?: unknown; agentType?: unknown; result?: unknown }
    if (ev.type !== 'subagent' || ev.kind !== 'end' || ev.agentType !== 'person') continue
    const parsed = parsePersonSeatOutput(typeof ev.result === 'string' ? ev.result : '')
    if (!parsed) continue
    if (parsed.veto.active) {
      vetoActive = true
      vetoReason = parsed.veto.reason
    }
    if (parsed.userQuestions.length > 0) {
      questions = parsed.userQuestions
      unknown =
        parsed.intent.unknown && !/^none/i.test(parsed.intent.unknown)
          ? [parsed.intent.unknown]
          : []
    }
  }
  const extras: TeamEventExtras = {
    ...(vetoActive ? { vetoActive: true, vetoReason } : {}),
    ...(opts?.contractSummary ? { contractSummary: opts.contractSummary } : {}),
  }
  setRun((prev) => applyTeamEvents(prev, events, ctx, extras))
  if (vetoActive) opts?.onVeto?.(vetoReason)
  if (questions.length > 0)
    opts?.onClarify?.({ personConversationId: ctx.personConversationId, questions, unknown })
}

/** Debug/cache copy of the live contract under
 *  `.trylo/team/<teamRunId>/contract.v1.json` (spec §18.2). The runtime
 *  Map stays the session authority; a failed write is logged, never
 *  fatal — the seat briefing comes from the PA append, not this file. */
async function persistTeamContract(
  workspaceRoot: string,
  contract: EngineeringContract,
): Promise<void> {
  try {
    const teamRunId = contract.teamRunId ?? `team-${contract.personConversationId}`
    const path = contractFilePath(workspaceRoot, teamRunId)
    await hostAdapter.fs.writeFile(path, serializeContractForDisk(contract))
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn('[team-access] contract persist failed:', err)
  }
}
// M4-C5 (P1-3 / §7.5): per-run telemetry + event-batch logs are DEV-ONLY.
// In production (a Vite build) `import.meta.env.DEV` is false, so no
// per-batch console noise or timing dumps are emitted.
const RUN_TELEMETRY_DEBUG =
  typeof import.meta !== 'undefined' &&
  (import.meta as { env?: { DEV?: boolean } }).env?.DEV === true

/** Dev-only dump of one run's segmented latencies (spec §7.2). Values
 *  that were never observed render as `n/a`; only real slices show. */
function logRunTelemetry(snap: RunTelemetrySnapshot, d: DerivedLatencies): void {
  // eslint-disable-next-line no-console
  console.warn(
    `[run-telemetry] ${snap.mode}/${snap.coldOrWarm ?? 'unknown'} ` +
      `run=${snap.runId} total=${d.totalDuration ?? 'n/a'}ms ` +
      `ui→paint=${d.uiSubmitToPaint ?? 'n/a'}ms ` +
      `spawn=${d.spawnLatency ?? 'n/a'}ms ` +
      `providerTTFT=${d.providerTTFT ?? 'n/a'}ms ` +
      `adapter=${d.adapterLatency ?? 'n/a'}ms`,
  )
}
/** A workspace = a folder the user opened. Becomes the
 *  "context" that owns the file tree + the session list. */
export interface Workspace {
  readonly id: string
  readonly root: string
  readonly name: string
}

/** Last path segment, e.g. `C:/work/demo-ws` → `trylo`. */
function basenameOf(p: string): string {
  const m = p.match(/[^/\\]+$/)
  return m ? m[0] : p
}

/** Resolve a Git repo-relative path against the workspace root, rejecting
 *  absolute / device / traversal paths (spec §13.4). */
function repoAbsPath(root: string, rel: string): string | null {
  if (!rel || rel.startsWith('/') || /^[a-z]:/i.test(rel) || rel.includes('\\')) return null
  const parts = rel.split('/')
  if (parts.some((part) => part === '..' || part === '.')) return null
  const clean = parts.filter((part) => part !== '')
  if (clean.length === 0) return null
  return `${root.replace(/[\\/]+$/, '')}/${clean.join('/')}`
}

// P2-1 A-Edge (audit §4 P1-4): Work artifact "Open" capability routing.
// Extracted into its own pure module (no React, no Tauri) so the
// dispatch matrix is unit-testable without pulling in the whole App.
// See `work-artifact-dispatch.ts` for the full matrix.
import { artifactCapabilityFor } from './work-artifact-dispatch'
// FilePeek base capability: byte-backed kinds (image / pdf / office /
// 3D) skip the text read — decoding binary as UTF-8 garbles the rail —
// and each renderer loads bytes itself (see previewKindNeedsBytes).
import { previewKindFor, previewKindNeedsBytes } from './components/preview/previewKind'

/** Remote `mode` string → Code permission mode (spec §8.1: plan/chat, else
 *  agent). Pure mapping used by the remote sendTask authority. */
function codeModeFromRemoteMode(mode: string): CodeMode {
  if (mode === 'plan' || mode === 'chat' || mode === 'cognition') return mode
  return 'agent'
}

function cliCodeMode(mode: CodeMode): 'chat' | 'plan' | 'agent' {
  return mode === 'cognition' ? 'chat' : mode
}

/** 2026-08-30 (routing-fix step 6): stable short hash of the user's
 *  Work message text, for the 10s send-idempotency window. Deterministic
 *  per input; collisions are acceptable (the gate only suppresses an exact
 *  identical resend, never a different message). */
function workTextHash(text: string): string {
  let h = 5381
  for (let i = 0; i < text.length; i++) {
    h = ((h << 5) + h + text.charCodeAt(i)) | 0
  }
  return (h >>> 0).toString(36)
}

/** Materialise the mobile Chat mode's attachments as real files in the
 *  workspace so the agent can read them like any local file (via FileRead).
 *  Images are written from their base64 data URL; text files from their
 *  inlined content. Returns the `Attachment` records to register. */
async function materializeRemoteAttachments(
  root: string,
  conversationId: string,
  attachments: readonly {
    kind: 'image' | 'text'
    name: string
    mimeType: string
    size: number
    dataUrl?: string
    text?: string
  }[],
): Promise<Attachment[]> {
  const sep = root.includes('\\') ? '\\' : '/'
  const dir = `${root}${sep}.trylo${sep}remote-attachments${sep}${conversationId}`
  const rid = (): string =>
    globalThis.crypto?.randomUUID?.() ?? `r-${Date.now()}-${Math.random().toString(36).slice(2)}`
  const created: Attachment[] = []
  for (const att of attachments) {
    const safeName =
      att.name.replace(/[^\w.\-]+/g, '_') || (att.kind === 'image' ? 'image.jpg' : 'file.txt')
    const filePath = `${dir}${sep}${rid()}-${safeName}`
    if (att.kind === 'image' && att.dataUrl) {
      await hostAdapter.fs.writeFileBytes(filePath, att.dataUrl)
      created.push({
        id: rid(),
        kind: 'image',
        name: att.name,
        path: filePath,
        size: att.size,
        mediaType: att.mimeType || 'image/jpeg',
        excerpt: '',
        addedAt: Date.now(),
      })
    } else if (att.kind === 'text' && att.text != null) {
      await hostAdapter.fs.writeFile(filePath, att.text)
      created.push({
        id: rid(),
        kind: 'text',
        name: att.name,
        path: filePath,
        size: att.size,
        mediaType: att.mimeType || 'text/plain',
        excerpt: att.text.slice(0, 200),
        addedAt: Date.now(),
      })
    }
  }
  return created
}

// PR-7 (§4.1): the explicit Work capability switches pick the run's Work
// Profile. 2026-09-06 办公基底 rev 2: desktop control (windows-mcp) is merged
// into the `work.core.v1` base, so the old `work.computer.v1` profile is gone.
// 浏览器调试 swaps Playwright for Chrome DevTools (`work.browser-debug.v1`);
// the CAD/EDA adapter Profile is opt-in only. Otherwise undefined = the
// surface default `work.core.v1`.
function workProfileIdFor(workBrowserDebug: boolean, workCad: boolean): string | undefined {
  if (workBrowserDebug && workCad) return 'work.cad-browser-debug.v1'
  if (workBrowserDebug) return 'work.browser-debug.v1'
  // TRYLO-CAD-EDA-TOOL-ADAPTER §4: the CAD/EDA adapter Profile — never a
  // default; each missing host application degrades to an unavailable
  // capability inside it (§4.4), so enabling the toggle is safe anywhere.
  if (workCad) return 'work.cad.v1'
  return undefined
}

/** Renderer-safe base64 (no Node Buffer in the Tauri process) for the remote
 *  artifact `read` authority. Chunked so `String.fromCharCode(...)` never hits
 *  the argument-spread limit on large deliverables. */
function bytesToBase64(bytes: Uint8Array): string {
  let binary = ''
  const chunk = 0x8000
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk))
  }
  return btoa(binary)
}

/** Coarse deliverable kind for the remote artifact `list` authority, derived
 *  from the file's MIME type (matches the gateway's closed-set classifier). */
function kindForArtifactName(name: string): string {
  const mime = mimeTypeForArtifactName(name)
  if (mime.startsWith('image/')) return 'image'
  if (mime === 'application/pdf' || mime.includes('officedocument')) return 'document'
  if (mime.startsWith('text/') || mime === 'application/json') return 'text'
  return 'file'
}

function App(): ReactElement {
  // A small global index remembers which folders were open.
  // The actual conversations live under each project at
  // <workspace>/.trylo/conversations.v1.json.
  const initialWorkspaceIndexRef = useRef<WorkspaceIndex | null>(null)
  if (initialWorkspaceIndexRef.current === null) {
    initialWorkspaceIndexRef.current = loadWorkspaceIndex({
      id: 'ws-default',
      root: DEFAULT_WORKSPACE_ROOT,
      name: basenameOf(DEFAULT_WORKSPACE_ROOT),
    })
  }
  const initialWorkspaceIndex = initialWorkspaceIndexRef.current
  const [workspaces, setWorkspaces] = useState<readonly Workspace[]>(
    initialWorkspaceIndex.workspaces,
  )
  const [currentWorkspaceId, setCurrentWorkspaceId] = useState<string>(
    initialWorkspaceIndex.currentWorkspaceId,
  )
  const [topMode, setTopMode] = useState<TopLevelMode>(
    initialWorkspaceIndex.topModeByWorkspace[initialWorkspaceIndex.currentWorkspaceId] ?? 'code',
  )
  // Person | Team surface (spec §1.2, §11 PR-A). `person` keeps
  // today's ChatPanel byte-for-byte; `team` swaps the main column
  // for the new task board. State lives at the App root so the
  // TopBar (right side) and the main column can both see it.
  const [collaborationSurface, setCollaborationSurface] = useState<CollaborationSurface>('person')
  // In-memory TeamRun. `null` = no team yet → TeamEmptyState.
  // Live `subagent` events for the five seats project here; the
  // DEV-only "加载示例" button still seeds FIXTURE_TEAM_RUN.
  const [teamRun, setTeamRun] = useState<TeamRun | null>(null)
  const [codeMode, setCodeMode] = useState<CodeMode>('agent')
  const [histories, setHistories] = useState<
    Readonly<Record<string, WorkspaceConversationHistory>>
  >({})
  const loadingHistoryRootsRef = useRef<Set<string>>(new Set())

  const currentWorkspace = useMemo<Workspace>(
    () => workspaces.find((workspace) => workspace.id === currentWorkspaceId) ?? workspaces[0]!,
    [workspaces, currentWorkspaceId],
  )
  const currentWorkspaceKey = workspaceKey(currentWorkspace.root)
  const currentHistory = histories[currentWorkspaceKey] ?? emptyWorkspaceHistory()
  const historyReady = histories[currentWorkspaceKey] !== undefined
  const codeSessionId = currentHistory.activeByKind.code
  const workSessionId = currentHistory.activeByKind.work
  const codeRecord = codeSessionId ? currentHistory.conversations[codeSessionId] : undefined
  const workRecord = workSessionId ? currentHistory.conversations[workSessionId] : undefined
  // Hermes session mirror (spec §7.4): the observer resolves the finished
  // conversation by project root + conversation id from the live histories
  // map, so a background run on another workspace mirrors correctly too.
  const historiesRef = useRef(histories)
  historiesRef.current = histories
  const messages = codeRecord?.messages ?? EMPTY_CHAT_MESSAGES
  const workMessages = workRecord?.messages ?? EMPTY_CHAT_MESSAGES
  const text = codeRecord?.draft ?? ''
  const workInput = workRecord?.draft ?? ''

  // P2-1 Work Package B: attachment partitions of the two VISIBLE
  // conversations. The store is the source of truth; React only reads
  // snapshots. Owners are rebuilt every render — the hook subscribes
  // by key, so literal identity never causes churn.
  const codeOwner: AttachmentOwner | null = codeSessionId
    ? { surface: 'code', projectKey: currentWorkspaceKey, conversationId: codeSessionId }
    : null
  const workOwner: AttachmentOwner | null = workSessionId
    ? { surface: 'work', projectKey: currentWorkspaceKey, conversationId: workSessionId }
    : null
  const codeAttachmentsState = useConversationAttachments(codeOwner)
  const workAttachmentsState = useConversationAttachments(workOwner)

  // The store's per-await ownership guard reads this ref. It carries
  // the identity of the conversation the user is looking at RIGHT NOW
  // (updated every render) — drops / pickers capture it at start and
  // the pipeline re-checks it between every await.
  const liveIdentityRef = useRef({
    topMode,
    workspaceKey: currentWorkspaceKey,
    conversationId: topMode === 'work' ? workSessionId : codeSessionId,
    root: currentWorkspace.root,
  })
  // PR-11 (spec §8.6): the non-terminal run survives restarts via
  // `.trylo/team-runs.json`. Load on workspace switch (active run only);
  // save on every run update. Failures are logged, never fatal.
  const teamRunsLoadedRootRef = useRef<string | null>(null)
  useEffect(() => {
    // Foundation spec §9.3: the cache holds the FULL team-runs file;
    // App's single teamRun state is the per-conversation projection.
    configureTeamRunsCache({
      readFile: (path) => hostAdapter.fs.readFile(path),
      writeFile: (path, body) => hostAdapter.fs.writeFile(path, body),
    })
  }, [])
  useEffect(() => {
    const root = currentWorkspace.root
    if (teamRunsLoadedRootRef.current === root) return
    teamRunsLoadedRootRef.current = root
    void loadTeamRunsForWorkspace(root, currentWorkspace.id).then(() => {
      const selected = selectRunForConversation(teamRunsSnapshot(), currentActiveSession?.id ?? '')
      setTeamRun(
        selected
          ? ({
              ...selected,
              workspaceId: currentWorkspace.id,
              selectedSeatId: null,
            } as unknown as TeamRun)
          : null,
      )
    })
    // currentActiveSession?.id is read inside the async continuation on
    // purpose: the load resolves after mount, when the session is known.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentWorkspace.root, currentWorkspace.id])
  useEffect(() => {
    // Re-select when the user switches Person conversations. Never clobbers
    // a live projection: feedTeamEvents writes straight into teamRun state.
    const sessionId = currentActiveSession?.id ?? null
    const selected = selectRunForConversation(teamRunsSnapshot(), sessionId ?? '')
    setTeamRun(
      selected
        ? ({
            ...selected,
            workspaceId: currentWorkspace.id,
            selectedSeatId: null,
          } as unknown as TeamRun)
        : null,
    )
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [codeSessionId, workSessionId, currentWorkspace.root])
  useEffect(() => {
    // Persist THROUGH the cache so other conversations' runs survive
    // (Foundation spec Pitfall 22) and UI-only fields stay off disk.
    if (!teamRun) return
    void upsertTeamRun(toPersistableTeamRun(teamRun))
  }, [teamRun])

  // ── Team composer data (Foundation spec PR-5 wiring) ────────────
  // Profiles cache: load on workspace switch, subscribe without new
  // useState (Pitfall 9). No new state below — all projections.
  useEffect(() => {
    configureTeamProfilesCache({
      readFile: (path) => hostAdapter.fs.readFile(path),
      writeFile: (path, body) => hostAdapter.fs.writeFile(path, body),
    })
  }, [])
  const teamProfilesLoadedRootRef = useRef<string | null>(null)
  useEffect(() => {
    const root = currentWorkspace.root
    if (teamProfilesLoadedRootRef.current === root) return
    teamProfilesLoadedRootRef.current = root
    void loadTeamProfilesForWorkspace(root, currentWorkspace.id)
  }, [currentWorkspace.root, currentWorkspace.id])
  const profilesVersionTick = useSyncExternalStore(subscribeTeamProfiles, teamProfilesVersion)
  const customTeamProfiles = useMemo(() => {
    void profilesVersionTick
    return teamProfilesSnapshot()
  }, [profilesVersionTick])
  // LeftRail marks (Foundation spec §10.6): derived purely from the
  // team-runs file — no conversation-kind change, no filtering.
  const teamRunsVersionTick = useSyncExternalStore(subscribeTeamRuns, teamRunsVersion)
  const teamMarks = useMemo(() => {
    void teamRunsVersionTick
    return teamMarksFromRuns(teamRunsSnapshot())
  }, [teamRunsVersionTick])
  const builtinTeamTemplates = useMemo(
    () => builtinTemplatesForSurface(topMode, Date.now()),
    [topMode],
  )

  liveIdentityRef.current = {
    topMode,
    workspaceKey: currentWorkspaceKey,
    conversationId: topMode === 'work' ? workSessionId : codeSessionId,
    root: currentWorkspace.root,
  }
  const currentSessions = useMemo<readonly ConversationSession[]>(
    () => listConversationSessions(currentHistory),
    [currentHistory],
  )
  const activeSessionId = currentHistory.activeByKind[topMode]
  const currentActiveSession = activeSessionId
    ? (currentHistory.conversations[activeSessionId]?.session ?? null)
    : null

  // ── Person | Team surface (spec §1.2 / §11) ─────────────────
  // The TeamRun is attached to the CURRENT Person (Code/Work)
  // conversation, not to a top-level workspace field. P0 keeps the
  // TeamRun in component state; P1 will move it into the per-conversation
  // history. The selector here just means: the run we render is the
  // one for the active conversation id (or null if it's been cleared).
  const teamRunForCurrentSession = useMemo<TeamRun | null>(() => {
    if (!teamRun) return null
    const sessionId = currentActiveSession?.id ?? null
    if (!sessionId) return null
    if (teamRun.personConversationId !== sessionId) return null
    return teamRun
  }, [teamRun, currentActiveSession])

  // Foundation spec §10.10: the DEV "加载示例" fixture CTA is gone from
  // the UI main path. FIXTURE_TEAM_RUN stays in team-fixture.ts for unit
  // tests only; visual debugging is gated by
  // `import.meta.env.DEV && localStorage.tryloTeamFixture === '1'` and
  // has no App wiring in v0.

  const handleSelectTeamSeat = useCallback((seatId: string | null) => {
    setTeamRun((run) => (run ? selectSeat(run, seatId) : run))
  }, [])

  const handlePersonTeamStatusBarOpen = useCallback(() => {
    setCollaborationSurface('team')
  }, [])

  const updateHistoryAt = useCallback(
    (
      root: string,
      updater: (history: WorkspaceConversationHistory) => WorkspaceConversationHistory,
    ): void => {
      const key = workspaceKey(root)
      setHistories((previous) => {
        const history = previous[key]
        if (!history) return previous
        const next = updater(history)
        return next === history ? previous : { ...previous, [key]: next }
      })
    },
    [],
  )

  const updateMessagesAt = useCallback(
    (
      root: string,
      sessionId: string | null,
      updater:
        readonly ChatMessage[] | ((previous: readonly ChatMessage[]) => readonly ChatMessage[]),
    ): void => {
      updateHistoryAt(root, (history) => updateConversationMessages(history, sessionId, updater))
    },
    [updateHistoryAt],
  )

  // P2-1 (spec §13.3 / §6.5): fold a normalised result snapshot back into the
  // persisted conversation history so switching projects/restarting restores it.
  const updateResultsAt = useCallback(
    (
      root: string,
      conversationId: string,
      resultsToMerge:
        import('./results/conversation-result-types').StoredConversationResults | undefined,
    ): void => {
      updateHistoryAt(root, (history) =>
        updateConversationResults(history, conversationId, resultsToMerge),
      )
    },
    [updateHistoryAt],
  )

  const setMessages = useCallback(
    (
      updater:
        readonly ChatMessage[] | ((previous: readonly ChatMessage[]) => readonly ChatMessage[]),
    ): void => {
      updateMessagesAt(currentWorkspace.root, codeSessionId, updater)
    },
    [currentWorkspace.root, codeSessionId, updateMessagesAt],
  )

  const setText = useCallback(
    (draft: string): void => {
      updateHistoryAt(currentWorkspace.root, (history) =>
        updateConversationDraft(history, history.activeByKind.code, draft),
      )
    },
    [currentWorkspace.root, updateHistoryAt],
  )

  const setWorkInput = useCallback(
    (draft: string): void => {
      updateHistoryAt(currentWorkspace.root, (history) =>
        updateConversationDraft(history, history.activeByKind.work, draft),
      )
    },
    [currentWorkspace.root, updateHistoryAt],
  )

  // M4-D: Work empty-state starter pick. Writes the
  // capability-neutral seed into the Work input. The
  // user still reviews and sends manually.
  const onPickWorkStarter = useCallback(
    (seed: string, _starterId: string): void => {
      setWorkInput(seed)
    },
    [setWorkInput],
  )

  const [leftRailCollapsed, setLeftRailCollapsed] = useState(false)
  // v1.17: the file tree moved out of the left rail into a
  // toggleable right rail (Option A — keep the left rail
  // project/conversation-focused, give files their own home).
  const [rightRailOpen, setRightRailOpen] = useState(false)
  // v1.17.1: live rail widths (px), driven by the draggable
  // resizers so the user can stretch / shrink the panels.
  const [leftWidth, setLeftWidth] = useState(240)
  const [rightWidth, setRightWidth] = useState(300)
  // Preview rail (FilePeek): same resizer pattern. `peekWidth` is the
  // dragged width; `peekExpanded` is the one-click fullscreen preview
  // that covers the window until toggled off or Escape (dragged width
  // is restored, not lost).
  const [peekWidth, setPeekWidth] = useState(480)
  const [peekExpanded, setPeekExpanded] = useState(false)
  // v1.16.3: inline-edit of past user messages. When
  // set, the corresponding <p> in Message.tsx swaps to a
  // <textarea>. On save we truncate everything after it
  // and re-send. On cancel we clear back to display.
  // The textarea keeps its own local draft mirror in
  // Message.tsx; no editing-draft state lives here.
  const [editingMessageId, setEditingMessageId] = useState<string | null>(null)
  // v1.16.4.1: messages ref. onSend and onSaveEdit
  // are useCallbacks whose dep arrays don't include
  // `messages` (deliberately — adding it would re-
  // create the callback on every event, churning
  // InputBar's memo). But the closures need the
  // LATEST messages when building `priorMessages`
  // for the CLI spawn. The ref is updated on every
  // render (the assignment runs every render, no
  // useEffect needed) so the closures always see
  // fresh state. Without this, every send after the
  // first uses a stale `priorMessages` snapshot —
  // the model then sees a context that doesn't
  // include the most recent user bubble, which is
  // what was producing the "model always responds
  // with the first hello" symptom in user testing.
  const messagesRef = useRef<readonly ChatMessage[]>(messages)
  messagesRef.current = messages
  // Companion ref for the Work stream, same contract: callbacks that need
  // the latest messages at CALL time read the ref instead of closing over
  // the array, so their identity stays stable across streaming deltas and
  // memoized timeline rows don't re-render for no reason.
  const workMessagesRef = useRef<readonly ChatMessage[]>(workMessages)
  workMessagesRef.current = workMessages
  // 2026-09-03 (run controls spec §UI-B): a per-conversation queue for
  // messages typed while a Code run is active. DEFAULT behaviour is QUEUE —
  // the message is not injected into the running turn; it runs automatically
  // when the current turn returns to idle. An explicit "打断" interrupts via
  // steerCode instead. Keyed `projectKey::conversationId`.
  const [nextLearningDirectiveByProduct, setNextLearningDirectiveByProduct] =
    useState<LearningDirectiveByProduct>({})
  const nextLearningDirectiveRef = useRef<LearningDirectiveByProduct>({})
  const setNextLearningDirective = useCallback(
    (product: ProductSurface, directive: LearningDirective | undefined): void => {
      const next = setLearningDirectiveForProduct(
        nextLearningDirectiveRef.current,
        product,
        directive,
      )
      nextLearningDirectiveRef.current = next
      setNextLearningDirectiveByProduct(next)
    },
    [],
  )
  const consumeNextLearningDirective = useCallback(
    (product: ProductSurface): LearningDirective | undefined => {
      const consumed = consumeLearningDirectiveForProduct(nextLearningDirectiveRef.current, product)
      if (!consumed.directive) return undefined
      nextLearningDirectiveRef.current = consumed.remaining
      setNextLearningDirectiveByProduct(consumed.remaining)
      return consumed.directive
    },
    [],
  )
  const pendingCodeQueueRef = useRef<
    Map<
      string,
      Array<{
        text: string
        turnId: string
        learningDirective?: LearningDirective
      }>
    >
  >(new Map())
  // Latest onSend — the flush effect needs it without re-firing on every run.
  const onSendRefForFlush = useRef<
    ((text: string, learningDirective?: LearningDirective) => void) | null
  >(null)
  // Re-render trigger when the queue length changes (the ref itself is not
  // reactive; the count is recomputed off the ref each render).
  const [, bumpQueueTick] = useReducer((x: number) => x + 1, 0)
  const codeQueuedCount =
    pendingCodeQueueRef.current.get(
      queueConversationKey(workspaceKey(currentWorkspace.root), codeSessionId ?? ''),
    )?.length ?? 0
  // 2026-09-04 (run controls §UI-B, Work): same queue-by-default for Work —
  // a message typed while a Work task is live waits for the current turn; an
  // explicit "立即打断" dispatches immediately. Keyed workspaceKey::workSessionId.
  const pendingWorkQueueRef = useRef<
    Map<
      string,
      Array<{
        text: string
        turnId: string
        learningDirective?: LearningDirective
      }>
    >
  >(new Map())
  const onWorkSendRefForFlush = useRef<
    | ((
        text: string,
        opts?: {
          fromSuggestion?: boolean
          suggestionId?: string
          learningDirective?: LearningDirective
        },
      ) => void)
    | null
  >(null)
  // 2026-09-04: "立即打断" dispatches the queued Work message immediately,
  // bypassing the queue-by-default gate.
  const bypassWorkQueueRef = useRef(false)
  const workQueuedCount =
    pendingWorkQueueRef.current.get(
      queueConversationKey(workspaceKey(currentWorkspace.root), workSessionId ?? ''),
    )?.length ?? 0
  // v1.16.6 (M4-A runtime ownership, spec §5.1/§5.4): Code run
  // state is no longer global. A ConversationRunSupervisor owns
  // every Code run keyed by (projectKey, conversationId); React
  // only reads the ViewState of the VISIBLE conversation. Pure
  // navigation (mode / session / sub-mode / workspace switch) never
  // stops a run — only a scoped stop, a delete, or a workspace
  // close does.
  // Hermes learning port (migration spec §7). Starts as the null port and is
  // replaced by the Service Host facade once the sidecar is up — Hermes is
  // non-essential, so nothing here may depend on it being available.
  const learningPortRef = useRef<LearningPort>(createNullLearningPort())
  // Trylo Tool Platform (tool-extension spec §4.2/§12.1): starts as a null
  // resolver and is bound once the Service Host client exists. `null` from
  // the resolver is a normal state — the run degrades to the legacy Hermes
  // args, it never fails (§4.4).
  const toolingFacadeRef = useRef<ToolingFacade | null>(null)
  // PR-3 (§6.5): the browser origin-lease store. ONE instance shared by the
  // risk classifier (reads leases) and the permission registry (records a
  // grant when the user approves a first navigation), so a user approval is
  // the only way a lease is ever created.
  const browserLeasesRef = useRef<BrowserOriginLeases | null>(null)
  if (!browserLeasesRef.current) browserLeasesRef.current = new BrowserOriginLeases()
  // PR-6 (§6.6): the Windows screen-consent store. Same ownership split as
  // the browser leases: the classifier reads it, the permission registry
  // records a grant only on an explicit user approval, and the emergency
  // stop revokes everything at once (§13 PR-6: stop 后无残留控制).
  const screenConsentRef = useRef<ScreenConsentLeases | null>(null)
  if (!screenConsentRef.current) screenConsentRef.current = new ScreenConsentLeases()
  // §11.3 用户接管 (WCC-P2-04): per-conversation takeover escalations. The
  // onEvents watcher records a conversation when a server-reported takeover
  // fact arrives; the classifier then forces per-call approvals for every
  // windows tool in that conversation until the TTL expires.
  const takeoverEscalationsRef = useRef<TakeoverEscalations | null>(null)
  if (!takeoverEscalationsRef.current) takeoverEscalationsRef.current = new TakeoverEscalations()
  // PR-6 偏差③收口 (§6.6 「拒绝自动化」分支): the output-side watcher. A
  // windows tool result that reveals a UAC / elevated window withdraws the
  // conversation's screen-consent lease, so automation stops and every
  // further desktop action needs fresh human approval. One instance for the
  // app lifetime; only Work sends can surface windows tools (the
  // work.computer.v1 profile), so only the Work onEvents feeds it.
  const sensitiveWindowWatcherRef = useRef<ReturnType<typeof createSensitiveWindowWatcher> | null>(
    null,
  )
  if (!sensitiveWindowWatcherRef.current) {
    sensitiveWindowWatcherRef.current = createSensitiveWindowWatcher(screenConsentRef.current)
  }
  // WCC-P2-03 (spec §16): the DesktopActionProvider catalog + the observe/
  // verify watcher over the CDP tool stream. Same wiring shape as the
  // sensitive-window watcher: one app-lifetime instance, fed from the Work
  // onEvents entries. The watcher only OBSERVES results and VERIFIES
  // evidence — the model keeps sending its own pinned CDP calls through the
  // risk classifier; provider routing never bypasses approval and never
  // dispatches an MCP call.
  const providerRegistryRef = useRef<ReturnType<typeof createProviderRegistry> | null>(null)
  if (!providerRegistryRef.current) providerRegistryRef.current = createProviderRegistry()
  const providerWatcherRef = useRef<ReturnType<typeof createProviderObservationWatcher> | null>(
    null,
  )
  if (!providerWatcherRef.current) {
    providerWatcherRef.current = createProviderObservationWatcher(providerRegistryRef.current)
  }
  // §18.3 wrong_window_dispatch_count — the host-collected half (the fork
  // declared it unsourced: only the host sees the intent receipt). Same
  // wiring shape as the sensitive-window watcher: one app-lifetime metrics
  // store + one event-pairing watcher, fed from the Work onEvents entries.
  // In-memory only, zero network; the fork's metrics file sink is untouched.
  const dispatchMetricsRef = useRef<DesktopDispatchMetrics | null>(null)
  if (!dispatchMetricsRef.current) dispatchMetricsRef.current = new DesktopDispatchMetrics()
  const wrongWindowWatcherRef = useRef<ReturnType<
    typeof createWrongWindowDispatchWatcher
  > | null>(null)
  if (!wrongWindowWatcherRef.current) {
    wrongWindowWatcherRef.current = createWrongWindowDispatchWatcher(dispatchMetricsRef.current)
  }
  const supervisorRef = useRef<ConversationRunSupervisor | null>(null)
  if (!supervisorRef.current) {
    supervisorRef.current = new ConversationRunSupervisor({
      // Hermes MCP args are resolved per run, right before the CLI spawn
      // (spec §7.3). The port is read through the ref because it is created
      // further down, after the Service Manager exists. This is now the
      // LEGACY path: it only runs when the Tool Platform has no answer.
      resolveCodeCliArgs: () => resolveHermesMcpArgs(learningPortRef.current, 'normal'),
      // Surface-aware resolver (spec §4.2): Code and Work pick their own
      // Profile. Work cannot inherit the Code `normal` argv (§4.3).
      resolveToolRuntime: (request) =>
        toolingFacadeRef.current?.resolveProfile(request) ?? Promise.resolve(null),
      // PR-2 (spec §6): the host risk classifier decides auto-allow /
      // deny / prompt for managed MCP tools BEFORE any approval is
      // projected. Deterministic and additive — without it every request
      // is a human approval, which is today's behaviour. PR-3 registers
      // the Playwright classifier with the shared lease store; PR-6 adds
      // the Windows classifier with the shared screen-consent store; PR-7
      // adds the Chrome DevTools debug classifier (same shared browser
      // lease store — one user-approved origin covers both browser
      // surfaces). PR-3 偏差④收口: the manifests' origin lists ride along
      // verbatim (empty today = server default; the classifier owns
      // navigation decisions either way).
      riskClassifier: createToolRiskClassifier([
        officecliClassifier,
        createPlaywrightClassifier({
          leases: browserLeasesRef.current,
          allowedOrigins: [...(PLAYWRIGHT_MANIFEST.mcp.allowedOrigins ?? [])],
          blockedOrigins: [...(PLAYWRIGHT_MANIFEST.mcp.blockedOrigins ?? [])],
        }),
        createWindowsClassifier({
          screenConsent: screenConsentRef.current,
          takeoverEscalations: takeoverEscalationsRef.current,
        }),
        // The CDP manifest deliberately declares NO origin lists (its
        // server flags are URL patterns, not origins) — the classifier's
        // defaults (empty) are the manifest truth; if a future manifest
        // adds lists, the .d.mts and this wiring grow together.
        createChromeDevtoolsClassifier({ leases: browserLeasesRef.current }),
        // CAD/EDA adapters (TRYLO-CAD-EDA-TOOL-ADAPTER §7): six explicit
        // policy tables, no leases — every prompt-class call is one approval.
        ...CAD_EDA_CLASSIFIERS,
      ]),
      onLeaseGrant: (lease) => {
        // windows-screen (screen consent) and windows-click (click scope)
        // live in ONE store keyed by kind; browser-origin goes to the
        // shared browser store (playwright + chrome-devtools).
        if (lease.kind === 'browser-origin') {
          browserLeasesRef.current?.grant(lease)
        } else {
          screenConsentRef.current?.grant(lease)
        }
        try {
          const conversationId = 'conversationId' in lease ? String(lease.conversationId ?? '') : ''
          if (!conversationId) return
          const traces = tracesByConversationRef.current
          for (const [key, traceId] of traces) {
            if (!key.endsWith(`::${conversationId}`)) continue
            userLearningRef.current?.recordEvent(
              traceId,
              eventFromLeaseGrant({
                kind: lease.kind,
                origin:
                  'origin' in lease
                    ? String((lease as { origin?: string }).origin ?? '')
                    : undefined,
              }),
            )
            break
          }
        } catch {
          /* never block a lease grant */
        }
      },
    })
  }
  const supervisor = supervisorRef.current
  const handleCancelTeamSeat = useCallback(
    (seatId: string) => {
      setTeamRun((run) => (run ? cancelTeamSeat(run, seatId) : run))
      // PR-9: the user stopping a seat is user Evidence with team provenance.
      try {
        const seat = teamRunRef.current?.seats.find((s) => s.id === seatId)
        const traceId = tracesByConversationRef.current.get(
          conversationTraceKey(currentWorkspaceKey, currentActiveSession?.id ?? ''),
        )
        if (traceId && seat) {
          userLearningRef.current?.recordEvent(
            traceId,
            withTeamProvenance(
              eventFromStop(),
              teamRunRef.current?.contractId
                ? teamEvidenceProvenance({
                    seatId: seat.seat,
                    teamRunId: teamRunRef.current.id,
                    contractId: teamRunRef.current.contractId,
                    contractVersion: teamRunRef.current.contractVersion ?? 0,
                  })
                : undefined,
            ),
          )
        }
      } catch {
        /* never block cancel */
      }
      const sessionId = currentActiveSession?.id
      if (!sessionId) return
      void supervisor.stopTask(currentWorkspaceKey, sessionId, seatId)
    },
    [currentActiveSession, currentWorkspaceKey, supervisor],
  )
  // Foundation spec §10.5: 「停止」 walks the existing per-seat cancel
  // for every running / waiting member. No new state — it reads the
  // same projected run the veto effect below uses.
  const handleStopTeamRun = useCallback(() => {
    const run = teamRunRef.current
    if (!run) return
    for (const seat of run.seats) {
      if (seat.status === 'running' || seat.status === 'waiting_approval') {
        handleCancelTeamSeat(seat.id)
      }
    }
  }, [handleCancelTeamSeat])

  // Composer profile save-as / delete (Foundation spec PR-5). The draft
  // lives in the composer-draft singleton; App only persists.
  const handleSaveTeamProfileAs = useCallback(async (name: string) => {
    const draft = getComposerDraft()
    if (!draft) return
    const profile = buildProfileFromDraft({ ...draft, title: name }, Date.now())
    const guard = guardSave(profile)
    if (!guard.ok) {
      // eslint-disable-next-line no-console
      console.warn('[team-access] profile save refused:', guard.reason)
      return
    }
    await upsertTeamProfile(profile)
  }, [])
  const handleDeleteTeamProfile = useCallback((profileId: string) => {
    void removeTeamProfile(profileId)
  }, [])
  // PR-8 (spec §10.4): a Person veto leaves the seat at waiting_approval
  // ("Person 否决 · …"). On first sight of an unhandled veto, stop every
  // writable worker (worker is the only writable seat in v0). Declarative
  // on the projected run, so it holds for every feedTeamEvents call site.
  const vetoHandledSeatsRef = useRef<Set<string>>(new Set())
  useEffect(() => {
    if (!teamRun) return
    const person = teamRun.seats.find(
      (s) =>
        s.seat === 'person' &&
        s.status === 'waiting_approval' &&
        s.summary.startsWith('Person 否决'),
    )
    if (!person || vetoHandledSeatsRef.current.has(person.id)) return
    vetoHandledSeatsRef.current.add(person.id)
    for (const seat of teamRun.seats) {
      if (
        seat.seat === 'worker' &&
        (seat.status === 'running' || seat.status === 'waiting_approval')
      ) {
        handleCancelTeamSeat(seat.id)
      }
    }
  }, [teamRun, handleCancelTeamSeat])
  // PR-9 (spec §13): user actions inside a live team run carry team
  // provenance in `event.structured` so the existing extractor can
  // attribute them without changing the snapshot shape. Only user-actor
  // events qualify — seat verdicts and Person vetoes stay out of Evidence.
  const teamRunRef = useRef<TeamRun | null>(null)
  useEffect(() => {
    teamRunRef.current = teamRun
  }, [teamRun])
  const teamProvenanceRef = useRef<TeamEvidenceProvenance | undefined>(undefined)
  useEffect(() => {
    const run = teamRun
    teamProvenanceRef.current = run?.contractId
      ? teamEvidenceProvenance({
          teamRunId: run.id,
          contractId: run.contractId,
          contractVersion: run.contractVersion ?? 0,
        })
      : undefined
  }, [teamRun])
  const codeView = useConversationRunViewState(supervisor, currentWorkspaceKey, codeSessionId)
  // P0 Work 单一发送: Work 每条消息都走 Code supervisor，因此 Work 会话
  // 复用 Code 的 ConversationRunViewState 派生运行态。workSessionId 为
  // null 时该 hook 已支持。
  const workCodeView = useConversationRunViewState(supervisor, currentWorkspaceKey, workSessionId)
  const running = codeView.running
  const sendingDisabled = !codeView.sendable
  const activeProcessId = codeView.activeProcessId
  const error = codeView.error
  // Fresh on every render (any supervisor bump re-renders this
  // component via useConversationRunViewState), so this is the
  // live set of in-flight Code runs (Activity badge, M4-A).
  const activeCodeRuns = supervisor.activeCodeRuns()

  // P3 (spec §4.5): project the live CodePermissionRegistry
  // entries for the visible Code conversation into the chat
  // stream. The projection is built FRESH from the registry on
  // every supervisor bump; raw tool input lives only in the
  // in-memory registry, never in the ConversationRecord. The
  // card routes `onRespond` through the unified ApprovalService
  // (Code path) or WorkRuntime.respondApproval (Work path).
  const codeApprovals = useMemo<readonly ChatMessage[]>(() => {
    if (!codeSessionId) return EMPTY_CHAT_MESSAGES
    const pending = supervisor
      .pendingCodePermissions()
      .filter((r) => r.conversationId === codeSessionId)
    return pending.map<ChatMessage>((req) => ({
      id: `code-approval:${req.requestId}`,
      kind: 'approval',
      role: 'system',
      createdAt: req.at,
      // P3: route is `code`; the host dispatches the response
      // through ApprovalService.decide(requestId, decision).
      authority: 'code',
      approvalId: req.requestId,
      type: req.toolName,
      description: req.title ?? `${req.toolName} 请求审批`,
      status: 'pending',
      // PR-2: the classifier's safe preview (paths only, no raw content)
      // rides with the pending request so the card renders a real summary
      // instead of a bare tool name.
      ...(req.preview ? { preview: req.preview } : {}),
      // Live handle to the in-memory registry entry. The
      // card calls buildApprovalPreview on demand; this
      // object is NOT written to ConversationRecord.
      pendingRequest: {
        requestId: req.requestId,
        projectKey: req.projectKey,
        conversationId: req.conversationId,
        processId: req.processId,
        toolName: req.toolName,
        input: req.input,
      },
    }))
  }, [supervisor, codeSessionId, codeView])

  // 2026-08-30 (intent-routing): a Work message routed to the Code runtime
  // raises Code permission requests whose conversationId is the WORK session,
  // not the Code session. Those requests must surface as approval cards in the
  // Work conversation — otherwise the user can only approve them via the pet.
  // Project the pending Code requests for the visible Work session here and
  // merge them into `workMergedMessages`.
  const workApprovals = useMemo<readonly ChatMessage[]>(() => {
    if (!workSessionId) return EMPTY_CHAT_MESSAGES
    const pending = supervisor
      .pendingCodePermissions()
      .filter((r) => r.conversationId === workSessionId)
    return pending.map<ChatMessage>((req) => ({
      id: `code-approval:${req.requestId}`,
      kind: 'approval',
      role: 'system',
      createdAt: req.at,
      authority: 'code',
      approvalId: req.requestId,
      type: req.toolName,
      description: req.title ?? `${req.toolName} 请求审批`,
      status: 'pending',
      ...(req.preview ? { preview: req.preview } : {}),
      pendingRequest: {
        requestId: req.requestId,
        projectKey: req.projectKey,
        conversationId: req.conversationId,
        processId: req.processId,
        toolName: req.toolName,
        input: req.input,
      },
    }))
  }, [supervisor, workSessionId, codeView])

  // P3: merge the live CodePermissionRegistry projection INTO the
  // persisted message stream AT RENDER TIME only. The persisted
  // record never carries the pendingRequest field — the registry
  // is the only source of truth for a live Code request, and the
  // merged messages are passed straight to the UI.
  const mergedMessages = useMemo<readonly ChatMessage[]>(() => {
    if (codeApprovals.length === 0) return messages
    return [...messages, ...codeApprovals]
  }, [messages, codeApprovals])

  // 2026-08-30 (intent-routing): merge the Work-session Code approval
  // requests into the Work message stream so a Work message routed to the
  // Code runtime can be approved inline (not only via the pet).
  const workMergedMessages = useMemo<readonly ChatMessage[]>(() => {
    if (workApprovals.length === 0) return workMessages
    return [...workMessages, ...workApprovals]
  }, [workMessages, workApprovals])

  // P2-1 (spec §5.1 / §13.3): one ConversationResultRepository + one
  // CodeResultProjector for the whole app. The projector finalizes into the
  // repository; the repository bumps a re-render; updates also fold back into
  // history via updateResultsAt (project-root aware, so background runs on
  // other projects persist to the right workspace).
  const resultRepoRef = useRef<ConversationResultRepository | null>(null)
  if (!resultRepoRef.current) resultRepoRef.current = new ConversationResultRepository()
  const resultRepo = resultRepoRef.current
  const [resultVersion, setResultVersion] = useState(0)
  void resultVersion
  const codeProjectorRef = useRef<CodeResultProjector | null>(null)
  if (!codeProjectorRef.current) {
    codeProjectorRef.current = new CodeResultProjector({
      store: {
        update: (projectKey, projectRoot, conversationId, code) => {
          resultRepo.update(projectKey, conversationId, (previous) => ({
            ...previous,
            schemaVersion: 1,
            code: code ? { latestRun: code } : undefined,
          }))
          const snapshot = resultRepo.snapshot(projectKey, conversationId)
          updateResultsAt(projectRoot, conversationId, snapshot)
        },
      },
    })
  }
  const codeProjector = codeProjectorRef.current

  // P2-1 (spec §5.1 / §8.2): one scoped WorkResultProjector for the whole app.
  // It finalises into the same repository `work` slice and folds back into
  // history, so background runs on other projects persist to the right
  // workspace and a project switch / restart restores them.
  const workProjectorRef = useRef<WorkResultProjector | null>(null)
  if (!workProjectorRef.current) {
    workProjectorRef.current = new WorkResultProjector({
      port: {
        update: (projectKey, projectRoot, conversationId, work) => {
          resultRepo.update(projectKey, conversationId, (previous) => ({
            ...previous,
            schemaVersion: 1,
            work:
              work &&
              (work.artifacts.length > 0 ||
                work.artifactCountTotal > 0 ||
                work.latestRun !== undefined)
                ? work
                : undefined,
          }))
          const snapshot = resultRepo.snapshot(projectKey, conversationId)
          updateResultsAt(projectRoot, conversationId, snapshot)
        },
      },
      // PR-5 (spec §11): the deterministic Office delivery validation runs
      // on the Service Host, after the scan write, over the run's file
      // artifacts. A transport failure degrades to "no verdict" — never a
      // pass (§4.4). The facade is bound lazily; the closure reads it at
      // call time so construction order cannot matter.
      verify: (projectRoot, artifacts) =>
        toolingFacadeRef.current
          ? toolingFacadeRef.current.validateOfficeArtifacts({ projectRoot, artifacts })
          : Promise.resolve(null),
    })
  }
  const workProjector = workProjectorRef.current

  // Re-render subscribers whenever any conversation's result snapshot changes.
  useEffect(() => {
    return resultRepo.subscribe(() => setResultVersion((value) => value + 1))
  }, [resultRepo])

  // Hydrate persisted results once per workspace (spec §2.5 / §6.5).
  const hydratedWorkspaceRef = useRef<string | null>(null)
  useEffect(() => {
    if (!historyReady) return
    if (hydratedWorkspaceRef.current === currentWorkspaceKey) return
    hydratedWorkspaceRef.current = currentWorkspaceKey
    for (const [id, record] of Object.entries(currentHistory.conversations)) {
      if (record.results) {
        // C-Edge P2-4 (defensive recovery): a persisted `collecting`
        // run whose runtime is no longer alive must be demoted to
        // `degraded`, never silently promoted. Verifiers read the
        // live supervisor + work-runtime registries.
        const session = record.session
        const taskId = session && 'taskId' in session ? (session.taskId ?? null) : null
        const turnId = session && 'turnId' in session ? (session.turnId ?? null) : null
        const recovered = applyRecovery(record.results, {
          projectKey: currentWorkspaceKey,
          conversationId: id,
          workTaskId: taskId,
          workTurnId: turnId,
          verifiers: {
            // 2026-09-04 (CLI 单核): the workd TaskRegistry is retired, so a
            // persisted `collecting` Work run can never be verified active
            // again — it always demotes to `degraded` on recovery.
            isWorkTaskActive: () => false,
            isCodeRunActive: (projectKey, conversationId) => {
              try {
                return supervisor
                  .activeCodeRuns()
                  .some((r) => r.projectKey === projectKey && r.conversationId === conversationId)
              } catch {
                return false
              }
            },
          },
        })
        if (recovered.report.changed && recovered.results) {
          resultRepo.hydrate(currentWorkspaceKey, id, recovered.results)
          // Persist the recovery correction so the next cold start
          // doesn't re-run the rewrite on the same stale state.
          const snapshot = recovered.results
          updateHistoryAt(currentWorkspace.root, (history) =>
            updateConversationResults(history, id, snapshot),
          )
        } else {
          resultRepo.hydrate(currentWorkspaceKey, id, record.results)
        }
        // P2-1 (spec §8.2 recovery): hydrate the scoped Work store so a fresh
        // run can compare signatures / versions against the persisted state.
        const workSlice = (recovered.results ?? record.results).work
        if (workSlice) {
          workProjector.hydrate(currentWorkspaceKey, id, workSlice)
        }
      }
    }
    setResultVersion((value) => value + 1)
  }, [
    historyReady,
    currentWorkspaceKey,
    currentHistory,
    resultRepo,
    workProjector,
    supervisor,
    currentWorkspace.root,
    updateHistoryAt,
  ])

  // The current visible Code conversation's normalized latest-run result.
  const codeResults = useMemo<StoredCodeRunResult | undefined>(() => {
    if (!codeSessionId) return undefined
    void resultVersion // subscription version forces re-read of the snapshot
    return resultRepo.snapshot(currentWorkspaceKey, codeSessionId)?.code?.latestRun
  }, [currentWorkspaceKey, codeSessionId, resultRepo, resultVersion])

  // v1.16.6 (P0-2): on app close, stop every owned Code run so no
  // trylo-cli Node child is orphaned (the Rust side also kills the
  // ProcessState table on CloseRequested — this covers the webview
  // side / non-Tauri reload too). Fire-and-forget; the controller
  // stop is idempotent.
  useEffect(() => {
    const onPageHide = (): void => {
      void supervisor.stopAll()
    }
    window.addEventListener('pagehide', onPageHide)
    return () => window.removeEventListener('pagehide', onPageHide)
  }, [supervisor])
  // v1.16.4: `turnStartedAt` is GONE from top-level
  // state. Each user message now carries its own
  // `turnStartedAt` + `finalElapsedMs`; events.ts
  // stamps the freeze on first output. MessageList
  // does the per-turn lookup. This is what makes
  // multiple turns coexist independently — the
  // previous global state was the root cause of the
  // "second turn sends and the first row's spinner
  // pauses weirdly" bug.
  const [peekFile, setPeekFile] = useState<{ path: string; content: string } | null>(null)
  // v1.16.5: Phase 2.5 收口 — Work sub-app can request
  // the Settings modal (e.g. when the user has no API
  // key configured). Lifting the state out of AppShell
  // lets any descendant trigger it.
  const [settingsOpen, setSettingsOpen] = useState(false)
  const openSettings = useCallback(() => setSettingsOpen(true), [])
  // 2026-08-29: remote pairing modal — opened by the TopBar
  // "远程" button. Holds the pairing QR + enable switch.
  const [showRemotePairing, setShowRemotePairing] = useState(false)
  // M4-D: Background Activity Center popover. The TopBar
  // activity chip flips this; the popover body is rendered
  // inside AppShell. Closing happens on Escape, on
  // outside-click, or on selecting a run (which jumps the
  // visible conversation and dismisses the panel).
  const [activityOpen, setActivityOpen] = useState(false)
  const openActivity = useCallback(() => setActivityOpen(true), [])
  const [settings, setSettings] = useState<TryloSettings>(() => loadSettings())
  const settingsRef = useRef(settings)
  settingsRef.current = settings
  // Per-conversation model choice (不同对话不同模型). A conversation remembers
  // which model source it uses (own / built-in pool / saved profile). Choices
  // are persisted separately from the global settings and fall back to it.
  const [conversationModels, setConversationModels] = useState<ConversationModelMap>(() =>
    loadConversationModels(),
  )
  const conversationModelsRef = useRef<ConversationModelMap>(conversationModels)
  conversationModelsRef.current = conversationModels
  const codeModeRef = useRef(codeMode)
  codeModeRef.current = codeMode

  const userLearningRef = useRef<UserLearningRuntime | null>(null)
  if (!userLearningRef.current) {
    userLearningRef.current = createUserLearningRuntime({
      store: createFileUserLearningStore({
        io: createLocalStorageFileIO(),
        rootDir: 'trylo:user-learning:v2',
      }),
      llm: () => {
        const current = settingsRef.current
        if (!current?.apiKey?.trim()) return null
        return createLearningLlm({
          apiKey: current.apiKey,
          apiHost: current.apiHost,
          apiModel: current.poolModel || current.apiModel,
          apiFormat: current.apiFormat,
          apiKeyHeader: current.apiKeyHeader,
          apiKeyPrefix: current.apiKeyPrefix,
        })
      },
    })
  }
  const userLearning = userLearningRef.current
  const tracesByConversationRef = useRef(new Map<string, string>())
  const pendingAgentRunRef = useRef<{
    readonly id: string
    readonly product: ProductSurface
    readonly workspaceRoot: string
    readonly conversationId: string
    readonly impactMessageId: string
    readonly start: (systemPrompt: string) => void
  } | null>(null)
  const loopResultsRef = useRef(new Map<string, string>())
  const [learningPanelOpen, setLearningPanelOpen] = useState(false)
  const [learningTick, setLearningTick] = useState(0)
  const [pendingCognitionByConversation, setPendingCognitionByConversation] = useState<
    Record<string, PendingCognitionView>
  >({})
  const [cognitionSendTick, setCognitionSendTick] = useState(0)
  const bumpLearning = useCallback(() => setLearningTick((n) => n + 1), [])
  // Standalone User Cognition session (the "fifth mode"): when
  // `cognitionViewOpen` the Person surface's main column becomes the
  // CognitionSurface instead of ChatPanel. It is NOT a third Code/Work
  // tab nor a conversation-history kind.
  const [cognitionSessionId, setCognitionSessionId] = useState<string | null>(null)
  const [cognitionViewOpen, setCognitionViewOpen] = useState(false)
  const learningView = useMemo(() => {
    const snap = userLearning.snapshot()
    const last = snap.policyDecisions.at(-1)
    return {
      mode: userLearning.settings().defaultMode,
      evidenceCount: snap.evidence.length,
      modelCount: snap.userModels.filter((m) => m.status === 'active').length,
      injected: last?.injected === true,
    }
  }, [learningTick, userLearning])
  useEffect(() => {
    userLearning.setSettings(settings.userLearning)
  }, [settings.userLearning, userLearning])
  useEffect(() => {
    if (settings.userLearning.userLearningNoTraceMode !== false) return
    nextLearningDirectiveRef.current = {}
    setNextLearningDirectiveByProduct({})
  }, [settings.userLearning.userLearningNoTraceMode])
  // Team composer flags + model choices (Foundation spec §9.4 / §4.4).
  const teamComposerLive = settings.userLearning.teamAccessEnabled === true
  const teamChoices = useMemo(() => teamModelChoices(settings), [settings])

  // ── Desktop pet (migration spec §6, Phase 2) ─────────────────────
  // Thin wiring only: the controller owns the pet policy (projection,
  // approvals, chat config). The manager degrades silently when the
  // sidecar is unavailable — Code/Work are never blocked (§5.1).
  const serviceManagerRef = useRef<ServiceManager | null>(null)
  if (!serviceManagerRef.current) {
    serviceManagerRef.current = new ServiceManager({
      invoke: (cmd, args) => invoke(cmd, args),
      listen: (event, handler) => listen(event, handler),
    })
  }
  const serviceManager = serviceManagerRef.current
  const serviceHostPathsRef = useRef<ReturnType<typeof createTauriCompanionPaths> | null>(null)
  if (!serviceHostPathsRef.current) serviceHostPathsRef.current = createTauriCompanionPaths()
  const companionPortRef = useRef<ServicesCompanionPort | null>(null)
  const companionRef = useRef<CompanionController | null>(null)
  if (!companionRef.current) {
    const port = new ServicesCompanionPort(
      serviceManager,
      serviceHostPathsRef.current,
      () => currentWorkspace.root,
    )
    companionPortRef.current = port
    companionRef.current = new CompanionController({
      manager: serviceManager,
      port,
      supervisor,
      settings: () => settingsRef.current,
    })
  }
  const companion = companionRef.current

  // ── Remote gateway (migration spec §8.1 / §8.2, arch §7) ──────────
  // Thin wiring only: the controller owns remote gateway policy
  // (projection, project/session authorities, send/cancel, approvals).
  // It reads the live settings group (remote.*), reuses the pet's
  // approval + chat authorities, and degrades when the host is down —
  // Code/Work are never blocked (§5.1).
  const remoteContextRef = useRef({
    workspaces,
    currentWorkspaceId,
    topMode,
    currentWorkspace,
  })
  remoteContextRef.current = { workspaces, currentWorkspaceId, topMode, currentWorkspace }
  const remoteControllerRef = useRef<RemoteController | null>(null)
  if (!remoteControllerRef.current) {
    const remotePort = new ServicesRemotePort(serviceManager)
    remoteControllerRef.current = new RemoteController({
      manager: serviceManager,
      port: remotePort,
      supervisor,
      settings: () => settingsRef.current,
      paths: serviceHostPathsRef.current!,
      isTauri: isTauriFn,
      // Read-only Work deliverables (`.trylo/out` of the active workspace)
      // for the remote gateway (spec §8.1 artifact routes). Read the root at
      // call time via the live ref so a project switch is honoured even though
      // the controller is constructed once.
      artifacts: {
        list: async () => {
          const root = remoteContextRef.current.currentWorkspace?.root
          if (!root) return []
          const outDir = `${root.replace(/[\\/]+$/, '')}/.trylo/out`
          try {
            const { files } = await hostAdapter.fs.scanTree(outDir, {
              maxFiles: 500,
              maxDepth: 8,
            })
            return files
              .filter((file) => file.isFile)
              .map((file) => {
                const rel = file.path.replace(/\\/g, '/')
                const short = rel.startsWith(`${outDir}/`) ? rel.slice(outDir.length + 1) : rel
                return {
                  id: short,
                  name: short,
                  kind: kindForArtifactName(short),
                  size: file.size,
                  modifiedAt: file.modifiedMs,
                }
              })
          } catch {
            return []
          }
        },
        read: async (relativePath) => {
          const root = remoteContextRef.current.currentWorkspace?.root
          const rel = sanitizeArtifactRelPath(relativePath)
          if (!root || !rel) throw new Error('invalid artifact path')
          const outDir = `${root.replace(/[\\/]+$/, '')}/.trylo/out`
          const bytes = await hostAdapter.fs.readFileBytes(`${outDir}/${rel}`)
          return {
            name: rel,
            mimeType: mimeTypeForArtifactName(rel),
            size: bytes.length,
            data: bytesToBase64(bytes),
          }
        },
      },
      workspaces: {
        list: () =>
          remoteContextRef.current.workspaces.map((workspace) => ({
            id: workspace.id,
            name: workspace.name,
            lastSeenAt: Date.now(),
          })),
        activeProjectId: () => remoteContextRef.current.currentWorkspace.id,
        select: async (projectId) => {
          const context = remoteContextRef.current
          if (projectId === context.currentWorkspaceId) return
          const target = context.workspaces.find((workspace) => workspace.id === projectId)
          if (!target) return
          void forceFlushHistory(context.currentWorkspace.root)
          setCurrentWorkspaceId(target.id)
          setTopMode(initialWorkspaceIndexRef.current?.topModeByWorkspace[target.id] ?? 'code')
        },
      },
      sessions: {
        list: () => {
          const context = remoteContextRef.current
          const history = historiesRef.current[workspaceKey(context.currentWorkspace.root)]
          return (history ? listConversationSessions(history) : []).slice(0, 40).map((session) => ({
            id: session.id,
            title: session.title.slice(0, 120),
            preview: '',
            updatedAt: session.updatedAt,
            workspace: { id: session.id, name: session.title.slice(0, 120), path: '' },
          }))
        },
        activeSessionId: () => {
          const context = remoteContextRef.current
          const history = historiesRef.current[workspaceKey(context.currentWorkspace.root)]
          return history?.activeByKind[context.topMode] ?? ''
        },
        select: async (sessionId) => {
          const context = remoteContextRef.current
          const root = context.currentWorkspace.root
          const history = historiesRef.current[workspaceKey(root)]
          const record = history?.conversations[sessionId]
          if (!record) return { switching: false }
          void forceFlushHistory(root)
          updateHistoryAt(root, (h) => selectConversation(h, sessionId))
          setTopMode(record.session.kind)
          if (record.session.kind === 'code' && record.session.codeMode) {
            setCodeMode(record.session.codeMode)
          }
          return { switching: true }
        },
      },
      sendTask: async ({ projectKey, conversationId, mode, text, requestId, attachments }) => {
        // Explicit (projectKey, conversationId) from the mobile request —
        // never guessed from the current UI selection (spec §8.1).
        const current = settingsRef.current
        const workspace =
          remoteContextRef.current.workspaces.find((w) => workspaceKey(w.root) === projectKey) ??
          remoteContextRef.current.currentWorkspace
        const root = workspace.root
        const key = workspaceKey(root)
        let history = historiesRef.current[key]
        if (!history) history = ensureConversation(emptyWorkspaceHistory(), 'code', 'agent')
        if (!history.conversations[conversationId]) {
          // Insert the EXACT mobile-requested conversation id so run
          // write-back lands in the Desktop history (spec §8.1). Mirrors
          // createConversation's record shape.
          const now = Date.now()
          const session: ConversationSession = {
            id: conversationId,
            title: text.slice(0, 56).replace(/\s+/g, ' ').trim() || 'Remote chat',
            mode: codeModeFromRemoteMode(mode),
            kind: 'code',
            codeMode: codeModeFromRemoteMode(mode),
            createdAt: now,
            updatedAt: now,
            turnCount: 0,
          }
          history = {
            ...history,
            activeByKind: { ...history.activeByKind, code: conversationId },
            conversations: {
              ...history.conversations,
              [conversationId]: { session, messages: [], draft: '' },
            },
          }
          setHistories((prev) => (prev[key] === history ? prev : { ...prev, [key]: history! }))
        }
        // Remote (mobile Chat mode) attachments: land each file on disk in the
        // workspace so the agent reads it like any local file, then register it
        // on the code partition. We bypass the live-UI identity guard because
        // the phone explicitly targeted this conversation (the desktop user
        // may be on a different one). The agent's code-send path reads this
        // partition via `buildAttachmentPromptContext` when it builds the run.
        let created: Attachment[] = []
        if (attachments?.length) {
          created = await materializeRemoteAttachments(root, conversationId, attachments)
          if (created.length) {
            conversationAttachmentStore.addRemoteAttachments(
              { surface: 'code', projectKey, conversationId },
              created,
            )
          }
        }
        const record = history.conversations[conversationId]
        // Mirror the desktop code-send path: prepend the attachment context so
        // the agent knows to read the materialised files via its file tools.
        const attachmentCtx = created.length ? buildAttachmentPromptContext(created) : ''
        const prompt = attachmentCtx ? `${attachmentCtx}\n\n${text}` : text
        await supervisor.runCode(projectKey, conversationId, {
          prompt,
          settings: settingsForCodeRun(current, root),
          codeMode: cliCodeMode(codeModeFromRemoteMode(mode)),
          // P2: remote / replayed sends use the current effective
          // level. The user cannot change the picker for a
          // replayed run; the active override wins.
          permissionLevel: effectivePermission.level,
          priorMessages: record?.messages ?? EMPTY_CHAT_MESSAGES,
          turnId: `remote-${requestId}`,
          lifecycleObserver: codeLifecycleObserver,
          onEvents: (events) => {
            feedTeamEvents(
              setTeamRun,
              { workspaceId: root, personConversationId: conversationId },
              events,
              { onClarify: handlePersonClarify },
            )
            updateMessagesAt(root, conversationId, (prev) => applyEvents(prev, events))
          },
        })
      },
      cancelTask: async (projectKey, conversationId) => {
        await supervisor.stopConversation(projectKey, conversationId)
      },
      approvals: companion.approvals,
      chatHandle: (message, chat) => companionPortRef.current!.chatHandle(message, chat),
      history: () =>
        historiesRef.current[workspaceKey(remoteContextRef.current.currentWorkspace.root)] ?? null,
      workspaceIndex: () => {
        const context = remoteContextRef.current
        const topModeByWorkspace: Record<string, TopLevelMode> = {
          ...(initialWorkspaceIndexRef.current?.topModeByWorkspace ?? {}),
        }
        topModeByWorkspace[context.currentWorkspaceId] = context.topMode
        return {
          version: 1,
          workspaces: context.workspaces.map((w) => ({ id: w.id, root: w.root, name: w.name })),
          currentWorkspaceId: context.currentWorkspaceId,
          topModeByWorkspace,
        }
      },
      currentWorkspace: () => {
        const w = remoteContextRef.current.currentWorkspace
        return { id: w.id, root: w.root, name: w.name }
      },
      conversationKind: () => remoteContextRef.current.topMode,
      codePermissions: () => supervisor.pendingCodePermissions(),
      workApprovals: () => [],
      projectKey: () => workspaceKey(remoteContextRef.current.currentWorkspace.root),
      conversationId: () => {
        const context = remoteContextRef.current
        const history = historiesRef.current[workspaceKey(context.currentWorkspace.root)]
        return context.topMode === 'work'
          ? (history?.activeByKind.work ?? '')
          : (history?.activeByKind.code ?? '')
      },
      mode: () => settingsRef.current.permissionMode,
    })
  }
  const remoteController = remoteControllerRef.current

  // The Service Host belongs to Desktop, not to the optional pet domain.
  // Start it once so Hermes remains available when the pet is disabled. A
  // real page exit is still the single owner of the final stop below.
  useEffect(() => {
    if (!isTauriFn()) return
    let active = true
    void serviceHostPathsRef.current!()
      .then((paths) => (active ? serviceManager.ensureRunning(paths) : undefined))
      .catch((err: unknown) => {
        if (active) console.warn('[trylo] Service Host startup failed; learning will degrade', err)
      })
    return () => {
      active = false
    }
  }, [serviceManager])

  // Hermes learning facade: the Service Host is the only transport, and it
  // degrades to "unavailable" answers when the sidecar is down (spec §7.3).
  // Bound once — the client instance is stable for the app's lifetime.
  const learningPortBoundRef = useRef(false)
  if (!learningPortBoundRef.current) {
    learningPortBoundRef.current = true
    learningPortRef.current = createLearningFacade(serviceManager.client)
  }

  // Tool Platform facade (tool-extension spec §12.1). Bound once with the
  // same stable client; until the sidecar answers, the resolver returns null
  // and every run keeps its legacy argv (§4.4 degrade contract).
  const toolingBoundRef = useRef(false)
  if (!toolingBoundRef.current) {
    toolingBoundRef.current = true
    toolingFacadeRef.current = createToolingFacade(serviceManager.client)
  }

  // P0-A (audit §3.3-1): the tool platform state machine. After the Service
  // Host is ready it asks `tooling.health` once and owns the four packages'
  // visible truth + install/repair actions. Hooks cannot be conditional, and
  // the facade is bound synchronously above, so this always runs — the hook
  // itself no-ops until the facade + a ready host exist.
  const toolPlatform = useToolPlatformState({
    facade: toolingFacadeRef.current,
    serviceManager,
  })

  // The IDE-style embedded browser (fork of vscode-browser-preview's CDP
  // screencast architecture). App owns the controller; the Work surface
  // hosts the drawer. The browser runs in the Service Host sidecar and
  // streams frames back as events — everything stays on this machine.
  const browserPreview = useBrowserPreview({
    facade: toolingFacadeRef.current,
    serviceManager,
  })

  // Hermes session mirror (spec §7.4): mirrors a FINISHED conversation so
  // session_search can recall it. Last in the chain and never throws, so the
  // mirror can never affect the run's own projection.
  const learningMirrorRef = useRef<ReturnType<typeof createLearningMirrorObserver> | null>(null)
  if (!learningMirrorRef.current) {
    learningMirrorRef.current = createLearningMirrorObserver({
      port: () => learningPortRef.current,
      resolve: (scope) => {
        const history = historiesRef.current[workspaceKey(scope.projectRoot)]
        const record = history?.conversations[scope.conversationId]
        if (!record) return null
        return {
          record,
          workspacePath: scope.projectRoot,
          model: settingsRef.current.apiModel,
        }
      },
    })
  }

  // Hermes implicit learning (spec §7.6): after a COMPLETED Code run, ask the
  // sidecar to review it. Detached behind the scenes — a learning run never
  // blocks or fails the user's task, and only evidence crosses the boundary.
  const learningTriggerRef = useRef<ReturnType<typeof createLearningTriggerObserver> | null>(null)
  if (!learningTriggerRef.current) {
    learningTriggerRef.current = createLearningTriggerObserver({
      port: () => learningPortRef.current,
      resolve: (scope) => {
        const history = historiesRef.current[workspaceKey(scope.projectRoot)]
        const record = history?.conversations[scope.conversationId]
        if (!record) return null
        return {
          record,
          workspacePath: scope.projectRoot,
          model: settingsRef.current.apiModel,
        }
      },
      config: (scope) => {
        const current = settingsRef.current
        if (!current.cliPath) return null
        return {
          enabled: true,
          cli: {
            cliPath: current.cliPath,
            cwd: scope.projectRoot,
            apiKey: current.apiKey,
            apiHost: current.apiHost,
            apiModel: current.apiModel,
            apiFormat: current.apiFormat,
            apiKeyHeader: current.apiKeyHeader,
            apiKeyPrefix: current.apiKeyPrefix,
            extraHeadersText: current.extraHeadersText,
          },
        }
      },
      allowReview: () => {
        const pendingUserInterrupt = messagesRef.current.some(
          (message) =>
            (message.kind === 'cognition_prompt' || message.kind === 'learning_impact') &&
            'status' in message &&
            message.status === 'pending',
        )
        return planPostTerminal({
          outcome: 'completed',
          userLearningEnabled: settingsRef.current.userLearning.enabled,
          hermesEnabled: true,
          cognitionTurn: codeModeRef.current === 'cognition',
          pendingUserInterrupt,
        }).hermesReview
      },
    })
  }

  const userLearningLifecycle = useMemo<CodeRunLifecycleObserver>(
    () => ({
      onRunStarted() {
        /* traces open at send time */
      },
      onEvents(scope, events) {
        const end = events.find((event) => event.type === 'loop_end')
        if (end && end.type === 'loop_end' && end.finalResult) {
          loopResultsRef.current.set(
            conversationTraceKey(scope.projectKey, scope.conversationId),
            end.finalResult,
          )
        }
      },
      onRunTerminal(scope, outcome) {
        const key = conversationTraceKey(scope.projectKey, scope.conversationId)
        const traceId = tracesByConversationRef.current.get(key)
        if (!traceId) return
        tracesByConversationRef.current.delete(key)
        const result = loopResultsRef.current.get(key)
        loopResultsRef.current.delete(key)
        try {
          userLearningRef.current?.closeTrace(traceId, outcome, result)
          void userLearningRef.current?.enrichAfterTrace(traceId).finally(() => bumpLearning())
          bumpLearning()
        } catch {
          // User Learning must never fail a Code run.
        }
      },
    }),
    [bumpLearning],
  )

  // Code lifecycle: result projection first, companion taps behind it,
  // Hermes mirror and learning trigger, remote gateway projection last.
  const codeLifecycleObserver = useMemo(
    () =>
      composeLifecycleObservers(
        composeLifecycleObservers(
          composeLifecycleObservers(
            composeLifecycleObservers(
              composeLifecycleObservers(codeProjector, companion.lifecycle),
              learningMirrorRef.current!,
            ),
            learningTriggerRef.current!,
          ),
          remoteController.lifecycle,
        ),
        userLearningLifecycle,
      ),
    [codeProjector, companion, remoteController, userLearningLifecycle],
  )

  useEffect(() => {
    void companion.setEnabled(settings.companion.enabled)
  }, [companion, settings.companion.enabled])

  // Remote enable follows the settings group (migration spec §8.1). The
  // controller no-ops when the platform/Tauri is unavailable or when the
  // gateway is already started.
  useEffect(() => {
    void remoteController.setEnabled(settings.remote?.enabled ?? false)
  }, [remoteController, settings.remote?.enabled])

  // Real remote status for the settings UI (spec §8.1.4). The controller
  // pushes on every gateway `remote.status` event + service-host health
  // change; `onStatus` seeds the current value, so the UI is correct from
  // the first paint.
  const [remoteStatus, setRemoteStatus] = useState<RemoteStatusResult>(() =>
    remoteController.status(),
  )
  useEffect(() => remoteController.onStatus(setRemoteStatus), [remoteController])

  // Real pet status for the settings UI (audit §4.2 PET-P0-1). The
  // controller pushes on every sidecar `pet.status` event and on every
  // service-host health change; `onStatus` seeds the current value, so the
  // UI is correct from the first paint.
  const [petStatus, setPetStatus] = useState<PetStatusSnapshot>(() => companion.petStatus())
  useEffect(() => companion.onStatus(setPetStatus), [companion])

  useEffect(() => {
    // §6.5 exit sequence (pet.disable → servicehost_stop) belongs on the
    // REAL exit/navigation signal — NOT on React unmount: StrictMode's
    // dev double-mount would otherwise permanently dispose the controller
    // before the second mount starts it again. The Rust shell repeats the
    // teardown on CloseRequested.
    const onPageHide = (): void => {
      void companion.dispose()
      void remoteController.dispose()
    }
    window.addEventListener('pagehide', onPageHide)
    return () => window.removeEventListener('pagehide', onPageHide)
  }, [companion, remoteController])

  const handleSettingsSave = useCallback((next: TryloSettings): void => {
    setSettings(next)
  }, [])

  /** Remember the model source a conversation chose. Keyed by the ACTIVE
   *  conversation (Code/Work per `topMode`); persisted independently so each
   *  conversation can carry its own model without touching the global default. */
  const persistConversationModel = useCallback(
    (choice: ConversationModelChoice): void => {
      const wsKey = currentWorkspaceKey
      const convId = topMode === 'work' ? workSessionId : codeSessionId
      if (!wsKey || !convId) return
      setConversationModels((prev) => {
        const next = setConversationChoice(prev, wsKey, convId, choice)
        saveConversationModels(next)
        return next
      })
    },
    [currentWorkspaceKey, topMode, workSessionId, codeSessionId],
  )

  // v-modelsel: the InputBar model picker. `poolModel` and the user's own
  // `apiModel` are kept apart so switching pool↔configured always round-trips
  // (the user can always switch back to their own model). Persisting here
  // (not handleSettingsSave) avoids bumping the Work runtime epoch — the new
  // model is picked up per-run (ANTHROPIC_MODEL at spawn).
  const handleSelectPool = useCallback(
    (model: string): void => {
      setSettings((prev) => {
        const persisted: TryloSettings = { ...prev, poolModel: model }
        try {
          saveSettings(persisted)
          return persisted
        } catch {
          return { ...prev, poolModel: model }
        }
      })
      persistConversationModel({ kind: 'pool', model })
    },
    [persistConversationModel],
  )

  const handleSelectConfigured = useCallback((): void => {
    setSettings((prev) => {
      const persisted: TryloSettings = { ...prev, poolModel: '', activeModelProfileId: '' }
      try {
        saveSettings(persisted)
        return persisted
      } catch {
        return { ...prev, poolModel: '', activeModelProfileId: '' }
      }
    })
    persistConversationModel({ kind: 'own' })
  }, [persistConversationModel])

  // My 配置: applying a saved profile loads its full connection into the
  // active primary fields (and clears any pool override so the profile's
  // model is the one that runs). Persisted here like model selection, so
  // the change is picked up per-run at spawn without bumping the epoch.
  const handleSelectProfile = useCallback(
    (id: string): void => {
      setSettings((prev) => {
        const profile: ModelProfile | undefined = prev.modelProfiles.find((p) => p.id === id)
        if (!profile) return prev
        const persisted: TryloSettings = { ...applyProfile(prev, profile), poolModel: '' }
        try {
          saveSettings(persisted)
          return persisted
        } catch {
          return { ...prev }
        }
      })
      persistConversationModel({ kind: 'profile', id })
    },
    [persistConversationModel],
  )

  // 2026-08-29: TopBar remote quick-toggle handler. Flips
  // `settings.remote.enabled` and persists immediately —
  // no need to open the settings modal for the on/off
  // decision. The detailed configurator (port / tunnel /
  // pairing QR) still lives in Settings.
  const handleRemoteToggle = useCallback((): void => {
    setSettings((prev) => {
      const nextRemote = {
        ...prev.remote,
        enabled: !prev.remote.enabled,
      }
      void remoteController.setEnabled(nextRemote.enabled)
      try {
        const persisted: TryloSettings = {
          ...prev,
          remote: nextRemote,
        }
        saveSettings(persisted)
        return persisted
      } catch {
        return { ...prev, remote: nextRemote }
      }
    })
  }, [remoteController])

  // P0 Work 单一发送: Work 会话的运行态由 Code supervisor 派生（不再创建
  // workd task），workActiveTask 仅作 legacy 展示保留。
  const workRunning = workCodeView.running
  // P2 (spec §3.2 / §5): per-conversation permission overrides.
  // The PICKER is purely controlled — it only calls
  // `onPermissionLevelChange` when the user confirms a new value.
  // The host (App) decides whether to apply it now (next turn
  // uses it) or queue it for the next turn (the spec calls this
  // "下轮生效"). We track the pending value separately so the
  // chip can render the visual hint without mutating the
  // effective level that the in-flight run is using.
  //
  // Declared here (after `settings` and `workRunning` are in
  // scope) to avoid a temporal-dead-zone ReferenceError.
  const [permissionOverrides, setPermissionOverrides] = useState<
    ReadonlyMap<string, { readonly level: PermissionLevel; readonly pendingForNextTurn: boolean }>
  >(() => new Map())
  // The picker keys its override map by the currently visible
  // session, regardless of the top-level mode (Code / Work). The
  // existing `activeSessionId` above is the renderer-level
  // "current" session; the picker uses its own scoped name to
  // avoid two declarations of the same variable in the same
  // component scope.
  const pickerSessionId = topMode === 'work' ? workSessionId : codeSessionId
  const activeOverride = pickerSessionId ? (permissionOverrides.get(pickerSessionId) ?? null) : null
  const settingsDefault = settings.permissionLevel ?? DEFAULT_PERMISSION_LEVEL
  const effectivePermission = resolveEffectivePermission({
    settingsDefault,
    conversationOverride: activeOverride?.level ?? null,
  })
  const permissionPendingNextTurn =
    activeOverride?.pendingForNextTurn === true && (topMode === 'work' ? workRunning : running)
  const onPermissionLevelChange = useCallback(
    (level: PermissionLevel): void => {
      if (!pickerSessionId) return
      const isRunning = topMode === 'work' ? workRunning : running
      setPermissionOverrides((prev) => {
        const next = new Map(prev)
        next.set(pickerSessionId, { level, pendingForNextTurn: isRunning })
        return next
      })
    },
    [pickerSessionId, topMode, workRunning, running],
  )
  // v1.17.2: IDs of sessions that are currently running so the left rail
  // can show a spinner on the active run. Declared here (after all three
  // inputs) to avoid a temporal-dead-zone ReferenceError.
  const runningSessionIds = useMemo(() => {
    const ids = new Set<string>(activeCodeRuns.map((r) => r.conversationId))
    if (workRunning && workSessionId) ids.add(workSessionId)
    return ids
  }, [activeCodeRuns, workRunning, workSessionId])
  // P0 Work 单一发送: 单一发送无 isChat 区分，busy 即 Code 运行中。
  const workBusy = workCodeView.running

  // M4-D: jump-to-conversation from the Activity Center.
  // The callback switches the visible mode to the run's
  // kind and activates the target conversation. The
  // jump target is owned by the workspace; we do NOT
  // switch workspace — that would lose context.
  const onJumpToConversation = useCallback(
    (kind: 'code' | 'work', conversationId: string): void => {
      setTopMode(kind)
      updateHistoryAt(currentWorkspace.root, (history) =>
        selectConversation(history, conversationId),
      )
    },
    [currentWorkspace.root, updateHistoryAt],
  )

  // M4-D: stop a specific Code run via the supervisor.
  // The supervisor targets the run by (projectKey,
  // conversationId) — the same identity the controller
  // uses. No global state, no race with the activity
  // chip's count.
  const onStopCodeConversation = useCallback(
    (projectKey: string, conversationId: string): void => {
      void supervisor.stopConversation(projectKey, conversationId)
    },
    [supervisor],
  )

  // M4-D: list of items rendered in the Activity Center.
  // Code side uses the supervisor (global); Work side
  // uses the current workspace's non-terminal tasks. The
  // host keeps the mapping local — the popover just
  // renders the list.
  const activityItems = useMemo<
    readonly import('./components/activity/BackgroundActivityCenter').ActivityItem[]
  >(() => {
    const out: import('./components/activity/BackgroundActivityCenter').ActivityItem[] = []
    // Code side.
    for (const r of activeCodeRuns) {
      const conv = currentHistory.conversations[r.conversationId]
      if (!conv) continue
      out.push({
        id: `code:${r.runId}`,
        kind: 'code',
        conversationId: r.conversationId,
        workspaceLabel: currentWorkspace.name,
        title: conv.session.title,
        statusLabel:
          r.bindingState === 'spawning'
            ? 'Starting…'
            : r.bindingState === 'ready'
              ? 'Ready'
              : r.bindingState === 'busy'
                ? 'Running'
                : r.bindingState === 'idle'
                  ? 'Idle'
                  : 'Exited',
        startedAt: r.startedAt,
        onStop: () => onStopCodeConversation(r.projectKey, r.conversationId),
        onJump: () => onJumpToConversation('code', r.conversationId),
      })
    }
    return out
  }, [
    activeCodeRuns,
    currentHistory.conversations,
    currentWorkspace.name,
    onStopCodeConversation,
    onJumpToConversation,
  ])

  // active. Code and Work have independent active pointers in the
  // same history file, so switching the top mode never rewrites a
  // conversation's identity.
  useEffect(() => {
    if (histories[currentWorkspaceKey]) return
    const loadingRoots = loadingHistoryRootsRef.current
    if (loadingRoots.has(currentWorkspaceKey)) return
    loadingRoots.add(currentWorkspaceKey)
    let cancelled = false
    void loadWorkspaceHistory(currentWorkspace.root as FilePath)
      .then((loaded) => {
        if (cancelled) return
        const ready = ensureConversation(loaded, topMode, codeMode)
        setHistories((previous) => ({ ...previous, [currentWorkspaceKey]: ready }))
        const activeCodeId = ready.activeByKind.code
        const savedCodeMode = activeCodeId
          ? ready.conversations[activeCodeId]?.session.codeMode
          : undefined
        if (savedCodeMode) setCodeMode(savedCodeMode)
        // P2-1 Work Package B: rehydrate Work attachment metadata —
        // each persisted record is re-validated against its staged
        // file on disk (missing files are dropped by the store).
        for (const record of Object.values(ready.conversations)) {
          if (
            record.session.kind === 'work' &&
            record.attachments &&
            record.attachments.length > 0
          ) {
            void conversationAttachmentStore.restoreWork(
              {
                surface: 'work',
                projectKey: currentWorkspaceKey,
                conversationId: record.session.id,
              },
              currentWorkspace.root,
              record.attachments,
            )
          }
        }
      })
      .catch((historyError) => {
        // eslint-disable-next-line no-console
        console.error('[trylo] failed to hydrate project conversations', historyError)
        if (!cancelled) {
          setHistories((previous) => ({
            ...previous,
            [currentWorkspaceKey]: ensureConversation(emptyWorkspaceHistory(), topMode, codeMode),
          }))
        }
      })
      .finally(() => loadingRoots.delete(currentWorkspaceKey))
    return () => {
      cancelled = true
      loadingRoots.delete(currentWorkspaceKey)
    }
  }, [histories, currentWorkspace.root, currentWorkspaceKey, topMode, codeMode])

  // If the user enters a mode that has never been used in this
  // project, create its first empty chat. Existing Code/Work chats
  // remain untouched and immediately reappear when switching back.
  useEffect(() => {
    if (!historyReady) return
    updateHistoryAt(currentWorkspace.root, (history) =>
      ensureConversation(history, topMode, codeMode),
    )
  }, [historyReady, currentWorkspace.root, topMode, codeMode, updateHistoryAt])

  // M4-C (§7.4): best-effort flush of pending history on abrupt close/crash.
  useEffect(() => {
    registerUnloadHistoryFlush()
  }, [])

  // M4-C1 (P1-2): once workspace/settings/history are ready, prewarm the
  // current Code conversation's idle CLI so the 50.8 MiB bundle cold-start
  // is moved OUT of the first-send critical path. No prompt is written, so
  // no model request and no history. Idempotent: the controller no-ops when
  // a process / prewarm is already live.
  useEffect(() => {
    if (!historyReady || !codeSessionId) return
    void supervisor.prewarmCode(
      currentWorkspaceKey,
      codeSessionId,
      settingsForCodeRun(settings, currentWorkspace.root),
      // §9: warm `code.core.v1` with the caller's own permission level, so
      // adoption is an exact runtime-contract match instead of the old
      // "argv is empty" guess (spec §1.4).
      { surface: 'code', permissionLevel: effectivePermission.level },
    )
  }, [
    historyReady,
    currentWorkspaceKey,
    codeSessionId,
    currentWorkspace.root,
    settings,
    supervisor,
    effectivePermission.level,
  ])

  // §9: warm the current Work conversation's `work.core.v1` runtime. The Work
  // prewarm is a DIFFERENT Profile from Code's, so the two can never adopt
  // each other's process — the fingerprint decides, not the caller. Work
  // warming stays best-effort: a missing sidecar degrades to the legacy path.
  // PR-6: with 电脑控制 enabled the prewarm matches the send contract
  // (`work.computer.v1`); with it off both stay `work.core.v1`.
  useEffect(() => {
    if (!historyReady || !workSessionId || topMode !== 'work') return
    // PR-6: with 电脑控制 enabled the prewarm matches the send contract
    // (`work.computer.v1`); PR-7: 浏览器调试 warms `work.browser-debug.v1`
    // the same way — the prewarm must match the send contract exactly or
    // the fingerprint never adopts it (§9). Priority mirrors the send.
    const profileId = workProfileIdFor(settings.workBrowserDebug, settings.workCad)
    void supervisor.prewarmCode(
      currentWorkspaceKey,
      workSessionId,
      settingsForCodeRun(settings, currentWorkspace.root),
      {
        surface: 'work',
        ...(profileId ? { requestedProfileId: profileId } : {}),
        permissionLevel: effectivePermission.level,
      },
    )
  }, [
    historyReady,
    currentWorkspaceKey,
    workSessionId,
    topMode,
    currentWorkspace.root,
    settings,
    supervisor,
    effectivePermission.level,
  ])

  // M4-C1: start the idle-TTL reaper once and clean it up on unmount. It
  // only ever reclaims IDLE runtimes past their TTL — busy ones are never
  // touched, and navigation does not stop them.
  useEffect(() => {
    const stop = supervisor.startPrewarmReaper()
    return () => stop()
  }, [supervisor])

  // M4-C (P1-4): window blur is a hard stop point for a write-behind save.
  // Force-drain every pending workspace snapshot so blur never loses the
  // trailing write-behind window. Flat-listener (no deps) uses the module's
  // pending registry, so it stays stable across renders.
  useEffect(() => {
    const onBlur = () => {
      void flushAllPendingSaves()
    }
    window.addEventListener('blur', onBlur)
    return () => window.removeEventListener('blur', onBlur)
  }, [])

  useEffect(() => {
    for (const workspace of workspaces) {
      const history = histories[workspaceKey(workspace.root)]
      if (history) scheduleWorkspaceHistorySave(workspace.root as FilePath, history)
    }
  }, [histories, workspaces])

  useEffect(() => {
    const previousIndex = initialWorkspaceIndexRef.current!
    const topModeByWorkspace: Record<string, TopLevelMode> = {
      ...previousIndex.topModeByWorkspace,
      [currentWorkspaceId]: topMode,
    }
    saveWorkspaceIndex({
      version: 1,
      workspaces,
      currentWorkspaceId,
      topModeByWorkspace,
    })
    initialWorkspaceIndexRef.current = {
      version: 1,
      workspaces,
      currentWorkspaceId,
      topModeByWorkspace,
    }
  }, [workspaces, currentWorkspaceId, topMode])

  // v1.16.5: Phase 2.5 收口 — connect to the coworker Control
  // Plane on mount. The client auto-reconnects on close;
  // status + event log surface in WorkDiagnostics. The URL is
  // hardcoded for now; later we'll read it from
  // `workd_status()` (the Tauri command we registered in
  // Phase 1) so Diagnostics can show the same URL the
  // daemon is actually listening on.
  //
  // Phase 2.5b: we hoist the client into a ref so the
  // `onGenerate` handler below can call `client.send()`
  // directly without forcing a state update on every
  // status / event tick.
  //
  // 2026-09-04 (CLI 单核): the per-launch Control Plane token and the
  // auto-spawn useEffect above are retired with the workd daemon.

  // v1.16.5: Phase 2.5b — InputBar's onSend in Work mode
  // calls this. We push the user's prompt into the chat
  // as a `text` user message, then dispatch to the coworker
  // daemon thread. The conversation is the same shape Code
  // uses, so MessageList renders it without any Work-specific
  // component.
  //
  // 2026-08-30 (P0 Work 单一发送): Work 彻底统一为单一发送 — 每条 Work
  // 消息都走 Code supervisor（sendWorkChat / codeMode 'agent'），删除
  // workd/task 分流、intent classifier、以及“任务=cowork”语义。存量 taskId
  // 绑定不再使用。`.trylo/out` 产物由 workProjector（WorkResultProjector）
  // 呈现。
  // 2026-08-30 (routing-fix step 6): Work send idempotency. One entry
  // (last send key + timestamp); see handleWorkSend.
  const workSendIdempotencyRef = useRef<{ key: string; at: number } | null>(null)
  const handleWorkSend = useCallback(
    async (
      text: string,
      opts?: {
        fromSuggestion?: boolean
        suggestionId?: string
        learningDirective?: LearningDirective
      },
    ) => {
      const fromSuggestion = opts?.fromSuggestion === true
      const root = currentWorkspace.root
      const sessionId = workSessionId
      if (!sessionId) return
      // 2026-09-04 (run controls §UI-B, Work): queue-by-default while a task is
      // live. Sending no longer injects immediately; the message waits for the
      // current turn, and "立即打断" dispatches it via the same send path right
      // away. Suggestion accepts still dispatch immediately.
      if (!fromSuggestion && !bypassWorkQueueRef.current && workRunning) {
        const now = Date.now()
        const turnId = `work-${now.toString(36)}`
        const qkey = queueConversationKey(workspaceKey(root), sessionId)
        const q = pendingWorkQueueRef.current.get(qkey) ?? []
        const learningDirective = opts?.learningDirective ?? consumeNextLearningDirective('work')
        q.push({ text, turnId, ...(learningDirective ? { learningDirective } : {}) })
        pendingWorkQueueRef.current.set(qkey, q)
        bumpQueueTick()
        setWorkInput('')
        return
      }
      // P0-A §3.3-5: non-blocking capability notice for THIS turn (set by the
      // gate below, appended right after the optimistic user bubble).
      let gateNotice: string | null = null
      // 2026-08-30 (routing-fix step 6): frontend send idempotency.
      // A 10s window suppresses an EXACT duplicate (same session, same
      // text hash) so a double-click / accidental resend cannot feed the
      // same message twice into the daemon. The window only matches
      // identical text in the same session — a legitimate re-send of the
      // same wording after the window never blocks. Only suggestion sends
      // are exempt (deliberate one-click accepts that must never be
      // silently swallowed).
      const textHash = workTextHash(text)
      const sendKey = `${sessionId}:${textHash}`
      const lastSend = workSendIdempotencyRef.current
      const nowAtSend = Date.now()
      if (
        !fromSuggestion &&
        lastSend &&
        lastSend.key === sendKey &&
        nowAtSend - lastSend.at < 10_000
      ) {
        updateMessagesAt(root, sessionId, (prev) => [
          ...prev,
          {
            id: `work-dup-${Date.now().toString(36)}`,
            kind: 'notice',
            role: 'system',
            createdAt: Date.now(),
            text: '已收到相同消息（10 秒内不重复发送）',
          },
        ])
        return
      }
      workSendIdempotencyRef.current = { key: sendKey, at: nowAtSend }
      // P0-A (audit §3.3-5): the pre-send capability gate. Resolve the SAME
      // Profile the run will use, then:
      //   - a request that explicitly needs a missing capability is BLOCKED
      //     (阻止伪开工) with the install action surfaced (settings opens at
      //     the Work 工具 section);
      //   - otherwise a missing package degrades to a NON-BLOCKING capability
      //    notice (§4.4: 能力声明和真实能力不得脱节);
      //   - a healthy Profile sends unchanged.
      // The resolved runtime is handed to sendWorkChat so the gate and the run
      // can never disagree about what this turn sees.
      const gateSettings = loadSettings()
      const gateProfileId = workProfileIdFor(gateSettings.workBrowserDebug, gateSettings.workCad)
      let gateRuntime: ResolvedToolRuntime | null = null
      try {
        gateRuntime =
          (await toolingFacadeRef.current?.resolveProfile({
            surface: 'work',
            ...(gateProfileId ? { requestedProfileId: gateProfileId } : {}),
            ...(gateSettings.workComputer === false ? { computerUse: false } : {}),
            projectKey: workspaceKey(root),
            projectRoot: root,
            conversationId: sessionId,
            permissionLevel: effectivePermission.level,
          })) ?? null
      } catch {
        gateRuntime = null
      }
      if (gateRuntime) {
        const decision = decideSendCapabilityGate(text, gateRuntime.unavailableCapabilities)
        if (decision.behavior === 'block') {
          updateMessagesAt(root, sessionId, (prev) => [
            ...prev,
            {
              id: `work-cap-${Date.now().toString(36)}`,
              kind: 'notice',
              role: 'system',
              createdAt: Date.now(),
              text: decision.notice,
            },
          ])
          openSettings()
          return
        }
        gateNotice = decision.behavior === 'degrade' ? decision.notice : null
      }
      const learningDirective = opts?.learningDirective ?? consumeNextLearningDirective('work')
      const now = Date.now()
      // The user message id doubles as the run's turnId
      // (spec §2.2): it is KNOWN at send time, persisted
      // with the binding, and never guessed later.
      const turnId = `user-${now.toString(36)}`
      // P2-1 Work Package B: snapshot the Work partition AT SEND TIME.
      // The attachment projection belongs to THIS turn — a later turn
      // takes its own snapshot. Sending never mutates the partition:
      // failed and successful sends both keep the attachments.
      const workAttachmentEntries = conversationAttachmentStore.snapshot({
        surface: 'work',
        projectKey: workspaceKey(root),
        conversationId: sessionId,
      }).workAttachments
      const workAttachmentSnapshot = workAttachmentEntries.map(toWorkDescriptor)
      // v1.16.8: mirror the sent Image/file on the Work bubble too (display-only).
      const workSentAttachments: readonly SentAttachment[] = workAttachmentEntries.map((entry) => ({
        id: entry.id,
        name: entry.name,
        kind: entry.kind,
        ...(entry.size !== undefined ? { size: entry.size } : {}),
        ...(entry.previewUrl !== undefined ? { previewUrl: entry.previewUrl } : {}),
      }))
      // Optimistic push: the user bubble only. "Is the agent
      // working" is run feedback — the MessageList's
      // StreamingIndicator (driven by workRunning) covers it;
      // a "Working on it…" SYSTEM pill here would be the
      // exact noise M3 removes. The shared
      // beginConversationTurn (spec §6.1) stamps
      // `turnStartedAt` so Work's TurnProgress appears the
      // moment the user hits send — matching Code.
      if (fromSuggestion) {
        const sid = opts?.suggestionId
        updateMessagesAt(root, sessionId, (prev) =>
          prev.filter((m) => (sid ? m.id !== sid : m.kind !== 'task_suggestion')),
        )
      } else {
        updateMessagesAt(root, sessionId, (prev) => [
          ...prev,
          beginConversationTurn({ text, now, turnId, attachments: workSentAttachments }),
        ])
        updateHistoryAt(root, (history) => updateConversationDraft(history, sessionId, ''))
      }
      setCognitionSendTick((tick) => tick + 1)
      // P0-A §3.3-5: the non-blocking capability notice lands AFTER the user
      // bubble so the run still starts (§4.4: the agent can chat) while the
      // missing capability is stated in the same turn.
      if (gateNotice) {
        updateMessagesAt(root, sessionId, (prev) => [
          ...prev,
          {
            id: `work-cap-${Date.now().toString(36)}`,
            kind: 'notice',
            role: 'system',
            createdAt: Date.now(),
            text: gateNotice,
          },
        ])
      }
      const startedAt = Date.now()
      try {
        // Always read the latest persisted settings. Code
        // does this on every send; Work must do the same.
        const currentSettings = loadSettings()
        setSettings(currentSettings)
        // 不同对话不同模型: resolve THIS Work conversation's connection so the
        // run spawns with the conversation's chosen model (profile/pool/own).
        const runConnection = resolveRunConnection(
          currentSettings,
          workspaceKey(root),
          sessionId,
          conversationModelsRef.current,
        )
        Object.assign(currentSettings, runConnection)
        const effectiveLearningDirective =
          currentSettings.userLearning.userLearningNoTraceMode === false
            ? undefined
            : learningDirective
        // P0 Work 单一发送: 每条 Work 消息都走 Code supervisor
        // (codeMode 'agent' + Work profile systemPrompt)。
        let workSystemPrompt = buildWorkProfilePrompt(root)
        let skipWork = false
        try {
          const opened = userLearning.openTrace({
            sessionId,
            turnId,
            workspaceRoot: root,
            product: 'work',
            prompt: text,
            codeMode: 'agent',
            ...(effectiveLearningDirective
              ? { learningDirective: effectiveLearningDirective }
              : {}),
          })
          tracesByConversationRef.current.set(
            conversationTraceKey(workspaceKey(root), sessionId),
            opened.id,
          )
          const interaction = prepareLearningInteraction(userLearning, {
            workspaceRoot: root,
            conversationId: sessionId,
            turnId,
            product: 'work',
            prompt: text,
            baseSystemPrompt: workSystemPrompt,
            settings: userLearning.settings(),
            ...(effectiveLearningDirective
              ? { learningDirective: effectiveLearningDirective }
              : {}),
            hasPendingLearningUi: Boolean(
              pendingCognitionByConversation[cognitionViewKey('work', sessionId)] ||
              userLearning.listPendingReceipts('work', sessionId).length > 0 ||
              workMessages.some(
                (item) =>
                  (item.kind === 'learning_impact' || item.kind === 'cognition_prompt') &&
                  item.status === 'pending',
              ),
            ),
          })
          const prepared = interaction.prepared
          const cognitionView = interaction.cognition
            ? pendingCognitionView(interaction.cognition)
            : null
          if (cognitionView) {
            setPendingCognitionByConversation((prev) => ({
              ...prev,
              [cognitionViewKey(cognitionView.product, cognitionView.conversationId)]:
                cognitionView,
            }))
          }
          workSystemPrompt = prepared.systemPrompt || workSystemPrompt
          if (prepared.contract) void persistTeamContract(root, prepared.contract)
          const workContractSummary = prepared.contract
            ? contractSummaryFromContract(prepared.contract)
            : undefined
          const impact = learningImpactMessage(prepared.decision)
          // Foundation spec §0 rule 1 / §8.5: no pending_team card, no
          // Person-conversation team prompt. `spawn_team` only ever arrives
          // from the Team composer's 开始 (startTeamTurn, PR-7).
          if (prepared.start === 'blocked') {
            updateMessagesAt(root, sessionId, (prev) => [
              ...prev,
              {
                id: `team-blocked-${Date.now().toString(36)}`,
                kind: 'notice' as const,
                role: 'system' as const,
                createdAt: Date.now(),
                text: prepared.teamSpawn?.reason ?? '组队请求被拒绝。',
              },
            ])
            skipWork = true
            bumpLearning()
          } else if (
            (prepared.start === 'pending_impact' || prepared.decision.impactCheck?.interruptUser) &&
            impact &&
            prepared.pendingRun
          ) {
            pendingAgentRunRef.current = {
              id: prepared.pendingRun.id,
              product: 'work',
              workspaceRoot: root,
              conversationId: sessionId,
              impactMessageId: impact.id,
              start: (systemPrompt) => {
                void workProjector
                  .onRunStarted({
                    projectKey: workspaceKey(root),
                    projectRoot: root,
                    conversationId: sessionId,
                    runId: turnId,
                    turnId,
                    startedAt: Date.now(),
                  })
                  .catch(() => undefined)
                void sendWorkChat(supervisor, {
                  projectKey: workspaceKey(root),
                  conversationId: sessionId,
                  text: formatWorkMessage({ userText: text, attachments: workAttachmentSnapshot }),
                  settings: settingsForCodeRun(currentSettings, root),
                  systemPrompt,
                  codeMode: 'agent',
                  permissionLevel: effectivePermission.level,
                  priorMessages: workMessages,
                  turnId,
                  requestedProfileId: workProfileIdFor(
                    currentSettings.workBrowserDebug,
                    currentSettings.workCad,
                  ),
                  toolRuntime: gateRuntime,
                  lifecycleObserver: userLearningLifecycle,
                  onEvents: (events) => {
                    sensitiveWindowWatcherRef.current?.(events, sessionId)
                    // §18.3 wrong_window_dispatch_count: pair intent receipts
                    // (tool_use input) with dispatch receipts (trylo-target
                    // facts) into the host-owned counter. Read-only observer.
                    wrongWindowWatcherRef.current?.(events, sessionId)
                    // WCC-P2-01: a server-reported foreground change withdraws
                    // window-scoped leases whose window is no longer foreground
                    // (lease revokeOn: foreground_changed).
                    if (screenConsentRef.current)
                      revokeOnForegroundChange(screenConsentRef.current, events, sessionId)
                    // §11.3 (WCC-P2-04): a server-reported user takeover
                    // escalates this conversation — every desktop call becomes
                    // a forced per-call approval until the TTL expires.
                    if (takeoverEscalationsRef.current)
                      escalateOnTakeover(takeoverEscalationsRef.current, events, sessionId)
                    // WCC-P2-03: provider observe/verify over CDP results
                    // (fire-and-forget — evidence lands in the watcher's
                    // bounded diagnostics buffer; the stream is unaffected).
                    void providerWatcherRef.current?.ingest(events, sessionId)
                    feedTeamEvents(
                      setTeamRun,
                      { workspaceId: root, personConversationId: sessionId },
                      events,
                      { contractSummary: workContractSummary, onClarify: handlePersonClarify },
                    )
                    updateMessagesAt(root, sessionId, (prev) => applyEvents(prev, events))
                  },
                })
              },
            }
            updateMessagesAt(root, sessionId, (prev) =>
              prev.some((item) => item.kind === 'learning_impact' && item.status === 'pending')
                ? prev
                : [...prev, impact],
            )
            skipWork = true
            bumpLearning()
          } else {
            bumpLearning()
          }
        } catch {
          // Fail open: Work still runs without personalization.
        }
        if (skipWork) return
        await workProjector.onRunStarted({
          projectKey: workspaceKey(root),
          projectRoot: root,
          conversationId: sessionId,
          runId: turnId,
          turnId,
          startedAt,
        })
        await sendWorkChat(supervisor, {
          projectKey: workspaceKey(root),
          conversationId: sessionId,
          text: formatWorkMessage({ userText: text, attachments: workAttachmentSnapshot }),
          settings: settingsForCodeRun(currentSettings, root),
          systemPrompt: workSystemPrompt,
          codeMode: 'agent',
          permissionLevel: effectivePermission.level,
          priorMessages: workMessages,
          turnId,
          // PR-6 (§4.1) / PR-7: 电脑控制 and 浏览器调试 are explicit
          // capability switches. The default Work send never asks for an
          // upgraded Profile, so the model cannot see the Windows desktop
          // tools or the Chrome DevTools surface unless the user turned the
          // corresponding switch on (§13 acceptance).
          requestedProfileId: workProfileIdFor(
            currentSettings.workBrowserDebug,
            currentSettings.workCad,
          ),
          // P0-A §3.3-5: the run uses the exact runtime the capability gate
          // resolved (single resolve — the gate and the run cannot disagree).
          toolRuntime: gateRuntime,
          lifecycleObserver: userLearningLifecycle,
          onEvents: (events) => {
            // PR-6 偏差③收口: an elevated/UAC window observed in a tool
            // result withdraws the screen-consent lease BEFORE the batch is
            // projected, so the very next desktop call re-prompts (§6.6).
            sensitiveWindowWatcherRef.current?.(events, sessionId)
            // WCC-P2-01: foreground change revokes window-scoped leases.
            if (screenConsentRef.current)
              revokeOnForegroundChange(screenConsentRef.current, events, sessionId)
            // §11.3 (WCC-P2-04): a server-reported user takeover escalates
            // this conversation to forced per-call approvals.
            if (takeoverEscalationsRef.current)
              escalateOnTakeover(takeoverEscalationsRef.current, events, sessionId)
            // WCC-P2-03: provider observe/verify over CDP results.
            void providerWatcherRef.current?.ingest(events, sessionId)
            feedTeamEvents(
              setTeamRun,
              { workspaceId: root, personConversationId: sessionId },
              events,
              { onClarify: handlePersonClarify },
            )
            updateMessagesAt(root, sessionId, (prev) => applyEvents(prev, events))
          },
        })
        await workProjector.onRunTerminal(
          {
            projectKey: workspaceKey(root),
            projectRoot: root,
            conversationId: sessionId,
            taskId: '',
            runId: turnId,
            turnId,
            startedAt,
          },
          'completed',
        )
      } catch (err) {
        await workProjector.onRunTerminal(
          {
            projectKey: workspaceKey(root),
            projectRoot: root,
            conversationId: sessionId,
            taskId: '',
            runId: turnId,
            turnId,
            startedAt,
          },
          'failed',
        )
        // eslint-disable-next-line no-console
        console.error('[trylo] work send failed', err)
        updateMessagesAt(root, sessionId, (prev) => [
          ...prev,
          {
            id: `err-${now.toString(36)}`,
            kind: 'error',
            role: 'system',
            createdAt: Date.now(),
            userMessage: `发送失败：${err instanceof Error ? err.message : String(err)}`,
            diagnosticId: `work-send-failed:${turnId}`,
          },
        ])
      }
    },
    [
      bumpLearning,
      consumeNextLearningDirective,
      currentWorkspace.root,
      effectivePermission.level,
      workSessionId,
      updateHistoryAt,
      updateMessagesAt,
      userLearning,
      workProjector,
      workMessages,
      openSettings,
      workRunning,
      setWorkInput,
      pendingCognitionByConversation,
    ],
  )

  // Publish the latest Work send for the flush effect (run-controls §UI-B).
  onWorkSendRefForFlush.current = handleWorkSend

  /** Work explicit interrupt: dispatch the oldest queued Work message now,
   *  bypassing the queue-by-default gate (run-controls §UI-B). */
  const interruptWorkQueue = useCallback((): void => {
    const sessionId = workSessionId
    if (!sessionId) return
    const key = queueConversationKey(workspaceKey(currentWorkspace.root), sessionId)
    const queue = pendingWorkQueueRef.current.get(key)
    if (!queue || queue.length === 0) return
    const [first, ...rest] = queue
    if (!first) return
    pendingWorkQueueRef.current.set(key, rest)
    bumpQueueTick()
    bypassWorkQueueRef.current = true
    try {
      void handleWorkSend(first.text, {
        ...(first.learningDirective ? { learningDirective: first.learningDirective } : {}),
      })
    } finally {
      bypassWorkQueueRef.current = false
    }
  }, [currentWorkspace.root, workSessionId, handleWorkSend])

  /** Work flush: when the live task returns to idle, run the oldest queued
   *  message via the normal Work send path (run-controls §UI-B). */
  useEffect(() => {
    if (workRunning || !historyReady) return
    const key = queueConversationKey(currentWorkspaceKey, workSessionId ?? '')
    const queue = pendingWorkQueueRef.current.get(key)
    if (!queue || queue.length === 0) return
    const [first, ...rest] = queue
    if (!first) return
    pendingWorkQueueRef.current.set(key, rest)
    bumpQueueTick()
    onWorkSendRefForFlush.current?.(first.text, {
      ...(first.learningDirective ? { learningDirective: first.learningDirective } : {}),
    })
  }, [workRunning, historyReady, currentWorkspaceKey, workSessionId])
  // the composer's 任务 pill AND the suggestion chip's
  // accept action share this entry. P0 Work 单一发送: asTask 语义
  // 已移除，统一走 handleWorkSend（同一 Code 主路径）。
  //
  // handleWorkSend closes over `workMessages`, so a useCallback dep on it
  // would hand the timeline an unstable `onRunTaskSuggestion` and defeat the
  // memo on every Work Message row for every streaming delta. Read the live
  // send through the same ref the flush effect uses instead.
  const handleRunWorkAsTask = useCallback((text: string, suggestionId?: string): void => {
    const send = onWorkSendRefForFlush.current
    if (!send) return
    if (suggestionId) {
      void send(text, { fromSuggestion: true, suggestionId })
    } else {
      void send(text)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // PR-3 遗留收口 (§6.5/§7.3): the Work-side promote action behind the
  // ToolCard affordance. Conversation scope is bound HERE (the visible Work
  // session + workspace root); the card only proposes the pinned file name
  // it parsed from its own result text. Transport failure resolves as a
  // readable denial — the button state machine renders it inline.
  const handlePromoteRuntimeArtifact = useCallback(
    async (packageId: string, fileName: string): Promise<{ ok: boolean; error?: string }> => {
      const facade = toolingFacadeRef.current
      const conversationId = workSessionId
      if (!facade || !conversationId) return { ok: false, error: '工具服务不可用' }
      try {
        const result = await facade.promoteArtifact({
          projectRoot: currentWorkspace.root,
          conversationId,
          packageId,
          fileName,
        })
        if (result.ok) {
          try {
            const traceId = tracesByConversationRef.current.get(
              conversationTraceKey(workspaceKey(currentWorkspace.root), conversationId),
            )
            if (traceId) {
              userLearningRef.current?.recordEvent(
                traceId,
                eventFromArtifact({
                  action: 'promote',
                  fileName,
                  packageId,
                }),
              )
            }
          } catch {
            /* never block promote */
          }
        }
        return result.ok
          ? { ok: true }
          : { ok: false, error: result.error ?? result.reasonCode ?? '提升失败' }
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) }
      }
    },
    [currentWorkspace.root, workSessionId],
  )

  // P0 Work 单一发送: Work Stop 不再走 workd runtime.cancelTask，
  // 直接停止 Code supervisor 上的 Work 会话运行。
  const handleWorkStop = useCallback(() => {
    if (!workSessionId) return
    try {
      const traceId = tracesByConversationRef.current.get(
        conversationTraceKey(workspaceKey(currentWorkspace.root), workSessionId),
      )
      if (traceId) userLearningRef.current?.recordEvent(traceId, eventFromWorkStop())
    } catch {
      /* never block stop */
    }
    // PR-6 (§13 emergency stop): a stop must leave nothing the model can
    // still consume — the conversation's screen-consent lease is revoked
    // with the run, so a desktop task cannot outlive its Stop button.
    // The CLI process tree kill (taskkill /T /F via the Rust host) takes
    // the MCP server with it (§8.1); the lease revocation guards the
    // warm-reuse window where a new turn could otherwise adopt the
    // still-valid consent.
    screenConsentRef.current?.revokeConversation(workSessionId)
    // P2 (§7): same revocation for the browser-origin leases — an approved
    // Playwright origin must not auto-navigate after Stop (§13 PR-6
    // 语义一致性: stop 撤销该会话全部短期授权).
    browserLeasesRef.current?.revokeConversation(workSessionId)
    // §11.3 (WCC-P2-04): the takeover escalation is per-conversation
    // in-run state like the leases — a stop clears it so the NEXT run in
    // this conversation starts from a clean classification slate (the
    // escalation's job — forcing approvals for the remainder of the
    // interrupted run — is done; a NEW takeover re-records it).
    takeoverEscalationsRef.current?.revokeConversation(workSessionId)
    void supervisor.stopConversation(workspaceKey(currentWorkspace.root), workSessionId)
  }, [supervisor, workSessionId, currentWorkspace.root])

  // 2026-08-30 (P0 Work 单一发送) + 2026-09-04 (CLI 单核): approvals run
  // solely through the supervisor's CodePermissionRegistry — the workd
  // runtime.respondApproval fallback and the managed-work coordinator branch
  // retired with the daemon.
  const handleRespondApproval = useCallback(
    (id: string, approved: boolean): void => {
      try {
        const primaryId = topMode === 'work' ? workSessionId : codeSessionId
        const secondaryId = topMode === 'work' ? codeSessionId : workSessionId
        const primaryKey = conversationTraceKey(currentWorkspaceKey, primaryId ?? '')
        const secondaryKey = conversationTraceKey(currentWorkspaceKey, secondaryId ?? '')
        const traceId =
          tracesByConversationRef.current.get(primaryKey) ??
          tracesByConversationRef.current.get(secondaryKey)
        if (traceId)
          userLearningRef.current?.recordEvent(
            traceId,
            withTeamProvenance(eventFromApproval(approved, id), teamProvenanceRef.current),
          )
      } catch {
        /* never block approval */
      }
      void supervisor.respondCodePermission(id, approved)
    },
    [supervisor, currentWorkspaceKey, codeSessionId, workSessionId, topMode],
  )

  // v1.15.8: the `currentTool` state used to feed the
  // StreamingIndicator / TaskHeader. The indicator is now
  // driven by the shared ConversationRunViewState (spec
  // §5.3/§9.3) and TaskHeader is not wired, so the state is
  // gone — the ToolCard itself shows the running tool.

  // P3: open the right-side diff panel for a pending approval.
  // The id is either a Work approvalId (looked up in the Work
  // message stream) or a Code requestId (looked up in the live
  // CodePermissionRegistry). The handler builds the safe preview
  // and opens the panel. CRITICAL: this never approves the
  // request — the card's Approve button is the only path that
  // does. The spec calls this out explicitly so a confused
  // "open = approve" bug never returns.
  const [approvalDiffState, setApprovalDiffState] = useState<{
    readonly identity: {
      readonly id: string
      readonly path: string
      readonly source: 'code' | 'work'
    }
    readonly diff?: import('./components/code-surface/GitDiffView').GitFileDiffData
    readonly preview?: import('./approval/approval-preview').ApprovalPreview
  } | null>(null)
  const onOpenApprovalPreview = useCallback(
    (id: string): void => {
      // Look up the pending request across both surfaces. The
      // Code path checks the live registry; the Work path
      // walks the merged message list.
      const findCode = supervisor.pendingCodePermissions().find((r) => r.requestId === id)
      if (findCode) {
        void (async () => {
          const preview = await buildApprovalPreview({
            toolName: findCode.toolName,
            input: findCode.input,
            projectRoot: currentWorkspace.root,
            readFile: async (path) => {
              try {
                return await hostAdapter.fs.readFile(path)
              } catch {
                return null
              }
            },
          })
          setApprovalDiffState({
            identity: {
              id: findCode.requestId,
              path: preview.target ?? '(unknown target)',
              source: 'code',
            },
            preview,
            diff: preview.diff
              ? {
                  original: preview.diff.original,
                  modified: preview.diff.modified,
                  binary: false,
                  truncated: preview.diff.truncated,
                }
              : undefined,
          })
        })()
        return
      }
      // Work: scan the current work messages for a pending
      // approval with the matching id. The mapper keeps the
      // pendingRequest-style fields off the persisted record,
      // so the Work preview has to fall back to the basic
      // summary built by the upstream payload. Real Work
      // previews are out of scope for the P3 first cut.
      const findWork = workMessagesRef.current.find((m) => m.kind === 'approval' && m.approvalId === id)
      if (findWork && findWork.kind === 'approval') {
        setApprovalDiffState({
          identity: { id, path: '(work request)', source: 'work' },
          preview: findWork.preview,
        })
      }
    },
    [supervisor, currentWorkspace.root],
  )
  const onCloseApprovalDiff = useCallback((): void => {
    setApprovalDiffState(null)
  }, [])

  // v1.16.0: derive `currentContextTokens` from the
  // most recent TurnMessage's `usage.input_tokens`.
  // events.ts applyTurnEnd creates a TurnMessage on
  // every `turn_end`; we read the tail. 0 means no
  // turn has finished yet (the first send, or before
  // the CLI emits the end event).
  // 2026-09-04: moved into `latestContextTokens` — it now also
  // honors a compaction's `tokensAfter`, so the ring drops the
  // moment the CLI emits `compact` instead of lagging one turn.
  const currentContextTokens = useMemo<number>(() => latestContextTokens(messages), [messages])

  // v1.16.0: the model's context window. Driven by the effective
  // model (pool override || apiModel); defaults to 200k for unknown
  // models (see context-windows.ts). When a conversation carries its own
  // model choice, the effective model resolves from THIS conversation.
  const activeConversationKey = {
    wsKey: currentWorkspaceKey,
    convId: (topMode === 'work' ? workSessionId : codeSessionId) ?? '',
  }
  const activeConversationChoice = getConversationChoice(
    conversationModels,
    activeConversationKey.wsKey,
    activeConversationKey.convId,
  )
  const effectiveModel = activeConversationChoice
    ? effectiveModelForConversation(
        settings,
        activeConversationKey.wsKey,
        activeConversationKey.convId,
        conversationModels,
      )
    : settings.poolModel.trim()
      ? settings.poolModel
      : settings.apiModel
  const contextWindow = useMemo(() => contextWindowFor(effectiveModel), [effectiveModel])

  // v1.16.0: percentage of context used, in [0, 1].
  // The Compact button uses this to decide when to
  // show (>= 0.85 — the "hot" tier) and the auto-
  // trigger watches for >= 0.95 (the "danger" tier).
  const contextPct = useMemo<number>(
    () => (contextWindow > 0 ? currentContextTokens / contextWindow : 0),
    [currentContextTokens, contextWindow],
  )

  // v1.16.0: is a compaction in flight? Derived from
  // the message stream — the latest message is a
  // pending "Compacting…" notice. Resolves to false
  // when the CLI emits the `compact` event and we
  // swap the notice for a CompactionMessage. Keeps
  // the desktop out of the business of tracking its
  // own busy state; the CLI is the source of truth.
  const compacting = useMemo<boolean>(() => {
    const last = messages[messages.length - 1]
    return !!(last && last.kind === 'notice' && last.text.startsWith('Compacting context'))
  }, [messages])

  // The stream-json CLI stays alive between turns so
  // /compact and the next prompt can reuse this handle.

  // v1.16.2.1: the ring itself is the entry point — the
  // user clicks the ring to open a popover with usage
  // + a "Compact now" action. No separate "should the
  // button show" check needed; the ring is always
  // visible and the popover always works (busy shows
  // "Compacting…"). The CLI auto-compacts on its own
  // when its in-process threshold hits — manual
  // compression is the user's escape hatch.

  // v1.16.0: write `/compact` to the active CLI's
  // stdin. The CLI parses it as a slash command, runs
  // compactConversation (LLM summarisation), and emits
  // the `compaction_trigger` + `compact` events. The
  // desktop's reducer renders the result. See
  // trylo-cli/src/commands/compact/compact.ts.
  const onCompact = useCallback((): void => {
    if (!activeProcessId) return
    void sendPromptToProcess(activeProcessId, '/compact')
  }, [activeProcessId])

  const onApplyPlan = useCallback((): void => {
    setCodeMode('agent')
    updateHistoryAt(currentWorkspace.root, (history) =>
      updateConversationCodeMode(history, history.activeByKind.code, 'agent'),
    )
    setText('Implement the plan above.')
  }, [currentWorkspace.root, setText, updateHistoryAt])

  // v1.16.3: edit/resend wiring for the inline-edit
  // pass-through (just routes the values — the actual
  // edit lifecycle lives in the useCallbacks above).

  // P2-1 Work Package B: attachment behavior lives in the partitioned
  // store (attachments/). The only wiring App keeps is the runtime
  // providers the store asks at acquisition time:
  //   - the LIVE identity + workspace root (ownership guard, staging
  //     anchor) — read from the render-fresh ref above;
  //   - the Work persistence hook — metadata lands in conversation
  //     history through the normal updateHistoryAt → write-behind
  //     save path; the store itself never writes history.
  const workspacesRef = useRef(workspaces)
  workspacesRef.current = workspaces
  useEffect(() => {
    conversationAttachmentStore.setRuntimeProviders({
      getLiveIdentity: () => {
        const live = liveIdentityRef.current
        return {
          topMode: live.topMode,
          workspaceKey: live.workspaceKey,
          conversationId: live.conversationId,
        }
      },
      getWorkspaceRoot: () => liveIdentityRef.current.root,
      onWorkAttachmentsChanged: (owner, entries) => {
        const workspace = workspacesRef.current.find(
          (w) => workspaceKey(w.root) === owner.projectKey,
        )
        if (!workspace) return
        updateHistoryAt(workspace.root, (history) =>
          updateConversationAttachments(history, owner.conversationId, entries),
        )
      },
    })
  }, [updateHistoryAt])
  // (P2-1 Work Package B: the ~135-line onAddAttachment picker
  // pipeline, onRemoveAttachment and onDismissFailed callbacks were
  // deleted here — the acquisition pipeline + partition store own
  // that behavior now. See attachments/attachment-acquisition.ts and
  // attachments/conversation-attachment-store.ts.)

  // P2-1 Work Package B (generalized A-Edge ownership): the Tauri
  // drag-drop listener is the ONLY entry point for native file drops.
  // It routes the drop to the conversation the user is looking at AT
  // DROP TIME (read from the render-fresh live-identity ref) and lets
  // the partition store own the rest: the store captures the identity
  // at acquisition start and the shared pipeline re-checks it between
  // every await, so a mid-flight navigation abandons the writes.
  // Both surfaces accept drops — Work goes through staging, Code
  // keeps its legacy direct-path behavior.
  useEffect(() => {
    if (!isTauriFn()) return
    let unlisten: (() => void) | undefined
    void (async () => {
      try {
        const { getCurrentWebview } = await import('@tauri-apps/api/webview')
        const webview = getCurrentWebview()
        const handle = await webview.onDragDropEvent((event) => {
          const payload = event.payload
          if (payload.type === 'drop' && payload.paths.length > 0) {
            const live = liveIdentityRef.current
            if (live.conversationId) {
              void conversationAttachmentStore.acquireByPaths(
                {
                  surface: live.topMode,
                  projectKey: live.workspaceKey,
                  conversationId: live.conversationId,
                },
                payload.paths,
              )
            }
          }
          // 'over' / 'leave' drive the drop overlay in
          // InputBar via a separate small effect — see
          // isDragging state below.
          setIsDragging(payload.type === 'over')
        })
        unlisten = handle
      } catch (err) {
        // eslint-disable-next-line no-console
        console.warn('[trylo] drag-drop hook failed', err)
      }
    })()
    return () => {
      unlisten?.()
    }
    // Bound once on mount; the handler reads the live identity ref so
    // it always sees the freshest owner.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // v1.16.3: drives the drop overlay in InputBar.
  // True when the user is dragging files over the
  // webview; the InputBar shows a "Drop files to
  // attach" highlight while this is true.
  const [isDragging, setIsDragging] = useState(false)

  // v1.16.3: inline-edit of a past user message. The
  // user clicks a user message → Message.tsx swaps that
  // <p> for a <textarea>; on save we (1) truncate
  // everything after the edited message, (2) replace
  // the message text, (3) re-spawn the CLI with the
  // new prompt so the conversation continues from
  // there. The old (now-truncated) messages are
  // discarded.
  const onEditMessage = useCallback(
    (messageId: string): void => {
      const target = messagesRef.current.find((m) => m.id === messageId)
      if (!target || target.role !== 'user' || target.kind !== 'text') return
      setEditingMessageId(messageId)
    },
    // `messages` is read through messagesRef (updated every render) to keep
    // this handler's identity stable — an unstable identity would re-render
    // every memoized Message row on each streaming delta.
    [],
  )
  const onCancelEdit = useCallback((): void => {
    setEditingMessageId(null)
  }, [])
  // v1.16.3.2: signature changed to accept the new text
  // directly. The local textarea mirror in Message.tsx
  // pipes its value in; we don't go through editingDraft
  // (setState is async and the previous closure read the
  // stale value, making Save silently bail).
  //
  // v1.16.4: await the OLD process to fully die before
  // spawning the new one. Without this, the dying CLI's
  // tail events keep arriving through the same onEvents
  // closure, get applied to the same `messages` array,
  // and produce exactly the "model first responds with
  // old content" + "thinking stream runs under the
  // output" symptoms the user reported. The pattern is
  // Cline's checkpoint-restore: cancel → wait for
  // streaming to settle → THEN mutate state + spawn.
  // We use `hostAdapter.process.stop(id)` to actually
  // kill the Rust-side child (Rust returns a result
  // when the child has been SIGKILLed), then poll
  // `activeProcessId` until it's null (loop_end sets
  // it) with a 3s fallback. If the wait times out we
  // still proceed — a stale tail event or two is
  // better than the user being stuck on the edit
  // button forever.
  const onSaveEdit = useCallback(
    async (newTextRaw: string): Promise<void> => {
      if (!editingMessageId || !codeSessionId) return
      const workspaceRootAtEdit = currentWorkspace.root
      const projectKeyAtEdit = workspaceKey(workspaceRootAtEdit)
      const sessionIdAtEdit = codeSessionId
      const latestMessages = messagesRef.current
      const idx = latestMessages.findIndex((m) => m.id === editingMessageId)
      if (idx < 0) return
      const newText = newTextRaw.trim()
      if (!newText) return
      // 0) Stop THIS conversation's run BEFORE truncating so the dying
      //    CLI's generation (bumped by the controller) can't push
      //    events into the array we're about to shrink.
      await supervisor.stopConversation(projectKeyAtEdit, sessionIdAtEdit)
      // 1) Truncate everything after the edited message and replace
      //    its text in place. Stamp a fresh turnStartedAt (per-turn
      //    timer lives on the user bubble).
      const newStartedAt = Date.now()
      updateMessagesAt(workspaceRootAtEdit, sessionIdAtEdit, (prev) => {
        const head = prev.slice(0, idx)
        const edited = prev[idx]!
        return [
          ...head,
          {
            ...edited,
            text: newText,
            frozen: false,
            partial: false,
            turnStartedAt: newStartedAt,
            finalElapsedMs: undefined,
          },
        ]
      })
      setEditingMessageId(null)
      const current = loadSettings()
      setSettings(current)
      // 不同对话不同模型: resolve THIS Code conversation's connection on resend too.
      Object.assign(
        current,
        resolveRunConnection(
          current,
          currentWorkspaceKey,
          codeSessionId,
          conversationModelsRef.current,
        ),
      )
      // 2) Resend through the supervisor. priorMessages is the
      //    truncated history (up to, but not including, the edited
      //    bubble — the bubble itself now carries the new text —
      //    spec §7.1). Because the edit rewrote history, the turn
      //    MUST spawn fresh (no warm reuse of the stopped CLI).
      try {
        // P2: edit-and-resend is a fresh run with the current
        // effective level. The previous level from the original
        // send is irrelevant — the user expects the latest chip
        // value to apply.
        await supervisor.runCode(projectKeyAtEdit, sessionIdAtEdit, {
          prompt: newText,
          settings: settingsForCodeRun(current, workspaceRootAtEdit),
          codeMode: cliCodeMode(codeMode),
          permissionLevel: effectivePermission.level,
          priorMessages: latestMessages.slice(0, idx),
          turnId: `user-${Date.now().toString(36)}`,
          lifecycleObserver: codeLifecycleObserver,
          onEvents: (events) => {
            feedTeamEvents(
              setTeamRun,
              { workspaceId: workspaceRootAtEdit, personConversationId: sessionIdAtEdit },
              events,
              { onClarify: handlePersonClarify },
            )
            updateMessagesAt(workspaceRootAtEdit, sessionIdAtEdit, (prev) =>
              applyEvents(prev, events),
            )
          },
        })
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error('[trylo] onSaveEdit: spawn failed', err)
        const reason = err instanceof Error ? err.message : String(err)
        updateMessagesAt(workspaceRootAtEdit, sessionIdAtEdit, (prev) => [
          ...finalizeLatestTurnTimer(prev),
          {
            id: `code-start-error-${Date.now().toString(36)}`,
            kind: 'notice',
            role: 'system',
            createdAt: Date.now(),
            text: `Code run could not start: ${reason}`,
          },
        ])
      }
    },
    [
      editingMessageId,
      codeLifecycleObserver,
      codeSessionId,
      currentWorkspace.root,
      codeMode,
      effectivePermission.level,
      supervisor,
      updateMessagesAt,
    ],
  )
  // `messages` is intentionally NOT in this dep array
  // — the closure reads it through messagesRef, which
  // is updated on every render. Adding `messages` here
  // would re-create the callback on every event and
  // churn InputBar's memo for no benefit.

  // v1.16.0: auto-trigger at >= 95% (danger tier).
  // The user gets 5 seconds of warning before the
  // desktop fires `/compact` for them. The compaction
  // empties the danger state; if they keep adding turns
  // and hit 95% again, this fires again.
  useEffect(() => {
    if (!activeProcessId) return
    if (compacting) return
    if (contextPct < 0.95) return
    const handle = window.setTimeout(() => {
      void sendPromptToProcess(activeProcessId, '/compact')
    }, 5_000)
    return () => window.clearTimeout(handle)
  }, [activeProcessId, compacting, contextPct])

  // v1.15.8: stop button. v1 just clears UI state — the
  // underlying CLI process keeps running until the Rust
  // process_spawn sees its stdout close (Phase 3: wire
  // process_stop to actually kill the child).
  //
  // v1.16.4: there is no top-level `turnStartedAt` to
  // clear anymore — the per-turn timer lives on the
  // user message and freezes on first output. The
  // stop button just marks the chat as no longer
  // running; any in-flight user message keeps its
  // `finalElapsedMs` (frozen at first output) and is
  // simply no longer the "active" turn.
  const onStop = useCallback((): void => {
    // v1.16.6 (M4-A): scoped to the VISIBLE Code conversation only.
    // Freeze the per-turn timer, then terminate THIS conversation's
    // CLI — every other conversation's run keeps going. Pure
    // navigation no longer routes through this.
    setMessages((prev) => finalizeLatestTurnTimer(prev))
    try {
      const traceId = tracesByConversationRef.current.get(
        conversationTraceKey(currentWorkspaceKey, codeSessionId ?? ''),
      )
      if (traceId)
        userLearningRef.current?.recordEvent(
          traceId,
          withTeamProvenance(eventFromStop(), teamProvenanceRef.current),
        )
    } catch {
      /* never block stop */
    }
    if (codeSessionId) {
      void supervisor.stopConversation(currentWorkspaceKey, codeSessionId)
    }
  }, [supervisor, currentWorkspaceKey, codeSessionId, setMessages])

  // The context follows the current workspace. Recreating
  // on workspace switch is cheap (it's just an object).
  const context = useMemo(
    () => createTryloContext({ workspaceRoot: currentWorkspace.root }),
    [currentWorkspace.root],
  )

  // ── Workspace actions ─────────────────────────────────────
  const onOpenFolder = useCallback(async (): Promise<void> => {
    const result = await pickFolder()
    if (!result.path) return
    // v1.16.6 (M4-A): opening/selecting a folder is navigation —
    // the previous workspace's run keeps going in the background.
    const path = result.path
    setWorkspaces((prev) => {
      const existing = prev.find((workspace) => workspaceKey(workspace.root) === workspaceKey(path))
      if (existing) {
        setCurrentWorkspaceId(existing.id)
        setTopMode(initialWorkspaceIndexRef.current?.topModeByWorkspace[existing.id] ?? 'code')
        return prev
      }
      const newWs: Workspace = {
        id: `ws-${Date.now()}`,
        root: path,
        name: basenameOf(path),
      }
      setCurrentWorkspaceId(newWs.id)
      setTopMode('code')
      return [...prev, newWs]
    })
  }, [])

  const onSwitchWorkspace = useCallback(
    (id: string): void => {
      if (id === currentWorkspaceId) return
      // v1.16.6 (M4-A): switching workspace is navigation — any run
      // in the current project keeps producing in the background.
      // M4-C (P1-4): flush the workspace we're leaving so the
      // write-behind window is not lost on the switch boundary.
      void forceFlushHistory(currentWorkspace.root)
      setCurrentWorkspaceId(id)
      setTopMode(initialWorkspaceIndexRef.current?.topModeByWorkspace[id] ?? 'code')
    },
    [currentWorkspaceId, currentWorkspace.root],
  )

  const onCloseWorkspace = useCallback(
    (id: string): void => {
      // v1.16.6 (P1-2): closing ANY workspace stops its in-flight
      // runs — a closed project's runs must not become orphans
      // projecting to a removed project. Non-current workspaces
      // included (there is no `currentWorkspaceId` guard here).
      const closing = workspaces.find((workspace) => workspace.id === id)
      if (closing) {
        void supervisor.stopWorkspace(workspaceKey(closing.root))
        // P2-1 Work Package B: drop every attachment partition of the
        // closed project (both surfaces) and remove the project-level
        // staging area (idempotent).
        conversationAttachmentStore.purgeProject(workspaceKey(closing.root))
        // C-Edge P2-4: drop every UI preference entry for this project.
        // Without this a closed project's collapse state could re-appear
        // if the same project root is later re-opened.
        resultDockPrefsStore.clearProject(workspaceKey(closing.root))
        void hostAdapter.attachments.removeProjectAttachments(closing.root).catch((err) => {
          // eslint-disable-next-line no-console
          console.warn('[trylo] project attachment staging cleanup failed', err)
        })
      }
      setWorkspaces((prev) => {
        const next = prev.filter((w) => w.id !== id)
        if (next.length === 0) {
          // Don't let the list go empty — keep the default.
          return prev
        }
        if (id === currentWorkspaceId) {
          setCurrentWorkspaceId(next[0]!.id)
          setTopMode(initialWorkspaceIndexRef.current?.topModeByWorkspace[next[0]!.id] ?? 'code')
        }
        return next
      })
    },
    [currentWorkspaceId, workspaces, supervisor],
  )

  // ── Session actions ───────────────────────────────────────
  const onSelectSession = useCallback(
    (id: string): void => {
      const record = currentHistory.conversations[id]
      if (!record) return
      // v1.16.6 (M4-A): selecting a session is navigation — any run
      // in the previously-selected conversation keeps producing in
      // the background and writes back to its own messages.
      // M4-C (P1-4): flush before switching so the write-behind
      // window of the outgoing conversation is not lost.
      void forceFlushHistory(currentWorkspace.root)
      updateHistoryAt(currentWorkspace.root, (history) => selectConversation(history, id))
      setTopMode(record.session.kind)
      if (record.session.kind === 'code' && record.session.codeMode) {
        setCodeMode(record.session.codeMode)
      }
    },
    [currentHistory.conversations, currentWorkspace.root, updateHistoryAt],
  )

  const onNewSession = useCallback((): void => {
    // v1.16.6 (M4-A): creating a new session is navigation — the
    // current run keeps producing in the background.
    updateHistoryAt(
      currentWorkspace.root,
      (history) => createConversation(history, { kind: topMode, codeMode }).history,
    )
    // P2-1 Work Package B: no explicit clear needed — the new
    // conversation has its own (empty) attachment partition.
  }, [topMode, codeMode, currentWorkspace.root, updateHistoryAt])

  const onDeleteSession = useCallback(
    (id: string): void => {
      const record = currentHistory.conversations[id]
      if (!record) return
      // v1.16.6 (P0-1): a delete ends the run REGARDLESS of which
      // conversation/mode is visible. A background run on a deleted
      // session must not become an orphan that keeps projecting to
      // a conversation that no longer exists (spec §11.1). No
      // controller → no-op.
      //
      // The explicit "continue background / stop and close / cancel"
      // confirm flow (§2.6 / §5.4) is registered as M4-D debt — see
      // CODE-WORK-M4A-AUDIT-CORRECTION P1-3.
      supervisor.removeConversation(currentWorkspaceKey, id)
      // P2-1 Work Package B: destroy both surface partitions of the
      // deleted conversation; the Work staging directory is removed
      // through the Rust cleanup (fire-and-forget, idempotent).
      conversationAttachmentStore.clearConversation({
        surface: 'code',
        projectKey: currentWorkspaceKey,
        conversationId: id,
      })
      conversationAttachmentStore.clearConversation({
        surface: 'work',
        projectKey: currentWorkspaceKey,
        conversationId: id,
      })
      // C-Edge P2-4: drop the per-conversation UI preferences for both
      // surfaces — a deleted conversation must not leak collapse state.
      resultDockPrefsStore.clearConversation({
        surface: 'code',
        projectKey: currentWorkspaceKey,
        conversationId: id,
      })
      resultDockPrefsStore.clearConversation({
        surface: 'work',
        projectKey: currentWorkspaceKey,
        conversationId: id,
      })
      // P2-1 C-Core (audit P2-2): the Work projection's finalized data has a
      // bounded lifecycle — conversation deletion is its explicit teardown.
      workProjector.clearConversation(currentWorkspaceKey, id)
      if (record.session.kind === 'work') {
        void hostAdapter.attachments
          .removeConversationAttachments(currentWorkspace.root, id)
          .catch((err) => {
            // eslint-disable-next-line no-console
            console.warn('[trylo] work attachment staging cleanup failed', err)
          })
      }
      updateHistoryAt(currentWorkspace.root, (history) => deleteConversation(history, id))
    },
    [
      currentHistory.conversations,
      currentWorkspace.root,
      currentWorkspaceKey,
      supervisor,
      updateHistoryAt,
      workProjector,
    ],
  )

  // v1.16.7: rename / archive / unarchive a session from the rail. These are
  // lightweight history mutations (the run itself is untouched) — mirror the
  // existing select/delete wiring so the persistence layer stays authoritative.
  const onRenameSession = useCallback(
    (id: string, title: string): void => {
      updateHistoryAt(currentWorkspace.root, (history) => renameConversation(history, id, title))
    },
    [currentWorkspace.root, updateHistoryAt],
  )

  const onArchiveSession = useCallback(
    (id: string): void => {
      // Archiving the active session nulls its active pointer (see
      // archiveConversation); ensure a fresh active conversation is selected
      // so the user is never left on an invisible session.
      updateHistoryAt(currentWorkspace.root, (history) => {
        const next = archiveConversation(history, id)
        if (next.activeByKind[history.conversations[id]?.session.kind ?? 'code'] === null) {
          return ensureConversation(
            next,
            history.conversations[id]?.session.kind ?? 'code',
            'agent',
          )
        }
        return next
      })
    },
    [currentWorkspace.root, updateHistoryAt],
  )

  const onUnarchiveSession = useCallback(
    (id: string): void => {
      updateHistoryAt(currentWorkspace.root, (history) => unarchiveConversation(history, id))
    },
    [currentWorkspace.root, updateHistoryAt],
  )

  // ── Mode toggles ──────────────────────────────────────────
  const onTopModeChange = useCallback(
    (m: TopLevelMode): void => {
      if (m === topMode) return
      // v1.16.6 (M4-A) — THE headline fix: switching Code/Work is
      // pure navigation. It does NOT stop the Code run. Background
      // Code keeps producing and writes back to its own conversation.
      // M4-C (P1-4): flush before the mode flip loses the window.
      void forceFlushHistory(currentWorkspace.root)
      setTopMode(m)
    },
    [topMode, currentWorkspace.root],
  )

  const onCodeModeChange = useCallback(
    (m: CodeMode): void => {
      if (m === 'cognition') {
        const snap = userLearning.snapshot()
        const existing = snap.cognitionSessions.find(
          (s) => s.status === 'open' && s.trigger !== 'team_clarification',
        )
        const sessionId = existing
          ? existing.id
          : userLearning.startCognitionConversation(currentWorkspace.root).id
        setCognitionSessionId(sessionId)
        setCognitionViewOpen(true)
        setLearningPanelOpen(false)
        bumpLearning()
        return
      }
      // v1.16.6 (M4-A): switching Chat/Plan/Agent is navigation —
      // do NOT stop the run. Whether the idle CLI is restarted for
      // the new permission mode is the controller's call (we keep
      // the running process; the mode applies to the next spawn).
      setCodeMode(m)
      updateHistoryAt(currentWorkspace.root, (history) =>
        updateConversationCodeMode(history, history.activeByKind.code, m),
      )
    },
    [bumpLearning, currentWorkspace.root, updateHistoryAt, userLearning],
  )

  const patchLearningCard = useCallback(
    (
      id: string,
      patch: (message: ChatMessage) => ChatMessage,
      extra: readonly ChatMessage[] = [],
    ): void => {
      const apply = (sessionId: string | null): void => {
        updateMessagesAt(currentWorkspace.root, sessionId, (prev) => {
          if (!prev.some((message) => message.id === id)) return prev
          return [
            ...prev.map((message) => (message.id === id ? patch(message) : message)),
            ...extra,
          ]
        })
      }
      apply(codeSessionId)
      apply(workSessionId)
    },
    [codeSessionId, currentWorkspace.root, updateMessagesAt, workSessionId],
  )

  const handleCognitionAnswer = useCallback(
    (id: string, text: string) => {
      // Message lookups go through the refs (see messagesRef above) so this
      // handler stays identity-stable across streaming deltas.
      const card = [...messagesRef.current, ...workMessagesRef.current].find(
        (message) => message.id === id && message.kind === 'cognition_prompt',
      )
      if (!card || card.kind !== 'cognition_prompt' || card.status !== 'pending') return
      const resolution = userLearning.answerCognition(card.sessionId, text)
      const extras: ChatMessage[] = [
        {
          id: `cog-ack-${Date.now().toString(36)}`,
          role: 'assistant',
          kind: 'text',
          createdAt: Date.now(),
          text: '记下了。',
        },
      ]
      if (resolution.followUp === 'confirm_scope') {
        const live = userLearning.snapshot().cognitionSessions.find((s) => s.id === card.sessionId)
        if (live) extras.push(cognitionPromptMessage(live))
      }
      patchLearningCard(
        id,
        (message) =>
          message.kind === 'cognition_prompt' ? { ...message, status: 'answered' } : message,
        extras,
      )
      bumpLearning()
    },
    [bumpLearning, patchLearningCard, userLearning],
  )

  const handleCognitionDismiss = useCallback(
    (id: string, kind: 'dismiss' | 'not_now' | 'snooze' | 'dont_ask_similar') => {
      const card = [...messagesRef.current, ...workMessagesRef.current].find(
        (message) => message.id === id && message.kind === 'cognition_prompt',
      )
      if (!card || card.kind !== 'cognition_prompt' || card.status !== 'pending') return
      userLearning.dismissCognition(card.sessionId, kind)
      patchLearningCard(id, (message) =>
        message.kind === 'cognition_prompt' ? { ...message, status: 'dismissed' } : message,
      )
      bumpLearning()
    },
    [bumpLearning, patchLearningCard, userLearning],
  )

  // Foundation spec §0 rule 1 / §8.5: `handleTeamSpawnResolve` and the
  // pending-team card it resumed are deleted. confirmedSpawn enters only
  // through the Team composer's 开始 (startTeamTurn, PR-7).

  const handleLearningImpactResolve = useCallback(
    (id: string, acceptPersonalization: boolean) => {
      const card = [...messagesRef.current, ...workMessagesRef.current].find(
        (message) => message.id === id && message.kind === 'learning_impact',
      )
      if (!card || card.kind !== 'learning_impact' || card.status !== 'pending') return
      const pending = pendingAgentRunRef.current
      if (!pending || pending.impactMessageId !== id) return
      pendingAgentRunRef.current = null
      userLearning.recordImpactResolution({
        workspaceRoot: pending.workspaceRoot,
        product: pending.product,
        acceptPersonalization,
        reason: card.reason,
      })
      const resumed = userLearning.resumePendingRun(
        pending.id,
        acceptPersonalization ? 'personalization' : 'baseline',
      )
      if (resumed.started === 1) pending.start(resumed.systemPrompt)
      const ack: ChatMessage = {
        id: `impact-ack-${Date.now().toString(36)}`,
        role: 'assistant',
        kind: 'text',
        createdAt: Date.now(),
        text: acceptPersonalization
          ? '记下了：这次按你的偏好走，安全与数据完整性底线仍优先。'
          : '记下了：这次保留工程基线，减少审核不等于取消最终验证。',
      }
      patchLearningCard(
        id,
        (message) =>
          message.kind === 'learning_impact'
            ? { ...message, status: acceptPersonalization ? 'accepted' : 'kept_baseline' }
            : message,
        [ack],
      )
      bumpLearning()
    },
    [bumpLearning, patchLearningCard, userLearning],
  )

  const removePendingCognitionView = useCallback((view: PendingCognitionView): void => {
    const key = cognitionViewKey(view.product, view.conversationId)
    setPendingCognitionByConversation((prev) => {
      if (!prev[key]) return prev
      const next = { ...prev }
      delete next[key]
      return next
    })
  }, [])

  const refreshPendingCognitionView = useCallback(
    (sessionId: string): void => {
      const session = userLearning
        .snapshot()
        .cognitionSessions.find((item) => item.id === sessionId)
      if (!session) return
      const view = pendingCognitionView(session)
      if (!view) return
      setPendingCognitionByConversation((prev) => ({
        ...prev,
        [cognitionViewKey(view.product, view.conversationId)]: view,
      }))
    },
    [userLearning],
  )

  const handleBadgeCognitionAnswer = useCallback(
    (view: PendingCognitionView, text: string): void => {
      const session = userLearning
        .snapshot()
        .cognitionSessions.find((item) => item.id === view.sessionId)
      if (!session || session.status !== 'open') {
        removePendingCognitionView(view)
        return
      }
      const resolution = session.pendingConfirmScope
        ? userLearning.confirmCognitionScope(session.id, !/^(不|否|no\b)/i.test(text.trim()))
        : userLearning.answerCognition(session.id, text)
      if (resolution.followUp === 'done') removePendingCognitionView(view)
      else refreshPendingCognitionView(session.id)
      bumpLearning()
    },
    [bumpLearning, refreshPendingCognitionView, removePendingCognitionView, userLearning],
  )

  const handleBadgeCognitionDismiss = useCallback(
    (
      view: PendingCognitionView,
      kind: Extract<CognitionDismissKind, 'not_now' | 'snooze' | 'dont_ask_similar'>,
    ): void => {
      userLearning.dismissCognition(view.sessionId, kind)
      removePendingCognitionView(view)
      bumpLearning()
    },
    [bumpLearning, removePendingCognitionView, userLearning],
  )

  // The persisted CognitionSession is authoritative. The map is only the
  // active conversation's lightweight badge projection, restored on switch.
  useEffect(() => {
    userLearning.sweepIgnoredAsks()
    const product: ProductSurface = topMode === 'work' ? 'work' : 'code'
    const conversationId = product === 'work' ? workSessionId : codeSessionId
    if (!conversationId) return
    const session = [...userLearning.snapshot().cognitionSessions]
      .reverse()
      .find(
        (item) =>
          item.status === 'open' &&
          item.conversationId === conversationId &&
          (item.product ?? 'code') === product &&
          item.trigger !== 'team_clarification' &&
          item.trigger !== 'user_opened',
      )
    const key = cognitionViewKey(product, conversationId)
    const view = session ? pendingCognitionView(session) : null
    setPendingCognitionByConversation((prev) => {
      if (view) return { ...prev, [key]: view }
      if (!prev[key]) return prev
      const next = { ...prev }
      delete next[key]
      return next
    })
  }, [codeSessionId, topMode, userLearning, workSessionId])

  const activeCognitionProduct: ProductSurface = topMode === 'work' ? 'work' : 'code'
  const activeCognitionConversationId =
    activeCognitionProduct === 'work' ? workSessionId : codeSessionId
  const activePendingCognition = activeCognitionConversationId
    ? pendingCognitionByConversation[
        cognitionViewKey(activeCognitionProduct, activeCognitionConversationId)
      ]
    : undefined
  const activeLearningReceipt = activeCognitionConversationId
    ? userLearning.listPendingReceipts(activeCognitionProduct, activeCognitionConversationId)[0]
    : undefined
  const activeReceiptCommitment = activeLearningReceipt
    ? userLearning
        .snapshot()
        .behaviorCommitments.find((item) => item.id === activeLearningReceipt.commitmentId)
    : undefined

  // ── User Cognition standalone session (fifth mode) ───────────────
  // Opening the cognition view swaps the Person main column to the
  // CognitionSurface. It does NOT touch CodeMode / messages / history:
  // the learning runtime holds the CognitionSession.
  const openCognitionView = useCallback(
    (_question?: CognitionQuestion) => {
      const snap = userLearning.snapshot()
      const existing = snap.cognitionSessions.find(
        (s) => s.status === 'open' && s.trigger !== 'team_clarification',
      )
      const sessionId = existing
        ? existing.id
        : userLearning.startCognitionConversation(currentWorkspace.root).id
      setCognitionSessionId(sessionId)
      setCognitionViewOpen(true)
      setLearningPanelOpen(false)
      bumpLearning()
    },
    [bumpLearning, currentWorkspace.root, userLearning],
  )

  const [cognitionBusy, setCognitionBusy] = useState(false)
  const handleCognitionSurfaceSend = useCallback(
    (text: string) => {
      setCognitionBusy(true)
      void userLearning
        .handleCognitionTurn(text, currentWorkspace.root)
        .then(() => {
          bumpLearning()
        })
        .finally(() => setCognitionBusy(false))
    },
    [bumpLearning, currentWorkspace.root, userLearning],
  )

  const handleCognitionSurfaceStop = useCallback(
    (kind: 'dismiss' | 'snooze' | 'dont_ask_similar') => {
      if (!cognitionSessionId) return
      userLearning.dismissCognition(cognitionSessionId, kind)
      setCognitionViewOpen(false)
      bumpLearning()
    },
    [bumpLearning, cognitionSessionId, userLearning],
  )

  const handleCognitionSurfaceOpenSession = useCallback((sessionId: string) => {
    setCognitionSessionId(sessionId)
    setCognitionViewOpen(true)
  }, [])

  // PR-12 (spec §11.2): Person `User questions` bubble into the existing
  // Cognition UI — the seat never talks to the user. blocking v0: a seat
  // question always gates the next writable spawn.
  const handlePersonClarify = useCallback(
    (payload: {
      readonly personConversationId: string
      readonly questions: readonly string[]
      readonly unknown: readonly string[]
    }) => {
      if (payload.questions.length === 0) return
      const session = userLearning.enqueueTeamClarification({
        kind: 'team_clarification',
        teamRunId: `team-${payload.personConversationId}`,
        questions: payload.questions,
        unknownItems: payload.unknown,
        blocking: true,
        risk: 'medium',
      })
      if (!session) return
      const source = topMode === 'work' ? workSessionId : codeSessionId
      if (!source) return
      updateMessagesAt(currentWorkspace.root, source, (prev) =>
        prev.some(
          (item) =>
            item.kind === 'cognition_prompt' &&
            item.sessionId === session.id &&
            item.status === 'pending',
        )
          ? prev
          : [...prev, cognitionPromptMessage(session)],
      )
    },
    [codeSessionId, currentWorkspace.root, topMode, updateMessagesAt, userLearning, workSessionId],
  )

  // ── Team composer launch (Foundation spec PR-7 / §7.6.2) ────────
  const lastPersonUserPrompt = useMemo(() => {
    const source = topMode === 'work' ? workMessages : messages
    for (let i = source.length - 1; i >= 0; i -= 1) {
      const m = source[i]!
      if (m.kind === 'text' && m.role === 'user') return m.text
    }
    return ''
  }, [topMode, messages, workMessages])
  const canSuggestTeam = lastPersonUserPrompt.trim().length > 0

  // PR-8: the opt-in 「让 Person 建议一组」 fills the composer draft from
  // the SAME signal mapping the scorer reads — never spawns, never cards.
  const handleSuggestTeamDraft = useCallback(() => {
    if (!canSuggestTeam) return
    const templateId = mapSignalsToTemplate({
      prompt: lastPersonUserPrompt,
      product: topMode,
    })
    const profile = builtinTeamTemplates.find((t) => t.id === templateId) ?? builtinTeamTemplates[0]
    if (!profile) return
    seedComposerDraft(profile, lastPersonUserPrompt)
  }, [builtinTeamTemplates, canSuggestTeam, lastPersonUserPrompt, topMode])

  const handleComposeTeamFromPerson = useCallback(() => {
    handleSuggestTeamDraft()
    setCollaborationSurface('team')
  }, [handleSuggestTeamDraft])

  const personTeamStatusBarNode = useMemo(() => {
    if (
      teamRunForCurrentSession &&
      isTeamRunActive(teamRunForCurrentSession) &&
      summarizeTeam(teamRunForCurrentSession).total > 0
    ) {
      return (
        <PersonTeamStatusBar
          run={teamRunForCurrentSession}
          onOpenTeam={handlePersonTeamStatusBarOpen}
        />
      )
    }
    if (teamComposerLive && canSuggestTeam && collaborationSurface === 'person') {
      return <PersonTeamComposeHint onCompose={handleComposeTeamFromPerson} />
    }
    return undefined
  }, [
    teamRunForCurrentSession,
    handlePersonTeamStatusBarOpen,
    teamComposerLive,
    canSuggestTeam,
    collaborationSurface,
    handleComposeTeamFromPerson,
  ])

  const handleStartTeam = useCallback(
    (goal: string): Promise<void> => {
      const draft = getComposerDraft()
      const sessionId = currentActiveSession?.id ?? null
      const root = currentWorkspace.root
      if (!draft || !sessionId) return Promise.resolve()
      return (async () => {
        const result = await startTeamTurn({
          workspaceRoot: root,
          conversationId: sessionId,
          product: topMode,
          goal,
          profile: buildProfileFromDraft(draft, Date.now()),
          composerLive: teamComposerLive,
          preparePrompt: (input) => userLearning.preparePrompt(input),
          isPersonTurnRunning: topMode === 'work' ? workRunning : running,
          writeFile: (path, body) => hostAdapter.fs.writeFile(path, body),
        })
        if (!result.ok) {
          setComposerLaunchError(result.message)
          updateMessagesAt(root, sessionId, (prev) => [
            ...prev,
            {
              id: `team-launch-${Date.now().toString(36)}`,
              kind: 'notice' as const,
              role: 'system' as const,
              createdAt: Date.now(),
              text: result.message,
            },
          ])
          return
        }
        clearDismissedTeamRun()
        setTeamRun({
          ...result.run,
          workspaceId: currentWorkspace.id,
          selectedSeatId: null,
        } as unknown as TeamRun)
        clearComposerDraft()
        // Duplicate-bubble guard: skip the user bubble when the goal already
        // is the latest user message (§7.6.2 step 8).
        const source = topMode === 'work' ? workMessages : messages
        const lastUserText = [...source].reverse().find(isUserMessage)
        if (lastUserText?.text !== result.goal) {
          updateMessagesAt(root, sessionId, (prev) => [
            ...prev,
            {
              id: `team-goal-${Date.now().toString(36)}`,
              kind: 'text' as const,
              role: 'user' as const,
              createdAt: Date.now(),
              text: result.goal,
              turnId: `turn-${Date.now().toString(36)}`,
            },
          ])
        }
        const onEvents = (events: readonly LoopEvent[]): void => {
          feedTeamEvents(
            setTeamRun,
            { workspaceId: root, personConversationId: sessionId },
            events,
            { onClarify: handlePersonClarify },
          )
          updateMessagesAt(root, sessionId, (prev) => applyEvents(prev, events))
        }
        const sendTurnId = `turn-${Date.now().toString(36)}`
        if (result.product === 'code') {
          // Code dispatch: teamMode flips TRYLO_TEAM_MODE (code-run-controller).
          void supervisor
            .runCode(currentWorkspaceKey, sessionId, {
              prompt: result.goal,
              settings: settingsForCodeRun(
                { ...loadSettings(), systemPrompt: result.systemPrompt },
                root,
              ),
              codeMode: 'agent',
              permissionLevel: effectivePermission.level,
              priorMessages: messages,
              turnId: sendTurnId,
              teamMode: true,
              lifecycleObserver: codeLifecycleObserver,
              onEvents,
            })
            .catch((err) => {
              const reason = err instanceof Error ? err.message : String(err)
              updateMessagesAt(root, sessionId, (prev) => [
                ...prev,
                {
                  id: `code-start-error-${Date.now().toString(36)}`,
                  kind: 'notice' as const,
                  role: 'system' as const,
                  createdAt: Date.now(),
                  text: `Code run could not start: ${reason}`,
                },
              ])
            })
        } else {
          // Work dispatch: no TRYLO_TEAM_MODE (Work profile spawnEnv covers it).
          void sendWorkChat(supervisor, {
            projectKey: currentWorkspaceKey,
            conversationId: sessionId,
            text: result.goal,
            settings: settingsForCodeRun(loadSettings(), root),
            systemPrompt: result.systemPrompt,
            codeMode: 'agent',
            permissionLevel: effectivePermission.level,
            priorMessages: workMessages,
            turnId: sendTurnId,
            requestedProfileId: workProfileIdFor(
              loadSettings().workBrowserDebug,
              loadSettings().workCad,
            ),
            ...(loadSettings().workComputer === false ? { computerUse: false } : {}),
            toolRuntime: null,
            lifecycleObserver: userLearningLifecycle,
            onEvents,
          })
        }
        setCollaborationSurface('team')
      })()
    },
    [
      builtinTeamTemplates,
      codeLifecycleObserver,
      updateMessagesAt,
      currentActiveSession,
      currentWorkspace.root,
      currentWorkspace.id,
      currentWorkspaceKey,
      effectivePermission.level,
      handlePersonClarify,
      messages,
      running,
      supervisor,
      teamComposerLive,
      topMode,
      userLearning,
      userLearningLifecycle,
      workMessages,
      workRunning,
    ],
  )

  const handleCognitionSurfaceBack = useCallback(() => {
    setCognitionViewOpen(false)
  }, [])

  const cognitionSession = useMemo(() => {
    if (!cognitionSessionId) return null
    return (
      userLearning.snapshot().cognitionSessions.find((s) => s.id === cognitionSessionId) ?? null
    )
  }, [cognitionSessionId, learningTick, userLearning])

  const onToggleLeftRail = useCallback((): void => {
    setLeftRailCollapsed((v) => !v)
  }, [])

  const onToggleRightRail = useCallback((): void => {
    setRightRailOpen((v) => !v)
  }, [])

  // ── File peek (base capability: shared by Code AND Work) ──
  // Text-likes are read as UTF-8 and rendered by PreviewRouter
  // (markdown / html / csv / dxf / gerber / text). Byte-backed kinds
  // skip the text read — decoding binary as UTF-8 garbles the rail —
  // and each component loads bytes itself.
  const onSelectFile = useCallback(async (path: string, kind: 'file' | 'dir'): Promise<void> => {
    if (kind === 'dir') return
    if (previewKindNeedsBytes(previewKindFor(path))) {
      setPeekFile({ path, content: '' })
      return
    }
    try {
      const content = await hostAdapter.fs.readFile(path)
      setPeekFile({ path, content })
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      setPeekFile({ path, content: `Error reading ${path}\n\n${msg}` })
    }
  }, [])

  const onClosePeek = useCallback((): void => {
    setPeekFile(null)
  }, [])

  // P2-1 (spec §9.6): an explicit Git-diff right-pane distinct from a plain
  // file peek. Diff bodies are resolved via the HostAdapter (never invoke).
  //
  // P2-1 C-Core (audit P2-1): the async request identity lives in a small
  // dedicated tracker — path-only comparison let a stale response overwrite
  // the panel after a workspace/session switch or a newer diff request.
  const diffTrackerRef = useRef<DiffRequestTracker | null>(null)
  if (!diffTrackerRef.current) diffTrackerRef.current = new DiffRequestTracker()
  const diffTracker = diffTrackerRef.current
  const [gitDiffState, setGitDiffState] = useState<{
    identity: DiffRequestIdentity
    diff?: import('./components/code-surface/GitDiffView').GitFileDiffData
    error?: string
  } | null>(null)
  const onOpenDiff = useCallback(
    (path: string, oldPath?: string): void => {
      setPeekFile(null)
      // Mint a NEW full identity (requestId + root + session + path + oldPath).
      // A newer diff implicitly invalidates every older in-flight request.
      const identity = diffTracker.begin(currentWorkspace.root, codeSessionId ?? '', path, oldPath)
      setGitDiffState({ identity })
      void hostAdapter.git
        .fileDiff(currentWorkspace.root, path, oldPath)
        .then((d) => {
          // Stale guard: only the exact identity still owning the panel may
          // land. Anything else (switched workspace/session, superseded by a
          // newer diff, different rename origin) is dropped silently.
          if (!diffTracker.isCurrent(identity)) return
          setGitDiffState({
            identity,
            diff: {
              original: d.original,
              modified: d.modified,
              binary: d.binary,
              truncated: d.truncated,
            },
          })
        })
        .catch(() => {
          if (!diffTracker.isCurrent(identity)) return
          setGitDiffState({ identity, error: 'Could not load the Git diff for this change.' })
        })
    },
    [currentWorkspace.root, codeSessionId, diffTracker],
  )
  // C-Core: workspace switch / session switch invalidate every in-flight
  // diff request and clear the panel — a stale response can never land in
  // another project's or conversation's surface.
  useEffect(() => {
    diffTracker.invalidate()
    setGitDiffState(null)
  }, [currentWorkspaceId, codeSessionId, diffTracker])
  const onOpenResultFile = useCallback(
    (relPath: string): void => {
      const abs = repoAbsPath(currentWorkspace.root, relPath)
      if (!abs) return
      void onSelectFile(abs, 'file')
    },
    [currentWorkspace.root, onSelectFile],
  )
  const onCloseGitDiff = useCallback((): void => {
    diffTracker.invalidate()
    setGitDiffState(null)
  }, [diffTracker])

  // ── Send ──────────────────────────────────────────────────
  const onSend = useCallback(
    (message: string, queuedLearningDirective?: LearningDirective): void => {
      // Issue-1 diagnosability: if we bail before even adding the user bubble,
      // the composer looks dead — surface WHY every time.
      if (!historyReady || !codeSessionId) {
        // eslint-disable-next-line no-console
        console.warn(
          '[trylo] onSend: blocked — historyReady=%s codeSessionId=%s',
          historyReady,
          codeSessionId,
        )
        return
      }
      // 2026-09-03 (run controls §UI-B): DEFAULT QUEUE. Sending while a turn
      // is live does NOT inject into the running CLI (the old steerCode). It
      // queues the message behind the current turn — a "pended" pill appears —
      // and runs automatically when the turn returns to idle. The explicit
      // "立即打断" affordance on that pill steers immediately instead.
      if (running && activeProcessId) {
        if (!isTauriFn()) return
        const now = Date.now()
        const projectKeyAtSend = workspaceKey(currentWorkspace.root)
        const sessionIdAtSend = codeSessionId
        const turnId = `user-${now.toString(36)}`
        setText('')
        const key = queueConversationKey(projectKeyAtSend, sessionIdAtSend)
        const queue = pendingCodeQueueRef.current.get(key) ?? []
        const learningDirective = queuedLearningDirective ?? consumeNextLearningDirective('code')
        queue.push({ text: message, turnId, ...(learningDirective ? { learningDirective } : {}) })
        pendingCodeQueueRef.current.set(key, queue)
        bumpQueueTick()
        return
      }
      // v1.15.8: prevent double-fire. UI gates this too via the
      // `disabled` attribute, but Enter-key repeat can still submit
      // form onSubmit — this guard is the authoritative one.
      if (sendingDisabled) {
        // eslint-disable-next-line no-console
        console.warn('[trylo] onSend: already running, ignoring')
        return
      }
      // eslint-disable-next-line no-console
      if (RUN_TELEMETRY_DEBUG) console.log('[trylo] onSend start, message=', message)
      if (codeMode === 'cognition') {
        openCognitionView()
        void userLearning
          .handleCognitionTurn(message, currentWorkspace.root)
          .then(() => bumpLearning())
        setText('')
        return
      }
      if (!isTauriFn()) {
        // eslint-disable-next-line no-console
        console.warn('[trylo] onSend: not in Tauri, bailing')
        return
      }
      const learningDirective = queuedLearningDirective ?? consumeNextLearningDirective('code')
      setText('')
      const current = loadSettings()
      setSettings(current)
      // 不同对话不同模型: resolve THIS Code conversation's connection so the
      // run spawns with the conversation's chosen model (profile/pool/own).
      Object.assign(
        current,
        resolveRunConnection(
          current,
          currentWorkspaceKey,
          codeSessionId,
          conversationModelsRef.current,
        ),
      )
      const effectiveLearningDirective =
        current.userLearning.userLearningNoTraceMode === false ? undefined : learningDirective
      if (RUN_TELEMETRY_DEBUG) {
        // eslint-disable-next-line no-console
        console.log('[trylo] onSend: settings loaded', {
          apiHost: current.apiHost,
          apiKeySet: Boolean(current.apiKey),
          apiModel: current.apiModel,
          cliPath: current.cliPath,
        })
      }
      // Capture the ORIGINAL conversation so the run writes back to
      // it even if the user navigates away mid-run (background
      // write-back, spec §2.2). v1.16.4 keeps the per-turn timer on
      // the user bubble itself.
      const sendStartedAt = Date.now()
      const priorMessagesAtSend = messagesRef.current
      const workspaceRootAtSend = currentWorkspace.root
      const projectKeyAtSend = workspaceKey(workspaceRootAtSend)
      const sessionIdAtSend = codeSessionId
      // M4-C5 (P1-3): one RunTelemetry per Code turn. Marks are placed
      // at the boundaries App can actually observe; slices that need
      // controller/Rust internals (childCreated → cliSessionReady) stay
      // undefined until those are instrumented. cold/warm starts here.
      const telemetry = new RunTelemetry({
        mode: 'code',
        projectKey: projectKeyAtSend,
        conversationId: sessionIdAtSend,
        model: current.apiModel,
        provider: current.apiFormat,
        historyMessageCount: priorMessagesAtSend.length,
      })
      telemetry.mark('sendClickAt', sendStartedAt)
      const attachmentViews = conversationAttachmentStore.snapshot({
        surface: 'code',
        projectKey: projectKeyAtSend,
        conversationId: sessionIdAtSend,
      }).attachments
      const attachmentCtx = buildAttachmentPromptContext(attachmentViews)
      const cliPrompt = attachmentCtx ? `${attachmentCtx}\n\n${message}` : message
      // v1.16.8: show what the user actually sent (image thumbnail / file
      // chip) on the sent bubble. Display-only — the CLI still gets the
      // prompt-context path block above.
      const sentAttachments: readonly SentAttachment[] = attachmentViews.map((a) => ({
        id: a.id,
        name: a.name,
        kind: a.kind,
        ...(a.size !== undefined ? { size: a.size } : {}),
        ...(a.previewUrl !== undefined ? { previewUrl: a.previewUrl } : {}),
      }))
      // P2-1 (spec §7.2): the user message id is BOTH the originating turn's
      // id and the result scope's turnId — known at send time, never guessed.
      const sendTurnId = `user-${sendStartedAt.toString(36)}`
      // The CLI doesn't echo the user prompt — add the bubble
      // ourselves so the user sees it immediately.
      updateMessagesAt(workspaceRootAtSend, sessionIdAtSend, (prev) => [
        ...prev,
        beginConversationTurn({
          text: message,
          now: sendStartedAt,
          turnId: sendTurnId,
          attachments: sentAttachments,
        }),
      ])
      setCognitionSendTick((tick) => tick + 1)
      telemetry.mark('userMessageCommittedAt')
      let warmRun = false
      // v1.16.6 (M4-A): the supervisor owns the run — it warm-reuses
      // this conversation's idle CLI when present, else spawns, and
      // keeps projecting events into sessionIdAtSend even if the
      // user navigates away.
      //
      // P2 (spec §5): snapshot the effective permission level
      // ONCE at send time. The supervisor does not re-read it
      // mid-run, so a picker change while this turn is in
      // flight is recorded as "下轮生效" instead of leaking
      // into the running CLI. `codeMode` (chat/plan/agent) is
      // the user's interaction intent; the level is the
      // permission. Both travel with the request.
      const sendPermissionLevel = effectivePermission.level
      let runSettings = settingsForCodeRun(current, workspaceRootAtSend)
      let skipAgent = false
      let teamLaunch = false
      try {
        const opened = userLearning.openTrace({
          sessionId: sessionIdAtSend,
          turnId: sendTurnId,
          workspaceRoot: workspaceRootAtSend,
          product: 'code',
          prompt: message,
          codeMode,
          ...(effectiveLearningDirective ? { learningDirective: effectiveLearningDirective } : {}),
        })
        tracesByConversationRef.current.set(
          conversationTraceKey(projectKeyAtSend, sessionIdAtSend),
          opened.id,
        )
        void discoverProjectFacts(workspaceRootAtSend, {
          listDir: (path) => hostAdapter.fs.listDir(path),
          gitSnapshot: () => hostAdapter.git.snapshot(workspaceRootAtSend),
        })
          .then((facts) => {
            userLearning.rememberProjectFacts({
              workspaceRoot: workspaceRootAtSend,
              product: 'code',
              languages: facts.languages,
              frameworks: facts.frameworks,
              hasTests: facts.hasTests,
              gitDirty: facts.gitDirty,
              gitBranch: facts.gitBranch,
            })
          })
          .catch(() => undefined)
        const interaction = prepareLearningInteraction(userLearning, {
          workspaceRoot: workspaceRootAtSend,
          conversationId: sessionIdAtSend,
          turnId: sendTurnId,
          product: 'code',
          prompt: message,
          baseSystemPrompt: current.systemPrompt,
          settings: userLearning.settings(),
          ...(effectiveLearningDirective ? { learningDirective: effectiveLearningDirective } : {}),
          hasPendingLearningUi: Boolean(
            pendingCognitionByConversation[cognitionViewKey('code', sessionIdAtSend)] ||
            userLearning.listPendingReceipts('code', sessionIdAtSend).length > 0 ||
            priorMessagesAtSend.some(
              (item) =>
                (item.kind === 'learning_impact' || item.kind === 'cognition_prompt') &&
                item.status === 'pending',
            ),
          ),
        })
        const prepared = interaction.prepared
        const cognitionView = interaction.cognition
          ? pendingCognitionView(interaction.cognition)
          : null
        if (cognitionView) {
          setPendingCognitionByConversation((prev) => ({
            ...prev,
            [cognitionViewKey(cognitionView.product, cognitionView.conversationId)]: cognitionView,
          }))
        }
        runSettings = settingsForCodeRun(
          { ...current, systemPrompt: prepared.systemPrompt },
          workspaceRootAtSend,
        )
        if (prepared.contract) void persistTeamContract(workspaceRootAtSend, prepared.contract)
        const codeContractSummary = prepared.contract
          ? contractSummaryFromContract(prepared.contract)
          : undefined
        const impact = learningImpactMessage(prepared.decision)
        const launchCode = (systemPrompt: string) => {
          void supervisor
            .runCode(projectKeyAtSend, sessionIdAtSend, {
              prompt: cliPrompt,
              settings: settingsForCodeRun({ ...current, systemPrompt }, workspaceRootAtSend),
              codeMode: cliCodeMode(codeMode),
              permissionLevel: sendPermissionLevel,
              priorMessages: priorMessagesAtSend,
              turnId: sendTurnId,
              teamMode: prepared.teamSpawn?.decision === 'spawn_team',
              lifecycleObserver: codeLifecycleObserver,
              onEvents: (events) => {
                feedTeamEvents(
                  setTeamRun,
                  { workspaceId: workspaceRootAtSend, personConversationId: sessionIdAtSend },
                  events,
                  { contractSummary: codeContractSummary, onClarify: handlePersonClarify },
                )
                updateMessagesAt(workspaceRootAtSend, sessionIdAtSend, (prev) =>
                  applyEvents(prev, events),
                )
              },
            })
            .catch((err) => {
              const reason = err instanceof Error ? err.message : String(err)
              updateMessagesAt(workspaceRootAtSend, sessionIdAtSend, (prev) => [
                ...prev,
                {
                  id: `code-start-error-${Date.now().toString(36)}`,
                  kind: 'notice',
                  role: 'system',
                  createdAt: Date.now(),
                  text: `Code run could not start: ${reason}`,
                },
              ])
            })
        }
        // Foundation spec §7.2.1: `teamMode` (TRYLO_TEAM_MODE) is set only
        // when the runtime produced a confirmed spawn_team; a plain Person
        // send never launches the team roster.
        if (prepared.teamSpawn?.decision === 'spawn_team' && prepared.start === 'ready') {
          teamLaunch = true
        }
        if (prepared.start === 'blocked') {
          skipAgent = true
          updateMessagesAt(workspaceRootAtSend, sessionIdAtSend, (prev) => [
            ...prev,
            {
              id: `team-blocked-${Date.now().toString(36)}`,
              kind: 'notice' as const,
              role: 'system' as const,
              createdAt: Date.now(),
              text: prepared.teamSpawn?.reason ?? '组队请求被拒绝。',
            },
          ])
        } else if (
          (prepared.start === 'pending_impact' || prepared.decision.impactCheck?.interruptUser) &&
          impact &&
          prepared.pendingRun
        ) {
          pendingAgentRunRef.current = {
            id: prepared.pendingRun.id,
            product: 'code',
            workspaceRoot: workspaceRootAtSend,
            conversationId: sessionIdAtSend,
            impactMessageId: impact.id,
            start: launchCode,
          }
          skipAgent = true
          updateMessagesAt(workspaceRootAtSend, sessionIdAtSend, (prev) =>
            prev.some((item) => item.kind === 'learning_impact' && item.status === 'pending')
              ? prev
              : [...prev, impact],
          )
        }
        bumpLearning()
      } catch {
        // Fail open: Code still runs without personalization.
      }
      if (skipAgent) {
        bumpLearning()
        return
      }
      void supervisor
        .runCode(projectKeyAtSend, sessionIdAtSend, {
          prompt: cliPrompt,
          settings: runSettings,
          codeMode: cliCodeMode(codeMode),
          permissionLevel: sendPermissionLevel,
          priorMessages: priorMessagesAtSend,
          turnId: sendTurnId,
          teamMode: teamLaunch,
          lifecycleObserver: codeLifecycleObserver,
          // M4-C5 (P1-3): mark the warm/cold path the controller took.
          onRuntimeAcquired: ({ warm }) => {
            warmRun = warm
            if (warm) {
              telemetry.mark('reuseAttemptAt')
            } else {
              telemetry.mark('spawnRequestedAt')
              telemetry.setColdOrWarm('cold')
            }
          },
          onEvents: (events) => {
            // M4-C5: first raw stdout frame arrives here (translated
            // events, so this is the earliest App can see); then the
            // first semantic event; terminal on loop_end/session_end.
            telemetry.mark('firstRawFrameAt')
            if (
              events.some(
                (e) =>
                  e.type === 'text' ||
                  e.type === 'thinking' ||
                  e.type === 'tool_use' ||
                  e.type === 'api_stream',
              )
            ) {
              telemetry.mark('firstSemanticEventAt')
            }
            if (RUN_TELEMETRY_DEBUG) {
              // eslint-disable-next-line no-console
              console.log(
                '[trylo] stdout events:',
                events.length,
                events.map((e) => e.type).join(','),
              )
            }
            feedTeamEvents(
              setTeamRun,
              { workspaceId: workspaceRootAtSend, personConversationId: sessionIdAtSend },
              events,
              { onClarify: handlePersonClarify },
            )
            updateMessagesAt(workspaceRootAtSend, sessionIdAtSend, (prev) =>
              applyEvents(prev, events),
            )
            if (events.some((e) => e.type === 'loop_end' || e.type === 'session_end')) {
              telemetry.mark('terminalAt')
              if (RUN_TELEMETRY_DEBUG) logRunTelemetry(telemetry.finish(), telemetry.derived())
            }
            // loop_end / returning to idle is the controller's job —
            // it flips the ViewState so the composer re-enables.
          },
        })
        .then(() => {
          // `run` resolves once the prompt is accepted (stdin write
          // accepted). For warm that confirms reuseOk; for cold the
          // prompt is on the wire.
          if (warmRun) {
            telemetry.mark('reuseOkAt')
            telemetry.setColdOrWarm('warm')
          } else {
            telemetry.mark('promptWrittenAt')
          }
        })
        .catch((err) => {
          if (warmRun) telemetry.setColdOrWarm('warm')
          telemetry.mark('terminalAt')
          if (RUN_TELEMETRY_DEBUG) logRunTelemetry(telemetry.finish(), telemetry.derived())
          // eslint-disable-next-line no-console
          console.error('[trylo] onSend: spawn failed', err)
          const reason = err instanceof Error ? err.message : String(err)
          // The controller already marked the run exited + error. Freeze the
          // timer and surface the real failure in the conversation; a console-
          // only error makes the composer appear permanently unresponsive.
          updateMessagesAt(workspaceRootAtSend, sessionIdAtSend, (prev) => [
            ...finalizeLatestTurnTimer(prev),
            {
              id: `code-start-error-${Date.now().toString(36)}`,
              kind: 'notice',
              role: 'system',
              createdAt: Date.now(),
              text: `Code run could not start: ${reason}`,
            },
          ])
        })
    },
    [
      historyReady,
      codeLifecycleObserver,
      codeSessionId,
      currentWorkspace.root,
      codeMode,
      effectivePermission.level,
      running,
      activeProcessId,
      sendingDisabled,
      supervisor,
      updateMessagesAt,
      setText,
      userLearning,
      bumpLearning,
      pendingCognitionByConversation,
      consumeNextLearningDirective,
    ],
  )
  // Publish the latest onSend for the flush effect (avoids stale closure and
  // an onSend-in-deps re-fire loop). run-controls §UI-B.
  onSendRefForFlush.current = onSend

  /** Explicit interrupt: steer the FIRST queued Code message immediately
   *  (bubble appears now, injected into the live CLI), instead of waiting for
   *  the queue to flush on idle. run-controls §UI-B. */
  const interruptCodeQueue = useCallback((): void => {
    const projectKeyAtSend = workspaceKey(currentWorkspace.root)
    const sessionIdAtSend = codeSessionId
    if (!sessionIdAtSend) return
    const key = queueConversationKey(projectKeyAtSend, sessionIdAtSend)
    const queue = pendingCodeQueueRef.current.get(key)
    if (!queue || queue.length === 0) return
    const [first, ...rest] = queue
    if (!first) return
    pendingCodeQueueRef.current.set(key, rest)
    bumpQueueTick()
    if (first.learningDirective) {
      // Steering changes the already-open trace, whose directive is frozen.
      // Keep the one-shot option armed for the next real task instead.
      setNextLearningDirective('code', first.learningDirective)
    }
    const now = Date.now()
    const attachmentCtx = buildAttachmentPromptContext(
      conversationAttachmentStore.snapshot({
        surface: 'code',
        projectKey: projectKeyAtSend,
        conversationId: sessionIdAtSend,
      }).attachments,
    )
    const steerPrompt = attachmentCtx ? `${attachmentCtx}\n\n${first.text}` : first.text
    updateMessagesAt(currentWorkspace.root, sessionIdAtSend, (prev) => [
      ...prev,
      {
        id: first.turnId,
        role: 'user',
        kind: 'text',
        createdAt: now,
        text: first.text,
      },
    ])
    try {
      const traceId = tracesByConversationRef.current.get(
        conversationTraceKey(projectKeyAtSend, sessionIdAtSend),
      )
      if (traceId) userLearningRef.current?.recordEvent(traceId, eventFromSteer(first.text))
    } catch {
      /* never block steer */
    }
    void supervisor.steerCode(projectKeyAtSend, sessionIdAtSend, steerPrompt).then((sent) => {
      if (sent) return
      updateMessagesAt(currentWorkspace.root, sessionIdAtSend, (prev) => [
        ...prev,
        {
          id: `code-steer-error-${Date.now().toString(36)}`,
          kind: 'error',
          role: 'system',
          createdAt: Date.now(),
          userMessage: '当前任务没有接受这条引导，请重试或先停止任务。',
          diagnosticId: `code-steer-rejected:${first.turnId}`,
        },
      ])
    })
  }, [codeSessionId, currentWorkspace.root, setNextLearningDirective, supervisor, updateMessagesAt])

  /** Flush: when a live turn returns to idle and this conversation has a
   *  queued message, run the oldest one as a normal send (bubble + spawn via
   *  onSend's idle path — no double-add, no double-bubble). run-controls §UI-B. */
  useEffect(() => {
    if (running || !historyReady) return
    const key = queueConversationKey(currentWorkspaceKey, codeSessionId ?? '')
    const queue = pendingCodeQueueRef.current.get(key)
    if (!queue || queue.length === 0) return
    const [first, ...rest] = queue
    if (!first) return
    pendingCodeQueueRef.current.set(key, rest)
    bumpQueueTick()
    onSendRefForFlush.current?.(first.text, first.learningDirective)
  }, [running, historyReady, currentWorkspaceKey, codeSessionId])

  // M3 closure §9.3 (M3-P1-11): artifact open/show/copy
  // actions go through a host adapter BOUND to the current
  // project root. The adapter denies targets outside the
  // root before any IPC, and the Rust host re-validates
  // after fs::canonicalize. Every denial/failure lands in
  // the console as an explicit record (the Diagnostics
  // drawer retired with the workd daemon).
  const workArtifactHost = useMemo(
    () =>
      createTryloHostAdapter(currentWorkspace.root, (message, filePath) => {
        // eslint-disable-next-line no-console
        console.error('[artifact host] action failed:', filePath, message)
      }),
    [currentWorkspace.root],
  )

  // In-conversation Work artifact Open → capability-routed preview
  // (P2-1 A-Edge / audit P1-4):
  //   - text / source / markdown / html / csv → internal rich peek
  //     (onSelectFile → PreviewRouter in components/preview/).
  //   - images + rich documents (PDF / Office / 3D / DXF / Gerber) →
  //     internal peek as well (byte-backed kinds skip the text read;
  //     each renderer loads what it needs).
  //   - legacy Office / CAD natives / archives / unknown binary / no
  //     extension → host/OS viewer through the project-root-bound
  //     workArtifactHost. The host adapter performs the
  //     validateArtifactTarget gate, and the Rust side re-validates
  //     after fs::canonicalize. Failures are reported via
  //     onActionError.
  // The "Open with…" submenu and "Show in folder" actions are still
  // driven by ArtifactCard and stay on workArtifactHost.
  const onOpenWorkArtifact = useCallback(
    (path: string): void => {
      const resolvedPath = repoAbsPath(currentWorkspace.root, path) ?? path
      const cap = artifactCapabilityFor(resolvedPath)
      if (
        cap.kind === 'text-preview' ||
        cap.kind === 'image-preview' ||
        cap.kind === 'rich-preview'
      ) {
        void onSelectFile(resolvedPath, 'file')
        return
      }
      // host-open: defer to the root-bound host. The host swallows
      // host-side failures and reports them through the Diagnostics
      // drawer; we ignore the returned promise to keep the click
      // handler fire-and-forget.
      void workArtifactHost.openFile(resolvedPath)
    },
    [currentWorkspace.root, onSelectFile, workArtifactHost],
  )

  // Work-result Diff routes to the shared Git-diff pane.
  const onOpenWorkDiff = useCallback(
    (relPath: string): void => {
      onOpenDiff(relPath)
    },
    [onOpenDiff],
  )

  const codeResultDockKey = useMemo<ResultDockKey>(
    () => ({
      surface: 'code',
      projectKey: currentWorkspaceKey,
      conversationId: codeSessionId ?? '__none__',
    }),
    [codeSessionId, currentWorkspaceKey],
  )
  const codeResultDockOpen = useResultDockOpen(codeResultDockKey, false)

  // P2-1 (spec §9): the visible Code ResultDock. Built once per result from
  // the normalized latest-run; keyed by conversation so fold state stays
  // isolated per conversation (spec §9.3). C-Edge P2-4: the dock is fully
  // controlled by `resultDockPrefsStore`; collapse state survives
  // conversation / project / surface changes.
  const codeResultDock = useMemo(() => {
    if (!codeResults || !codeSessionId) return undefined
    const meta = codeResults.meta
    const count = codeResults.changeCountTotal
    const checksPassed = codeResults.checks.filter((c) => c.status === 'passed').length
    const degraded = meta.status === 'degraded'
    const status: ResultDockStatus = degraded ? 'partial' : 'ready'
    // WP-4: "3 files +128 −24 · 2 checks passed". Totals only render when a
    // reliable stat exists; an incomplete/unknown count simply stays out of
    // the summary (per-file `—` is handled inside CodeResultContent).
    const statsText =
      codeResults.additionsTotal !== undefined || codeResults.deletionsTotal !== undefined
        ? `+${codeResults.additionsTotal ?? 0} −${codeResults.deletionsTotal ?? 0}`
        : null
    const parts = [`${count} 个文件`]
    if (statsText) parts.push(statsText)
    if (codeResults.checkCountTotal > 0) {
      parts.push(`${checksPassed}/${codeResults.checkCountTotal} 项检查通过`)
    }
    const summary = count > 0 || codeResults.checkCountTotal > 0 ? parts.join(' · ') : undefined
    return (
      <ResultDock
        key={`code-results-${codeSessionId}`}
        id={`code-results-${codeSessionId}`}
        mode="code"
        title="变更审查"
        count={count}
        status={status}
        summary={summary}
        warning={meta.warning}
        truncated={codeResults.truncated}
        open={codeResultDockOpen}
        onOpenChange={(o) => resultDockPrefsStore.setOpen(codeResultDockKey, o)}
        onToggle={() => resultDockPrefsStore.setOpen(codeResultDockKey, false)}
      >
        <CodeResultContent
          result={codeResults}
          onOpenDiff={onOpenDiff}
          onOpenFile={onOpenResultFile}
        />
      </ResultDock>
    )
  }, [
    codeResults,
    codeSessionId,
    onOpenDiff,
    onOpenResultFile,
    codeResultDockKey,
    codeResultDockOpen,
  ])

  // P2-1 (spec §8 / §9): the current visible Work conversation's normalised
  // scoped result snapshot (the UI read path — never the raw runtime store).
  const workResults = useMemo<StoredWorkResult | undefined>(() => {
    if (!workSessionId) return undefined
    void resultVersion
    return resultRepo.snapshot(currentWorkspaceKey, workSessionId)?.work
  }, [currentWorkspaceKey, workSessionId, resultRepo, resultVersion])

  const currentWorkTurnId = useMemo(() => {
    const currentUser = [...workMessages]
      .reverse()
      .find((message) => message.kind === 'text' && message.role === 'user')
    return currentUser?.turnId ?? currentUser?.id
  }, [workMessages])
  // P3: `work_rail` is no longer produced, so run attribution comes only
  // from the originating turn id — the old work_rail scan was dead code.
  // 2026-09-10 (applyWorkItem deletion面): work-item-mapper deleted (zero
  // production callers); the deliverable projection it once folded is now
  // owned upstream (DeliverableWorkflowAdapter in @trylo/work).
  const currentWorkArtifactCount = useMemo(
    () =>
      latestRunArtifactCount(
        workResults ?? { artifacts: [], artifactCountTotal: 0, truncated: false },
        { turnId: currentWorkTurnId },
      ),
    [currentWorkTurnId, workResults],
  )
  const workResultDockKey = useMemo<ResultDockKey>(
    () => ({
      surface: 'work',
      projectKey: currentWorkspaceKey,
      conversationId: workSessionId ?? '__none__',
    }),
    [currentWorkspaceKey, workSessionId],
  )
  const workResultDockOpen = useResultDockOpen(workResultDockKey, false)

  // P2-1 (spec §9.4): Work ResultDock. Count is the REAL artifact total; the
  // summary mirrors the latest run's created/updated/discovered deltas.
  // C-Edge P2-4: collapse state is per (work, project, conversation).
  const workResultDock = useMemo(() => {
    if (!workResults || !workSessionId) return undefined
    const latestRun = workResults.latestRun
    // ResultDock is a result of THIS run, not a permanent conversation
    // inventory. A greeting/chat turn with no file delta must not resurrect
    // old artifacts below the answer (the screenshot regression). Historical
    // files remain persisted and reappear when a run actually touches output.
    const latestCount = currentWorkArtifactCount
    if (!latestRun || latestCount === 0) return undefined
    const count = latestCount
    const degraded = latestRun?.status === 'degraded'
    const status: ResultDockStatus = degraded ? 'partial' : 'ready'
    const parts: string[] = []
    if (latestRun) {
      if (latestRun.createdIds.length > 0) parts.push(`新建 ${latestRun.createdIds.length}`)
      if (latestRun.updatedIds.length > 0) parts.push(`更新 ${latestRun.updatedIds.length}`)
      if (latestRun.discoveredIds.length > 0) parts.push(`发现 ${latestRun.discoveredIds.length}`)
    }
    const summary = parts.length > 0 ? parts.join(' · ') : `${count} 个交付物`
    return (
      <ResultDock
        key={`work-results-${workSessionId}`}
        id={`work-results-${workSessionId}`}
        mode="work"
        title="交付物"
        count={count}
        status={status}
        summary={summary}
        warning={latestRun?.warning}
        truncated={workResults.truncated}
        open={workResultDockOpen}
        onOpenChange={(o) => resultDockPrefsStore.setOpen(workResultDockKey, o)}
        onToggle={() => resultDockPrefsStore.setOpen(workResultDockKey, false)}
      >
        <WorkResultContent
          result={workResults}
          workspaceRoot={currentWorkspace.root}
          host={workArtifactHost}
          onPreviewArtifact={onOpenWorkArtifact}
          onDiffArtifact={onOpenWorkDiff}
        />
      </ResultDock>
    )
  }, [
    workResults,
    workSessionId,
    currentWorkArtifactCount,
    currentWorkspace.root,
    workArtifactHost,
    onOpenWorkArtifact,
    onOpenWorkDiff,
    workResultDockKey,
    workResultDockOpen,
  ])

  return (
    <AppShell
      workspaces={workspaces}
      currentWorkspaceId={currentWorkspaceId}
      sessions={currentSessions}
      activeSessionId={currentActiveSession?.id ?? null}
      leftRailCollapsed={leftRailCollapsed}
      onToggleLeftRail={onToggleLeftRail}
      runningSessionIds={runningSessionIds}
      teamMarks={teamMarks}
      fileTreeRoot={currentWorkspace.root}
      rightRailOpen={rightRailOpen}
      onToggleRightRail={onToggleRightRail}
      leftWidth={leftWidth}
      onLeftWidthChange={setLeftWidth}
      rightWidth={rightWidth}
      onRightWidthChange={setRightWidth}
      style={
        {
          // Content-area edges (incl. the 5px draggable resizer that sits
          // between a rail and the main column). 0 when the rail is
          // collapsed/closed so the TopBar's mode selector can recentre on
          // the *remaining* content area, never on the full window.
          '--rail-left-w': `${leftWidth}px`,
          '--rail-right-w': `${rightWidth}px`,
        } as unknown as CSSProperties
      }
      onSwitchWorkspace={onSwitchWorkspace}
      onOpenFolder={onOpenFolder}
      onCloseWorkspace={onCloseWorkspace}
      onSelectSession={onSelectSession}
      onNewSession={onNewSession}
      onDeleteSession={onDeleteSession}
      onRenameSession={onRenameSession}
      onArchiveSession={onArchiveSession}
      onUnarchiveSession={onUnarchiveSession}
      topMode={topMode}
      onTopModeChange={onTopModeChange}
      // Person | Team surface (spec §1.2). A second segmented
      // control on the right of the TopBar; visually quieter than
      // the Code | Work tab so it doesn't read as a third product
      // mode. Owns `collaborationSurface` together with the main
      // column (SurfaceHost below).
      topBarCollaborationSwitch={
        <CollaborationSwitch value={collaborationSurface} onChange={setCollaborationSurface} />
      }
      peekFile={peekFile}
      onClosePeek={onClosePeek}
      peekWidth={peekWidth}
      onPeekWidthChange={setPeekWidth}
      peekExpanded={peekExpanded}
      onTogglePeekExpanded={() => setPeekExpanded((v) => !v)}
      gitDiff={
        gitDiffState
          ? {
              path: gitDiffState.identity.path,
              diff: gitDiffState.diff,
              error: gitDiffState.error,
              onClose: onCloseGitDiff,
            }
          : null
      }
      // P3 (spec §3.3): the approval preview panel uses the
      // same GitDiffView renderer; the AppShell decides which
      // of the two right-pane states (committed diff vs
      // pending approval) is active. Approval wins so the
      // user never opens a workspace diff over the top of
      // a pending card.
      approvalDiff={
        approvalDiffState
          ? {
              path: approvalDiffState.identity.path,
              source: approvalDiffState.identity.source,
              ...(approvalDiffState.diff ? { diff: approvalDiffState.diff } : {}),
              onClose: onCloseApprovalDiff,
            }
          : null
      }
      settings={settings}
      onSelectFile={onSelectFile}
      settingsOpen={settingsOpen}
      onSettingsOpenChange={setSettingsOpen}
      onSettingsSave={handleSettingsSave}
      petStatus={petStatus}
      remoteStatus={remoteStatus}
      // P0-A (audit §3.3): the Work tool packages' health + install surface.
      toolPlatform={toolPlatform}
      // Hermes learning port for the Settings → Skills library modal.
      learningPort={learningPortRef.current}
      onOpenLearningPending={() => {
        setSettingsOpen(false)
        setLearningPanelOpen(true)
      }}
      browserPreview={browserPreview}
      remoteController={remoteController}
      // 2026-08-29: TopBar "远程" button opens the pairing
      // modal (the new home of the pairing QR). The modal
      // holds enable/disable + QR; Settings keeps port /
      // tunnel / URL config only.
      remoteEnabled={settings.remote.enabled}
      remoteRunning={remoteStatus?.running ?? false}
      remotePairingOpen={showRemotePairing}
      onRemotePairingOpenChange={setShowRemotePairing}
      onRemoteToggle={handleRemoteToggle}
      // M4-D: the TopBar owns the activity chip now
      // (was a loose badge in M4-A). The shell only
      // forwards the count + the open trigger.
      activeCodeRuns={activeCodeRuns.length}
      onOpenActivityCenter={openActivity}
      // M4-D: Background Activity Center popover. The
      // body is rendered by AppShell so the popover can
      // portal above the shell.
      activityOpen={activityOpen}
      onActivityOpenChange={setActivityOpen}
      activityItems={activityItems}
      topBarRight={
        <>
          <button
            type="button"
            className={`top-bar__learning${learningPanelOpen ? ' is-active' : ''}`}
            onClick={() => setLearningPanelOpen((open) => !open)}
            title="学习：用户认知 / 代理学习"
          >
            学习
          </button>
          <button
            type="button"
            className={`top-bar__rail-toggle${rightRailOpen ? ' top-bar__rail-toggle--active' : ''}`}
            onClick={onToggleRightRail}
            title="Toggle file tree"
            aria-label="Toggle file tree"
            aria-pressed={rightRailOpen}
          >
            <PanelRight size={15} strokeWidth={2.2} aria-hidden="true" />
          </button>
        </>
      }
    >
      <SurfaceHost
        collaborationSurface={collaborationSurface}
        teamRun={teamRunForCurrentSession}
        composerLive={teamComposerLive}
        templateProfiles={builtinTeamTemplates}
        customProfiles={customTeamProfiles}
        modelChoices={teamChoices}
        onSaveProfileAs={handleSaveTeamProfileAs}
        onDeleteProfile={handleDeleteTeamProfile}
        onStartTeam={handleStartTeam}
        onSuggest={handleSuggestTeamDraft}
        canSuggest={canSuggestTeam}
        lastPrompt={lastPersonUserPrompt}
        onOpenPerson={() => setCollaborationSurface('person')}
        onSelectTeamSeat={handleSelectTeamSeat}
        onCancelTeamSeat={handleCancelTeamSeat}
        onStopTeamRun={handleStopTeamRun}
        personView={
          cognitionViewOpen && cognitionSession ? (
            <CognitionSurface
              session={cognitionSession}
              snapshot={userLearning.snapshot()}
              busy={cognitionBusy}
              onSend={handleCognitionSurfaceSend}
              onStop={handleCognitionSurfaceStop}
              onOpenSession={handleCognitionSurfaceOpenSession}
              onBack={handleCognitionSurfaceBack}
            />
          ) : (
            <ChatPanel
              workspaceRoot={currentWorkspace.root}
              context={context}
              activeSession={currentActiveSession}
              topMode={topMode}
              codeMode={codeMode}
              onCodeModeChange={onCodeModeChange}
              // v1.16.1: plan → agent transition handler.
              onApplyPlan={onApplyPlan}
              messages={mergedMessages}
              onSend={onSend}
              text={text}
              onTextChange={setText}
              onOpenCodeArtifact={onOpenResultFile}
              // v1.16.5: Work surface. Phase 2.5 收口 uses the
              // same MessageList + InputBar as Code.
              onOpenWorkArtifact={onOpenWorkArtifact}
              // M3 closure §9.3 (M3-P1-11): the root-bound
              // adapter every artifact action flows through.
              artifactHost={workArtifactHost}
              hasApiKey={!!settings.apiKey.trim()}
              onOpenSettings={openSettings}
              workMessages={workMergedMessages}
              // P2-1 (spec §9): the Work capability's shared ResultDock, built by
              // the host from the scoped result snapshot and rendered in the
              // surface's `resultDockSlot`. Replaces the old ArtifactDock + the
              // project/run-unaware global artifact store.
              workResultDock={workResultDock}
              workInput={workInput}
              onWorkInputChange={setWorkInput}
              onWorkSend={handleWorkSend}
              // 2026-08-28 (chat-mode split): the explicit 任务
              // send under the composer — a work order, tools allowed.
              onWorkRunAsTask={handleRunWorkAsTask}
              // 2026-08-28: the suggestion chip's accept action.
              onRunTaskSuggestion={handleRunWorkAsTask}
              // PR-3 遗留收口: ToolCard runtime-artifact promote (Work only).
              onPromoteRuntimeArtifact={handlePromoteRuntimeArtifact}
              onPickWorkStarter={onPickWorkStarter}
              workRunning={workRunning}
              workComposerRunning={workBusy}
              onWorkStop={handleWorkStop}
              // M4-E (spec §6.7 Core "approval"): the inline ApprovalCard responder.
              // 2026-09-04 (CLI 单核): the workd input-request responder is retired
              // with the daemon — approvals run through the CodePermissionRegistry.
              onRespondApproval={handleRespondApproval}
              onCognitionAnswer={handleCognitionAnswer}
              onCognitionDismiss={handleCognitionDismiss}
              onLearningImpactResolve={handleLearningImpactResolve}
              cognitionBadgeSlot={
                activePendingCognition ? (
                  <CognitionBadge
                    dimension={activePendingCognition.dimension}
                    label="有 1 个偏好问题待确认"
                    prompt={activePendingCognition.prompt}
                    options={activePendingCognition.options}
                    sendTick={cognitionSendTick}
                    onAnswer={(answer) =>
                      handleBadgeCognitionAnswer(activePendingCognition, answer)
                    }
                    onDismiss={(kind) => handleBadgeCognitionDismiss(activePendingCognition, kind)}
                  />
                ) : undefined
              }
              learningReceiptSlot={
                activeLearningReceipt && activeReceiptCommitment ? (
                  <LearningReceiptPill
                    receipt={activeLearningReceipt}
                    canActivate={activeReceiptCommitment.state !== 'active'}
                    onAcknowledge={() => {
                      userLearning.acknowledgeReceipt(activeLearningReceipt.id)
                      bumpLearning()
                    }}
                    onActivate={() => {
                      userLearning.activateCommitment(activeReceiptCommitment.id)
                      bumpLearning()
                    }}
                    onThisTimeOnly={() => {
                      const evidence = userLearning
                        .snapshot()
                        .evidence.find((item) =>
                          activeReceiptCommitment.provenanceEvidenceIds.includes(item.id),
                        )
                      if (evidence)
                        userLearning.applyCommitmentThisTimeOnly(
                          activeReceiptCommitment.id,
                          evidence.source.traceId,
                        )
                      bumpLearning()
                    }}
                    onChangeScope={(level) => {
                      const currentScope = activeReceiptCommitment.scope
                      userLearning.updateCommitmentScope(activeReceiptCommitment.id, {
                        workspaceId:
                          level === 'project'
                            ? workspaceIdFromRoot(currentWorkspace.root)
                            : 'global',
                        projectId:
                          level === 'project' ? projectIdFromRoot(currentWorkspace.root) : 'global',
                        product: activeCognitionProduct,
                        component: currentScope.component ?? undefined,
                        taskCategory: currentScope.taskCategory ?? undefined,
                        artifactAudience: currentScope.artifactAudience ?? undefined,
                        taskStage: currentScope.taskStage ?? undefined,
                        corePath: currentScope.corePath ?? undefined,
                        riskLevel: currentScope.riskLevel ?? undefined,
                        reversible: currentScope.reversible ?? undefined,
                        scopeTags: activeReceiptCommitment.conditions,
                      })
                      bumpLearning()
                    }}
                    onPause={() => {
                      userLearning.pauseCommitment(activeReceiptCommitment.id)
                      bumpLearning()
                    }}
                    onRetract={() => {
                      userLearning.retractCommitment(activeReceiptCommitment.id)
                      bumpLearning()
                    }}
                  />
                ) : undefined
              }
              learning={{
                mode: learningView.mode,
                evidenceCount: learningView.evidenceCount,
                modelCount: learningView.modelCount,
                injected: learningView.injected,
                onOpen: () => setLearningPanelOpen(true),
              }}
              {...(settings.userLearning.userLearningNoTraceMode !== false
                ? {
                    learningDirective: nextLearningDirectiveByProduct[activeCognitionProduct],
                    onLearningDirectiveChange: (directive: LearningDirective | undefined) =>
                      setNextLearningDirective(activeCognitionProduct, directive),
                  }
                : {})}
              // P3 (spec §3.3): open the right-side diff panel for
              // a pending approval. The card only triggers the
              // open; the host owns the panel state and the
              // approval/denial is a SEPARATE path.
              onOpenApprovalPreview={onOpenApprovalPreview}
              // P2 (spec §3.2): the resolved permission level +
              // change handler. The chip lives in the action row
              // on BOTH Code and Work composers; ChatPanel does
              // not branch on conversation kind.
              permissionLevel={effectivePermission.level}
              permissionSource={effectivePermission.source}
              permissionPendingNextTurn={permissionPendingNextTurn}
              onPermissionLevelChange={onPermissionLevelChange}
              // 2026-09-04 (CLI 单核): composer enablement is a projection of the
              // CLI supervisor's sendable state — the workd handshake gate is gone.
              workCanSend={
                historyReady &&
                (workCodeView.sendable || (workRunning && workCodeView.activeProcessId !== null))
              }
              running={running}
              error={error}
              onStop={onStop}
              queuedCount={topMode === 'work' ? workQueuedCount : codeQueuedCount}
              onInterruptQueued={topMode === 'work' ? interruptWorkQueue : interruptCodeQueue}
              // v1.15.8: gate the input bar on sending. We
              // separately re-enable when loop_end arrives in
              // the events stream.
              sendingDisabled={!historyReady || sendingDisabled}
              // v1.16.3: inline-edit of past user messages.
              editingMessageId={editingMessageId}
              onEditMessage={onEditMessage}
              onSaveEdit={onSaveEdit}
              onCancelEdit={onCancelEdit}
              // v1.16.0: ring data. Renders in the action row
              // below the input (not the top bar — top placement
              // was a v1.16.0.0 mistake, corrected here).
              contextUsed={currentContextTokens}
              contextWindow={contextWindow}
              model={effectiveModel}
              // v-modelsel: model chip (Code + Work). Own model is preserved
              // in settings.apiModel; pool selection only sets settings.poolModel.
              // A conversation's own choice (if any) overrides the global pick so
              // the chip reflects what THIS conversation will actually run.
              configuredModel={settings.apiModel}
              poolModel={
                activeConversationChoice?.kind === 'pool'
                  ? activeConversationChoice.model
                  : activeConversationChoice
                    ? ''
                    : settings.poolModel
              }
              savedProfiles={settings.modelProfiles.map((p) => ({
                id: p.id,
                label: p.name || '未命名配置',
                hint: p.apiModel || '默认模型',
              }))}
              activeProfileId={
                activeConversationChoice?.kind === 'profile'
                  ? activeConversationChoice.id
                  : activeConversationChoice
                    ? ''
                    : settings.activeModelProfileId
              }
              onSelectConfigured={handleSelectConfigured}
              onSelectPool={handleSelectPool}
              onSelectProfile={handleSelectProfile}
              // v1.16.2.1: ring is the compact trigger; the
              // popover inside the ring handles the action.
              onCompact={onCompact}
              compacting={compacting}
              // v1.16.2.2: forwarded so the ring's popover can
              // show a "no live CLI" hint in dev mode.
              activeProcessId={activeProcessId}
              // v1.16.2: attachments. The 📎 button in
              // InputBar opens the file picker; chips render
              // below the input; × on a chip removes it.
              attachments={codeAttachmentsState.attachments}
              onAddAttachment={codeAttachmentsState.actions.openPicker}
              onRemoveAttachment={codeAttachmentsState.actions.remove}
              // Reading-count placeholder ("Reading N file(s)…") — now
              // sourced from the partition store snapshot.
              attachmentLoading={codeAttachmentsState.readingCount}
              // Red error chips for files that couldn't be attached +
              // dismiss/retry. Retry only renders for retryable failures.
              failed={codeAttachmentsState.failed}
              onDismissFailed={codeAttachmentsState.actions.dismissFailed}
              onRetryFailed={codeAttachmentsState.actions.retryFailed}
              // P2-1 Work Package B: the Work surface's attachment strip —
              // same shared InputBar/AttachmentList, fed by the staged
              // Work partition.
              workAttachments={workAttachmentsState.workAttachments}
              onAddWorkAttachment={workAttachmentsState.actions.openPicker}
              onRemoveWorkAttachment={workAttachmentsState.actions.remove}
              workAttachmentLoading={workAttachmentsState.readingCount}
              workFailed={workAttachmentsState.failed}
              onDismissWorkFailed={workAttachmentsState.actions.dismissFailed}
              onRetryWorkFailed={workAttachmentsState.actions.retryFailed}
              // v1.16.3: drop overlay highlight. Tauri
              // drag-drop sets this true while a file is over
              // the webview; InputBar shows a dashed highlight.
              isDragging={isDragging}
              codeResultDock={codeResultDock}
              // Person | Team surface (spec §5.1): the quiet status
              // bar that sits just above the composer when a TeamRun is
              // active on the current Code/Work conversation. Undefined
              // when there's no run → the slot simply doesn't render.
              personTeamStatusBar={personTeamStatusBarNode}
            />
          )
        }
      />
      <UserLearningPanel
        key={learningTick}
        open={learningPanelOpen}
        snapshot={userLearning.snapshot()}
        settings={userLearning.settings()}
        learningPort={learningPortRef.current}
        lastDecision={userLearning.snapshot().policyDecisions.at(-1)?.mode}
        onClose={() => setLearningPanelOpen(false)}
        onSettingsChange={(next) => {
          const merged = userLearning.setSettings(next)
          const updated = { ...settings, userLearning: merged }
          setSettings(updated)
          saveSettings(updated)
          bumpLearning()
        }}
        onOpenCognition={() => openCognitionView()}
        onCorrect={() => openCognitionView()}
        onExport={() => {
          const payload = JSON.stringify(userLearning.exportForUser(), null, 2)
          const blob = new Blob([payload], { type: 'application/json' })
          const url = URL.createObjectURL(blob)
          const link = document.createElement('a')
          link.href = url
          link.download = 'trylo-user-learning.json'
          link.click()
          URL.revokeObjectURL(url)
        }}
        onDeleteUserData={() => {
          if (!window.confirm('删除全部 User Learning 数据？此操作不能恢复。')) return
          userLearning.deleteUserData()
          bumpLearning()
        }}
      />
    </AppShell>
  )
}

export default App
