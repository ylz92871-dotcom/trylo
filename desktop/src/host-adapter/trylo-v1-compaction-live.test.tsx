// @vitest-environment jsdom
import { useState } from 'react'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import { expect, it, vi } from 'vitest'
import { createServer } from 'node:http'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { NodeProcessFixture } from './cli-node-process.fixture'
import type { ProcessService } from './process-service'
import type { FilePath } from './types'
import { CodePermissionRegistry } from '../runtime/code-permission-registry'
import { applyEvents } from '../components/chat/events'
import { latestContextTokens, type ChatMessage } from '../components/chat/types'
import { ContextRing } from '../components/app-shell/ContextRing'
const h = vi.hoisted(() => ({ service: null as ProcessService | null }))
vi.mock('./index', () => ({
  hostAdapter: {
    get process() {
      return h.service
    },
  },
}))
vi.mock('../runtime/cli-runtime-guard', () => ({
  verifyCliRuntime: vi.fn(async () => ({ ok: true })),
}))
const { CodeRunController } = await import('../runtime/code-run-controller')

// Opt in with a compiled CLI entry; the regular unit suite owns no CLI build.
it.skipIf(!process.env.TRYLO_DESKTOP_CLI_ENTRY)(
  'clicks the real ring, commits a compact window and resumes with a shorter actual provider request',
  async () => {
    const root = mkdtempSync(join(tmpdir(), 'trylo-compact-'))
    const home = join(root, 'home'),
      workspace = join(root, 'workspace') as FilePath
    mkdirSync(home)
    mkdirSync(workspace)
    writeFileSync(join(workspace, 'package.json'), '{}')
    execFileSync('git', ['init', '--quiet', workspace], { windowsHide: true })
    const requests: { messages: unknown[] }[] = []
    const server = createServer((incoming, outgoing) => {
      let body = ''
      incoming.on('data', (chunk) => {
        body += String(chunk)
      })
      incoming.on('end', () => {
        requests.push(JSON.parse(body))
        const index = requests.length
        outgoing.writeHead(200, { 'content-type': 'text/event-stream' })
        const tool = index <= 2
        const delta = {
          ...(index === 1 ? { content: 'HISTORY_MARKER ' + 'old history '.repeat(8000) } : {}),
          ...(tool
            ? {
                tool_calls: [
                  {
                    index: 0,
                    id: `read-${index}`,
                    type: 'function',
                    function: { name: 'read_file', arguments: '{"path":"package.json"}' },
                  },
                ],
              }
            : { content: index === 3 ? 'FIRST_DONE' : 'AFTER_COMPACTION_OK' }),
        }
        outgoing.write(
          `data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`,
        )
        outgoing.end(
          `data: ${JSON.stringify({
            choices: [{ index: 0, delta: {}, finish_reason: tool ? 'tool_calls' : 'stop' }],
            usage: {
              prompt_tokens: index <= 3 ? 29000 + 1000 * index : 6000,
              completion_tokens: 100,
              total_tokens: index <= 3 ? 29100 + 1000 * index : 6100,
            },
          })}\n\ndata: [DONE]\n\n`,
        )
      })
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const service = new NodeProcessFixture({
      ...process.env,
      TRYLO_HOME: home,
      TRYLO_API_KEY: '',
      TRYLO_OPENAI_API_KEY: '',
    })
    h.service = service
    let refresh = () => {}
    let messages: readonly ChatMessage[] = [
      { id: 'u', kind: 'text', role: 'user', text: 'run', createdAt: 0 },
    ]
    const controller = new CodeRunController({
      projectKey: 'p',
      conversationId: 'c',
      permissions: new CodePermissionRegistry({
        onChange() {},
        send: async (id, line) => {
          await service.send(id as never, line)
          return true
        },
      }),
      onChange: () => refresh(),
    })
    function Harness() {
      const [, setVersion] = useState(0)
      refresh = () => setVersion((n) => n + 1)
      return (
        <ContextRing
          used={latestContextTokens(messages)}
          total={200000}
          onCompact={() => {
            void controller.compact()
          }}
        />
      )
    }
    const view = render(<Harness />)
    const settings = {
      cwd: workspace,
      cliPath: process.env.TRYLO_DESKTOP_CLI_ENTRY as FilePath,
      cliNodeProgram: process.execPath,
      apiFormat: 'openai' as const,
      providerId: 'openai-compatible',
      apiHost: `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`,
      apiModel: 'compact-test',
      apiKey: 'local-test',
    }
    const onEvents = (batch: Parameters<typeof applyEvents>[1]) => {
      messages = applyEvents(messages, batch)
      refresh()
    }
    try {
      await controller.run({
        prompt: 'run',
        settings,
        codeMode: 'agent',
        permissionLevel: 'ask',
        priorMessages: [],
        onEvents,
      })
      await waitFor(() => expect(service.children.size).toBe(0), { timeout: 20000 })
      expect(requests).toHaveLength(3)
      expect(latestContextTokens(messages)).toBe(32000)
      expect(controller.canCompact()).toBe(true)
      fireEvent.click(screen.getByRole('button', { name: '点击压缩上下文' }))
      await waitFor(
        () => expect(messages.some((message) => message.kind === 'compaction')).toBe(true),
        { timeout: 20000 },
      )
      await waitFor(() => expect(service.children.size).toBe(0), { timeout: 12000 })
      expect(requests).toHaveLength(3) // Maintenance itself never asks the model to act on /compact.
      const compact = messages.find((message) => message.kind === 'compaction')
      if (!compact || compact.kind !== 'compaction') throw new Error('compaction missing')
      expect(compact.tokensAfter).toBeLessThan(compact.tokensBefore!)
      const compactedTokens = latestContextTokens(messages)
      expect(compactedTokens).toBe(compact.tokensAfter)
      const turnsBefore = messages.filter((message) => message.kind === 'turn').length
      expect(turnsBefore).toBe(1) // No fabricated empty assistant turn for maintenance.
      await controller.run({
        prompt: 'continue after compaction',
        settings,
        codeMode: 'agent',
        permissionLevel: 'ask',
        priorMessages: [],
        onEvents,
      })
      await waitFor(() => expect(service.children.size).toBe(0), { timeout: 12000 })
      expect(requests).toHaveLength(4)
      expect(JSON.stringify(requests[3]?.messages)).toContain('[compacted history')
      expect(JSON.stringify(requests[3]?.messages).length).toBeLessThan(
        JSON.stringify(requests[2]?.messages).length,
      )
      expect(latestContextTokens(messages)).toBe(6000)
      const journals = readdirSync(join(home, 'sessions')).filter((name) =>
        name.endsWith('.ndjson'),
      )
      expect(journals).toHaveLength(1)
      const records = readFileSync(join(home, 'sessions', journals[0]!), 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line).record)
      expect(records.filter((record) => record.type === 'compact')).toHaveLength(1)
      expect(
        records.some(
          (record) => record.type === 'transcript_item' && record.payload.text === '/compact',
        ),
      ).toBe(false)
      if (process.env.TRYLO_CONTEXT_PROOF_DIR)
        writeFileSync(
          join(process.env.TRYLO_CONTEXT_PROOF_DIR, 'compaction-live.json'),
          JSON.stringify(
            {
              requests: requests.length,
              before: compact.tokensBefore,
              after: compact.tokensAfter,
              finalTokens: latestContextTokens(messages),
              maintenanceModelRequests: 0,
              committedWindows: 1,
              resumedRequestShorter: true,
              maintenanceAssistantTurns: 0,
              processes: service.children.size,
              nativeWindow: false,
            },
            null,
            2,
          ),
        )
    } finally {
      await controller.stop()
      await service.dispose()
      view.unmount()
      server.closeAllConnections()
      server.close()
    }
  },
  60000,
)
