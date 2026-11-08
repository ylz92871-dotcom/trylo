import { renderCapabilities } from "../../adapters/provider/capabilities.js";
import { resolveProvider } from "../../adapters/provider/resolver.js";
import { selectProvider } from "../../adapters/provider/registry.js";
import type { ProviderKind } from "../../adapters/provider/providers-file.js";
import type { CredentialPort } from "../../ports/credentials.js";
import { isDocumentFailure, PROVIDERS_FILE_NAME, readCliProviderRegistry } from "./providers-wiring.js";
import type { DoctorCheck, DoctorIo } from "./doctor.js";

/**
 * The provider-shaped rows of `doctor`.
 *
 * One concern, and the one a person is most likely to be lied to about: which
 * provider a run *would* use, what it declares, and whether it can authenticate.
 * They live apart from the rest of `doctor` so the reason each row exists is
 * readable in one place — these are the rows a person reads to decide whether to
 * believe the run they are about to start, and a row that is merely plausible is
 * worse than a missing one.
 */

/** One config value as a string, or `undefined` when it is absent or not one. */
export function stringEntry(
  resolved: Readonly<Record<string, { readonly value: unknown }>>,
  key: string,
): string | undefined {
  const entry = resolved[key];
  return typeof entry?.value === "string" ? entry.value : undefined;
}

type SelectedProvider = {
  readonly providerId: string;
  readonly kind: ProviderKind;
  readonly model: string;
  readonly endpoint: string;
};

/**
 * The provider a run would use, resolved once for every provider-shaped row.
 *
 * Declaration `selected` first, then the config value — the same order a run
 * uses. `undefined` means the built-in default, the fixture, which has a row of
 * its own.
 */
export function resolveSelectedProvider(
  io: Pick<DoctorIo, "readFile" | "homeDir" | "env">,
  resolved: Readonly<Record<string, { readonly value: unknown }>>,
): SelectedProvider | undefined {
  const registry = readCliProviderRegistry({ readFile: io.readFile, homeDir: io.homeDir, env: io.env });
  if (isDocumentFailure(registry)) {
    return undefined;
  }

  const requested = registry.selected ?? stringEntry(resolved, "provider");
  const resolvedProvider = resolveProvider({
    registry,
    ...(requested === undefined ? {} : { requested }),
    endpoint: stringEntry(resolved, "endpoint") ?? "",
    model: stringEntry(resolved, "model") ?? "",
  });

  return resolvedProvider.ok ? resolvedProvider.value : undefined;
}

/**
 * What the selected provider declares — reported only when someone declared
 * one.
 *
 * The gate this respects is the zero-difference one: `doctor`'s output on a
 * machine with no `providers.json` is byte for byte what it was before this
 * package existed, so this row appears *only* when there is something to say.
 * A diagnostic that grew a line for everyone would be a regression disguised as
 * a feature.
 *
 * A selection that names a provider which is not registered is a `fail`, not a
 * skip: the person's file says "use this", the registry says "there is no
 * such thing", and that disagreement is exactly what a diagnostic exists to
 * surface.
 */
export function declaredCapabilityCheck(io: DoctorIo): DoctorCheck | undefined {
  const registry = readCliProviderRegistry({
    readFile: io.readFile,
    homeDir: io.homeDir,
    env: io.env,
  });
  if (isDocumentFailure(registry)) {
    return {
      id: "provider.capability",
      status: "fail",
      detail: `${PROVIDERS_FILE_NAME} unusable: ${registry.code}: ${registry.detail}`,
    };
  }

  if (!registry.declared) {
    return undefined;
  }

  const selected = selectProvider(registry);
  if (!selected.ok) {
    return {
      id: "provider.capability",
      status: "fail",
      detail: `selected provider ${registry.selected ?? "(none)"} is not registered`,
    };
  }

  return {
    id: "provider.capability",
    status: "ok",
    detail: `${selected.entry.id}: ${renderCapabilities(selected.entry.capabilities)}`,
  };
}

/**
 * The endpoint half of the selected provider. Whether a credential exists is a
 * separate check below, so "no endpoint" and "no credential" cannot blur into
 * one diagnostic.
 */
export function providerCheck(
  provider: string,
  model: string,
  selection: SelectedProvider | undefined,
  loaded: { readonly resolved: Readonly<Record<string, { readonly value: unknown }>> },
): DoctorCheck {
  if (provider !== "openai-compatible") {
    return { id: "provider.selected", status: "ok", detail: `${provider} (model ${model})` };
  }

  // The endpoint a run would actually send to: a declaration's, or the config's.
  const endpoint = selection === undefined ? "" : selection.endpoint;
  if (endpoint.length === 0) {
    const declared = stringEntry(loaded.resolved, "endpoint");
    return {
      id: "provider.selected",
      status: "fail",
      detail:
        declared === undefined
          ? "openai-compatible has no endpoint; `trylo providers add <id> --endpoint <url>` declares one"
          : "openai-compatible has no endpoint; set `endpoint` in config",
    };
  }

  return { id: "provider.selected", status: "ok", detail: `openai-compatible -> ${endpoint}` };
}

/**
 * The redacted credential check (WP §0.2): ask the ledger's `status`, print
 * layers and account ids, never a value. Failing means the run would refuse to
 * authenticate: the ledger is damaged, or the selected provider has nothing to
 * resolve and no environment key either.
 */
export function credentialCheck(
  port: CredentialPort,
  selectedProvider: string,
  nowMs: () => number,
): DoctorCheck {
  const id = "credentials.openai-compatible";
  const result = port.status();
  if (!result.ok) {
    return { id, status: "fail", detail: `ledger unusable: ${result.code} (value never printed)` };
  }

  const row = result.value.find((entry) => entry.providerId === "openai-compatible");
  if (row === undefined) {
    return { id, status: "skip", detail: "not evaluated" };
  }

  if (selectedProvider !== "openai-compatible") {
    return {
      id,
      status: "ok",
      detail: `layer=${row.layer} logged_in=${row.loggedIn} (not selected)`,
    };
  }

  if (row.loggedIn) {
    const authTypePart = row.authType !== undefined ? ` auth=${row.authType}` : "";
    let expiryPart = "";

    if (row.expiresAt !== undefined) {
      // The clock is injected: a diagnostic that reads the wall clock itself
      // cannot be tested, and "is this token expired" is exactly the kind of
      // answer a test wants to pin.
      const isExpired = nowMs() >= new Date(row.expiresAt).getTime();
      expiryPart = isExpired ? " token=expired" : " token=valid";
    }

    return {
      id,
      status: "ok",
      detail: `layer=${row.layer} account=${row.accountId}${authTypePart}${expiryPart}`,
    };
  }

  return {
    id,
    status: "fail",
    detail: "not logged in; run `trylo login --provider openai-compatible`",
  };
}
