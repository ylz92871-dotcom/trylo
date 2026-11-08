import type { CliContext } from "./context.js";
import { prepareConnectionDraft, type ConnectionDraft, type ConnectionFailure } from "./connection-draft.js";
import { storeCredential } from "./credential-login.js";
import { addDeclaredProvider, editDeclaredProvider, switchSelected } from "./providers-wiring.js";
import { connectionStatus } from "./connection-status.js";

export type ConnectionSaveResult =
  | { readonly ok: true; readonly id: string; readonly accountId?: string; readonly selected: boolean; readonly status: ReturnType<typeof connectionStatus> }
  | (ConnectionFailure & { readonly stage: "validation" | "credential" | "declaration" | "selection"; readonly committed: ReadonlyArray<string>; readonly accountId?: string });

/** Uses the existing ledger and provider writers; partial commits are explicit and retryable. */
export function saveConnection(ctx: CliContext, draft: ConnectionDraft, select = true): ConnectionSaveResult {
  const prepared = prepareConnectionDraft(ctx, draft);
  if (!prepared.ok) return { ...prepared, stage: "validation", committed: [] };

  const committed: string[] = [];
  let accountId = "accountId" in prepared ? prepared.accountId : undefined;

  if (draft.credential.kind === "secret") {
    const stored = storeCredential(ctx, { providerId: "openai-compatible", scope: "user", authType: "api_key", secret: prepared.apiKey, ...(draft.credential.label === undefined ? {} : { label: draft.credential.label }) });
    if (!stored.ok) return { ...stored, stage: "credential", committed };
    accountId = stored.value.accountId;
    committed.push("credential");
  }

  const { declaration } = prepared;
  const written = draft.operation === "add"
    ? addDeclaredProvider(ctx, { ...declaration, ...(accountId === undefined ? {} : { accountId }) })
    : editDeclaredProvider(ctx, { id: declaration.id, endpoint: declaration.endpoint, model: declaration.model, ...(accountId === undefined ? {} : { account: accountId }), ...(draft.contextWindow === undefined ? {} : { contextWindow: draft.contextWindow }) });
  if (!written.ok) return { ...written, stage: "declaration", committed, ...(accountId === undefined ? {} : { accountId }) };

  committed.push("declaration");

  if (select) {
    const selected = switchSelected(ctx, { id: declaration.id });
    if (!selected.ok) return { ...selected, stage: "selection", committed, ...(accountId === undefined ? {} : { accountId }) };
  }

  return { ok: true, id: declaration.id, ...(accountId === undefined ? {} : { accountId }), selected: select, status: connectionStatus(ctx) };
}
