import { startTeamTurn } from '../user-learning/team-access/profiles/host-launch'
import { builtinTemplatesForSurface } from '../user-learning/team-access/profiles/templates'
import { settingsForCodeRun } from '../runtime/conversation-run-supervisor'
import { sendWorkChat } from '../work-chat/work-chat-adapter'
import type { TryloSettings } from '../settings/settings-store'
import type { ConversationRunSupervisor } from '../runtime/conversation-run-supervisor'
import type { CodeRunLifecycleObserver } from '../runtime/code-run-lifecycle'
import type { ChatMessage } from '../components/chat/types'
import type { LoopEvent } from '../host-adapter/loop-events'
import type { UserLearningRuntime } from '../user-learning/runtime'

/** Phone launch uses the same frozen profiles, preparation and native owner as Desktop. */
export async function launchRemoteTeam(input: {
  supervisor: ConversationRunSupervisor
  projectKey: string
  root: string
  workspaceId: string
  conversationId: string
  surface: 'code' | 'work'
  profileId: string
  goal: string
  turnId: string
  settings: TryloSettings
  permissionLevel: import('../permission/permission-policy').PermissionLevel
  priorMessages: readonly ChatMessage[]
  preparePrompt: UserLearningRuntime['preparePrompt']
  writeFile: (path: string, body: string) => Promise<void>
  workProfile: ReturnType<typeof import('../work-chat/work-tool-profile').workToolProfile>
  lifecycleObserver: CodeRunLifecycleObserver
  onPrepared: (result: Extract<Awaited<ReturnType<typeof startTeamTurn>>, { ok: true }>) => void
  onEvents: (events: readonly LoopEvent[]) => void
  onFailed: (runId: string, error: unknown, cancelled: boolean) => void
}): Promise<void> {
  const profile = builtinTemplatesForSurface(input.surface, Date.now()).find(
    (p) => p.id === input.profileId,
  )
  if (!profile) throw new Error('团队模板已变化，请重新选择。')
  const preparation = input.supervisor.beginSend(
    input.projectKey,
    input.conversationId,
    input.turnId,
  )
  if (!preparation) throw new Error('当前会话有任务正在准备，请稍后重试或先停止。')
  let runId = ''
  try {
    const result = await startTeamTurn({
      workspaceRoot: input.root,
      workspaceId: input.workspaceId,
      conversationId: input.conversationId,
      product: input.surface,
      goal: input.goal,
      profile,
      composerLive: input.settings.userLearning.teamAccessEnabled === true,
      preparePrompt: input.preparePrompt,
      isPersonTurnRunning: false,
      inspectOwner: () => input.supervisor.inspectTeamOwner(input.projectKey, input.conversationId),
      signal: preparation.signal,
      writeFile: input.writeFile,
    })
    if (!result.ok) throw new Error(result.message)
    runId = result.teamRunId
    input.onPrepared(result)
    if (!preparation.isCurrent()) throw new Error('团队启动已取消。')
    const common = {
      sendPreparation: preparation,
      teamMode: true,
      teamRunId: runId,
      codeMode: 'agent' as const,
      permissionLevel: input.permissionLevel,
      priorMessages: input.priorMessages,
      turnId: input.turnId,
      lifecycleObserver: input.lifecycleObserver,
      onEvents: input.onEvents,
    }
    if (input.surface === 'work') {
      await sendWorkChat(input.supervisor, {
        ...common,
        ...input.workProfile,
        projectKey: input.projectKey,
        conversationId: input.conversationId,
        text: result.goal,
        settings: settingsForCodeRun(input.settings, input.root),
        systemPrompt: result.systemPrompt,
      })
    } else {
      await input.supervisor.runCode(input.projectKey, input.conversationId, {
        ...common,
        prompt: result.goal,
        settings: settingsForCodeRun(
          { ...input.settings, systemPrompt: result.systemPrompt },
          input.root,
        ),
      })
    }
  } catch (error) {
    if (runId) input.onFailed(runId, error, preparation.signal.aborted)
    throw error
  } finally {
    preparation.finish()
  }
}
