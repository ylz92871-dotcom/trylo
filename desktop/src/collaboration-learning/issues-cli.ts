import {
  runCliCommand,
  type CliCommandInput,
  type CliCommandResult,
  type CliCommandControlPort,
} from '../host-adapter/cli-command'
import type { CollaborationLearningRuntime } from './cli'
import type {
  CollaborationIssueViewV1,
  CollaborationIssueControlResultV1,
  CollaborationIssuesClient,
  CollaborationIssuesSnapshotV1,
} from './issues-client'

type Runner = (input: CliCommandInput) => Promise<CliCommandResult>
type JsonRecord = Record<string, unknown>
const object = (value: unknown): value is JsonRecord =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
const text = (value: unknown): value is string =>
  typeof value === 'string' && value.length > 0 && value.length <= 16000
const count = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
const list = <T>(value: unknown, guard: (item: unknown) => item is T): value is T[] =>
  Array.isArray(value) && value.length <= 512 && value.every(guard)
const optionalText = (value: unknown) => value === undefined || text(value)
const texts = (value: unknown): value is string[] => list(value, text)
function scopeIdentity(value: string) {
  const normalized = value.replaceAll('\\', '/').replace(/\/+$/, '')
  return /^[a-z]:\//i.test(normalized) || normalized.startsWith('//')
    ? normalized.toLowerCase()
    : normalized
}
const matches = (left: string, right: string) => scopeIdentity(left) === scopeIdentity(right)

function report(value: unknown): value is CollaborationIssueViewV1['reports'][number] {
  return (
    object(value) &&
    text(value.reportId) &&
    text(value.memberId) &&
    texts(value.facts) &&
    texts(value.suspectedCauses) &&
    texts(value.evidenceRefs)
  )
}
function dependency(value: unknown): value is CollaborationIssueViewV1['dependencies'][number] {
  return (
    object(value) &&
    text(value.dependencyId) &&
    ['tool', 'expert', 'skill'].includes(String(value.owner)) &&
    text(value.state) &&
    optionalText(value.requestId) &&
    optionalText(value.reason) &&
    (value.approvalStage === undefined ||
      value.approvalStage === 'creation' ||
      value.approvalStage === 'retention')
  )
}
function adjustment(value: unknown): value is CollaborationIssueViewV1['adjustments'][number] {
  return (
    object(value) &&
    [value.adjustmentRef, value.title, value.details, value.state].every(text) &&
    texts(value.affectedMembers) &&
    texts(value.experienceVersionIds)
  )
}
function feedback(value: unknown): value is CollaborationIssueViewV1['feedback'][number] {
  return object(value) && text(value.ref) && text(value.summary) && texts(value.sourceRefs)
}
function issue(value: unknown): value is CollaborationIssueViewV1 {
  if (
    !object(value) ||
    ![value.issueId, value.title, value.decision, value.updatedAt].every(text) ||
    !count(value.revision) ||
    !optionalText(value.reason) ||
    !list(value.reports, report) ||
    !list(value.dependencies, dependency) ||
    !list(value.adjustments, adjustment) ||
    !list(value.feedback, feedback)
  )
    return false
  const learning = value.learning
  return (
    learning === undefined ||
    (object(learning) &&
      [learning.jobId, learning.state, learning.grantId].every(text) &&
      learning.unit === 'total_model_tokens' &&
      [learning.allowance, learning.spent, learning.remaining].every(count))
  )
}
export function parseCollaborationIssues(
  stdout: string,
  expectedScope: string,
): CollaborationIssuesSnapshotV1 {
  const value: unknown = JSON.parse(stdout)
  if (
    !object(value) ||
    value.schemaVersion !== 1 ||
    !text(value.scope) ||
    !matches(value.scope, expectedScope) ||
    !list(value.issues, issue)
  )
    throw new Error('invalid_collaboration_issues_reply')
  return { schemaVersion: 1, scope: expectedScope, issues: value.issues }
}
function parseReceipt(stdout: string): CollaborationIssueControlResultV1 {
  const value: unknown = JSON.parse(stdout)
  if (object(value) && value.schemaVersion === 1) {
    if (value.ok === true && count(value.revision))
      return { schemaVersion: 1, ok: true, revision: value.revision }
    if (value.ok === false && text(value.reason))
      return { schemaVersion: 1, ok: false, reason: value.reason }
  }
  throw new Error('invalid_collaboration_control_receipt')
}

/** Native process owner remains the transport authority; this bridge never opens Board files. */
export function createCollaborationIssuesClient(
  runtime: CollaborationLearningRuntime,
  run: Runner = runCliCommand,
  lifecycle?: CliCommandControlPort,
): CollaborationIssuesClient {
  const assertScope = (scope: string) => {
    if (!matches(scope, runtime.cwd)) throw new Error('workspace_scope_mismatch')
  }
  return {
    async read(scope, signal) {
      assertScope(scope)
      const result = await run({
        ...runtime,
        args: ['learn', 'collaboration', 'issues', '--workspace', scope, '--json'],
        signal,
        timeoutMs: 30000,
        ...(lifecycle ? { lifecycle } : {}),
      })
      if (!result.ok) throw new Error(result.reason)
      return parseCollaborationIssues(result.stdout, scope)
    },
    async resolve(scope, control, signal) {
      assertScope(scope)
      if (
        control.schemaVersion !== 1 ||
        control.action !== 'resolve' ||
        !text(control.issueId) ||
        !count(control.expectedRevision) ||
        !text(control.reason) ||
        control.reason.trim() === '' ||
        control.reason.length > 1200
      )
        throw new Error('invalid_collaboration_resolution')
      const result = await run({
        ...runtime,
        args: ['learn', 'collaboration', 'coordinate', '--workspace', scope, '-'],
        stdin: `${JSON.stringify(control)}\n`,
        signal,
        timeoutMs: 30000,
        ...(lifecycle ? { lifecycle } : {}),
      })
      if (!result.ok) throw new Error(result.reason)
      return parseReceipt(result.stdout)
    },
  }
}
