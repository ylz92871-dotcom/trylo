// WCC-P2-03: provider contract, registry routing, and the browser CDP
// provider. The security invariants pinned here:
//  - execute() validates input against the action's declared schema and
//    refuses malformed/URL-unsafe input BEFORE anything routes;
//  - evaluate_script / upload_file / interaction actions are deliberately
//    NOT capabilities (no arbitrary script execution through providers);
//  - execute() itself never claims confirmed_success — routing and effect
//    are separated exactly like ActionResult;
//  - registry: cross-provider action ids cannot ride the wrong provider.

import { describe, expect, it } from 'vitest'

import { BROWSER_CDP_PROVIDER_ID, BrowserCdpProvider } from './browser-cdp-provider'
import { ProviderRegistry, createProviderRegistry } from './provider-registry'
import { validateAgainstSchema } from './provider-json-schema'
import type { AppIdentity, DesktopActionProvider } from './provider-contract'

const CHROME: AppIdentity = {
  appClass: 'browser',
  browser: { vendor: 'chrome' },
  processName: 'chrome',
}
const NOTEPAD: AppIdentity = { appClass: 'unknown', processName: 'notepad' }
const EDGE: AppIdentity = { appClass: 'browser', browser: { vendor: 'edge' } }

describe('browser-cdp provider matching', () => {
  it('matches chrome exactly, other browsers likely, non-browsers not at all', () => {
    const provider = new BrowserCdpProvider()
    expect(provider.match(CHROME)).toMatchObject({ confidence: 'exact' })
    expect(provider.match(EDGE)).toMatchObject({ confidence: 'likely' })
    expect(provider.match(NOTEPAD)).toMatchObject({ confidence: 'no' })
  })

  it('capabilities exclude script execution and interaction tools', () => {
    const provider = new BrowserCdpProvider()
    const ids = provider.capabilities().map((c) => c.actionId)
    expect(ids).toEqual([
      'browser.list_pages',
      'browser.navigate',
      'browser.new_page',
      'browser.screenshot',
    ])
    // §16 禁止项: no arbitrary script execution surface.
    expect(ids).not.toContain('browser.evaluate_script')
  })

  it('every capability maps to a pinned trylo-chrome MCP tool', () => {
    const provider = new BrowserCdpProvider()
    for (const capability of provider.capabilities()) {
      expect(capability.mcpToolName).toMatch(/^mcp__trylo-chrome__\w+$/)
    }
  })
})

describe('execute() input validation', () => {
  const provider = new BrowserCdpProvider()

  it('refuses malformed input by schema before routing', async () => {
    const result = await provider.execute({
      actionId: 'browser.navigate',
      input: {},
      interactionPolicy: 'background_only',
    })
    expect(result.effect).toBe('refused')
    expect(result.detail).toContain('missing required property')
  })

  it('refuses non-http URLs and credential-carrying URLs', async () => {
    for (const url of [
      'file:///C:/x',
      'javascript:alert(1)',
      'https://u:p@example.com',
      'not a url',
    ]) {
      const result = await provider.execute({
        actionId: 'browser.navigate',
        input: { url },
        interactionPolicy: 'background_only',
      })
      expect(result.effect).toBe('refused')
      expect(result.detail).toContain('http/https')
    }
  })

  it('accepts a well-formed https URL as routed (unknown_outcome, never confirmed)', async () => {
    const result = await provider.execute({
      actionId: 'browser.navigate',
      input: { url: 'https://example.com/guide' },
      interactionPolicy: 'background_only',
    })
    expect(result.effect).toBe('unknown_outcome')
    expect(result.mcpToolName).toBe('mcp__trylo-chrome__navigate_page')
  })

  it('unsupported action ids are refused, not guessed', async () => {
    const result = await provider.execute({
      actionId: 'browser.evaluate_script',
      input: { script: '1+1' },
      interactionPolicy: 'background_only',
    })
    expect(result.effect).toBe('unsupported')
  })
})

describe('verify() honesty', () => {
  it('list_pages confirms only on a well-formed page listing', async () => {
    const provider = new BrowserCdpProvider()
    const confirmed = await provider.verify({
      actionId: 'browser.list_pages',
      mcpToolName: 'mcp__trylo-chrome__list_pages',
      input: {},
      postState: { pages: [{ type: 'page' }] },
    })
    expect(confirmed.observed).toContain('page listing')
    const empty = await provider.verify({
      actionId: 'browser.list_pages',
      mcpToolName: 'mcp__trylo-chrome__list_pages',
      input: {},
      postState: { pages: [] },
    })
    expect(empty.observed).toContain('did not contain')
  })

  it('navigation has no deterministic predicate: stays unknown', async () => {
    const provider = new BrowserCdpProvider()
    const evidence = await provider.verify({
      actionId: 'browser.navigate',
      mcpToolName: 'mcp__trylo-chrome__navigate_page',
      input: { url: 'https://example.com' },
    })
    expect(evidence.observed).toContain('stays unknown')
  })
})

describe('registry routing', () => {
  it('routes the best provider and guards cross-provider action ids', async () => {
    const registry = new ProviderRegistry()
    registry.register(new BrowserCdpProvider())

    const routed = registry.route(CHROME)
    expect(routed?.provider.id).toBe(BROWSER_CDP_PROVIDER_ID)
    expect(registry.route(NOTEPAD)).toBeNull()

    // An action id unknown to the routed provider cannot execute there.
    const result = await registry.execute(CHROME, {
      actionId: 'some.other.action',
      input: {},
      interactionPolicy: 'background_only',
    })
    expect(result.effect).toBe('unsupported')
    expect(result.detail).toContain('not offered by')
  })

  it('a second provider with a duplicate id is rejected at registration', () => {
    const registry = new ProviderRegistry()
    registry.register(new BrowserCdpProvider())
    expect(() => registry.register(new BrowserCdpProvider())).toThrow('duplicate provider id')
  })

  it('exact match wins over a likely match regardless of registration order', async () => {
    const likelyFirst: DesktopActionProvider = {
      id: 'generic-browser',
      version: '1.0.0',
      match: (t) =>
        t.appClass === 'browser'
          ? { confidence: 'likely', reason: 'generic' }
          : { confidence: 'no', reason: 'no' },
      capabilities: () => [],
      observe: async () => ({
        providerId: 'generic-browser',
        matched: true,
        availableActions: [],
        warnings: [],
      }),
      execute: async () => ({ effect: 'unsupported', mcpToolName: '', detail: '', warnings: [] }),
      verify: async () => ({ verifier: 'x', predicate: 'p', observed: 'o' }),
    }
    const registry = new ProviderRegistry()
    registry.register(likelyFirst)
    registry.register(new BrowserCdpProvider())
    expect(registry.route(CHROME)?.provider.id).toBe(BROWSER_CDP_PROVIDER_ID)
  })

  it('the production registry ships the pinned catalog', () => {
    const registry = createProviderRegistry()
    expect(registry.list().map((p) => p.id)).toEqual([BROWSER_CDP_PROVIDER_ID])
  })
})

describe('schema validation helper', () => {
  it('validates nested objects and enums', () => {
    const violations = validateAgainstSchema(
      {
        type: 'object',
        properties: {
          mode: { type: 'string', enum: ['a', 'b'] },
          nested: {
            type: 'object',
            required: ['x'],
            properties: { x: { type: 'number' } },
          },
        },
        required: ['mode'],
      },
      { mode: 'a', nested: { x: 'not-a-number' } },
    )
    expect(violations).toHaveLength(1)
    expect(violations[0]?.path).toBe('$.nested.x')
  })
})
