// WCC-P2-03 第二批: provider observe/verify event watchers. The invariants
// pinned here:
//  - the watcher OBSERVES/VERIFIES only — it never emits an MCP call (the
//    模型→CLI→server chain stays untouched; these are result-side hooks);
//  - attribution is keyed on the tool_use/tool_result pair across batches
//    (same pending-map范式 as createSensitiveWindowWatcher);
//  - evidence is bounded and carries structural facts only (verifier /
//    predicate / observed) — no page bodies, no URLs;
//  - CDP tools outside every provider capability table stay unattributed
//    (fail-closed routing display);
//  - a throwing provider.verify() is contained and never breaks ingest.

import { describe, expect, it } from 'vitest'

import { BrowserCdpProvider } from './browser-cdp-provider'
import { ProviderRegistry } from './provider-registry'
import {
  createProviderObservationWatcher,
  providerRoutingLabelForTool,
  routingFactForMcpTool,
  type ProviderObservationWatcher,
} from './provider-observation-watcher'
import type { LoopEvent } from '../../host-adapter/loop-events'
import type { DesktopActionProvider } from './provider-contract'

function toolUse(id: string, toolName: string): LoopEvent {
  return { type: 'tool_use', seq: 1, ts: 1, turn: 1, id, tool: toolName, input: {} } as never
}

function toolResult(id: string, output: string, ok = true): LoopEvent {
  return {
    type: 'tool_result',
    seq: 2,
    ts: 2,
    turn: 1,
    id,
    tool: '',
    ok,
    output,
    durationMs: 1,
  } as never
}

function watcherWith(registry: ProviderRegistry): ProviderObservationWatcher {
  return createProviderObservationWatcher(registry)
}

function productionRegistry(): ProviderRegistry {
  const registry = new ProviderRegistry()
  registry.register(new BrowserCdpProvider())
  return registry
}

describe('routing attribution (capability-table derived)', () => {
  it('maps pinned CDP tools onto their provider + action id', () => {
    const registry = productionRegistry()
    expect(routingFactForMcpTool(registry, 'mcp__trylo-chrome__list_pages')).toEqual({
      providerId: 'browser-cdp',
      mcpToolName: 'mcp__trylo-chrome__list_pages',
      actionId: 'browser.list_pages',
    })
    expect(routingFactForMcpTool(registry, 'mcp__trylo-chrome__navigate_page')).toMatchObject({
      providerId: 'browser-cdp',
      actionId: 'browser.navigate',
    })
  })

  it('leaves unknown CDP tools unattributed (fail-closed display)', () => {
    const registry = productionRegistry()
    expect(routingFactForMcpTool(registry, 'mcp__trylo-chrome__evaluate_script')).toBeNull()
    expect(routingFactForMcpTool(registry, 'mcp__trylo-windows__Snapshot')).toBeNull()
  })

  it('the pure UI helper resolves the provider label without an instance', () => {
    expect(providerRoutingLabelForTool('mcp__trylo-chrome__list_pages')).toBe('browser-cdp')
    expect(providerRoutingLabelForTool('mcp__trylo-windows__Snapshot')).toBeNull()
  })
})

describe('observe/verify over the event stream', () => {
  it('tool_use + tool_result across batches yields observation, routing and evidence', async () => {
    const watcher = watcherWith(productionRegistry())
    // First batch: only the call. No observation, no evidence yet.
    const first = await watcher.ingest([toolUse('tu-1', 'mcp__trylo-chrome__list_pages')], 'conv-1')
    expect(first.observation).toBeNull()
    expect(first.verifications).toHaveLength(0)
    expect(watcher.recentEvidence()).toHaveLength(0)
    // Second batch: the result. The watcher attributes it and verifies.
    const second = await watcher.ingest([toolResult('tu-1', 'Pages: 1 (type: page)')], 'conv-1')
    expect(second.observation?.providerId).toBe('browser-cdp')
    expect(second.observation?.matched).toBe(true)
    expect(second.observation?.availableActions.map((a) => a.actionId)).toContain(
      'browser.list_pages',
    )
    expect(second.routings).toEqual([
      {
        providerId: 'browser-cdp',
        mcpToolName: 'mcp__trylo-chrome__list_pages',
        actionId: 'browser.list_pages',
      },
    ])
    expect(second.verifications).toHaveLength(1)
    const record = second.verifications[0]!
    expect(record).toMatchObject({
      toolCallId: 'tu-1',
      conversationId: 'conv-1',
      mcpToolName: 'mcp__trylo-chrome__list_pages',
      routedTo: 'browser-cdp',
      actionId: 'browser.list_pages',
      ok: true,
    })
    // The evidence is the provider's own honest verdict.
    expect(record.evidence.verifier).toBe('browser-cdp@1.0.0')
    // Bounded buffers expose the same record for diagnostics.
    expect(watcher.recentEvidence()).toHaveLength(1)
    expect(watcher.recentObservations()).toHaveLength(1)
  })

  it('verify stays honest: navigation results do not claim confirmed success', async () => {
    const watcher = watcherWith(productionRegistry())
    await watcher.ingest([toolUse('tu-2', 'mcp__trylo-chrome__navigate_page')], 'conv-1')
    const outcome = await watcher.ingest([toolResult('tu-2', 'navigated')], 'conv-1')
    const record = outcome.verifications[0]!
    expect(record.evidence.observed).toContain('stays unknown')
  })

  it('unattributed results (no tracked tool_use, foreign tools) yield nothing', async () => {
    const watcher = watcherWith(productionRegistry())
    // A result with no preceding tool_use is not ours to attribute.
    const orphan = await watcher.ingest([toolResult('tu-x', 'Pages: 1 (type: page)')], 'conv-1')
    expect(orphan.observation).toBeNull()
    expect(orphan.verifications).toHaveLength(0)
    expect(orphan.routings).toHaveLength(0)
    // A windows tool result never routes to a provider.
    await watcher.ingest([toolUse('tu-3', 'mcp__trylo-windows__Snapshot')], 'conv-1')
    const windows = await watcher.ingest([toolResult('tu-3', 'snapshot text')], 'conv-1')
    expect(windows.observation).toBeNull()
    expect(windows.routings).toHaveLength(0)
    expect(windows.verifications).toHaveLength(0)
    expect(watcher.recentEvidence()).toHaveLength(0)
  })

  it('evidence buffers stay bounded and diagnostics-safe', async () => {
    const registry = productionRegistry()
    const watcher = watcherWith(registry)
    for (let i = 0; i < 80; i += 1) {
      await watcher.ingest([toolUse(`tu-${i}`, 'mcp__trylo-chrome__list_pages')], 'conv-1')
      await watcher.ingest([toolResult(`tu-${i}`, `pages ${i}`)], 'conv-1')
    }
    expect(watcher.recentEvidence().length).toBeLessThanOrEqual(64)
    expect(watcher.recentObservations().length).toBeLessThanOrEqual(16)
    // The carried evidence never includes the result text — only the
    // provider's structural predicate summary.
    for (const record of watcher.recentEvidence()) {
      expect(Object.keys(record.evidence).sort()).toEqual(['observed', 'predicate', 'verifier'])
      expect(record.evidence.observed).not.toMatch(/pages \d+/)
    }
  })

  it('a throwing provider.verify() never breaks ingest', async () => {
    const broken: DesktopActionProvider = {
      id: 'broken',
      version: '1.0.0',
      match: (t) =>
        t.appClass === 'browser'
          ? { confidence: 'exact', reason: 'x' }
          : { confidence: 'no', reason: 'no' },
      capabilities: () => [],
      observe: async () => ({
        providerId: 'broken',
        matched: true,
        availableActions: [],
        warnings: [],
      }),
      execute: async () => ({ effect: 'unsupported', mcpToolName: '', detail: '', warnings: [] }),
      verify: async () => {
        throw new Error('boom')
      },
    }
    const registry = new ProviderRegistry()
    registry.register(broken)
    const watcher = watcherWith(registry)
    await watcher.ingest([toolUse('tu-9', 'mcp__trylo-chrome__list_pages')], 'conv-1')
    const outcome = await watcher.ingest([toolResult('tu-9', 'text')], 'conv-1')
    // Observation + routing survive; the failed verification is contained.
    expect(outcome.observation?.providerId).toBe('broken')
    expect(outcome.routings).toHaveLength(0)
    expect(outcome.verifications).toHaveLength(0)
    expect(watcher.recentEvidence()).toHaveLength(0)
  })
})
