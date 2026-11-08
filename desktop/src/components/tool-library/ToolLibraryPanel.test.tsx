import { act, fireEvent, render, screen, waitFor, cleanup, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ToolLibraryPanel } from './ToolLibraryPanel'
import { createToolLibraryClient } from '../../tool-library/client'

afterEach(cleanup)
const item = {
  id: 'runtime:read_file',
  name: 'read_file',
  description: '读取工作区文件',
  capabilities: ['read_file'],
  source: { kind: 'builtin', label: 'Trylo' },
  availability: { state: 'available' },
  configured: false,
  configuration: 'configurable',
  runtimeName: 'read_file',
}
const reply = { ok: true, value: { formatVersion: 1, items: [item], total: 1 } }

describe('tool library panel', () => {
  it('reads the complete catalog object and returns to the same tool without changing configuration', async () => {
    const invoke = vi.fn(async () => reply)
    render(<ToolLibraryPanel client={createToolLibraryClient(invoke)} context={{ memberId: 'personal', scope: 'workspace' }} />)
    const open = await screen.findByRole('button', { name: '阅读完整工具说明' })
    open.focus()
    fireEvent.click(open)
    const reader = screen.getByRole('region', { name: '学习文档阅读' })
    expect(within(reader).getByRole('heading', { name: '可做什么' })).toBeTruthy()
    fireEvent.click(within(reader).getByRole('button', { name: '源码' }))
    expect(reader.textContent).toContain('runtime:read_file')
    expect(reader.textContent).toContain('"configured": false')
    fireEvent.click(within(reader).getByRole('button', { name: '返回工具库' }))
    expect(document.activeElement).toBe(open)
    expect(invoke).toHaveBeenCalledTimes(1)
  })
  it('shows source/environment/member facts and sends selected IDs to the existing configuration owner', async () => {
    let configured = false
    const invoke = vi.fn(async (_context, command) => {
      if (command.operation === 'query')
        return { ...reply, value: { ...reply.value, items: [{ ...item, configured }] } }
      configured = true
      return { ok: true, value: [] }
    })
    const client = createToolLibraryClient(invoke)
    render(
      <ToolLibraryPanel client={client} context={{ memberId: 'personal', scope: 'workspace' }} />,
    )
    const tool = await screen.findByRole('checkbox', {
      name: /内置\s*·\s*环境可用\s*·\s*成员未配置/,
    })
    fireEvent.click(tool)
    fireEvent.click(screen.getByRole('button', { name: '查看 read_file 来源和状态' }))
    expect(screen.getByRole('complementary', { name: '工具详情' })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '保存成员工具配置' }))
    await screen.findByText('成员工具配置已保存，后续任务会使用此选择。')
    expect(invoke.mock.calls[1]?.[1]).toEqual({
      operation: 'configure',
      toolIds: ['runtime:read_file'],
    })
    expect(invoke.mock.calls.filter((call) => call[1].operation === 'query')).toHaveLength(2)
    expect((screen.getByRole('checkbox') as HTMLInputElement).checked).toBe(true)
  })
  it('reports a saved configuration separately when rereading the original owner fails', async () => {
    let saved = false
    const invoke = vi.fn(async (_context, command) => {
      if (command.operation !== 'query') {
        saved = true
        return { ok: true, value: [] }
      }
      return saved ? { ok: false, code: 'read_failed', message: '暂时无法读取配置' } : reply
    })
    render(
      <ToolLibraryPanel
        client={createToolLibraryClient(invoke)}
        context={{ memberId: 'personal_agent', scope: 'workspace' }}
      />,
    )
    await screen.findByRole('checkbox')
    fireEvent.click(screen.getByRole('button', { name: '保存成员工具配置' }))
    await screen.findByText(/配置已保存，但状态刷新失败/)
    expect(screen.queryByRole('checkbox')).toBeNull()
    expect(screen.getByRole('button', { name: '刷新' })).toBeTruthy()
  })
  it('ignores a late query after switching member and rejects malformed transport data', async () => {
    let finish!: (value: unknown) => void
    const first = new Promise((resolve) => {
      finish = resolve
    })
    const invoke = vi
      .fn()
      .mockReturnValueOnce(first)
      .mockResolvedValue({ ok: true, value: { broken: true } })
    const client = createToolLibraryClient(invoke)
    const view = render(
      <ToolLibraryPanel client={client} context={{ memberId: 'old', scope: 'workspace' }} />,
    )
    view.rerender(
      <ToolLibraryPanel client={client} context={{ memberId: 'new', scope: 'workspace' }} />,
    )
    await screen.findByText(/invalid_library_reply/)
    await act(async () => finish(reply))
    expect(screen.queryByRole('checkbox')).toBeNull()
  })
  it('keeps incomplete catalogs from overwriting hidden configuration and exposes acquisition refusal', async () => {
    const invoke = vi.fn(async (_context, command) =>
      command.operation === 'query'
        ? { ...reply, value: { ...reply.value, total: 300 } }
        : { ok: false, code: 'acquisition_not_approved', message: '需要用户同意' },
    )
    render(
      <ToolLibraryPanel
        client={createToolLibraryClient(invoke)}
        context={{ memberId: 'personal', scope: 'workspace' }}
      />,
    )
    await screen.findByText(/目录超过本次显示上限/)
    expect(
      (screen.getByRole('button', { name: '保存成员工具配置' }) as HTMLButtonElement).disabled,
    ).toBe(true)
    fireEvent.change(screen.getByLabelText('补齐所需能力'), { target: { value: '绘制工程图' } })
    fireEvent.click(screen.getByRole('button', { name: '提交需求' }))
    await waitFor(() => expect(screen.getByText(/acquisition_not_approved/)).toBeTruthy())
  })
  it('rereads the exact focused capability request when refreshing the catalog', async () => {
    let requestReads = 0
    const invoke = vi.fn(async (_context, command) =>
      command.operation === 'get-request'
        ? {
            ok: true,
            value: {
              requestId: command.requestId,
              state: 'queued',
              capability: ++requestReads === 1 ? '需要核对表格' : '需要核对表格的最新处理结果',
              toolIds: [],
            },
          }
        : reply,
    )
    render(
      <ToolLibraryPanel
        client={createToolLibraryClient(invoke)}
        context={{ memberId: 'personal', scope: 'workspace' }}
        initialRequestId="request:focused"
      />,
    )
    await screen.findByText('需要核对表格 · queued')
    await waitFor(() => expect((screen.getByRole('button', { name: '刷新' }) as HTMLButtonElement).disabled).toBe(false))
    fireEvent.click(screen.getByRole('button', { name: '刷新' }))
    await screen.findByText('需要核对表格的最新处理结果 · queued')
    expect(invoke.mock.calls.filter((call) => call[1].operation === 'get-request')).toEqual([
      [{ memberId: 'personal', scope: 'workspace' }, { operation: 'get-request', requestId: 'request:focused' }, expect.any(AbortSignal)],
      [{ memberId: 'personal', scope: 'workspace' }, { operation: 'get-request', requestId: 'request:focused' }, expect.any(AbortSignal)],
    ])
  })
  it('ignores a focused request reply from the previous workspace', async () => {
    let finish!: (value: unknown) => void
    const first = new Promise((resolve) => { finish = resolve })
    const request = (capability: string) => ({
      ok: true,
      value: { requestId: 'request:focused', state: 'queued', capability, toolIds: [] },
    })
    const invoke = vi.fn(async (context, command) =>
      command.operation === 'get-request'
        ? context.scope === 'old-workspace' ? first : request('当前工作区需求')
        : reply,
    )
    const client = createToolLibraryClient(invoke)
    const view = render(
      <ToolLibraryPanel client={client} context={{ memberId: 'personal', scope: 'old-workspace' }} initialRequestId="request:focused" />,
    )
    view.rerender(
      <ToolLibraryPanel client={client} context={{ memberId: 'personal', scope: 'new-workspace' }} initialRequestId="request:focused" />,
    )
    await screen.findByText('当前工作区需求 · queued')
    await act(async () => finish(request('上个工作区需求')))
    expect(screen.queryByText('上个工作区需求 · queued')).toBeNull()
    expect(screen.getByText('当前工作区需求 · queued')).toBeTruthy()
  })
})
