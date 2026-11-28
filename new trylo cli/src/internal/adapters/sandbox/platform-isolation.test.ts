import assert from "node:assert/strict";
import { test } from "node:test";
import { createPlatformIsolation } from "./platform-isolation.js";

for (const platform of ["linux", "freebsd"] as const) {
  test("unintegrated " + platform + " isolation reports unavailable without selecting Windows", async () => {
    const isolation = createPlatformIsolation({}, platform);
    const status = await isolation.probe();
    assert.equal(status.state, "unavailable");
    if (status.state === "unavailable") assert.ok(status.reason.includes(platform));
  });
}

test("darwin routes to Seatbelt and never probes a Windows isolation backend", async () => {
  const isolation = createPlatformIsolation({}, "darwin");
  const status = await isolation.probe();
  assert.notEqual(status.state, "unavailable");
  if (status.state === "ready" || status.state === "broken" || status.state === "not_installed") {
    assert.equal(status.backend, "macos-seatbelt");
  } else assert.fail("Expected a Seatbelt readiness observation");
});
