import { createRoot } from 'react-dom/client'
import { PanelRight } from 'lucide-react'
import { useCallback, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { AppShell, type AppShellProps } from '../../src/components/app-shell/AppShell'
import { ChatPanel } from '../../src/components/chat/ChatPanel'
import { CodeReviewPanel } from '../../src/components/chat/CodeReviewPanel'
import { codeReviewSummary } from '../../src/components/chat/code-review-summary'
import { WorkReviewPanel } from '../../src/components/chat/WorkReviewPanel'
import { ResultDock } from '../../src/components/chat/ResultDock'
import { latestRunArtifactCount } from '../../src/components/chat/WorkResultContent'
import { codeReviewFiles, workReviewFiles } from '../../src/components/chat/result-preview-files'
import { joinRoot } from '../../src/components/chat/artifact-mention'
import { useResultReview } from '../../src/result-dock/use-result-review'
import { latestUserTurnId, resultMatchesTurn, workReviewForTurn } from '../../src/result-dock/result-review-state'
import { useDiffPreview } from '../../src/result-dock/use-diff-preview'
import { loadPreviewFile } from '../../src/host-adapter/preview/read-file'
import { hostAdapter } from '../../src/host-adapter'
import { createTryloContext } from '../../src/host-adapter/trylo-context'
import type { Attachment } from '../../src/host-adapter/attachment-utils'
import type { WorkAttachmentEntry } from '../../src/attachments/attachment-acquisition'
import type { PermissionLevel } from '../../src/permission/permission-policy'
import type { TopLevelMode } from '../../src/host-adapter/types'
import { settingsDefaults } from '../../src/settings/settings-store'
import { setAppearance } from '../../src/settings/appearance-store'
import { makeCodeResult, makeWorkResult, makeMessages, markdownRelative } from './records'
import '../../src/index.css'

const noop = (): void => {}
const query = new URLSearchParams(location.search)
const root = query.get('root')!
if (!root) throw new Error('The acceptance fixture needs its isolated project root')
const context = createTryloContext({ workspaceRoot: root })
const proof = {
  mode: 'code', sessionId: 'chat-a', running: false, empty: false, delayDiffs: false,
  fileCalls: [] as string[], hostCalls: [] as string[],
  diffCalls: [] as { root: string; path: string; oldPath?: string }[],
  composerCalls: [] as { mode: string; action: string; text?: string; attachments?: number }[],
  pendingDiffs: 0, activeDiff: null as string | null,
}
const delayed: (() => void)[] = []
const host = {
  openFile: async (path: string) => { proof.hostCalls.push(`open:${path}`) },
  openFileWithApp: async (path: string) => { proof.hostCalls.push(`open-with:${path}`) },
  showInFolder: async (path: string) => { proof.hostCalls.push(`folder:${path}`) },
  copyToClipboard: async (path: string) => { proof.hostCalls.push(`copy:${path}`) },
}
const read = async (path: string): Promise<string> => {
  const response = await fetch(`/__code_work/read?path=${encodeURIComponent(path)}`)
  if (!response.ok) throw new Error(await response.text())
  return response.text()
}
Object.assign(hostAdapter.fs, { listDir: async (path: string) => {
  const response = await fetch(`/__code_work/list?path=${encodeURIComponent(path)}`)
  if (!response.ok) throw new Error(await response.text())
  return response.json()
} })

function Fixture(): JSX.Element {
  const [mode, setMode] = useState<TopLevelMode>('code')
  const [sessionId, setSessionId] = useState('chat-a')
  const [empty, setEmpty] = useState(false)
  const [running, setRunning] = useState(false)
  const [text, setText] = useState('')
  const [permission, setPermission] = useState<PermissionLevel>('unrestricted')
  const [attached, setAttached] = useState(false)
  const [railOpen, setRailOpen] = useState(false)
  const [expanded, setExpanded] = useState(false)
  const [peek, setPeek] = useState<AppShellProps['peekFile']>(null)
  const requestId = useRef(0)
  const resultKey = useMemo(() => ({ surface: mode, projectKey: root, conversationId: sessionId }), [mode, sessionId])
  const review = useResultReview(resultKey, railOpen, setRailOpen)
  const diff = useDiffPreview({ projectId: 'acceptance-project', projectRoot: root,
    conversationId: sessionId, surface: mode,
    onOpen: () => { setPeek(null); setExpanded(false); setRailOpen(true) },
    readDiff: async (projectRoot, path, oldPath) => {
      proof.diffCalls.push({ root: projectRoot, path, oldPath })
      const modified = await read(joinRoot(projectRoot, path)!)
      if (proof.delayDiffs) await new Promise<void>(resolve => {
        delayed.push(resolve); proof.pendingDiffs = delayed.length
      })
      return { original: '# Previous revision\nBefore the acceptance update.\n', modified,
        binary: false, truncated: false }
    },
  })
  const openFile = useCallback(async (path: string): Promise<void> => {
    const absolute = path.startsWith(`${root}/`) ? path : joinRoot(root, path)
    if (!absolute) throw new Error(`Invalid synthetic file: ${path}`)
    proof.fileCalls.push(absolute)
    diff.close(); setRailOpen(true)
    // Test-host delivery only; production code still owns classification and reading.
    const loaded = await loadPreviewFile(absolute, root, {
      text: read, head: async file => new TextEncoder().encode((await read(file)).slice(0, 4096)),
    })
    setPeek({ path: absolute, ...loaded, requestId: ++requestId.current })
  }, [diff.close])
  useLayoutEffect(() => { setPeek(null); setExpanded(false); setText(''); setAttached(false) }, [mode, sessionId])
  const messages = makeMessages(sessionId, empty)
  const codeRecord = makeCodeResult(sessionId)
  const codeResult = empty ? { ...codeRecord, meta: { ...codeRecord.meta, turnId: 'old-turn' } } : codeRecord
  const workResult = makeWorkResult(sessionId, empty)
  const turnId = latestUserTurnId(messages)
  const codeCurrent = Boolean(turnId && resultMatchesTurn(codeResult.meta, { turnId }))
  const workReview = workReviewForTurn(workResult, turnId)
  const codeSummary = codeReviewSummary(codeResult)
  const previewFiles = (mode === 'code' ? codeReviewFiles(codeResult) : workReviewFiles(workReview))
    .map(file => ({ ...file, path: `${root}/${file.path}` }))
  const count = mode === 'code' ? codeSummary.count : latestRunArtifactCount(workReview)
  const showInline = mode === 'code' ? codeResult.attribution === 'workspace_only' || codeCurrent
    : count > 0 || Boolean(workReview.latestRun?.warning)
  const panelId = `${mode}-review-${sessionId}`
  const label = mode === 'code' ? '变更' : '交付物'
  const dock = showInline ? <ResultDock id={`${mode}-results-${sessionId}`} panelId={panelId}
    mode={mode} title={mode === 'code' ? '变更审查' : '交付物'} count={count}
    status="ready" summary={mode === 'code' ? codeSummary.text : `${count} 个交付物`} open={review.open}
    onOpenChange={review.toggle} onToggle={() => review.toggle(false)} /> : undefined
  const resultReview = { id: panelId, label, open: review.open, onOpenChange: review.select,
    content: mode === 'code'
      ? <CodeReviewPanel result={codeResult} currentTurn={codeCurrent} onOpenDiff={diff.open} onOpenFile={path => { void openFile(path) }} />
      : <WorkReviewPanel result={workReview} workspaceRoot={root} host={host}
          onPreviewArtifact={path => { void openFile(path) }} onDiffArtifact={diff.open} />,
  }
  const closeRail = (): void => { review.toggle(false); setPeek(null); diff.close(); setExpanded(false) }
  const add = (): void => { proof.composerCalls.push({ mode, action: 'attach' }); setAttached(true) }
  const send = (value: string): void => {
    proof.composerCalls.push({ mode, action: 'send', text: value, attachments: Number(attached) })
    setText(''); setAttached(false)
  }
  const stop = (): void => { proof.composerCalls.push({ mode, action: 'stop' }); setRunning(false) }
  const attachment: Attachment = { id: 'attachment', kind: 'image', name: 'reference.png',
    path: `${root}/reference.png`, size: 74000, mediaType: 'image/png', excerpt: 'reference', addedAt: 1 }
  const workAttachment: WorkAttachmentEntry = { ...attachment, sourcePath: attachment.path,
    relativePath: '.trylo/attachments/reference.png' }
  Object.assign(proof, { mode, sessionId, running, empty, activeDiff: diff.state?.identity.path ?? null })
  Object.assign(window, { codeWorkProof: proof, codeWorkControls: {
    setMode, setSessionId, setEmpty, setRunning, setAppearance,
    reopenMarkdown: () => openFile(markdownRelative),
    releaseDiffs: () => { for (const done of delayed.splice(0)) done(); proof.pendingDiffs = 0 },
  } })
  const session = { id: sessionId, title: `预览任务 ${sessionId}`, mode: 'agent' as const,
    createdAt: 1, updatedAt: 1, turnCount: 1, kind: mode }
  return <AppShell workspaces={[{ id: 'acceptance-project', name: 'Code / Work 验收', root }]}
    currentWorkspaceId="acceptance-project" sessions={[session]} activeSessionId={sessionId}
    runningSessionIds={running ? new Set([sessionId]) : new Set()} leftRailCollapsed={true}
    onToggleLeftRail={noop} onSwitchWorkspace={noop} onOpenFolder={noop} onCloseWorkspace={noop}
    onSelectSession={setSessionId} onNewSession={noop} onDeleteSession={noop} onRenameSession={noop}
    onArchiveSession={noop} onUnarchiveSession={noop} topMode={mode} settings={settingsDefaults}
    topBarRight={<button type="button" className="top-bar__rail-toggle" title="结果侧栏" aria-label="结果侧栏"
      onClick={() => railOpen ? closeRail() : setRailOpen(true)}><PanelRight size={16} /></button>}
    leftWidth={256} onLeftWidthChange={noop} rightWidth={480} onRightWidthChange={noop}
    fileTreeRoot={root} rightRailOpen={railOpen} onToggleRightRail={() => railOpen ? closeRail() : setRailOpen(true)}
    resultReview={resultReview} peekFile={peek} previewRoot={root}
    previewFiles={previewFiles}
    onSelectPreviewFile={path => { void openFile(path) }} onSelectFile={path => { void openFile(path) }}
    onClosePeek={() => setPeek(null)} onReloadPeek={() => { if (peek) void openFile(peek.path) }}
    peekExpanded={expanded} onTogglePeekExpanded={() => setExpanded(value => !value)}
    gitDiff={diff.state ? { id: diff.state.identity.requestId, path: diff.state.identity.path,
      diff: diff.state.diff, error: diff.state.error, onClose: diff.close } : null}
    settingsOpen={false} onSettingsOpenChange={noop} onSettingsSave={noop}
    remotePairingOpen={false} onRemotePairingOpenChange={noop} toolMessages={messages}>
    <ChatPanel workspaceRoot={root} context={context} activeSession={session} topMode={mode}
      onTopModeChange={setMode} codeMode="agent" onCodeModeChange={noop} onApplyPlan={noop}
      messages={messages} workMessages={messages} text={text} workInput={text}
      onTextChange={setText} onWorkInputChange={setText} onSend={send} onWorkSend={send}
      artifactHost={host} onOpenCodeArtifact={path => { void openFile(path) }}
      onOpenWorkArtifact={path => { void openFile(path) }}
      codeResultDock={mode === 'code' ? dock : undefined} workResultDock={mode === 'work' ? dock : undefined}
      running={running} onStop={stop} workRunning={running} workComposerRunning={running}
      onWorkStop={stop} workCanSend={true} hasApiKey={true} onOpenSettings={noop}
      permissionLevel={permission} permissionSource="conversation"
      onPermissionLevelChange={value => { proof.composerCalls.push({ mode, action: `permission:${value}` }); setPermission(value) }}
      contextUsed={0} contextWindow={128000} model="验收模型" onCompact={noop} compacting={false}
      activeProcessId={running ? 'synthetic-process' : null}
      attachments={attached ? [attachment] : []} onAddAttachment={add} onRemoveAttachment={() => setAttached(false)}
      attachmentLoading={0} failed={[]} onDismissFailed={noop}
      workAttachments={attached ? [workAttachment] : []} onAddWorkAttachment={add}
      onRemoveWorkAttachment={() => setAttached(false)} workAttachmentLoading={0} workFailed={[]}
      onDismissWorkFailed={noop} isDragging={false} editingMessageId={null} onEditMessage={noop}
      onSaveEdit={noop} onCancelEdit={noop} />
  </AppShell>
}

createRoot(document.getElementById('root')!).render(<Fixture />)
