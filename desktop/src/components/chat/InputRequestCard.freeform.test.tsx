// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { expect, it, vi } from 'vitest'
import { InputRequestCard } from './InputRequestCard'

it('submits a free-text account question without inventing a selected option', async () => {
  const onRespond = vi.fn().mockResolvedValue(true)
  render(<InputRequestCard onRespond={onRespond} message={{ id: 'q', kind: 'input_request', role: 'system', createdAt: 1,
    requestId: 'accounts', status: 'pending', questions: [{ id: 'sites', header: '网页账号', question: '你有哪些可用的网页创作账号？', options: [] }] }} />)
  fireEvent.change(screen.getByRole('textbox'), { target: { value: '我有即梦账号，可以由我登录。' } })
  fireEvent.click(screen.getByRole('button', { name: '提交回答' }))
  await waitFor(() => expect(onRespond).toHaveBeenCalledWith('accounts', 'submitted', {
    sites: { otherText: '我有即梦账号，可以由我登录。' },
  }))
})
