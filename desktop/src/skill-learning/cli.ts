import { runCliCommand, type CliCommandInput } from '../host-adapter/cli-command'

export type SkillLearningRuntime = Pick<
  CliCommandInput,
  'process' | 'cliPath' | 'nodeProgram' | 'cwd'
> & { readonly trialAuthorized?: boolean }
export type SkillSummary = {
  readonly versionId: string
  readonly proposalId: string
  readonly name: string
  readonly version: number
  readonly status: string
  readonly createdAt: string
  readonly sourceOpportunityId: string
  readonly observationRefs: readonly string[]
  readonly contentHash: string
  readonly parentVersionId?: string
  readonly taskFamily: {
    readonly id: string
    readonly intentClass: string
    readonly checkKind: string
    readonly language?: string
  }
  readonly usage: { readonly loads: number; readonly successes: number; readonly failures: number }
}
export type SkillUse = {
  readonly runId: string
  readonly variantId: string
  readonly outcome: string
  readonly sourceRef: string
}
export type SkillResult<T> =
  ({ readonly ok: true } & T) | { readonly ok: false; readonly reason: string }
export type SkillLearningPort = {
  list(
    signal: AbortSignal,
  ): Promise<
    SkillResult<{ readonly workspaceId: string; readonly skills: readonly SkillSummary[] }>
  >
  show(
    versionId: string,
    signal: AbortSignal,
  ): Promise<
    SkillResult<{
      readonly skill: SkillSummary
      readonly content: string
      readonly uses: readonly SkillUse[]
    }>
  >
  withdraw(
    versionId: string,
    signal: AbortSignal,
  ): Promise<SkillResult<{ readonly status: string }>>
  learn(
    allowance: { readonly maxTokens: number; readonly maxCalls: number },
    signal: AbortSignal,
  ): Promise<
    SkillResult<{
      readonly status: string
      readonly reason: string
      readonly usage: {
        readonly tokens?: number
        readonly calls: number
        readonly usageStatus: 'reported' | 'missing'
      }
    }>
  >
}

/** Read the versioned CLI reply; this adapter never opens the Board or experience files. */
export function createSkillLearningPort(runtime: SkillLearningRuntime): SkillLearningPort {
  const call = async (args: readonly string[], signal: AbortSignal) => {
    const result = await runCliCommand({
      ...runtime,
      args: [
        'skills',
        ...args,
        ...(args[0] === 'learn' && runtime.trialAuthorized
          ? ['--allow-writes', '--allow-exec', '--allow-skill-trial']
          : []),
        '--json',
      ],
      signal,
      timeoutMs: args[0] === 'learn' ? 300_000 : 10_000,
    })
    if (!result.ok && result.stdout === undefined)
      return { ok: false as const, reason: result.reason }
    const text = result.stdout ?? ''
    let value: unknown
    try {
      value = JSON.parse(text)
    } catch {
      return { ok: false as const, reason: 'invalid_skill_reply' }
    }
    if (!record(value) || value.schemaVersion !== 1 || typeof value.ok !== 'boolean')
      return { ok: false as const, reason: 'unsupported_skill_reply' }
    if (!value.ok)
      return {
        ok: false as const,
        reason: nonEmpty(value.code) ? value.code : 'skill_command_failed',
      }
    if (!result.ok) return { ok: false as const, reason: result.reason }
    return { ok: true as const, value }
  }
  return {
    async list(signal) {
      const reply = await call(['list'], signal)
      if (!reply.ok) return reply
      if (!nonEmpty(reply.value.workspaceId) || !Array.isArray(reply.value.skills)) return invalid()
      const skills: SkillSummary[] = []
      for (const item of reply.value.skills) {
        const skill = summary(item)
        if (!skill) return invalid()
        skills.push(skill)
      }
      if (new Set(skills.map((skill) => skill.versionId)).size !== skills.length) return invalid()
      return { ok: true, workspaceId: reply.value.workspaceId, skills }
    },
    async show(versionId, signal) {
      const reply = await call(['show', versionId], signal)
      if (!reply.ok) return reply
      const skill = summary(reply.value.skill)
      if (
        !skill ||
        skill.versionId !== versionId ||
        typeof reply.value.content !== 'string' ||
        !Array.isArray(reply.value.uses)
      )
        return invalid()
      const uses: SkillUse[] = []
      for (const item of reply.value.uses) {
        if (
          !record(item) ||
          !nonEmpty(item.runId) ||
          !nonEmpty(item.variantId) ||
          !nonEmpty(item.outcome) ||
          !nonEmpty(item.sourceRef)
        )
          return invalid()
        uses.push({
          runId: item.runId,
          variantId: item.variantId,
          outcome: item.outcome,
          sourceRef: item.sourceRef,
        })
      }
      return { ok: true, skill, content: reply.value.content, uses }
    },
    async withdraw(versionId, signal) {
      const reply = await call(['withdraw', versionId], signal)
      if (!reply.ok) return reply
      if (
        reply.value.versionId !== versionId ||
        (reply.value.status !== 'withdrawn' && reply.value.status !== 'already_withdrawn')
      )
        return invalid()
      return { ok: true, status: reply.value.status }
    },
    async learn(allowance, signal) {
      const reply = await call(
        [
          'learn',
          '--max-tokens',
          String(allowance.maxTokens),
          '--max-calls',
          String(allowance.maxCalls),
        ],
        signal,
      )
      if (!reply.ok) return reply
      const result = reply.value.result
      if (!record(result) || !nonEmpty(result.status) || !nonEmpty(result.reason)) return invalid()
      const usage = result.usage
      if (
        !record(usage) ||
        !Number.isSafeInteger(usage.calls) ||
        Number(usage.calls) < 0 ||
        (usage.tokens !== undefined &&
          (!Number.isSafeInteger(usage.tokens) || Number(usage.tokens) < 0)) ||
        (usage.usageStatus !== undefined &&
          usage.usageStatus !== 'reported' &&
          usage.usageStatus !== 'missing')
      )
        return invalid()
      return {
        ok: true,
        status: result.status,
        reason: result.reason,
        usage: {
          ...(typeof usage.tokens === 'number' ? { tokens: usage.tokens } : {}),
          calls: Number(usage.calls),
          usageStatus:
            usage.usageStatus === 'missing' || usage.tokens === undefined ? 'missing' : 'reported',
        },
      }
    },
  }
}

function summary(raw: unknown): SkillSummary | undefined {
  if (
    !record(raw) ||
    !nonEmpty(raw.versionId) ||
    !nonEmpty(raw.proposalId) ||
    !nonEmpty(raw.name) ||
    !Number.isSafeInteger(raw.version) ||
    Number(raw.version) < 1 ||
    !nonEmpty(raw.status) ||
    !nonEmpty(raw.createdAt) ||
    !nonEmpty(raw.sourceOpportunityId) ||
    !nonEmpty(raw.contentHash) ||
    !Array.isArray(raw.observationRefs) ||
    raw.observationRefs.some((item) => !nonEmpty(item)) ||
    (raw.parentVersionId !== undefined && !nonEmpty(raw.parentVersionId))
  )
    return undefined
  const family = raw.taskFamily,
    usage = raw.usage
  if (
    !record(family) ||
    !nonEmpty(family.id) ||
    !nonEmpty(family.intentClass) ||
    !nonEmpty(family.checkKind) ||
    (family.language !== undefined && !nonEmpty(family.language)) ||
    !record(usage) ||
    [usage.loads, usage.successes, usage.failures].some(
      (value) => !Number.isSafeInteger(value) || Number(value) < 0,
    )
  )
    return undefined
  return {
    versionId: raw.versionId,
    proposalId: raw.proposalId,
    name: raw.name,
    version: Number(raw.version),
    status: raw.status,
    createdAt: raw.createdAt,
    sourceOpportunityId: raw.sourceOpportunityId,
    observationRefs: raw.observationRefs as string[],
    contentHash: raw.contentHash,
    ...(raw.parentVersionId === undefined ? {} : { parentVersionId: String(raw.parentVersionId) }),
    taskFamily: {
      id: family.id,
      intentClass: family.intentClass,
      checkKind: family.checkKind,
      ...(family.language === undefined ? {} : { language: family.language }),
    },
    usage: {
      loads: Number(usage.loads),
      successes: Number(usage.successes),
      failures: Number(usage.failures),
    },
  }
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
function nonEmpty(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0
}
function invalid(): { readonly ok: false; readonly reason: string } {
  return { ok: false, reason: 'invalid_skill_reply' }
}
