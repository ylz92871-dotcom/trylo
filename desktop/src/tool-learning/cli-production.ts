import { runCliCommand } from '../host-adapter/cli-command'
import type { ToolLearningRuntime } from './cli-status'
import {
  parseProductionList,
  parseProductionDetail,
  reviewId,
  type ProductionDetail,
  type ProductionLoad,
} from './production-contract'
import { productionVersion, record, text, wireJson } from './wire'

export type ProductionAction =
  | { readonly kind: 'activate'; readonly versionId: string; readonly reviewId: string }
  | { readonly kind: 'verify' | 'suspend' | 'withdraw' | 'rollback'; readonly versionId: string }
export async function loadProductionList(runtime: ToolLearningRuntime, signal: AbortSignal) {
  const result = await runCliCommand({
    ...runtime,
    args: ['tools', 'production-list', '--json'],
    signal,
  })
  return result.ok ? parseProductionList(result.stdout) : result
}
export async function loadProductionDetail(
  runtime: ToolLearningRuntime,
  versionId: string,
  workspaceId: string,
  signal: AbortSignal,
): Promise<ProductionLoad<ProductionDetail>> {
  if (!productionVersion(versionId)) return { ok: false, reason: 'invalid_production_version' }
  const result = await runCliCommand({
    ...runtime,
    args: ['tools', 'production-show', versionId, '--json'],
    signal,
  })
  return result.ok ? parseProductionDetail(result.stdout, versionId, workspaceId) : result
}
/** Explicit user gestures only. CLI remains the authority for permission, receipts and lifecycle transitions. */
export async function runProductionAction(
  runtime: ToolLearningRuntime,
  action: ProductionAction,
  signal: AbortSignal,
): Promise<ProductionLoad<null>> {
  if (
    !productionVersion(action.versionId) ||
    (action.kind === 'activate' && !reviewId(action.reviewId))
  )
    return { ok: false, reason: 'invalid_production_action' }
  const args = ['tools', `production-${action.kind}`, action.versionId, '--json']
  if (action.kind === 'activate') args.push('--approve', action.reviewId)
  if (action.kind === 'verify') args.push('--allow-tools', 'run_shell')
  const result = await runCliCommand({
    ...runtime,
    args,
    signal,
    timeoutMs: action.kind === 'verify' ? 270_000 : 15_000,
  })
  const raw = wireJson(result.stdout ?? '')
  if (!result.ok)
    return {
      ok: false,
      reason: record(raw) && text(raw['code'], 160) ? raw['code'] : result.reason,
    }
  return record(raw) && raw['ok'] === true
    ? { ok: true, value: null }
    : {
        ok: false,
        reason:
          record(raw) && text(raw['code'], 160) ? raw['code'] : 'production_action_unconfirmed',
      }
}
