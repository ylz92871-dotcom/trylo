import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import test from "node:test";

import { daemonLaunchTarget, parseDaemon } from "./commands-daemon.js";

/**
 * `trylo daemon start` must launch something that exists.
 *
 * ## Why this file exists
 *
 * The daemon's whole lifecycle was verified end-to-end — six processes racing for
 * one lease, a real spawn, a stop that works — through a probe that imported
 * `daemon-main.js` directly, and through `daemonLaunchFor()`, the injectable hook
 * for tests. Neither of those ever read the *default* launch path the person
 * typing `trylo daemon start` actually gets. So `daemon start` reported "spawned
 * as pid 58536" while pointing `node` at a file that did not exist, and only
 * `daemon status` — honest, saying "stopped" — revealed it.
 *
 * That is the same shape this package has now hit three times: green harness,
 * broken binary. The fix is not more care, it is a test that reads the default.
 */
test("`daemon start` launches a target that exists", () => {
  const launch = daemonLaunchTarget();
  const [target] = launch.args;

  if (target === undefined) {
    assert.fail("the launch config carries no script");
  }

  assert.ok(existsSync(launch.file), `the interpreter ${launch.file} is not real`);
  assert.ok(
    existsSync(target),
    `"daemon start" would spawn a child that dies at once: ${target} does not exist`,
  );
});

test("`--force` and `--now` are the same promise, and a bare stop is not it", () => {
  assert.deepEqual(parseDaemon(["stop"]), { verb: "stop", force: false });
  assert.deepEqual(parseDaemon(["stop", "--force"]), { verb: "stop", force: true });
  assert.deepEqual(parseDaemon(["kill", "--now"]), { verb: "stop", force: true });
});

test("an unknown daemon verb is answered with the family's own help", () => {
  // `ps` belongs to background sessions, not to the daemon; answering it here
  // would advertise a verb that cannot work.
  assert.deepEqual(parseDaemon(["wat"]), { verb: "help" });
});
