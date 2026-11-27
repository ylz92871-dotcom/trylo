import assert from "node:assert/strict";
import { test } from "node:test";
import { createPlatformIsolation } from "./platform-isolation.js";

for (const platform of ["darwin", "linux", "freebsd"] as const) {
  test("unintegrated " + platform + " isolation reports unavailable without selecting Windows", async () => {
    const isolation = createPlatformIsolation({}, platform);
    const status = await isolation.probe();
    assert.equal(status.state, "unavailable");
    if (status.state === "unavailable") assert.ok(status.reason.includes(platform));
  });
}
