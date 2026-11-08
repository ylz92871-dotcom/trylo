import { runCliCommand } from '../host-adapter/cli-command'
import type { ToolLearningRuntime } from '../tool-learning/cli-status'

export type CentralRuntimeState = {
  readonly enabled: boolean
  readonly owner?: {
    readonly ownerId: string
    readonly state: 'waiting' | 'running' | 'stopping' | 'stopped' | 'failed'
    readonly revision: number
    readonly reason?: string
    readonly progress?: { readonly message: string; readonly phase?: 'initializing' }
  }
  readonly configuration?: {
    readonly providerId: string
    readonly model: string
    readonly endpointHash: string
    readonly endpoint?: string
    readonly accountId?: string
    readonly reasoningEffort?: string
    readonly userLearning: boolean
    readonly thoughtMaxTokens?: number
    readonly allowance?: { readonly maxTokens: number }
  }
}
const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
const states = new Set(['waiting', 'running', 'stopping', 'stopped', 'failed'])
const positive = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value > 0 && value <= 1000000000
export function parseCentralRuntimeState(stdout: string): CentralRuntimeState {
  if (stdout.length > 32768) throw new Error('central_runtime_output_limit')
  const value: unknown = JSON.parse(stdout)
  if (
    !record(value) ||
    value.schemaVersion !== 1 ||
    value.domain !== 'central_runtime' ||
    value.ok !== true ||
    typeof value.enabled !== 'boolean'
  )
    throw new Error(
      record(value) && typeof value.reason === 'string'
        ? value.reason
        : 'central_runtime_reply_invalid',
    )
  const owner = value.owner
  const configuration = value.configuration
  if (
    configuration !== undefined &&
    (!record(configuration) ||
      configuration.schemaVersion !== 1 ||
      typeof configuration.providerId !== 'string' ||
      typeof configuration.model !== 'string' ||
      typeof configuration.endpointHash !== 'string' ||
      typeof configuration.userLearning !== 'boolean' ||
      (configuration.endpoint !== undefined && typeof configuration.endpoint !== 'string') ||
      (configuration.accountId !== undefined && typeof configuration.accountId !== 'string') ||
      (configuration.reasoningEffort !== undefined &&
        typeof configuration.reasoningEffort !== 'string') ||
      (configuration.thoughtMaxTokens !== undefined && !positive(configuration.thoughtMaxTokens)) ||
      (configuration.allowance !== undefined &&
        (!record(configuration.allowance) || !positive(configuration.allowance.maxTokens))))
  )
    throw new Error('central_runtime_reply_invalid')
  if (
    owner !== undefined &&
    (!record(owner) ||
      typeof owner.ownerId !== 'string' ||
      !states.has(String(owner.state)) ||
      typeof owner.revision !== 'number' ||
      !Number.isSafeInteger(owner.revision) ||
      owner.revision < 0 ||
      (owner.reason !== undefined && typeof owner.reason !== 'string') ||
      (owner.progress !== undefined &&
        (!record(owner.progress) ||
          typeof owner.progress.message !== 'string' ||
          (owner.progress.phase !== undefined && owner.progress.phase !== 'initializing'))))
  )
    throw new Error('central_runtime_reply_invalid')
  return {
    enabled: value.enabled,
    ...(configuration === undefined
      ? {}
      : {
          configuration: {
            providerId: configuration.providerId as string,
            model: configuration.model as string,
            endpointHash: configuration.endpointHash as string,
            userLearning: configuration.userLearning as boolean,
            ...(configuration.thoughtMaxTokens === undefined
              ? {}
              : { thoughtMaxTokens: configuration.thoughtMaxTokens as number }),
            ...(configuration.allowance === undefined
              ? {}
              : {
                  allowance: {
                    maxTokens: (configuration.allowance as Record<string, unknown>)
                      .maxTokens as number,
                  },
                }),
            ...(configuration.endpoint === undefined
              ? {}
              : { endpoint: configuration.endpoint as string }),
            ...(configuration.accountId === undefined
              ? {}
              : { accountId: configuration.accountId as string }),
            ...(configuration.reasoningEffort === undefined
              ? {}
              : { reasoningEffort: configuration.reasoningEffort as string }),
          },
        }),
    ...(owner === undefined
      ? {}
      : {
          owner: {
            ownerId: owner.ownerId as string,
            state: owner.state as NonNullable<CentralRuntimeState['owner']>['state'],
            revision: owner.revision as number,
            ...(owner.reason === undefined ? {} : { reason: owner.reason as string }),
            ...(owner.progress === undefined
              ? {}
              : {
                  progress: {
                    message: (owner.progress as Record<string, unknown>).message as string,
                    ...((owner.progress as Record<string, unknown>).phase === undefined
                      ? {}
                      : { phase: 'initializing' as const }),
                  },
                }),
          },
        }),
  }
}
/** Uses the existing CLI command transport; no task/model is created for status or stop. */
export async function controlCentralRuntime(
  runtime: ToolLearningRuntime,
  action: 'inspect' | 'stop' | 'pause' | 'resume',
  signal?: AbortSignal,
): Promise<CentralRuntimeState> {
  return requestCentralRuntimeControl(runtime, { workspaceRoot: runtime.cwd, action }, signal)
}
export async function requestCentralRuntimeControl(
  runtime: ToolLearningRuntime,
  input: Readonly<Record<string, unknown>>,
  signal?: AbortSignal,
  env?: Readonly<Record<string, string>>,
): Promise<CentralRuntimeState> {
  const result = await runCliCommand({
    ...runtime,
    args: ['learn', 'central', 'runtime', '-'],
    timeoutMs: 15000,
    stdin: JSON.stringify(input),
    ...(env === undefined ? {} : { env }),
    ...(signal === undefined ? {} : { signal }),
  })
  if (!result.ok) {
    if (result.stdout) {
      let failure: unknown
      try {
        failure = JSON.parse(result.stdout)
      } catch {
        /* Retain the original transport failure below. */
      }
      if (
        record(failure) &&
        failure.domain === 'central_runtime' &&
        failure.ok === false &&
        typeof failure.reason === 'string'
      )
        throw new Error(failure.reason)
    }
    throw new Error(result.reason)
  }
  signal?.throwIfAborted()
  return parseCentralRuntimeState(result.stdout)
}
