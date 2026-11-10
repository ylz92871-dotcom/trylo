import type { PackageRiskClassifier, ToolRiskDecision } from '../tool-risk-classifier'
import { inputDigestOf } from '../input-digest'
import type { ApprovalPreview } from '../../approval/approval-preview'

export const SOFTWARE_TOOL_NAMES = [
  'software_status',
  'software_open',
  'software_snapshot',
  'software_input',
  'software_view',
  'software_resize',
  'software_close',
] as const

export function buildSoftwareApprovalPreview({
  toolName,
  input,
}: {
  readonly toolName: string
  readonly input: Readonly<Record<string, unknown>>
}): ApprovalPreview {
  const name = toolName.split('__').pop()
  const launch = name === 'software_open' && typeof input.path === 'string'
  return {
    kind: launch ? 'command' : 'desktop',
    title:
      name === 'software_close' ? '关闭软件工作区（未保存的内容会丢失）' : '操作后台软件工作区',
    actionLabel: name,
    reason: '操作仅发生在本对话的后台软件中。',
    ...(launch
      ? {
          target: input.path as string,
          command: [
            input.path,
            ...(Array.isArray(input.args)
              ? input.args.filter((value): value is string => typeof value === 'string')
              : []),
          ]
            .map((value) => JSON.stringify(value))
            .join(' '),
        }
      : {}),
    ...(name === 'software_input' && typeof input.text === 'string'
      ? { textChars: input.text.length }
      : {}),
  }
}

export const softwareWorkspaceClassifier: PackageRiskClassifier = {
  id: 'software-workspace',
  serverName: 'trylo-software',
  expectedTools: SOFTWARE_TOOL_NAMES.map((name) => `mcp__trylo-software__${name}`),
  classify(context): ToolRiskDecision {
    const name = context.toolName.split('__').pop()
    const read = name === 'software_status' || name === 'software_snapshot'
    const behavior =
      read || context.permissionLevel === 'unrestricted'
        ? 'auto_allow'
        : context.permissionLevel === 'read_only'
          ? 'deny'
          : 'prompt'
    const reasonCode = read ? 'software_workspace_observation' : `software_workspace_${behavior}`
    const risk = read ? 'read' : 'workspace-write'
    const audit = {
      at: context.at,
      profileId: context.profileId,
      packageId: context.packageId,
      toolName: context.toolName,
      behavior,
      risk,
      reasonCode,
      inputDigest: inputDigestOf(context.input),
      pathZones: [],
    } as const
    if (behavior === 'auto_allow') return { behavior, risk, reasonCode, audit }
    if (behavior === 'deny')
      return {
        behavior,
        reasonCode,
        userMessage: '当前对话为只读模式，不能启动或操作软件。',
        audit,
      }
    return {
      behavior,
      risk: name === 'software_close' ? 'destructive' : 'sensitive',
      reasonCode,
      audit: { ...audit, risk: name === 'software_close' ? 'destructive' : 'sensitive' },
      preview: buildSoftwareApprovalPreview(context),
    }
  },
}
