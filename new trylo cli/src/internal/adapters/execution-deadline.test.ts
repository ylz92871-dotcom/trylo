import assert from "node:assert/strict";
import { test } from "node:test";
import { executionDeadline } from "./execution-deadline.js";

test("omitted deadlines create no timer; explicit long deadlines expire once and can be cancelled", t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let fired = 0;

  assert.equal(executionDeadline(undefined, () => { fired++; }), undefined);
  const long = executionDeadline(2_147_483_700, () => { fired++; });
  const cancelled = executionDeadline(60_000, () => { fired++; });

  cancelled?.cancel();
  t.mock.timers.tick(2_147_483_647);
  assert.equal(fired, 0, "a long caller deadline must not overflow into an immediate timeout");
  t.mock.timers.tick(53);
  assert.equal(fired, 1);
  long?.cancel();
});
