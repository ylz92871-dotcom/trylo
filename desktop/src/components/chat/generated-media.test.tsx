// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { ToolCard } from './ToolCard'
import { Message } from './Message'
import { CodeReasoningTranscript } from './CodeReasoningTranscript'
import type { ToolMessage } from './types'
afterEach(cleanup)
vi.mock('../../tooling/tool-result-store', () => ({
  useBinaryRefObjectUrl: () => ({ url: 'blob:generated-image', failed: false }),
  openCachedToolResource: vi.fn(),
}))

const image: ToolMessage = { id: 'image', kind: 'tool', role: 'assistant', createdAt: 1, tool: 'image_generate', status: 'done', summary: '图片已生成',
  input: { prompt: '安静的工作台' }, outputContent: [{ type: 'image', ref: { id: 'output', storage: 'ephemeral-tool-cache', path: '/cache/image.png',
    mimeType: 'image/png', size: 1000, sha256: 'a'.repeat(64) } }] }

for (const mode of ['Code', 'Work'] as const) it(`${mode} keeps images folded until the user opens the result`, async () => {
  render(mode === 'Code' ? <CodeReasoningTranscript entries={[image]} active={false} turnId="turn" phaseId="phase" workspacePath="D:/task" />
    : <Message message={image} workspacePath="D:/task" />)
  expect(screen.queryByRole('img', { name: '生成的图片' })).toBeNull()
  const disclosure = screen.getByText('1 张图片')
  expect(disclosure.closest('details')?.open).toBe(false)
  fireEvent.click(disclosure)
  await waitFor(() => expect(screen.getByRole('img', { name: '生成的图片' })).toBeTruthy())
  expect(screen.getByRole('button', { name: '查看图片' })).toBeTruthy()
  expect(screen.queryByText('查看原图')).toBeNull()
  fireEvent.click(disclosure)
  await waitFor(() => expect(screen.queryByRole('img', { name: '生成的图片' })).toBeNull())
})

it('keeps the image disclosure available independently of tool details', () => {
  render(<ToolCard variant="event" message={{ id: 'generation', kind: 'tool', role: 'assistant', createdAt: 1,
    tool: 'image_generate', status: 'done', summary: '图片已生成', input: { prompt: '雨夜的小卖部' },
    outputContent: [{ type: 'image', ref: { id: 'image', storage: 'ephemeral-tool-cache', path: '/cache/scene.png',
      mimeType: 'image/png', size: 1000, sha256: 'a'.repeat(64) } }] }} />)
  expect(screen.queryByRole('img', { name: '生成的图片' })).toBeNull()
  expect(screen.getByText('1 张图片').closest('details')?.open).toBe(false)
})
