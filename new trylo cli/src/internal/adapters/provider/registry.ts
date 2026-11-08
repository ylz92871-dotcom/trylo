import type { CapabilityKey, ProviderCapabilities } from "./capabilities.js";
import { requireCapability, type CapabilityDenial } from "./capabilities.js";
import {
  decodeDocument,
  PROVIDER_KINDS,
  type DeclaredProvider,
  type DocumentFailure,
  type ProviderKind,
  type ProvidersDocument,
} from "./providers-file.js";

/**
 * The provider registry: what exists, what it can do, which one is selected.
 *
 * Two kinds of provider live here and the difference is load-bearing:
 *
 *  - **built-in** — the four ids the CLI has always accepted. They are declared
 *    here rather than assumed, so "what can `fixture` do" is answered by the
 *    same matrix as everything else instead of by a special case in a caller;
 *  - **declared** — entries the person added in `providers.json`. They may name
 *    a new endpoint and its capabilities, but they may *not* redefine a
 *    built-in id: `decodeDocument` refuses that, and a shipped provider that
 *    could be silently re-pointed would make "offline and deterministic" a
 *    claim about a file rather than a fact.
 *
 * Selection is a pure function of (requested id, document `selected`, the
 * built-in default). It is resolved once and handed out as one object, so no
 * caller can end up with the endpoint of one provider and the model of another.
 *
 * A missing file is *not* an error: it is the state every machine is in before
 * anyone declares anything, and it must behave exactly as today. A file that
 * exists but cannot be trusted is an error, and is reported with the code that
 * says why — the same discipline the config loader already applies to
 * `config.json`.
 */

export type ProviderEntry = {
  readonly id: string;
  readonly kind: ProviderKind;
  /**
   * The model this entry supplies. Empty means "the run's own model wins",
   * which is what every built-in says: a shipped provider that overrode the
   * model would change the model of every run that did not ask for one, and
   * that is a difference nobody asked for.
   */
  readonly model: string;
  readonly capabilities: ProviderCapabilities;
  readonly builtin: boolean;
  /** The ledger account this declared provider binds to, when it names one. */
  readonly accountId?: string;
};

export type ProviderRegistry = {
  readonly entries: ReadonlyArray<ProviderEntry>;
  /** The id a run selects when nothing names one. Absent means the default. */
  readonly selected?: string;
  /** True when a declared-providers file was read and understood. */
  readonly declared: boolean;
};

export const DEFAULT_PROVIDER_ID = "fixture";

export type RegistryIo = {
  readonly readFile: (absolutePath: string) => string | undefined;
  readonly providersFile: string;
};

function caps(partial: Partial<ProviderCapabilities> & { readonly auth: ProviderCapabilities["auth"] }): ProviderCapabilities {
  return {
    models: [],
    streaming: true,
    reasoning: false,
    tools: true,
    cancellation: true,
    endpoint: "",
    ...partial,
  };
}

/**
 * The four shipped declarations.
 *
 * Nothing here is aspirational. `reasoning` is false on every one of them
 * because no adapter in this repo translates a reasoning channel: the port has
 * reasoning events, the OpenAI translator emits them only when the wire carries
 * them, and "we support reasoning" would therefore be a claim about someone
 * else's endpoint. A declared provider may raise it for its own endpoint.
 *
 * `openai-compatible` declares *no* models on purpose: its catalogue is a fact
 * about whatever endpoint was configured, and this process does not ask.
 */
export function builtinEntries(): ReadonlyArray<ProviderEntry> {
  return [
    {
      id: "fixture",
      kind: "fixture",
      model: "",
      capabilities: caps({ auth: "none", models: ["fixture"] }),
      builtin: true,
    },
    {
      id: "fixture-write",
      kind: "fixture-write",
      model: "",
      capabilities: caps({ auth: "none", models: ["fixture-write"] }),
      builtin: true,
    },
    {
      id: "fixture-subagent",
      kind: "fixture-subagent",
      model: "",
      capabilities: caps({ auth: "none", models: ["fixture-subagent"] }),
      builtin: true,
    },
    {
      id: "openai-compatible",
      kind: "openai-compatible",
      model: "",
      capabilities: caps({ auth: "api_key" }),
      builtin: true,
    },
  ];
}

export function builtinRegistry(): ProviderRegistry {
  return { entries: builtinEntries(), declared: false };
}

function entryOfDeclared(declared: DeclaredProvider): ProviderEntry {
  return {
    id: declared.id,
    kind: declared.kind,
    model: declared.model,
    capabilities: declared.capabilities,
    builtin: false,
    ...(declared.accountId === undefined ? {} : { accountId: declared.accountId }),
  };
}

/**
 * The registry a run sees: built-ins plus whatever was declared.
 *
 * The failure is returned rather than swallowed because a caller has to be able
 * to turn "your providers file is broken" into an exit code and a sentence — a
 * registry that quietly dropped the unreadable half would leave the person
 * looking at a provider list that is missing entries they wrote.
 */
export function readRegistry(io: RegistryIo): ProviderRegistry | DocumentFailure {
  const raw = io.readFile(io.providersFile);
  if (raw === undefined) {
    return builtinRegistry();
  }

  const decoded = decodeDocument(raw);
  if (!decoded.ok) {
    return decoded.failure;
  }

  return registryOfDocument(decoded.value);
}

export function registryOfDocument(doc: ProvidersDocument): ProviderRegistry {
  return {
    entries: [...builtinEntries(), ...doc.providers.map(entryOfDeclared)],
    ...(doc.selected === undefined ? {} : { selected: doc.selected }),
    declared: true,
  };
}

export function findProvider(reg: ProviderRegistry, id: string): ProviderEntry | undefined {
  return reg.entries.find((entry) => entry.id === id);
}

export type ProviderDenial = {
  readonly code: "unknown_provider";
  readonly id: string;
  readonly known: ReadonlyArray<string>;
};

/**
 * Look a provider up and be refused when it is not there (D4: fail-closed).
 *
 * The known ids travel with the denial so the message can end in "known
 * providers: …" — a refusal that only says no sends the person to `--help`
 * guessing, which is where a typo becomes a wild goose chase.
 */
export function requireProvider(
  reg: ProviderRegistry,
  id: string,
): { readonly ok: true; readonly entry: ProviderEntry } | { readonly ok: false; readonly denial: ProviderDenial } {
  const entry = findProvider(reg, id);
  if (entry === undefined) {
    return {
      ok: false,
      denial: { code: "unknown_provider", id, known: reg.entries.map((item) => item.id) },
    };
  }

  return { ok: true, entry };
}

/**
 * Which provider a run uses, resolved in one step.
 *
 * Precedence, highest first: the id the caller named (a `--provider` flag), the
 * document's `selected`, then the built-in default. The result is *one* entry:
 * a caller that resolved the id and then looked the entry up again could read a
 * registry that changed in between, which is exactly the half-old/half-new
 * state D3 forbids.
 */
export function selectProvider(
  reg: ProviderRegistry,
  requested?: string,
): { readonly ok: true; readonly entry: ProviderEntry } | { readonly ok: false; readonly denial: ProviderDenial } {
  const id = requested !== undefined && requested.length > 0
    ? requested
    : (reg.selected ?? DEFAULT_PROVIDER_ID);
  return requireProvider(reg, id);
}

/**
 * A capability, demanded of a provider that must exist first.
 *
 * The two refusals are kept distinct on purpose: "no such provider" and "that
 * provider cannot do this" need different sentences and, at the command line,
 * different hints.
 */
export function demandCapability(
  reg: ProviderRegistry,
  id: string,
  key: CapabilityKey,
): { readonly ok: true } | { readonly ok: false; readonly denial: ProviderDenial | CapabilityDenial } {
  const found = requireProvider(reg, id);
  if (!found.ok) {
    return found;
  }
  return requireCapability(found.entry.id, found.entry.capabilities, key);
}

/** The kinds a declaration may name, for messages that list them. */
export function providerKinds(): ReadonlyArray<string> {
  return [...PROVIDER_KINDS];
}
