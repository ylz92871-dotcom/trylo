import { providerArgsFor } from '../host-adapter/cli-auth-status'
import { v1CredentialEnv } from '../host-adapter/trylo-v1-connection'
import { modelReasoningEffort } from '../settings/model-reasoning'
import type { TryloSettings } from '../settings/settings-store'
import type { ToolLearningRuntime } from '../tool-learning/cli-status'
import { controlCentralRuntime, requestCentralRuntimeControl } from './central-runtime'

/** Called by an explicit settings save, never by temporary task overrides. */
export async function configureCentralRuntimeForSettings(
  runtime: ToolLearningRuntime,
  settings: TryloSettings,
  change: {
    readonly connection: boolean
    readonly userLearning: boolean
    readonly thought?: boolean
  },
): Promise<void> {
  const current = await controlCentralRuntime(runtime, 'inspect')
  if (current.configuration === undefined) return
  const patch: Record<string, unknown> = {}
  if (change.userLearning) patch.userLearning = settings.userLearning.enabled === true
  if (change.thought) {
    const thought = settings.agentLearning?.centralThoughtMaxTokens
    if (
      thought !== undefined &&
      (!Number.isSafeInteger(thought) || thought < 1 || thought > 1000000000)
    )
      throw new Error('中央思考包络需要是 1–1,000,000,000 的整数。')
    if (thought !== current.configuration.thoughtMaxTokens) patch.thoughtMaxTokens = thought ?? null
  }
  let env: Readonly<Record<string, string>> | undefined
  const selected = providerArgsFor(settings)
  if (
    selected.providerId === current.configuration.providerId &&
    selected.model === current.configuration.model &&
    selected.endpoint !== undefined &&
    selected.endpoint === current.configuration.endpoint
  )
    env = v1CredentialEnv(selected.providerId, settings.apiKey)
  if (change.connection) {
    if (settings.poolModel?.trim())
      throw new Error('工作区后台连接需要明确的本地 provider；临时池连接不会改写后台配置。')
    if (selected.providerId === undefined) throw new Error('请选择工作区后台使用的 CLI provider。')
    patch.connection = { ...selected, reasoningEffort: modelReasoningEffort(settings) ?? null }
    env = v1CredentialEnv(selected.providerId, settings.apiKey)
  }
  if (Object.keys(patch).length > 0)
    await requestCentralRuntimeControl(
      runtime,
      { workspaceRoot: runtime.cwd, action: 'configure', patch },
      undefined,
      env,
    )
}
