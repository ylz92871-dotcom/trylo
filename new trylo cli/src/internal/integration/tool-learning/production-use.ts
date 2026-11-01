import { createBoardReader } from "../../adapters/learning-store/file-event-store.js";
import { contentHashOf } from "../../learning/control/hash.js";
import { toolProductionScope } from "../../learning/domains/tool/evolution/production-plan.js";
import type { VerificationAuthorityReader } from "../../learning/verification-authority/contracts.js";
import type { ToolPort } from "../../ports/tools.js";
import { activeProductionFromBoard, readActiveProductionTool } from "./production-reader.js";
import { openFrozenToolUse, type FrozenUseOptions, type FrozenUseMount, type FrozenUseSelection } from "./frozen-use.js";
import { pipelineFailure } from "./pipeline-assets.js";
import type { ToolProductionPort } from "../../ports/tool-production.js";

export type ProductionUseOptions = FrozenUseOptions & { readonly authority: VerificationAuthorityReader; readonly executePlan?: ToolProductionPort["execute"] };

/** Per-call authority checks and generation pinning prevent revoke/replacement races from returning stale results. */
export async function openToolProductionUse(options: ProductionUseOptions) {
  const first = await readActiveProductionTool(options);
  if (!first.ok) return first;
  const read = async () => {
    const current = await readActiveProductionTool(options);
    if (!current.ok) return current;
    if (current.generation !== first.generation || current.receipt.receiptId !== first.receipt.receiptId) return pipelineFailure("production_binding_changed", "activation changed after this turn was frozen");
    const value: FrozenUseSelection = { ok: true, candidate: current.plan.candidate, scope: toolProductionScope(current.plan),
      contentHash: contentHashOf(current.plan), nameDigest: contentHashOf(current.plan), label: "Approved confined tool" };
    return value;
  };
  const selected = await read();
  if (!selected.ok) return selected;
  const execute: Parameters<typeof openFrozenToolUse>[3] = async (input, signal) => {
    const revoked = new AbortController(); let pending: Promise<void> | undefined;
    const check = (): Promise<void> => {
      if (revoked.signal.aborted) return Promise.resolve();
      pending ??= Promise.resolve().then(async () => {
        try { if (!(await read()).ok) revoked.abort(); }
        catch { revoked.abort(); }
      }).finally(() => { pending = undefined; });
      return pending;
    };
    const timer = setInterval(() => { void check(); }, 1_000);
    try {
      const combined = AbortSignal.any([signal, revoked.signal]);
      const result = options.executePlan !== undefined ? await options.executePlan(first.plan, input, combined)
        : first.plan.type === "tool_production_package" ? await options.executor.execute(first.plan.candidate, input, combined)
          : { kind: "unavailable" as const, detail: "host does not support this installed package runtime" };
      await check();
      if (!(await read()).ok) revoked.abort();
      if (signal.aborted) return { kind: "cancelled" };
      if (revoked.signal.aborted) return { kind: "unavailable", detail: "production binding was withdrawn, replaced or could not be verified during execution" };
      return result;
    } finally { clearInterval(timer); await pending; }
  };
  return openFrozenToolUse(options, selected, read, execute);
}

/** Bounded workspace inventory. Candidate and foreign assets never enter the provider catalog. */
export async function openWorkspaceProductionTools(options: Omit<ProductionUseOptions, "versionId">) {
  const loaded = await createBoardReader(options.boardRoot).load();
  if (!loaded.ok) return pipelineFailure(loaded.reason, loaded.detail);
  const mounts: FrozenUseMount[] = [];
  for (const pointer of loaded.state.activations) {
    if (pointer.assetKind !== "tool_package" || pointer.pointer !== "active" || !pointer.scope.startsWith("tool-production:v1:")) continue;
    const selected = await activeProductionFromBoard(loaded.state, pointer.versionId, options.workspaceId, options.authority);
    if (!selected.ok) { if (selected.code !== "production_workspace_mismatch") options.warn(`${selected.code}: approved tool omitted`); continue; }
    if (mounts.length >= 32) { for (const mount of mounts) await mount.close(); return pipelineFailure("production_catalog_capacity", "workspace exceeds 32 active tools; select a smaller approved inventory"); }
    const opened = await openToolProductionUse({ ...options, versionId: pointer.versionId });
    if (!opened.ok) { options.warn(`${opened.code}: approved tool omitted`); continue; }
    mounts.push(opened.mount);
  }
  const tools: ToolPort = { snapshot: () => mounts.flatMap(mount => mount.tools.snapshot()),
    execute: (call, signal) => {
      const mount = mounts.find(item => item.binding.name === call.name);
      return mount === undefined ? Promise.resolve({ outcome: "unknown", code: "unknown_tool", message: "production tool is not mounted" }) : mount.tools.execute(call, signal);
    }, cancel: async id => { await Promise.all(mounts.map(mount => mount.tools.cancel(id))); } };
  return { ok: true as const, tools, close: async () => { await Promise.all(mounts.map(mount => mount.close())); } };
}
