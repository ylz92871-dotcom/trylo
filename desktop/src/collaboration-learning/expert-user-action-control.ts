import {
  EXPERT_APPROVAL_REVIEW_MAX_BYTES,
  validateConfiguration,
  validateRequest,
  validateVersion,
} from '../../../new trylo cli/src/internal/subagent/experts/browser'
import type { ExpertCommand, ExpertUserActionEvidence } from '../experts/client'
import type { ExpertRequest } from '../../../new trylo cli/src/internal/subagent/experts/contracts'
import type { CliCommandControlPort } from '../host-adapter/cli-command'
import type { ControlFrame } from '../host-adapter/control-protocol'

type PermissionFrame = Extract<ControlFrame, { kind: 'permission' }>
type Options = {
  readonly command: ExpertCommand
  readonly evidence?: ExpertUserActionEvidence
  readonly workspaceRoot: string
  readonly control: CliCommandControlPort
  readonly signal: AbortSignal
  readonly createId?: () => string
  readonly digest?: (bytes: Uint8Array) => Promise<string>
}

/** Local evidence of a UI gesture. It never enters command JSON or creates a CLI
 * privilege: the normal PermissionPort must still issue the exact stdio request. */
export function expertUserActionControl(options: Options): {
  readonly command: ExpertCommand
  readonly control: CliCommandControlPort
} {
  const createId = options.createId ?? (() => crypto.randomUUID())
  const digest = options.digest ?? sha256
  const original = structuredClone(options.command)
  const command =
    original.operation === 'submit' || original.operation === 'draft_revision'
      ? { ...original, requestId: original.requestId ?? createId() }
      : original
  const evidence = options.evidence === undefined ? undefined : structuredClone(options.evidence)
  const stage = expectedStage(command)
  let state: 'available' | 'checking' | 'consumed' | 'closed' = 'available'
  let processId: string | undefined
  const active = (): boolean => state !== 'closed' && !options.signal.aborted
  const fallback = (frame: ControlFrame, id: string): void => options.control.receive(frame, id)
  return {
    command,
    control: {
      ...options.control,
      acquired(handle, stop, reservationId, confirmExit) {
        processId = handle.id
        options.control.acquired?.(handle, stop, reservationId, confirmExit)
      },
      clearProcess(id) {
        if (id === processId) state = 'closed'
        options.control.clearProcess(id)
      },
      receive(frame, id) {
        if (frame.kind === 'cancel') {
          if (id === processId && state === 'checking') state = 'closed'
          fallback(frame, id)
          return
        }
        if (
          frame.kind !== 'permission' ||
          stage === undefined ||
          frame.toolName !== `expert_library.${stage}` ||
          state !== 'available' ||
          processId !== id ||
          options.signal.aborted ||
          options.control.respondToUserAction === undefined
        ) {
          fallback(frame, id)
          return
        }
        state = 'checking'
        void (async () => {
          const matches = await matchesReview(
            frame,
            command,
            evidence,
            options.workspaceRoot,
            digest,
          )
          if (state !== 'checking' || options.signal.aborted) return
          state = 'consumed'
          if (!matches) {
            fallback(frame, id)
            return
          }
          if (!(await options.control.respondToUserAction!(frame, id)) && active())
            fallback(frame, id)
        })().catch(() => {
          // Failed verification/delivery falls back to the original pending approval;
          // it never becomes local consent or a second automatic response attempt.
          if (state !== 'closed' && !options.signal.aborted) {
            state = 'consumed'
            fallback(frame, id)
          }
        })
      },
    },
  }
}

function expectedStage(command: ExpertCommand): string | undefined {
  switch (command.operation) {
    case 'submit':
    case 'draft_revision':
    case 'authorize_creation':
      return 'create'
    case 'edit':
      return 'edit'
    case 'retain':
      return command.result.kind === 'save' ? 'retain' : undefined
    case 'archive':
      return 'archive'
    default:
      return undefined
  }
}

async function matchesReview(
  frame: PermissionFrame,
  command: ExpertCommand,
  evidence: ExpertUserActionEvidence | undefined,
  workspaceRoot: string,
  digest: (bytes: Uint8Array) => Promise<string>,
): Promise<boolean> {
  const input = frame.input
  if (
    frame.requester !== undefined ||
    !Object.keys(input).every((key) =>
      ['requestId', 'stage', 'fingerprint', 'summary', 'reviewJson'].includes(key),
    ) ||
    input.stage !== expectedStage(command) ||
    typeof input.requestId !== 'string' ||
    typeof input.summary !== 'string' ||
    typeof input.fingerprint !== 'string' ||
    !/^[a-f0-9]{64}$/.test(input.fingerprint) ||
    typeof input.reviewJson !== 'string'
  )
    return false
  const bytes = new TextEncoder().encode(input.reviewJson)
  if (
    bytes.byteLength > EXPERT_APPROVAL_REVIEW_MAX_BYTES ||
    (await digest(bytes)) !== input.fingerprint
  )
    return false
  const value: unknown = JSON.parse(input.reviewJson)
  if (command.operation === 'archive') {
    const version = validateVersion(value)
    return (
      evidence?.kind === 'expert' &&
      version.expertId === command.expertId &&
      version.requestId === input.requestId &&
      same(version, evidence.expert)
    )
  }
  const request = validateRequest(value)
  if (request.requestId !== input.requestId) return false
  if (command.operation === 'submit' || command.operation === 'draft_revision')
    return matchesCreation(request, command, evidence, workspaceRoot)
  if (
    !('requestId' in command) ||
    command.requestId !== request.requestId ||
    evidence?.kind !== 'request'
  )
    return false
  if (command.operation === 'edit') {
    const configuration = validateConfiguration({
      ...evidence.request.configuration,
      ...command.edits,
    })
    return same(request, { ...evidence.request, configuration })
  }
  return same(request, evidence.request)
}

function matchesCreation(
  request: ExpertRequest,
  command: Extract<ExpertCommand, { operation: 'submit' | 'draft_revision' }>,
  evidence: ExpertUserActionEvidence | undefined,
  workspaceRoot: string,
): boolean {
  const previous = evidence?.kind === 'expert' ? evidence.expert : undefined
  if (
    request.requestId !== command.requestId ||
    request.state !== 'awaiting_creation' ||
    request.revision !== 0 ||
    request.creationAuthorization !== undefined ||
    request.retentionAuthorization !== undefined ||
    (command.expertId !== undefined &&
      (previous?.expertId !== command.expertId || request.expertId !== command.expertId)) ||
    request.baseVersion !== (previous?.version ?? 0) ||
    !same(request.configuration, previous?.configuration) ||
    request.experienceKey !== (previous?.experienceKey ?? `expert:${request.expertId}`) ||
    request.useScope === undefined ||
    scope(request.useScope.workspaceId) !== scope(workspaceRoot) ||
    !request.useScope.taskId.trim()
  )
    return false
  if (previous === undefined && Object.keys(request.userEdits).length !== 0) return false
  if (command.operation === 'draft_revision')
    return (
      request.origin === 'settings' &&
      request.preparation === 'reuse_configuration' &&
      request.association === undefined
    )
  return (
    request.origin === command.origin &&
    request.instruction === command.instruction &&
    same(request.association, command.association) &&
    (request.preparation ?? 'build') === 'build'
  )
}

function same(left: unknown, right: unknown): boolean {
  if (left === right) return true
  if (Array.isArray(left) && Array.isArray(right))
    return left.length === right.length && left.every((value, index) => same(value, right[index]))
  if (
    !left ||
    !right ||
    typeof left !== 'object' ||
    typeof right !== 'object' ||
    Array.isArray(left) ||
    Array.isArray(right)
  )
    return false
  const a = left as Record<string, unknown>,
    b = right as Record<string, unknown>
  return (
    Object.keys(a).length === Object.keys(b).length &&
    Object.keys(a).every((key) => Object.hasOwn(b, key) && same(a[key], b[key]))
  )
}
const scope = (value: string): string =>
  value.replaceAll('\\', '/').replace(/\/+$/, '').toLowerCase()
async function sha256(bytes: Uint8Array): Promise<string> {
  const hash = await crypto.subtle.digest('SHA-256', bytes)
  return [...new Uint8Array(hash)].map((byte) => byte.toString(16).padStart(2, '0')).join('')
}
