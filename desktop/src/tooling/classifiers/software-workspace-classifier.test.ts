import { describe, expect, it } from 'vitest'
import { createToolRiskClassifier } from '../tool-risk-classifier'
import { SOFTWARE_TOOL_NAMES } from './software-workspace-classifier'
import { buildApprovalPreview } from '../../approval/approval-preview'

describe('software workspace permission chain', () => {
  const router = createToolRiskClassifier()
  const request = {
    input: {},
    projectRoot: 'D:/project',
    conversationId: 'conversation',
    profileId: 'code.core.v1',
    managedPackageIds: ['software-workspace'],
  }
  it('automatic mode admits each shipped tool without an extra permission layer', () => {
    for (const name of SOFTWARE_TOOL_NAMES)
      expect(
        router.classify({
          ...request,
          toolName: `mcp__trylo-software__${name}`,
          permissionLevel: 'unrestricted',
        }),
      ).toMatchObject({ behavior: 'auto_allow' })
  })
  it('read-only can observe its owned application but cannot mutate it', () => {
    for (const name of SOFTWARE_TOOL_NAMES)
      expect(
        router.classify({
          ...request,
          toolName: `mcp__trylo-software__${name}`,
          permissionLevel: 'read_only',
        }).behavior,
      ).toBe(['software_status', 'software_snapshot'].includes(name) ? 'auto_allow' : 'deny')
  })
  it('disabled packages stay unmanaged and unknown tools are rejected', () => {
    expect(
      router.classify({
        ...request,
        managedPackageIds: [],
        toolName: 'mcp__trylo-software__software_open',
        permissionLevel: 'unrestricted',
      }).behavior,
    ).toBe('unmanaged')
    expect(
      router.classify({
        ...request,
        toolName: 'mcp__trylo-software__run_arbitrary',
        permissionLevel: 'unrestricted',
      }).behavior,
    ).toBe('deny')
  })
  it('interactive mode uses the existing approval preview without echoing typed secrets', () => {
    const result = router.classify({
      ...request,
      toolName: 'mcp__trylo-software__software_input',
      input: { kind: 'text', text: 'private-value' },
      permissionLevel: 'ask',
    })
    expect(result.behavior).toBe('prompt')
    expect(JSON.stringify(result)).not.toContain('private-value')
  })
  it('both approval surfaces show the complete executable arguments before launch', async () => {
    const result = await buildApprovalPreview({ toolName: 'mcp__trylo-software__software_open',
      input: { path: 'C:/tools/python.exe', args: ['-c', 'print("review this code")'] }, projectRoot: 'D:/project' as import('../../host-adapter/types').FilePath })
    expect(result.kind).toBe('command')
    expect(result.command).toContain('-c')
    expect(result.command).toContain('review this code')
  })
})
