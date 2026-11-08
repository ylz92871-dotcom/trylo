import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type {
  ExpertConfiguration,
  ExpertRequest,
  ExpertVersion,
} from '../../../new trylo cli/src/internal/subagent/experts/contracts'
import { ExpertLibraryPanel } from './ExpertLibraryPanel'
import { ExpertSelector } from './ExpertSelector'
import { createExpertLibraryClient, type ExpertCommand } from './client'

afterEach(cleanup)

const configuration: ExpertConfiguration = {
  displayName: '前端无障碍专家',
  specialty: '可访问性审查',
  situations: ['组件交付'],
  responsibilities: ['检查键盘导航'],
  constraints: ['保留用户约束'],
  collaboration: ['向验收成员交接问题'],
  baseRole: 'worker',
  role: { name: 'worker', description: '无障碍实现', skills: ['a11y'] },
  toolRefs: ['runtime:read_file'],
  methods: [
    {
      title: '键盘检查',
      instructions: '逐项检查焦点顺序',
      sourceUris: ['https://www.w3.org/WAI/'],
    },
  ],
  sources: [
    { kind: 'official', title: 'WAI', uri: 'https://www.w3.org/WAI/', excerpt: '键盘导航方法' },
  ],
}
const expert: ExpertVersion = {
  expertId: 'expert-a11y',
  experienceKey: 'expert:expert-a11y',
  version: 2,
  requestId: 'saved-request',
  createdAt: 1,
  configuration,
}
const draft: ExpertRequest = {
  requestId: 'request-1',
  expertId: expert.expertId,
  experienceKey: expert.experienceKey,
  origin: 'settings',
  instruction: '专项前端无障碍审查',
  state: 'awaiting_retention',
  revision: 1,
  createdAt: 1,
  baseVersion: 2,
  userEdits: {},
  configuration,
  creationAuthorization: 'permission:create',
}

describe('expert settings and selection contracts', () => {
  it('starts with saved expertise rather than a creation form and keeps the full configuration readable', async () => {
    const invoke = vi.fn(async (command: ExpertCommand) => command.operation === 'query' ? [expert] : [])
    render(<ExpertLibraryPanel client={createExpertLibraryClient({ invoke })} />)
    const open = await screen.findByRole('button', { name: '阅读完整专家说明' })
    expect(screen.queryByRole('button', { name: '同意创建并构建' })).toBeNull()
    expect(screen.getByText('逐项检查焦点顺序')).toBeTruthy()
    fireEvent.click(open)
    const reader = screen.getByRole('region', { name: '学习文档阅读' })
    expect(reader.textContent).toContain('工作方法')
    expect(reader.textContent).toContain('键盘检查')
    expect(invoke.mock.calls.every(([command]) => ['query', 'requests'].includes(command.operation))).toBe(true)
  })
  it('creates after a user action, builds an authorized draft, and saves only on a separate gesture', async () => {
    const userAction = vi.fn(async (command: ExpertCommand) => {
      if (command.operation === 'submit')
        return { ...draft, state: 'authorized', configuration: undefined }
      if (command.operation === 'retain')
        return { ...draft, state: 'saved', retentionAuthorization: 'permission:retain' }
      throw new Error('unexpected action')
    })
    const invoke = vi.fn(async (command: ExpertCommand) => {
      if (command.operation === 'query' || command.operation === 'requests') return []
      if (command.operation === 'build') return draft
      throw new Error('unexpected command')
    })
    render(
      <ExpertLibraryPanel
        client={createExpertLibraryClient({ invoke, invokeUserAction: userAction })}
      />,
    )
    await screen.findByText('还没有长期保存的专家。')
    fireEvent.change(screen.getByLabelText('用自然语言描述专家'), {
      target: { value: draft.instruction },
    })
    fireEvent.click(screen.getByRole('button', { name: '同意创建并构建' }))
    await screen.findByRole('button', { name: '长期保存' })
    expect(userAction).toHaveBeenCalledTimes(1)
    expect(invoke).toHaveBeenCalledWith(
      expect.objectContaining({ operation: 'build', requestId: draft.requestId }),
      expect.any(AbortSignal),
    )
    fireEvent.click(screen.getByRole('button', { name: '长期保存' }))
    await waitFor(() =>
      expect(userAction).toHaveBeenCalledWith(
        expect.objectContaining({ operation: 'retain', result: { kind: 'save' } }),
        expect.any(AbortSignal),
        { kind: 'request', request: draft },
      ),
    )
    await screen.findByText('已长期保存')
  })

  it('keeps failed operations visible and does not report a failed save as persisted', async () => {
    const client = createExpertLibraryClient({
      invoke: vi.fn(async (command: ExpertCommand) => {
        if (command.operation === 'query') return []
        if (command.operation === 'requests') return [draft]
        throw new Error('存储暂时不可用')
      }),
    })
    render(<ExpertLibraryPanel client={client} />)
    fireEvent.click(await screen.findByRole('button', { name: /继续审核/ }))
    fireEvent.click(screen.getByRole('button', { name: '长期保存' }))
    await screen.findByRole('alert')
    expect(screen.getByRole('alert').textContent).toContain('存储暂时不可用')
    expect(screen.queryByText('已长期保存')).toBeNull()
  })

  it('returns a stable expert version for the dispatch boundary and labels unresolved tools honestly', async () => {
    const selected = vi.fn()
    const client = createExpertLibraryClient({
      invoke: vi.fn(async (command: ExpertCommand) => {
        if (command.operation === 'query') return [expert]
        throw new Error('unexpected command')
      }),
    })
    render(<ExpertSelector client={client} onSelect={selected} />)
    fireEvent.click(await screen.findByRole('button', { name: '选用 前端无障碍专家' }))
    expect(selected).toHaveBeenCalledWith({
      expertId: expert.expertId,
      version: 2,
      experienceKey: expert.experienceKey,
    })
    expect(screen.getByText('工具将在派发时解析并检查权限')).toBeTruthy()
  })

  it('preserves multiline user edits and an explicit empty tool allowlist before retention', async () => {
    const invoke = vi.fn(async (command: ExpertCommand) => {
      if (command.operation === 'query') return []
      if (command.operation === 'requests') return [draft]
      if (command.operation === 'edit')
        return { ...draft, revision: 2, configuration: { ...configuration, ...command.edits } }
      throw new Error('unexpected command')
    })
    render(<ExpertLibraryPanel client={createExpertLibraryClient({ invoke })} />)
    fireEvent.click(await screen.findByRole('button', { name: /继续审核/ }))
    const responsibilities = screen.getByLabelText('职责（每行一项）') as HTMLTextAreaElement
    fireEvent.change(responsibilities, { target: { value: '检查键盘导航\n' } })
    expect(responsibilities.value).toBe('检查键盘导航\n')
    expect((screen.getByRole('button', { name: '长期保存' }) as HTMLButtonElement).disabled).toBe(
      true,
    )
    fireEvent.change(responsibilities, { target: { value: '检查键盘导航\n检查焦点恢复' } })
    fireEvent.change(screen.getByLabelText('允许工具的方式'), { target: { value: 'selected' } })
    fireEvent.click(screen.getByRole('button', { name: '应用配置修改' }))
    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith(
        expect.objectContaining({
          operation: 'edit',
          edits: expect.objectContaining({
            responsibilities: ['检查键盘导航', '检查焦点恢复'],
            role: expect.objectContaining({ allowedTools: [] }),
          }),
        }),
        expect.any(AbortSignal),
      ),
    )
    const submittedEdit = invoke.mock.calls
      .map(([command]) => command)
      .find((command) => command.operation === 'edit')
    if (submittedEdit?.operation !== 'edit') throw new Error('No configuration edit was submitted')
    expect(submittedEdit.edits).not.toHaveProperty('specialty')
    expect(submittedEdit.edits).not.toHaveProperty('constraints')
    await waitFor(() =>
      expect((screen.getByRole('button', { name: '长期保存' }) as HTMLButtonElement).disabled).toBe(
        false,
      ),
    )
  })

  it('rejects malformed transport success data instead of displaying a saved expert', async () => {
    const client = createExpertLibraryClient({
      invoke: vi.fn(async () => [{ expertId: expert.expertId, version: 2 }]),
    })
    await expect(client.query('', new AbortController().signal)).rejects.toThrow(
      'Invalid expert version',
    )
  })

  it('opens a saved expert configuration for direct edits without invoking the builder', async () => {
    const invoke = vi.fn(async (command: ExpertCommand) => {
      if (command.operation === 'query') return [expert]
      if (command.operation === 'requests') return []
      throw new Error('Direct edits must not invoke the builder')
    })
    const invokeUserAction = vi.fn(async () => draft)
    render(<ExpertLibraryPanel client={createExpertLibraryClient({ invoke, invokeUserAction })} />)
    fireEvent.click(await screen.findByRole('button', { name: /前端无障碍专家.*可访问性审查/ }))
    fireEvent.click(screen.getByRole('button', { name: '编辑配置' }))
    await screen.findByLabelText('职责（每行一项）')
    expect(invokeUserAction).toHaveBeenCalledWith(
      { operation: 'draft_revision', expertId: expert.expertId },
      expect.any(AbortSignal),
      { kind: 'expert', expert },
    )
    expect(invoke.mock.calls.map(([command]) => command.operation)).not.toContain('build')
  })

  it('does not offer an implementation expert to a read-only review seat', async () => {
    const onSelect = vi.fn()
    const client = createExpertLibraryClient({ invoke: vi.fn(async () => [expert]) })
    render(<ExpertSelector client={client} targetRole="reviewer" onSelect={onSelect} />)
    const button = await screen.findByRole('button', { name: '选用 前端无障碍专家' })
    expect((button as HTMLButtonElement).disabled).toBe(true)
    fireEvent.click(button)
    expect(onSelect).not.toHaveBeenCalled()
    expect(screen.getByText('基础席位不相容，请选择审查专家')).toBeTruthy()
  })
})
