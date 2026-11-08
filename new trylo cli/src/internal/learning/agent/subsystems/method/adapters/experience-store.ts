import { createBoardReader, withBoardWriter } from "../../../../../adapters/learning-store/file-event-store.js";
import { shortId } from "../../../../domains/shared/hash.js";
import { applyCommandSequence, variantsOf } from "./board-writer.js";
import type { BoardState } from "../../../../control/state.js";
import type { MethodExperienceFact } from "../domain/experience-facts.js";
import { experienceSourceOf } from "../domain/experience-source.js";
import type { ExperienceStore, ExperienceView } from "../orchestration/experience-runtime.js";
import { canonicalCardJson } from "../domain/contracts.js";

/** Same Board lock, reducer and append log as method cards and feedback. */
export function createExperienceStore(root: string, now: () => string): ExperienceStore {
  const view = experienceViewOf;
  return {
    async load() {
      const loaded = await createBoardReader(root).load();
      if (!loaded.ok) throw new Error(`method_experience_load:${loaded.reason}`);
      return view(loaded.state);
    },
    async append(make) {
      const result = await withBoardWriter(root, async store => {
        const loaded = await store.load();
        if (!loaded.ok) return loaded;

        const fact: MethodExperienceFact = make(view(loaded.state));
        const existing = loaded.state.methodExperienceFacts?.find(item => item.factId === fact.factId);
        if (existing !== undefined) {
          const { sequence: _oldSequence, ...oldPayload } = existing;
          const { sequence: _newSequence, ...newPayload } = fact;
          if (canonicalCardJson(oldPayload) !== canonicalCardJson(newPayload)) throw new Error("method_fact_identity_conflict");
          return { ok: true as const, view: view(loaded.state) };
        }

        const written = await applyCommandSequence(store, [{ type: "record_method_experience",
          commandId: shortId("method-experience", [fact.factId]), issuedAt: now(), fact }]);
        if (!written.ok) return written;

        const after = await store.load();

        return after.ok ? { ok: true as const, view: view(after.state) } : after;
      });
      if (!result.ok || !("view" in result)) throw new Error(`method_experience_write:${result.ok ? "unknown" : result.reason}`);

      return result.view;
    },
  };
}

/** Preparation and execution project the same canonical source snapshot. */
export function experienceViewOf(state: BoardState): ExperienceView {
  return { ...experienceSourceOf(state), variants: variantsOf(state) };
}
