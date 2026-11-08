import type { ExpertCommand } from '../../../new trylo cli/src/internal/subagent/experts/commands'
import type {
  ExpertConfiguration,
  ExpertRequest,
  ExpertVersion,
} from '../../../new trylo cli/src/internal/subagent/experts/contracts'
import {
  validateRequest,
  validateVersion,
} from '../../../new trylo cli/src/internal/subagent/experts/browser'

export type { ExpertCommand }
/** Presentation evidence stays in the trusted UI transport; it is never a CLI/model payload. */
export type ExpertUserActionEvidence =
  | { readonly kind: 'request'; readonly request: ExpertRequest }
  | { readonly kind: 'expert'; readonly expert: ExpertVersion }
/** The host routes these commands through its registered expert protocol adapter. */
export interface ExpertClientTransport {
  invoke(command: ExpertCommand, signal: AbortSignal): Promise<unknown>
  /** Trusted UI boundary: record this exact gesture and consume it in the existing authority.
   * Omit this method when unavailable; ordinary invoke then requests canonical approval. */
  invokeUserAction?(
    command: ExpertCommand,
    signal: AbortSignal,
    evidence?: ExpertUserActionEvidence,
  ): Promise<unknown>
}

export interface ExpertLibraryClient {
  query(text: string, signal: AbortSignal): Promise<readonly ExpertVersion[]>
  requests(signal: AbortSignal): Promise<readonly ExpertRequest[]>
  draftRevision(
    expertId: string,
    signal: AbortSignal,
    presented?: ExpertVersion,
  ): Promise<ExpertRequest>
  submit(
    instruction: string,
    expertId: string | undefined,
    signal: AbortSignal,
    presented?: ExpertVersion,
  ): Promise<ExpertRequest>
  build(requestId: string, signal: AbortSignal): Promise<ExpertRequest>
  authorizeCreation(
    requestId: string,
    signal: AbortSignal,
    presented?: ExpertRequest,
  ): Promise<ExpertRequest>
  edit(
    requestId: string,
    edits: Partial<ExpertConfiguration>,
    signal: AbortSignal,
    presented?: ExpertRequest,
  ): Promise<ExpertRequest>
  retain(
    requestId: string,
    result: Extract<ExpertCommand, { operation: 'retain' }>['result'],
    signal: AbortSignal,
    presented?: ExpertRequest,
  ): Promise<ExpertRequest>
}

/** This adapter validates transport responses before the UI can report persisted facts. */
export function createExpertLibraryClient(transport: ExpertClientTransport): ExpertLibraryClient {
  const requests = new Map<string, ExpertRequest>()
  const experts = new Map<string, ExpertVersion>()
  const rememberRequest = (value: unknown): ExpertRequest => {
    const parsed = validateRequest(value)
    requests.set(parsed.requestId, structuredClone(parsed))
    if (requests.size > 512) requests.delete(requests.keys().next().value!)
    return parsed
  }
  const evidence = (command: ExpertCommand): ExpertUserActionEvidence | undefined => {
    if ('requestId' in command && command.requestId !== undefined) {
      const request = requests.get(command.requestId)
      return request === undefined
        ? undefined
        : { kind: 'request', request: structuredClone(request) }
    }
    if ('expertId' in command && command.expertId !== undefined) {
      const expert = experts.get(command.expertId)
      return expert === undefined ? undefined : { kind: 'expert', expert: structuredClone(expert) }
    }
    return undefined
  }
  const request = async (
    command: ExpertCommand,
    signal: AbortSignal,
    gesture = false,
    presented?: ExpertUserActionEvidence,
  ) => {
    const value =
      gesture && transport.invokeUserAction
        ? await transport.invokeUserAction(command, signal, presented ?? evidence(command))
        : await transport.invoke(command, signal)
    signal.throwIfAborted()
    return value
  }
  return {
    async query(text, signal) {
      const result = await request({ operation: 'query', text }, signal)
      if (!Array.isArray(result)) throw new Error('专家列表响应格式无效')
      return result.map((item) => {
        const parsed = validateVersion(item)
        experts.set(parsed.expertId, structuredClone(parsed))
        if (experts.size > 512) experts.delete(experts.keys().next().value!)
        return parsed
      })
    },
    async requests(signal) {
      const result = await request({ operation: 'requests' }, signal)
      if (!Array.isArray(result)) throw new Error('专家请求响应格式无效')
      return result.map(rememberRequest)
    },
    async draftRevision(expertId, signal, presented) {
      return rememberRequest(
        await request(
          { operation: 'draft_revision', expertId },
          signal,
          true,
          presented === undefined ? undefined : { kind: 'expert', expert: presented },
        ),
      )
    },
    async submit(instruction, expertId, signal, presented) {
      return rememberRequest(
        await request(
          {
            operation: 'submit',
            origin: 'settings',
            instruction,
            ...(expertId === undefined ? {} : { expertId }),
          },
          signal,
          true,
          presented === undefined ? undefined : { kind: 'expert', expert: presented },
        ),
      )
    },
    async build(requestId, signal) {
      return rememberRequest(await request({ operation: 'build', requestId }, signal))
    },
    async authorizeCreation(requestId, signal, presented) {
      return rememberRequest(
        await request(
          { operation: 'authorize_creation', requestId },
          signal,
          true,
          presented === undefined ? undefined : { kind: 'request', request: presented },
        ),
      )
    },
    async edit(requestId, edits, signal, presented) {
      return rememberRequest(
        await request(
          { operation: 'edit', requestId, edits },
          signal,
          true,
          presented === undefined ? undefined : { kind: 'request', request: presented },
        ),
      )
    },
    async retain(requestId, result, signal, presented) {
      return rememberRequest(
        await request(
          { operation: 'retain', requestId, result },
          signal,
          true,
          presented === undefined ? undefined : { kind: 'request', request: presented },
        ),
      )
    },
  }
}
