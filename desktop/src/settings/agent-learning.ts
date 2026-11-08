/** Cumulative authorization and central thought envelope; domain policy stays in the CLI. */
export type AgentLearningSettings = {
  readonly enabled: boolean
  readonly skillTokens: number
  readonly skillCalls: number
  readonly skillOutputTokens: number
  readonly centralEnabled?: boolean
  readonly centralTokens?: number
  readonly centralCalls?: number
  readonly centralThoughtMaxTokens?: number
}
export const DEFAULT_AGENT_LEARNING: Required<AgentLearningSettings> = {
  enabled: false,
  skillTokens: 32000,
  skillCalls: 4,
  skillOutputTokens: 8000,
  centralEnabled: false,
  centralTokens: 160000,
  centralCalls: 16,
  centralThoughtMaxTokens: 64000,
}
type ResolvedAgentLearningSettings = Omit<
  Required<AgentLearningSettings>,
  'centralThoughtMaxTokens'
> &
  Pick<AgentLearningSettings, 'centralThoughtMaxTokens'>

export function agentLearningSettings(value: unknown): ResolvedAgentLearningSettings {
  const raw = value !== null && typeof value === 'object' ? (value as Record<string, unknown>) : {}
  const valid = (value: unknown, max: number): value is number =>
    typeof value === 'number' && Number.isSafeInteger(value) && value > 0 && value <= max
  const bounded = (value: unknown, max: number, fallback: number) =>
    valid(value, max) ? value : fallback
  const legacy = ['centralTokens', 'centralCalls', 'centralThoughtMaxTokens'].some((key) =>
    Object.hasOwn(raw, key),
  )
  const thought = legacy
    ? raw.centralThoughtMaxTokens
    : DEFAULT_AGENT_LEARNING.centralThoughtMaxTokens
  return {
    enabled: raw.enabled === true,
    skillTokens: bounded(raw.skillTokens, 1000000, DEFAULT_AGENT_LEARNING.skillTokens),
    skillCalls: bounded(raw.skillCalls, 16, DEFAULT_AGENT_LEARNING.skillCalls),
    skillOutputTokens: bounded(
      raw.skillOutputTokens,
      1000000,
      DEFAULT_AGENT_LEARNING.skillOutputTokens,
    ),
    // Missing/corrupt caps cannot turn display defaults into fresh authority.
    // Enabling through the settings control writes both visible valid caps.
    centralEnabled:
      raw.centralEnabled === true &&
      valid(raw.centralTokens, 1000000000) &&
      valid(raw.centralCalls, 64) &&
      (thought === undefined || valid(thought, 1000000000)),
    centralTokens: bounded(
      raw.centralTokens,
      1000000000,
      legacy ? 32000 : DEFAULT_AGENT_LEARNING.centralTokens,
    ),
    centralCalls: bounded(raw.centralCalls, 64, legacy ? 4 : DEFAULT_AGENT_LEARNING.centralCalls),
    ...(valid(thought, 1000000000) ? { centralThoughtMaxTokens: thought } : {}),
  }
}

export function agentLearningForRun(
  value: unknown,
  userEnabled: boolean,
  directive?: {
    readonly collectNewLearning: boolean
    readonly retention: 'normal' | 'session_only'
  },
): {
  readonly learning?: 'user' | 'agent' | 'all'
  readonly skillLearningAllowance?: { readonly maxTokens: number; readonly maxCalls: number }
  readonly centralLearningAllowance?: {
    readonly maxTokens: number
    readonly maxCalls: number
    readonly thoughtMaxTokens?: number
  }
} {
  if (directive?.collectNewLearning === false || directive?.retention === 'session_only') return {}
  const settings = agentLearningSettings(value)
  if (settings.centralEnabled)
    return {
      learning: userEnabled ? 'all' : 'agent',
      centralLearningAllowance: {
        maxTokens: settings.centralTokens,
        maxCalls: settings.centralCalls,
        ...(settings.centralThoughtMaxTokens === undefined
          ? {}
          : { thoughtMaxTokens: settings.centralThoughtMaxTokens }),
      },
    }
  return settings.enabled
    ? {
        learning: userEnabled ? 'all' : 'agent',
        skillLearningAllowance: { maxTokens: settings.skillTokens, maxCalls: settings.skillCalls },
      }
    : userEnabled
      ? { learning: 'user' }
      : {}
}
