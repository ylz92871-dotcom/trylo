import assert from "node:assert/strict";
import test from "node:test";
import { ChildProcess, type SpawnOptions } from "node:child_process";
import { PassThrough } from "node:stream";
import { executeNpmResolverProcess, type NpmResolverProcessOptions } from "./npm-resolver-process.js";

class ControlledChild extends ChildProcess {
  readonly signals: (NodeJS.Signals | number | undefined)[] = [];

  override kill(signal?: NodeJS.Signals | number): boolean {
    this.signals.push(signal);
    return true;
  }
}

function fixture() {
  const child = new ControlledChild(), timers = new Map<ReturnType<typeof setTimeout>, { callback: () => void; milliseconds: number }>();
  const controller = new AbortController(), launches: { file: string; args: readonly string[]; options: SpawnOptions }[] = [];

  child.stderr = new PassThrough();
  child.stdout = new PassThrough();
  const options: NpmResolverProcessOptions = {
    launch: (file, args, options) => {
      launches.push({ file, args, options });
      return child;
    },
    after: (callback, milliseconds) => {
      const handle = setTimeout(() => {}, 1);
      clearTimeout(handle);
      timers.set(handle, { callback, milliseconds });
      return handle;
    }, clear: handle => { timers.delete(handle); },
  };
  const start = () => executeNpmResolverProcess({ executable: "TEST_ONLY_node", args: ["TEST_ONLY_npm-cli.js", "install", "--package-lock-only"],
    cwd: "TEST_ONLY_private", env: {}, signal: controller.signal }, options);
  const fire = (milliseconds: number) => {
    const entry = [...timers].find(([, timer]) => timer.milliseconds === milliseconds);
    assert.ok(entry);
    timers.delete(entry[0]);
    entry[1].callback();
  };

  return { child, controller, start, fire, launches, timers };
}

test("cancel and a child AbortError never release scratch ownership before actual close", async () => {
  const fx = fixture();
  let settled = false;
  const pending = fx.start().then(result => {
    settled = true;
    return result;
  });
  fx.controller.abort();
  fx.child.emit("error", Object.assign(new Error("TEST ONLY abort"), { code: "ABORT_ERR" }));
  await Promise.resolve();
  assert.equal(settled, false);
  assert.deepEqual(fx.child.signals, ["SIGTERM"]);
  fx.child.emit("close", null, "SIGTERM");
  assert.deepEqual(await pending, { ok: false, code: "cancelled", cleanup: "safe" });
  assert.equal(fx.timers.size, 0);
  assert.equal(fx.launches.length, 1);
  assert.equal(fx.launches[0]?.options.shell, undefined);
});

test("an unconfirmed stop has a bounded exact outcome and retains the original process ownership", async () => {
  const fx = fixture(), pending = fx.start();
  fx.controller.abort();
  fx.fire(5_000);
  fx.fire(2_000);
  assert.deepEqual(await pending, { ok: false, code: "npm_resolver_stop_unconfirmed", cleanup: "retained" });
  assert.deepEqual(fx.child.signals, ["SIGTERM", "SIGKILL"]);
  assert.equal(fx.launches.length, 1);
  fx.child.emit("error", new Error("TEST ONLY late error"));
  fx.child.emit("close", null, "SIGKILL");
  assert.equal(fx.timers.size, 0);
});

test("the process deadline distinguishes a confirmed timeout from npm failure", async () => {
  const fx = fixture(), pending = fx.start();
  fx.fire(90_000);
  fx.child.emit("close", null, "SIGTERM");
  assert.deepEqual(await pending, { ok: false, code: "npm_resolution_timeout", cleanup: "safe" });
});

test("a definite executable launch failure becomes typed unavailable, with no second launch", async () => {
  const fx = fixture(), pending = fx.start();
  fx.child.emit("error", Object.assign(new Error("TEST ONLY"), { code: "ENOENT" }));
  fx.child.emit("close", -2, null);
  assert.deepEqual(await pending, { ok: false, code: "npm_resolver_unavailable", cleanup: "safe" });
  assert.equal(fx.launches.length, 1);
});

test("bounded combined output requests a stop but still waits for the close receipt", async () => {
  const fx = fixture(), pending = fx.start();
  let settled = false;
  void pending.then(() => { settled = true; });
  const stderr = fx.child.stderr;
  assert.ok(stderr instanceof PassThrough);
  stderr.write(Buffer.alloc(262_145));
  await Promise.resolve();
  assert.equal(settled, false);
  assert.deepEqual(fx.child.signals, ["SIGTERM"]);
  fx.child.emit("close", null, "SIGTERM");
  assert.deepEqual(await pending, { ok: false, code: "npm_resolver_output_limit", cleanup: "safe" });
});
