import { expect, it } from 'vitest'
import { TryloV1EventAdapter } from './trylo-v1-event-adapter'

it('projects a closed workspace image reference without provider transport data', () => {
  const artifact = { path: 'D:/task/out/scene.png', mimeType: 'image/png', size: 70, sha256: 'a'.repeat(64), base64: 'PRIVATE_IMAGE_DATA' }
  const events = new TryloV1EventAdapter().feed(JSON.stringify({ type: 'tool_result', toolCallId: 'image', name: 'image_generate', status: 'succeeded',
    output: 'Image saved', truncated: false, generatedMedia: [artifact] }))
  const result = events.find(event => event.type === 'tool_result')
  expect(result).toMatchObject({ content: [{ type: 'image', ref: { path: artifact.path, storage: 'workspace-artifact' } }] })
  expect(JSON.stringify(events)).not.toContain('PRIVATE_IMAGE_DATA')
})

it('does not display generated media on a failed result', () => {
  const events = new TryloV1EventAdapter().feed(JSON.stringify({ type: 'tool_result', toolCallId: 'image', name: 'image_generate', status: 'failed',
    output: 'Failed', truncated: false, generatedMedia: [{ path: 'D:/task/out.png', mimeType: 'image/png', size: 70, sha256: 'a'.repeat(64) }] }))
  expect(JSON.stringify(events)).not.toContain('workspace-artifact')
})
