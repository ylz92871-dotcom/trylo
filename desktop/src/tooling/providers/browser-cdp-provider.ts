// Trylo Desktop — Browser CDP provider (WCC-P2-03, spec §16 首批 #1).
//
// Routes app-level browser actions to the PINNED Chrome DevTools MCP
// surface (`mcp__trylo-chrome__*`, 29 tools — manifest + classifier agree).
// Design constraints:
//  - never raw CDP sockets: every action maps to ONE pinned MCP tool call
//    that the existing risk classifier already gates (defense in depth —
//    provider routing does not bypass approval);
//  - no arbitrary script execution exposed through this provider:
//    `evaluate_script` is deliberately NOT in capabilities (§16 禁止项);
//  - actions without a deterministic verification predicate refuse to
//    claim confirmed_success — they return unknown_outcome with an honest
//    detail instead.

import type {
  ActionDescriptor,
  AppIdentity,
  DesktopActionProvider,
  ProviderActionResult,
  ProviderMatch,
  ProviderObservation,
  ProviderObservationRequest,
  ProviderActionRequest,
  ProviderVerificationEvidence,
  ProviderVerificationRequest,
} from './provider-contract'
import { validateAgainstSchema, type SchemaViolation } from './provider-json-schema'

export const BROWSER_CDP_PROVIDER_ID = 'browser-cdp'
export const BROWSER_CDP_PROVIDER_VERSION = '1.0.0'
export const CHROME_MCP_SERVER_NAME = 'trylo-chrome'

function cdpTool(tool: string): string {
  return `mcp__${CHROME_MCP_SERVER_NAME}__${tool}`
}

/** The app-level actions v1 routes. Deliberately narrow: navigation and
 *  page lifecycle only. Interaction (click/fill/…) stays with the snapshot-
 *  uid flow the CDP MCP server already defines; routing those through an
 *  app-level provider adds a second targeting vocabulary without a second
 *  capability. */
const NAVIGATE: ActionDescriptor = {
  actionId: 'browser.navigate',
  mcpToolName: cdpTool('navigate_page'),
  inputSchema: {
    type: 'object',
    properties: { url: { type: 'string', description: 'http/https URL' } },
    required: ['url'],
  },
  resultSchema: { type: 'object' },
  sideEffect: 'external_communication',
  interactionPolicy: 'background_only',
  retryClass: 'verify_before_retry',
  supportsProgress: false,
  supportsCancellation: false,
  supportsUndo: false,
}

const NEW_PAGE: ActionDescriptor = {
  actionId: 'browser.new_page',
  mcpToolName: cdpTool('new_page'),
  inputSchema: {
    type: 'object',
    properties: { url: { type: 'string', description: 'http/https URL' } },
    required: ['url'],
  },
  resultSchema: { type: 'object' },
  sideEffect: 'external_communication',
  interactionPolicy: 'background_only',
  retryClass: 'verify_before_retry',
  supportsProgress: false,
  supportsCancellation: false,
  supportsUndo: false,
}

const LIST_PAGES: ActionDescriptor = {
  actionId: 'browser.list_pages',
  mcpToolName: cdpTool('list_pages'),
  inputSchema: { type: 'object', properties: {} },
  resultSchema: { type: 'object' },
  sideEffect: 'read',
  interactionPolicy: 'background_only',
  retryClass: 'idempotent',
  supportsProgress: false,
  supportsCancellation: false,
  supportsUndo: false,
}

const SCREENSHOT: ActionDescriptor = {
  actionId: 'browser.screenshot',
  mcpToolName: cdpTool('take_screenshot'),
  // No filePath: in-page capture stays a read; file writes go through the
  // classifier's file-write rules instead.
  inputSchema: { type: 'object', properties: {} },
  resultSchema: { type: 'object' },
  sideEffect: 'read',
  interactionPolicy: 'background_only',
  retryClass: 'idempotent',
  supportsProgress: false,
  supportsCancellation: false,
  supportsUndo: false,
}

const CAPABILITIES: readonly ActionDescriptor[] = Object.freeze([
  LIST_PAGES,
  NAVIGATE,
  NEW_PAGE,
  SCREENSHOT,
])

const CAPABILITY_BY_ID = new Map(CAPABILITIES.map((c) => [c.actionId, c]))

/** http/https only, no credentials — mirrors the CDP classifier's URL rules
 *  (the classifier remains the authority; this is provider-side pre-check). */
function isRoutableUrl(value: unknown): boolean {
  if (typeof value !== 'string' || value.length === 0 || value.length > 2048) {
    return false
  }
  try {
    const url = new URL(value)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return false
    if (url.username || url.password) return false
    return true
  } catch {
    return false
  }
}

export class BrowserCdpProvider implements DesktopActionProvider {
  readonly id = BROWSER_CDP_PROVIDER_ID
  readonly version = BROWSER_CDP_PROVIDER_VERSION

  match(target: AppIdentity): ProviderMatch {
    if (target.appClass === 'browser') {
      if (target.browser && target.browser.vendor === 'chrome') {
        return { confidence: 'exact', reason: 'chrome application identity' }
      }
      return { confidence: 'likely', reason: 'browser application identity' }
    }
    const process = (target.processName ?? '').toLowerCase()
    if (process === 'chrome' || process === 'msedge') {
      return { confidence: 'likely', reason: `browser process ${process}` }
    }
    return { confidence: 'no', reason: 'not a browser target' }
  }

  capabilities(): readonly ActionDescriptor[] {
    return CAPABILITIES
  }

  async observe(request: ProviderObservationRequest): Promise<ProviderObservation> {
    const match = this.match(request.identity)
    return {
      providerId: this.id,
      matched: match.confidence !== 'no',
      availableActions: match.confidence === 'no' ? [] : CAPABILITIES,
      warnings: match.confidence === 'likely' ? ['matched on class, not exact vendor'] : [],
    }
  }

  async execute(request: ProviderActionRequest): Promise<ProviderActionResult> {
    const descriptor = CAPABILITY_BY_ID.get(request.actionId)
    if (!descriptor) {
      return {
        effect: 'unsupported',
        mcpToolName: '',
        detail: `unknown action ${request.actionId}`,
        warnings: [],
      }
    }
    const violations: readonly SchemaViolation[] = validateAgainstSchema(
      descriptor.inputSchema,
      request.input,
    )
    if (violations.length > 0) {
      return {
        effect: 'refused',
        mcpToolName: descriptor.mcpToolName,
        detail: `input rejected: ${violations.map((v) => `${v.path} ${v.problem}`).join('; ')}`,
        warnings: [],
      }
    }
    // URL-shaped actions carry the same http/https, no-credentials rule as
    // the CDP classifier's navigation flow.
    const url = request.input['url']
    if (url !== undefined && !isRoutableUrl(url)) {
      return {
        effect: 'refused',
        mcpToolName: descriptor.mcpToolName,
        detail: 'url must be http/https without credentials',
        warnings: [],
      }
    }
    return {
      // v1 executes nothing itself: the host routes descriptor.mcpToolName
      // through the pinned MCP call and classifier gating; effect stays
      // unknown until verify() sees the MCP result.
      effect: 'unknown_outcome',
      mcpToolName: descriptor.mcpToolName,
      detail: `routed to ${descriptor.mcpToolName}; effect pending MCP result`,
      warnings: [],
    }
  }

  async verify(request: ProviderVerificationRequest): Promise<ProviderVerificationEvidence> {
    // Verification is honest by construction: only actions whose MCP result
    // carries machine-checkable state may confirm. list_pages/screenshot
    // results arriving as postState confirm only on well-formed output.
    if (request.actionId === 'browser.list_pages' && request.postState) {
      const text = JSON.stringify(request.postState)
      if (text.includes('"type": "page"') || text.includes('list_pages')) {
        return {
          verifier: `${this.id}@${this.version}`,
          predicate: 'browser.list_pages_result_wellformed',
          observed: 'post-state contained a page listing',
        }
      }
      return {
        verifier: `${this.id}@${this.version}`,
        predicate: 'browser.list_pages_result_wellformed',
        observed: 'post-state did not contain a page listing',
      }
    }
    return {
      verifier: `${this.id}@${this.version}`,
      predicate: `${request.actionId}.effect_verified`,
      observed: 'no deterministic predicate for this action; effect stays unknown',
    }
  }
}
