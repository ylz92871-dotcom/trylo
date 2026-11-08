import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createProcessSessionRegistry } from "./session-registry.js";
import { createJobStore } from "./job-store.js";

/**
 * The registry publishes into the durable table, so `trylo bg` from a second
 * process sees what this process started.
 *
 * This is the seam the whole feature depends on, and it is the kind of seam that
 * has bitten this package twice: every piece on either side of it can be tested
 * alone and stay green while nothing connects them (the daemon's launch target,
 * the family entry point nobody called). So this file does not test the store or
 * the registry — it tests that a real child process, started through the real
 * registry, ends up readable through the store, with its output and with an exit
 * code written by the only process that could see it.
 */

function wired() {
  const home = mkdtempSync(join(tmpdir(), "wp26-wired-"));
  const jobs = createJobStore({ home, now: () => Date.now() });
  const registry = createProcessSessionRegistry({ jobs });
  const start = (id: string, code: string) =>
    registry.start({
      id,
      argv: [process.execPath, "-e", code],
      cwd: home,
      env: {},
      tty: false,
      rows: 24,
      cols: 80,
      maxBufferBytes: 8_192,
    });

  return { home, jobs, registry, start };
}

/** Wait for the owner's own `exit` event to have settled the record. */
async function settled(h: ReturnType<typeof wired>, id: string) {
  for (let tries = 0; tries < 80; tries += 1) {
    const found = h.jobs.read(id);
    if (found.ok && found.record.status !== "running") {
      return found.record;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.fail(`the owner never settled ${id}; the exit hook is not wired`);
}

test("a session started through the registry is a job record with a pid", async () => {
  const h = wired();
  const id = "ps_00000000000000000000000a";
  const snapshot = await h.start(id, "console.log('published')");

  assert.equal(typeof snapshot.pid, "number", "the snapshot must carry the pid bg needs");
  const found = h.jobs.read(id);

  assert.equal(found.ok, true, "no job record was published for a started session");

  if (!found.ok) return;

  assert.equal(found.record.pid, snapshot.pid);
  assert.equal(found.record.status, "running");
  await settled(h, id);
});

test("the output the model buffered is the same output a second process can read", async () => {
  const h = wired();
  const id = "ps_00000000000000000000000b";

  await h.start(id, "console.log('line one'); console.log('line two');");
  const record = await settled(h, id);
  const output = h.jobs.readOutput(id);

  assert.equal(output.ok, true);

  if (!output.ok) return;

  assert.match(output.text, /line one/);
  assert.match(output.text, /line two/);
  assert.ok(record.logBytes > 0, "the record must say how much it wrote, not leave it a guess");
});

test("the exit code in the table comes from the process that waited on the child", async () => {
  const h = wired();
  const id = "ps_00000000000000000000000c";
  await h.start(id, "process.exit(7)");
  const record = await settled(h, id);
  assert.equal(record.status, "exited");
  assert.equal(record.exitCode, 7, "the owner is the only writer allowed to name a code");
});

test("with no table wired, the registry behaves exactly as it did before", async () => {
  const home = mkdtempSync(join(tmpdir(), "wp26-unwired-"));
  const registry = createProcessSessionRegistry();
  const snapshot = await registry.start({
    id: "ps_00000000000000000000000d",
    argv: [process.execPath, "-e", "process.exit(0)"],
    cwd: home,
    env: {},
    tty: false,
    rows: 24,
    cols: 80,
    maxBufferBytes: 8_192,
  });

  assert.equal(snapshot.status, "running");
  assert.equal(typeof snapshot.pid, "number");
});
