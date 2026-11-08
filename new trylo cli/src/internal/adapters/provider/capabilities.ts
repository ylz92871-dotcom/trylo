/**
 * Per-provider capability declarations (WP PW-1, design decision D1).
 *
 * A capability is something the *adapter itself* declares at runtime, not
 * something the CLI infers, guesses or degrades into. The rule that makes this
 * file worth having is a negative one: an adapter that does not declare a
 * capability is asked for nothing that needs it, and a caller that asks anyway
 * is refused with a name — never handed a silent approximation.
 *
 * Three facts are load-bearing:
 *
 *  - **the key set is closed.** A capability that is not one of
 *    `CAPABILITY_KEYS` cannot be spelled, so "we support something undefined"
 *    is not a state this matrix can be in;
 *  - **an empty model list means "not declared", not "no models".** An
 *    OpenAI-compatible endpoint's catalogue is a fact about the endpoint, and
 *    this process does not ask it. Inventing plausible model names would be
 *    the single most useful-looking lie in the package;
 *  - **refusal is a value, not an exception.** `requireCapability` returns the
 *    denial so a caller can render it, fold it into a doctor row or turn it
 *    into an exit code without catching anything.
 */

/** The closed vocabulary of capabilities a provider may declare. */
export const CAPABILITY_KEYS = ["streaming", "reasoning", "tools", "cancellation"] as const;

export type CapabilityKey = (typeof CAPABILITY_KEYS)[number];

export function isCapabilityKey(value: string): value is CapabilityKey {
  return (CAPABILITY_KEYS as readonly string[]).includes(value);
}

/** How a provider expects to be authenticated. `none` is a real answer, not a
 *  placeholder: the offline fixtures need no credential at all. */
export const PROVIDER_AUTH_TYPES = ["none", "api_key", "oauth"] as const;

export type ProviderAuthType = (typeof PROVIDER_AUTH_TYPES)[number];

export function isProviderAuthType(value: string): value is ProviderAuthType {
  return (PROVIDER_AUTH_TYPES as readonly string[]).includes(value);
}

/**
 * What one provider says about itself.
 *
 * `endpoint` is part of the declaration rather than a separate lookup because
 * "which endpoint" and "what this endpoint can do" are one decision: a caller
 * that resolved one of them twice could hold an endpoint from one provider and
 * the capabilities of another.
 */
export type ProviderCapabilities = {
  /** Declared model ids. Empty means "not declared"; see the file comment. */
  readonly models: ReadonlyArray<string>;
  readonly streaming: boolean;
  readonly reasoning: boolean;
  readonly tools: boolean;
  readonly cancellation: boolean;
  /** How a credential is expected to arrive. Never carries the credential. */
  readonly auth: ProviderAuthType;
  /** Endpoint, when the kind needs one. Empty means "none declared". */
  readonly endpoint: string;
  /**
   * Declared context ceiling in tokens, when the declaration carries one.
   * Absent is *not* a request to invent a ceiling: see `resolver.ts`.
   */
  readonly contextWindow?: number;
};

/** The truth table of one capability, read as a value. */
export function supports(caps: ProviderCapabilities, key: CapabilityKey): boolean {
  switch (key) {
    case "streaming":
      return caps.streaming;
    case "reasoning":
      return caps.reasoning;
    case "tools":
      return caps.tools;
    case "cancellation":
      return caps.cancellation;
    default: {
      const _never: never = key;
      void _never;
      return false;
    }
  }
}

export type CapabilityDenial = {
  readonly code: "unsupported_capability";
  readonly providerId: string;
  readonly capability: CapabilityKey;
};

/**
 * Ask for a capability, and be told no when it is not there.
 *
 * The provider id travels with the denial because the sentence a caller needs
 * is "this provider cannot do this", and a denial without the subject would
 * have to be completed by whoever is lucky enough to still hold the id.
 */
export function requireCapability(
  providerId: string,
  caps: ProviderCapabilities,
  key: CapabilityKey,
): { readonly ok: true } | { readonly ok: false; readonly denial: CapabilityDenial } {
  if (!supports(caps, key)) {
    return { ok: false, denial: { code: "unsupported_capability", providerId, capability: key } };
  }
  return { ok: true };
}

/** Every capability the declaration has, in the closed set's own order. */
export function declaredCapabilities(caps: ProviderCapabilities): ReadonlyArray<CapabilityKey> {
  return CAPABILITY_KEYS.filter((key) => supports(caps, key));
}

/**
 * The one-sentence rendering shared by `providers list`, `providers config`
 * and the doctor row.
 *
 * Undeclared models are the interesting case and are said out loud: "not
 * declared" is information, whereas an empty list printed as nothing reads as
 * "this provider has no models", which is a different and false sentence.
 */
export function renderCapabilities(caps: ProviderCapabilities): string {
  const flags = declaredCapabilities(caps);
  const models = caps.models.length === 0 ? "models=not-declared" : `models=${caps.models.join(",")}`;
  const context =
    caps.contextWindow === undefined ? "context=not-declared" : `context=${caps.contextWindow}`;
  return `${flags.join("|") || "none"} ${models} ${context} auth=${caps.auth}`;
}
