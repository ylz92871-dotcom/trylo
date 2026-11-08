import assert from "node:assert/strict";
import test from "node:test";
import { advancedAssistantStatus } from "../voice/assistant-modes.js";
import { computerUseStatus, refuseComputerUse } from "./computer-use-status.js";

/**
 * WP19.3 (A09, A10) anti-masquerade contract: the missing pieces report
 * missing. If a future change flips either flag, it must arrive with the
 * transport, the authorization boundary, and the test that drives them —
 * deleting this test without those three is a review-blocking signal, not a
 * cleanup.
 */

test("computer-use stays source_missing with its three named gaps", () => {
  const status = computerUseStatus();

  assert.equal(status.available, false);

  if (!status.available) {
    assert.equal(status.reason, "source_missing");
    assert.equal(status.missing.length, 3);
  }

  const refused = refuseComputerUse("browse");

  assert.equal(refused.outcome, "error");
  assert.equal(refused.code, "computer_use_unavailable");
});

test("voice/assistant/kairos/ultraplan report blocked, never completed", () => {
  const modes = advancedAssistantStatus();

  assert.equal(modes.length, 4);

  for (const mode of modes) {
    assert.equal(mode.available, false);
  }

  const ids = modes.map((mode) => mode.id);

  assert.deepEqual(ids, ["voice_mode", "assistant", "kairos", "ultraplan"]);
  // WP19 复核订正 (F2): ultraplan is a real implementation behind a flag +
  // remote backend, so conditionally blocked; the stub stays source-missing.
  const byId = new Map(modes.map((mode) => [mode.id, mode.reason]));

  assert.equal(byId.get("ultraplan"), "conditionally_blocked");
  assert.equal(byId.get("assistant"), "source_missing");
  assert.equal(byId.get("voice_mode"), "conditionally_blocked");
  assert.equal(byId.get("kairos"), "conditionally_blocked");
});
