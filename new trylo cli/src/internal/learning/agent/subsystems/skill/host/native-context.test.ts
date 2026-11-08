import assert from "node:assert/strict";
import { ChildProcess } from "node:child_process";
import { PassThrough } from "node:stream";
import test from "node:test";
import { createHermesNativeContext } from "./native-context.js";

class FixtureChild extends ChildProcess {
  override stdin = new PassThrough(); override stdout = new PassThrough(); override stderr = new PassThrough();
  override stdio: [PassThrough, PassThrough, PassThrough, undefined, undefined] = [this.stdin, this.stdout, this.stderr, undefined, undefined];
  override killed = false;

  override kill() {
    this.killed = true;
    return true;
  }

  reply(value: unknown, code = 0) {
    this.stdout.write(JSON.stringify(value));
    this.emit("close", code, null);
  }
}

test("native context is lazy and forwards only explicit runtime locations and visibility inputs", async () => {
  const children: FixtureChild[] = [], warnings: string[] = [];
  let request = "", environment: Readonly<Record<string, string | undefined>> | undefined;
  const client = createHermesNativeContext({ pythonBinary: "owned-python", capabilitiesDir: "owned-capabilities", hermesHome: "owned-home",
    env: { BASE: "value" }, warn: code => warnings.push(code), spawn(command, args, options) {
      assert.equal(command, "owned-python");
      assert.deepEqual(args.slice(1), ["--capabilities-dir", "owned-capabilities"]);
      environment = options.env;
      const child = new FixtureChild();
      children.push(child);
      child.stdin.on("data", (part: Buffer) => { request += part.toString(); });
      return child;
    } });

  assert.equal(children.length, 0, "disabled runtime can avoid construction without starting or reading anything");
  const reading = client.context({ availableTools: ["read_file"], maxPromptChars: 15_000 });

  assert.deepEqual(JSON.parse(request), { op: "context", availableTools: ["read_file"], maxPromptChars: 15_000 });
  assert.equal(environment?.HERMES_HOME, "owned-home");
  const hash = "sha256:" + "0".repeat(64);

  children[0]!.reply({ success: true, prompt: "native compact index", upstreamPromptHash: hash });
  assert.deepEqual(await reading, { ok: true, prompt: "native compact index", upstreamPromptHash: hash });
  assert.deepEqual(warnings, []);
});

test("dependency errors expose a fixed diagnostic without leaking raw messages", async () => {
  const warnings: string[] = [], child = new FixtureChild();
  const client = createHermesNativeContext({ pythonBinary: "python", capabilitiesDir: "capabilities", hermesHome: "home", env: {},
    warn: code => warnings.push(code), spawn: () => child });
  const reading = client.context();

  child.stderr.write("secret credential and private path");
  child.reply({ success: false, code: "private secret path" }, 1);
  assert.deepEqual(await reading, { ok: false, code: "hermes_native_context_unavailable" });
  assert.deepEqual(warnings, ["hermes_native_context_unavailable"]);
});

test("usage uses its own native operation and cancellation prevents starting another child", async () => {
  const child = new FixtureChild(), warnings: string[] = [];
  let request = "", starts = 0;
  const client = createHermesNativeContext({ pythonBinary: "python", capabilitiesDir: "capabilities", hermesHome: "home", env: {},
    warn: code => warnings.push(code), spawn() {
      starts += 1;
      child.stdin.on("data", (part: Buffer) => { request += part.toString(); });
      return child;
    } });
  const recording = client.recordView({ name: "release" });

  assert.deepEqual(JSON.parse(request), { op: "record_view", name: "release" });
  child.reply({ success: true });
  assert.deepEqual(await recording, { ok: true });
  const cancel = new AbortController();
  cancel.abort();
  assert.deepEqual(await client.context({}, cancel.signal), { ok: false, code: "cancelled" });
  assert.equal(starts, 1);
  assert.deepEqual(warnings, []);
});

test("context output overflow kills its process and reports a bounded failure", async () => {
  const child = new FixtureChild(), warnings: string[] = [];
  const client = createHermesNativeContext({ pythonBinary: "python", capabilitiesDir: "capabilities", hermesHome: "home", env: {},
    warn: code => warnings.push(code), spawn: () => child });
  const reading = client.context();

  child.stdout.write("x".repeat(1024 * 1024 + 1));
  assert.deepEqual(await reading, { ok: false, code: "hermes_native_context_output_limit" });
  assert.equal(child.killed, true);
  assert.deepEqual(warnings, ["hermes_native_context_output_limit"]);
});
