import assert from "node:assert/strict";
import test from "node:test";
import { isSelectedPromptBudgetObservation, PROMPT_BUDGET_COMPONENT, PROMPT_BUDGET_SELECTED_STATUS } from "./prompt-budget-observation.js";

test("only an observation with the exact normal budget component and status is classified", () => {
  const payload = { component: PROMPT_BUDGET_COMPONENT, status: PROMPT_BUDGET_SELECTED_STATUS, tokens: 0 };

  assert.equal(isSelectedPromptBudgetObservation({ kind: "observation", payload }), true);

  for (const kind of ["tool_result", "tool_use", "terminal", "file_write"]) {
    assert.equal(isSelectedPromptBudgetObservation({ kind, payload }), false);
  }

  for (const component of ["business", "checker", "unknown_component"]) {
    assert.equal(isSelectedPromptBudgetObservation({ kind: "observation", payload: { ...payload, component } }), false);
  }

  for (const status of ["failed", "unknown", ""]) {
    assert.equal(isSelectedPromptBudgetObservation({ kind: "observation", payload: { ...payload, status } }), false);
  }

  assert.equal(isSelectedPromptBudgetObservation({ kind: "observation", payload: { component: PROMPT_BUDGET_COMPONENT } }), false);
});
