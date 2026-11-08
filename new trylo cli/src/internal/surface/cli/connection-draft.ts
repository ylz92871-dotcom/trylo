import type { CliContext } from "./context.js";
import { normalizeChatEndpoint } from "./connection-endpoint.js";
import { isDocumentFailure, readCliProviderRegistry, validateDeclaration } from "./providers-wiring.js";
import { createCliCredentialPortWithReport, credentialWarningTo } from "./credentials-wiring.js";

export type ConnectionCredential =
  | { readonly kind: "secret"; readonly secret: string; readonly label?: string }
  | { readonly kind: "account"; readonly accountId: string }
  | { readonly kind: "environment" };

export type ConnectionDraft = {
  readonly operation: "add" | "edit";
  readonly id: string;
  readonly address: string;
  readonly addressKind?: "base-url" | "endpoint";
  readonly model: string;
  readonly contextWindow?: number;
  readonly credential: ConnectionCredential;
};

export type ConnectionFailure = { readonly ok: false; readonly code: string; readonly detail: string };

/** Validation and credential resolution only: no writes, no selection, no network. */
export function prepareConnectionDraft(ctx: CliContext, draft: ConnectionDraft) {
  const address = normalizeChatEndpoint(draft.address, draft.addressKind);
  if (!address.ok) return address;

  const declaration = { id: draft.id.trim(), kind: "openai-compatible" as const, endpoint: address.endpoint, model: draft.model.trim(), ...(draft.contextWindow === undefined ? {} : { contextWindow: draft.contextWindow }) };
  const invalid = validateDeclaration(declaration);
  if (invalid !== undefined) return invalid;

  const registry = readCliProviderRegistry(ctx);
  if (isDocumentFailure(registry)) return { ok: false as const, code: registry.code, detail: registry.detail };

  const found = registry.entries.find(entry => entry.id === declaration.id);
  if (draft.operation === "add" && found !== undefined) return { ok: false as const, code: "duplicate_id", detail: "That connection exists; edit it explicitly." };

  if (draft.operation === "edit" && (found === undefined || found.builtin || found.kind !== "openai-compatible")) return { ok: false as const, code: "unknown_provider", detail: "Choose an existing declared OpenAI-compatible connection." };

  if (draft.operation === "edit" && found?.accountId !== undefined && draft.credential.kind === "environment") return { ok: false as const, code: "account_binding_present", detail: "This connection is bound to a stored account. Select that account, bind another key, or create a separate environment-backed connection." };

  if (draft.contextWindow !== undefined && (!Number.isInteger(draft.contextWindow) || draft.contextWindow <= 0)) return { ok: false as const, code: "invalid_context_window", detail: "The context window must be a positive integer." };

  if (draft.credential.kind === "secret") {
    if (draft.credential.secret.trim().length === 0) return { ok: false as const, code: "missing_secret", detail: "Enter a key or select an existing account." };
    return { ok: true as const, declaration, apiKey: draft.credential.secret };
  }

  const port = createCliCredentialPortWithReport(ctx, credentialWarningTo(ctx));
  const resolved = draft.credential.kind === "account"
    ? port.getAccount({ providerId: "openai-compatible", accountId: draft.credential.accountId })
    : port.get("openai-compatible");
  if (!resolved.ok) return resolved;

  if (resolved.value.layer === "none" || resolved.value.secret === undefined) return { ok: false as const, code: "missing_secret", detail: "No credential resolved; enter a key or select a stored account." };

  if (draft.credential.kind === "environment" && resolved.value.layer !== "env") return { ok: false as const, code: "missing_environment_credential", detail: "No environment credential is active; select a stored account instead." };

  return { ok: true as const, declaration, apiKey: resolved.value.secret, ...(draft.credential.kind === "account" ? { accountId: draft.credential.accountId } : {}) };
}
