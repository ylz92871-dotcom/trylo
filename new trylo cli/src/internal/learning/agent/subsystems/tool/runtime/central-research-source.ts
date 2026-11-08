import { withBoardWriter } from "../../../../../adapters/learning-store/file-event-store.js";
import { canonicalJson, contentHashOf } from "../../../../control/hash.js";
import { isRewardV2Draft } from "../../../../reward/v2-facts.js";
import { fields, identity, text } from "../../../../../validation/json-shape.js";
import type { CentralToolResearchOptions } from "./central-research-intake.js";

/** Freeze the producer's actual creation time under the original Board lock.
 * Plan content identity therefore survives concurrent intake and process restart.
 */
export async function centralToolResearchCreatedAt(options: CentralToolResearchOptions, requestRef: string, signal: AbortSignal) {
  const id = `tool-research-request:${contentHashOf([options.scope, requestRef])}`;
  const result = await withBoardWriter(options.boardRoot, async store => {
    const loaded = await store.load();
    if (!loaded.ok) throw new Error(loaded.reason);

    const existing = loaded.state.rewardV2Facts?.find(row => row.id === id);
    if (existing !== undefined) {
      let value: unknown;

      try { value = JSON.parse(existing.payloadJson); }
      catch { throw new Error("tool_research_request_corrupt"); }

      if (existing.scope !== options.scope || existing.kind !== "projection" || existing.algorithmVersion !== "central-tool-research-v1"
        || !fields(value, ["type", "schemaVersion", "requestRef", "createdAt"]) || value.type !== "tool_research_request"
        || value.schemaVersion !== 1 || value.requestRef !== requestRef || !identity(value.requestRef)
        || !text(value.createdAt, 64) || !Number.isFinite(Date.parse(value.createdAt))) throw new Error("tool_research_request_corrupt");

      return value.createdAt;
    }

    const createdAt = new Date(options.now()).toISOString();
    const fact = { id, scope: options.scope, algorithmVersion: "central-tool-research-v1", kind: "projection" as const,
      payloadJson: canonicalJson({ type: "tool_research_request", schemaVersion: 1, requestRef, createdAt }) };
    if (!isRewardV2Draft(fact)) throw new Error("tool_research_request_invalid");

    const saved = await store.apply({ type: "record_reward_v2_fact", commandId: `rw2:${id}`, issuedAt: createdAt,
      expectedSequence: loaded.state.sequence, fact });
    if (!saved.ok) throw new Error(saved.reason);

    return createdAt;
  }, { commandGuard: () => options.enabled() && !signal.aborted });

  return typeof result === "string" ? { ok: true as const, createdAt: result } : { ok: false as const, reason: result.reason };
}
