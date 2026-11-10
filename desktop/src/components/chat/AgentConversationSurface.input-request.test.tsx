// @vitest-environment jsdom
import { forwardRef, type ReactNode } from 'react'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { AgentConversationSurface } from './AgentConversationSurface'
import { ConversationPresentation } from './ConversationPresentation'
import type { ChatMessage, InputRequestMessage } from './types'

afterEach(cleanup)
vi.mock('react-virtuoso', () => ({
  Virtuoso: forwardRef(function Virtuoso(props: { data: readonly unknown[]; itemContent: (index: number, item: unknown) => ReactNode }, _ref) {
    return <>{props.data.map((item, index) => props.itemContent(index, item))}</>
  }),
}))

const request: InputRequestMessage = {
  id: 'question', requestId: 'native-request', kind: 'input_request', role: 'system', createdAt: 2, status: 'pending',
  questions: [{ id: 'route', header: '创作方式', question: '你希望用哪种方式创作？', options: [{ label: '网页账号', description: '' }, { label: '图片 API', description: '' }] }],
}
const user = { id: 'user', kind: 'text' as const, role: 'user' as const, text: '制作一张图片', createdAt: 1 }

it.each(['code', 'work'] as const)('%s puts questions above the composer, preserves drafts, and sends the original request identity', async surface => {
  const onRespond = vi.fn().mockResolvedValue(true)
  const base = { surface, running: true, emptyState: null, composer: <textarea aria-label="聊天输入" defaultValue="已写好的草稿" />, onRespondInputRequest: onRespond }
  const view = render(<AgentConversationSurface {...base} messages={[user, request]} />)
  const questions = screen.getByRole('region', { name: '待回答的问题' })
  const timeline = screen.getByRole('list', { name: 'Chat' })
  expect(within(timeline).queryByText(request.questions[0]!.question)).toBeNull()
  expect(questions.compareDocumentPosition(screen.getByRole('textbox', { name: '聊天输入' })) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  fireEvent.click(within(questions).getByLabelText('网页账号'))
  fireEvent.click(within(questions).getByRole('button', { name: '提交回答' }))
  await waitFor(() => expect(onRespond).toHaveBeenCalledWith('native-request', 'submitted', { route: { optionLabel: '网页账号' } }))
  view.rerender(<AgentConversationSurface {...base} messages={[user, { ...request, status: 'submitted', answers: { route: { optionLabel: '网页账号' } } }]} />)
  expect(screen.queryByRole('region', { name: '待回答的问题' })).toBeNull()
  expect(within(timeline).queryByText('已回答')).toBeNull()
  expect((screen.getByRole('textbox', { name: '聊天输入' }) as HTMLTextAreaElement).value).toBe('已写好的草稿')
})

it('keeps question payloads out of an embedded timeline as well', () => {
  const timeline = vi.fn((_messages: readonly ChatMessage[]) => <div>成员事件流</div>)
  render(<ConversationPresentation.Provider value={{ embedded: true, timeline }}>
    <AgentConversationSurface surface="work" running messages={[user, request]} emptyState={null} composer={<textarea aria-label="聊天输入" />} onRespondInputRequest={vi.fn()} />
  </ConversationPresentation.Provider>)
  expect(timeline.mock.calls.at(-1)?.[0]).toEqual([user])
  expect(screen.getByRole('region', { name: '待回答的问题' })).toBeTruthy()
})
