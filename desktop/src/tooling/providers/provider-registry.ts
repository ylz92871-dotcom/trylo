// Trylo Desktop — DesktopActionProvider registry (WCC-P2-03).
//
// Routing rule (spec §16): providers run BEFORE generic UIA routing — when
// one matches `exact`, the host offers the app-level action set; a `likely`
// match is advisory ( surfaced in observations only); `no` means the
// generic desktop path handles it. Registration order is stable and the
// catalog is pinned by tests (one provider per id).

import type {
  AppIdentity,
  DesktopActionProvider,
  ProviderActionRequest,
  ProviderActionResult,
  ProviderMatch,
  ProviderObservation,
  ProviderObservationRequest,
  ProviderVerificationEvidence,
  ProviderVerificationRequest,
} from './provider-contract'
import { BrowserCdpProvider } from './browser-cdp-provider'

export class ProviderRegistry {
  private readonly providers = new Map<string, DesktopActionProvider>()

  register(provider: DesktopActionProvider): void {
    if (this.providers.has(provider.id)) {
      throw new Error(`duplicate provider id: ${provider.id}`)
    }
    this.providers.set(provider.id, provider)
  }

  list(): readonly DesktopActionProvider[] {
    return [...this.providers.values()]
  }

  /** Best match by confidence; `no` matches never route. */
  route(target: AppIdentity): { provider: DesktopActionProvider; match: ProviderMatch } | null {
    let best: { provider: DesktopActionProvider; match: ProviderMatch } | null = null
    for (const provider of this.providers.values()) {
      const match = provider.match(target)
      if (match.confidence === 'no') continue
      if (match.confidence === 'exact') return { provider, match }
      if (best === null) best = { provider, match }
    }
    return best
  }

  async observe(request: ProviderObservationRequest): Promise<ProviderObservation | null> {
    const routed = this.route(request.identity)
    if (routed === null) return null
    return routed.provider.observe(request)
  }

  /** Execute validates the action exists on the ROUTED provider before
   *  delegating — an action id from provider A can never ride provider B. */
  async execute(
    identity: AppIdentity,
    request: ProviderActionRequest,
  ): Promise<ProviderActionResult> {
    const routed = this.route(identity)
    if (routed === null) {
      return {
        effect: 'unsupported',
        mcpToolName: '',
        detail: 'no provider matched this application',
        warnings: [],
      }
    }
    const known = routed.provider.capabilities().some((c) => c.actionId === request.actionId)
    if (!known) {
      return {
        effect: 'unsupported',
        mcpToolName: '',
        detail: `action ${request.actionId} is not offered by ${routed.provider.id}`,
        warnings: [],
      }
    }
    return routed.provider.execute(request)
  }

  async verify(
    identity: AppIdentity,
    request: ProviderVerificationRequest,
  ): Promise<ProviderVerificationEvidence> {
    const routed = this.route(identity)
    if (routed === null) {
      return {
        verifier: 'registry',
        predicate: 'provider_matched',
        observed: 'no provider matched; nothing to verify',
      }
    }
    return routed.provider.verify(request)
  }
}

/** Production registry: the pinned catalog (one provider in v1). */
export function createProviderRegistry(): ProviderRegistry {
  const registry = new ProviderRegistry()
  registry.register(new BrowserCdpProvider())
  return registry
}

// Type re-exports for call sites that want the contract without importing
// the contract module directly.
export type {
  ActionDescriptor,
  AppIdentity,
  DesktopActionProvider,
  ProviderActionRequest,
  ProviderActionResult,
  ProviderMatch,
  ProviderObservation,
  ProviderObservationRequest,
  ProviderVerificationEvidence,
  ProviderVerificationRequest,
} from './provider-contract'
