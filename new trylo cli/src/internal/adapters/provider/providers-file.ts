import type { CapabilityKey, ProviderAuthType, ProviderCapabilities } from "./capabilities.js";
import { CAPABILITY_KEYS, isProviderAuthType } from "./capabilities.js";

/**
 * The declared-providers document: read, write, refuse.
 *
 * This file is pure. It never touches a disk, never resolves a home directory
 * and never decides *where* the document lives — that is the caller's job —
 * because the same decode has to serve the CLI (which knows the profile root)
 * and tests (which hand it a string).
 *
 * The shape follows the成熟 precedent of a *separate* providers file rather
 * than a new section in the settings schema: cline keeps `providers.json`
 * beside its settings, and opencode keeps provider declarations in config while
 * credentials live in `auth.json`. Two reasons survive import into this repo:
 *
 *  - the closed settings schema is owned elsewhere and is not this package's
 *    to widen (`OPEN-PW-1`);
 *  - a provider declaration names an endpoint, and an endpoint is the first
 *    thing a person will want to share, diff or delete without touching the
 *    rest of their configuration.
 *
 * Every rejection is a `code`, never a thrown exception and never a partially
 * filled document: a file that cannot be trusted is a file the caller must be
 * able to *say* is untrustworthy, and half a provider list would be worse than
 * none because it would look like the rest of the list was complete.
 */

export const PROVIDERS_DOCUMENT_VERSION = 1;

/**
 * The implementation families a declaration may name. Mirrors the CLI's
 * `--provider` vocabulary; `registry.test.ts` asserts the two sets are equal,
 * so a drift is a failing test rather than a surprise at run time.
 *
 * `openai-responses` (WP18.2: C68) is declarable but has no built-in entry:
 * the wire is chosen per declaration, never by sniffing, and the default
 * path stays byte for byte the run path it was. Both keyed families share
 * the one credential family (see `isKeyedProviderKind`).
 */
export const PROVIDER_KINDS = [
  "fixture",
  "fixture-write",
  "fixture-subagent",
  "openai-compatible",
  "openai-responses",
] as const;

export type ProviderKind = (typeof PROVIDER_KINDS)[number];

export function isProviderKind(value: string): value is ProviderKind {
  return (PROVIDER_KINDS as readonly string[]).includes(value);
}

/**
 * Whether a family authenticates through the shared keyed credential family
 * (`openai-compatible` in the ledger and `TRYLO_*_API_KEY` in the
 * environment). Responses endpoints take the same API key as their Chat
 * Completions siblings: a second family would be a second ledger for the same
 * account, which is exactly the half-old/half-new credential D3 forbids.
 */
export function isKeyedProviderKind(kind: ProviderKind): boolean {
  return kind === "openai-compatible" || kind === "openai-responses";
}

/** One user-declared provider, exactly as the file spells it. */
export type DeclaredProvider = {
  readonly id: string;
  readonly kind: ProviderKind;
  readonly endpoint: string;
  readonly model: string;
  readonly capabilities: ProviderCapabilities;
  /**
   * The ledger account this declaration binds to, when it names one.
   *
   * Absent means "whatever that family's current account is", which is the
   * behaviour every declaration had before binding existed. Naming one is how a
   * person with two keys for two hosts says *which* key belongs to *this*
   * endpoint; without it the family's current pointer decides, and switching
   * accounts for one host silently re-points the other.
   */
  readonly accountId?: string;
}

export type ProvidersDocument = {
  readonly version: typeof PROVIDERS_DOCUMENT_VERSION;
  /** The provider a run selects when nothing else names one. */
  readonly selected?: string;
  readonly providers: ReadonlyArray<DeclaredProvider>;
};

export type DocumentFailureCode =
  | "not_json"
  | "bad_shape"
  | "bad_version"
  | "unknown_field"
  | "bad_entry"
  | "reserved_id"
  | "duplicate_id";

export type DocumentFailure = {
  readonly code: DocumentFailureCode;
  readonly detail: string;
};

export type DecodeResult =
  | { readonly ok: true; readonly value: ProvidersDocument }
  | { readonly ok: false; readonly failure: DocumentFailure };

const TOP_LEVEL_FIELDS = ["version", "selected", "providers"] as const;
const ENTRY_FIELDS = [
  "id",
  "kind",
  "endpoint",
  "model",
  "accountId",
  "models",
  "auth",
  "streaming",
  "reasoning",
  "tools",
  "cancellation",
  "contextWindow",
] as const;

/** Provider ids the file may not redefine: the four shipped ones. */
const RESERVED_IDS: ReadonlyArray<string> = [...PROVIDER_KINDS];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function str(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function bool(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

/**
 * Unknown fields are refused rather than ignored.
 *
 * A declaration nobody reads is a declaration that quietly does nothing, and
 * this is exactly the file where a typo would otherwise look accepted: every
 * key here is optional, so there is no missing-key error to catch it.
 */
function unknownField(record: Record<string, unknown>, allowed: ReadonlyArray<string>): string | undefined {
  return Object.keys(record).find((key) => !allowed.includes(key));
}

/**
 * One entry's capability block.
 *
 * The three booleans default to the *kind's* truth rather than to `true`: a
 * declaration that says nothing about reasoning must not acquire reasoning.
 */
export function capabilitiesFor(
  kind: ProviderKind,
  entry: Record<string, unknown>,
): ProviderCapabilities {
  return {
    models: Array.isArray(entry["models"])
      ? entry["models"].filter((item): item is string => typeof item === "string")
      : [],
    streaming: bool(entry["streaming"]) ?? true,
    reasoning: bool(entry["reasoning"]) ?? false,
    tools: bool(entry["tools"]) ?? true,
    cancellation: bool(entry["cancellation"]) ?? true,
    auth: authFor(kind, entry),
    endpoint: str(entry["endpoint"]) ?? "",
  };
}

/** The credential shape, defaulted per kind: only the keyed families need one. */
function authFor(kind: ProviderKind, entry: Record<string, unknown>): ProviderAuthType {
  const declared = str(entry["auth"]);
  if (declared !== undefined && isProviderAuthType(declared)) {
    return declared;
  }
  return isKeyedProviderKind(kind) ? "api_key" : "none";
}

function contextWindowOf(entry: Record<string, unknown>): number | undefined {
  const raw = entry["contextWindow"];
  return typeof raw === "number" && Number.isFinite(raw) && raw > 0 ? raw : undefined;
}

function entryOf(raw: unknown, index: number): DeclaredProvider | DocumentFailure {
  if (!isRecord(raw)) {
    return { code: "bad_entry", detail: `providers[${index}] is not an object` };
  }

  const unknown = unknownField(raw, ENTRY_FIELDS);
  if (unknown !== undefined) {
    return { code: "unknown_field", detail: `providers[${index}].${unknown} is not a known field` };
  }

  const id = str(raw["id"])?.trim() ?? "";
  const kind = str(raw["kind"]) ?? "";

  if (id.length === 0) {
    return { code: "bad_entry", detail: `providers[${index}].id is required` };
  }

  if (!isProviderKind(kind)) {
    return { code: "bad_entry", detail: `providers[${index}].kind is not supported: ${kind}` };
  }

  if (RESERVED_IDS.includes(id)) {
    return { code: "reserved_id", detail: `providers[${index}].id redefines a built-in provider: ${id}` };
  }

  const capabilities = capabilitiesFor(kind, raw);
  const contextWindow = contextWindowOf(raw);
  const accountId = str(raw["accountId"])?.trim() ?? "";

  return {
    id,
    kind,
    endpoint: capabilities.endpoint,
    model: str(raw["model"]) ?? "",
    ...(accountId.length === 0 ? {} : { accountId }),
    capabilities:
      contextWindow === undefined ? capabilities : { ...capabilities, contextWindow },
  };
}

export function decodeDocument(text: string): DecodeResult {
  let parsed: unknown;

  try {
    parsed = JSON.parse(text);
  } catch {
    return { ok: false, failure: { code: "not_json", detail: "file is not valid JSON" } };
  }

  if (!isRecord(parsed)) {
    return { ok: false, failure: { code: "bad_shape", detail: "document is not an object" } };
  }

  const unknown = unknownField(parsed, TOP_LEVEL_FIELDS);
  if (unknown !== undefined) {
    return { ok: false, failure: { code: "unknown_field", detail: `${unknown} is not a known field` } };
  }

  if (parsed["version"] !== PROVIDERS_DOCUMENT_VERSION) {
    return {
      ok: false,
      failure: { code: "bad_version", detail: `version must be ${PROVIDERS_DOCUMENT_VERSION}` },
    };
  }

  const rawProviders = parsed["providers"];
  if (!Array.isArray(rawProviders)) {
    return { ok: false, failure: { code: "bad_shape", detail: "providers must be an array" } };
  }

  const providers: DeclaredProvider[] = [];
  const seen = new Set<string>();

  for (let index = 0; index < rawProviders.length; index += 1) {
    const entry = entryOf(rawProviders[index], index);
    if (!("id" in entry)) {
      return { ok: false, failure: entry };
    }

    if (seen.has(entry.id)) {
      return { ok: false, failure: { code: "duplicate_id", detail: `duplicate provider id: ${entry.id}` } };
    }

    seen.add(entry.id);
    providers.push(entry);
  }

  const selected = str(parsed["selected"])?.trim();

  return {
    ok: true,
    value: {
      version: PROVIDERS_DOCUMENT_VERSION,
      ...(selected === undefined || selected.length === 0 ? {} : { selected }),
      providers,
    },
  };
}

/** The inverse of `decodeDocument`, for the writers (`add`/`switch`/`remove`/`edit`). */
export function encodeDocument(doc: ProvidersDocument): string {
  const providers = doc.providers.map((entry) => ({
    id: entry.id,
    kind: entry.kind,
    endpoint: entry.endpoint,
    model: entry.model,
    ...(entry.accountId === undefined ? {} : { accountId: entry.accountId }),
    models: [...entry.capabilities.models],
    auth: entry.capabilities.auth,
    streaming: entry.capabilities.streaming,
    reasoning: entry.capabilities.reasoning,
    tools: entry.capabilities.tools,
    cancellation: entry.capabilities.cancellation,
    ...(entry.capabilities.contextWindow === undefined
      ? {}
      : { contextWindow: entry.capabilities.contextWindow }),
  }));
  return `${JSON.stringify(
    {
      version: PROVIDERS_DOCUMENT_VERSION,
      ...(doc.selected === undefined ? {} : { selected: doc.selected }),
      providers,
    },
    null,
    2,
  )}\n`;
}

/** Which capability keys exist, restated for callers that render the matrix. */
export function capabilityKeys(): ReadonlyArray<CapabilityKey> {
  return [...CAPABILITY_KEYS];
}

/** The named fields `providers edit` may change. Absent means "keep". */
export type DeclarationPatch = {
  readonly endpoint?: string;
  readonly model?: string;
  readonly accountId?: string;
  readonly contextWindow?: number;
};

export type RemoveEditFailure =
  | { readonly code: "reserved_id"; readonly detail: string }
  | { readonly code: "unknown_provider"; readonly detail: string; readonly known: ReadonlyArray<string> }
  | { readonly code: "missing_field"; readonly detail: string };

/** Ids no writer may touch, in the order refusals list them. */
function knownIdsOf(doc: ProvidersDocument): ReadonlyArray<string> {
  return [...PROVIDER_KINDS, ...doc.providers.map((entry) => entry.id)];
}

function declaredTarget(
  doc: ProvidersDocument,
  id: string,
): { readonly ok: true; readonly index: number } | { readonly ok: false; readonly failure: RemoveEditFailure } {
  if (RESERVED_IDS.includes(id)) {
    return { ok: false, failure: { code: "reserved_id", detail: `${id} is a built-in provider and cannot be changed` } };
  }

  const index = doc.providers.findIndex((entry) => entry.id === id);
  if (index < 0) {
    return {
      ok: false,
      failure: { code: "unknown_provider", detail: `unknown provider: ${id}`, known: knownIdsOf(doc) },
    };
  }

  return { ok: true, index };
}

/**
 * Drop one declaration. When it was the selection, the selection goes with
 * it — a `selected` pointing at nothing is a run that resolves against a ghost
 * (absent means the built-in default, the same state a fresh machine is in).
 */
export function removeDeclared(
  doc: ProvidersDocument,
  id: string,
):
  | { readonly ok: true; readonly value: ProvidersDocument; readonly clearedSelected: boolean }
  | { readonly ok: false; readonly failure: RemoveEditFailure } {
  const target = declaredTarget(doc, id);
  if (!target.ok) {
    return target;
  }

  // `selected` is rebuilt rather than spread: spreading `...doc` would carry a
  // selection that points at the entry just removed.
  const value: ProvidersDocument = {
    version: doc.version,
    ...(doc.selected === undefined || doc.selected === id ? {} : { selected: doc.selected }),
    providers: doc.providers.filter((entry) => entry.id !== id),
  };

  return { ok: true, value, clearedSelected: doc.selected === id };
}

/**
 * Patch one declaration's named fields. Unnamed fields — including the account
 * binding — are kept verbatim: only an explicit `accountId` rebinds, so moving
 * an endpoint never silently re-points the key it is sent.
 */
export function editDeclared(
  doc: ProvidersDocument,
  id: string,
  patch: DeclarationPatch,
):
  | { readonly ok: true; readonly value: ProvidersDocument; readonly changed: ReadonlyArray<string> }
  | { readonly ok: false; readonly failure: RemoveEditFailure } {
  const target = declaredTarget(doc, id);
  if (!target.ok) {
    return target;
  }

  const empty = (["endpoint", "model", "accountId"] as const)
    .filter((key) => patch[key] !== undefined)
    .filter((key) => (patch[key] ?? "").trim().length === 0);
  if (empty.length > 0) {
    return { ok: false, failure: { code: "missing_field", detail: `providers edit needs non-empty ${empty.join(" and ")}` } };
  }

  const current = doc.providers[target.index];
  if (current === undefined) {
    return {
      ok: false,
      failure: { code: "unknown_provider", detail: `unknown provider: ${id}`, known: knownIdsOf(doc) },
    };
  }

  const endpoint = patch.endpoint === undefined ? current.endpoint : patch.endpoint.trim();
  const model = patch.model === undefined ? current.model : patch.model.trim();

  if (patch.contextWindow !== undefined && (!Number.isInteger(patch.contextWindow) || patch.contextWindow <= 0)) {
    return { ok: false, failure: { code: "missing_field", detail: "providers edit needs a positive integer --context-window" } };
  }

  const changed = [
    ...(patch.endpoint === undefined ? [] : ["endpoint"]),
    ...(patch.model === undefined ? [] : ["model"]),
    ...(patch.accountId === undefined ? [] : ["account"]),
    ...(patch.contextWindow === undefined ? [] : ["context-window"]),
  ];
  const next: DeclaredProvider = {
    ...current,
    endpoint,
    model,
    ...(patch.accountId === undefined
      ? current.accountId === undefined
        ? {}
        : { accountId: current.accountId }
      : { accountId: patch.accountId.trim() }),
    capabilities: {
      ...current.capabilities,
      ...(patch.endpoint === undefined ? {} : { endpoint }),
      ...(patch.model === undefined ? {} : { models: [model] }),
      ...(patch.contextWindow === undefined ? {} : { contextWindow: patch.contextWindow }),
    },
  };

  return {
    ok: true,
    value: { ...doc, providers: doc.providers.map((entry) => (entry.id === id ? next : entry)) },
    changed,
  };
}
