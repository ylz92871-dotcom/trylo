import assert from "node:assert/strict";
import test from "node:test";
import { isMethodLearningControlObservation } from "../control-observation.js";

const context = { component: "method_context", taskId: "task", opportunityId: "opportunity", selected: 0 };
const refresh = { component: "method_context_refresh", taskId: "task", reason: "new_user_input" };

test("method control observation registration accepts only the complete original diagnostic shapes", () => {
  assert.ok(isMethodLearningControlObservation(context));
  assert.ok(isMethodLearningControlObservation({ ...context, selected: 2 }));
  assert.ok(isMethodLearningControlObservation(refresh));
  assert.ok(isMethodLearningControlObservation(Object.assign(Object.create(null), refresh)));
  const rejected: readonly unknown[] = [null, [], "method_context", { component: "method_context" },
    { ...context, taskId: "" }, { ...context, opportunityId: "" }, { ...context, selected: "0" },
    { ...context, selected: -1 }, { ...context, selected: .5 }, { ...context, selected: Number.NaN },
    { ...context, selected: Number.POSITIVE_INFINITY }, { ...context, selected: Number.MAX_SAFE_INTEGER + 1 },
    { ...context, versionId: "method:v1", action: "adopt" }, { ...context, extra: undefined },
    { ...refresh, reason: "" }, { ...refresh, taskId: 1 }, { ...refresh, extra: true },
    { ...refresh, observationId: "correction", outcome: "unhelpful" },
    { component: "method_adoption", versionId: "method:v1", action: "adopt", reason: "actual adoption" },
    { component: "checker", status: "passed" }, { component: "business", value: context },
    { ...context, component: "method_context_business" }, Object.create(context)];

  for (const value of rejected) assert.equal(isMethodLearningControlObservation(value), false);
});

test("hidden, symbol, inherited and accessor fields cannot masquerade as the registered payload", () => {
  assert.equal(isMethodLearningControlObservation(Object.defineProperty({ ...context }, "feedback", { value: "actual feedback" })), false);
  assert.equal(isMethodLearningControlObservation({ ...context, [Symbol("feedback")]: "actual feedback" }), false);
  assert.equal(isMethodLearningControlObservation(Object.assign(Object.create({ versionId: "actual:v1" }), context)), false);
  let reads = 0;
  const accessor = Object.defineProperty({ ...context }, "selected", { enumerable: true, get() {
    reads++;
    return 1;
  } });
  assert.equal(isMethodLearningControlObservation(accessor), false);
  assert.equal(reads, 0);
});
