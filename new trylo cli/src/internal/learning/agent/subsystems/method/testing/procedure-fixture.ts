import assert from "node:assert/strict";
import type { ExperienceReviewRequest } from "../experience-port.js";
import type { CompiledProcedure } from "../domain/procedure.js";

/** Scripted compiler output; references actual material supplied to the model. */
export function procedureFixture(request: ExperienceReviewRequest, action: string,
  when = "registered conditions", expect = "expected business result"): CompiledProcedure {
  const source = request.observations.find(item => item.adoption === "adopted" && item.outcome === "helped" &&
    item.compilationId === undefined);

  assert.ok(source, "a compiler fixture must receive a helpful source observation");

  return { schemaVersion: 1, steps: [{ id: "s1", when, action, expect, onMismatch: "block" }],
    eliminatedDecisions: [{ decision: "Repeat source interpretation", resolution: action,
      basis: "The supplied source use supports applying the registered practice while retaining its live result check.",
      evidenceIds: [source.observationId] }] };
}
