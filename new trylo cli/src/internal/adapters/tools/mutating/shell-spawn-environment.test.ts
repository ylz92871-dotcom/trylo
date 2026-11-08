import assert from "node:assert/strict";
import test from "node:test";
import { createNodeSpawner, childEnvironment } from "./shell-spawn.js";

test("a trusted broker environment reaches every actual pipeline segment", async () => {
  const argv = [process.execPath, "-e", "console.log(process.env.LOCALAPPDATA)"];
  const spawner = createNodeSpawner(() => ({ ...childEnvironment(), LOCALAPPDATA: "WP28_HOST_LEDGER" }));
  const spec = { argv, cwd: process.cwd(), timeoutMs: 10000, signal: new AbortController().signal, maxOutputBytes: 10000, maxOutputLines: 100 };
  const single = await spawner(spec);

  assert.equal(single.exitCode, 0);
  assert.equal(single.stdout.trim(), "WP28_HOST_LEDGER");
  const receiver = [process.execPath, "-e", "let b='';process.stdin.on('data',x=>b+=x);process.stdin.on('end',()=>console.log(b.trim()+'|'+process.env.LOCALAPPDATA))"];
  const piped = await spawner({ ...spec, pipeTo: [{ argv: receiver, shape: { kind: "direct", argv: receiver } }] });

  assert.equal(piped.exitCode, 0);
  assert.equal(piped.stdout.trim(), "WP28_HOST_LEDGER|WP28_HOST_LEDGER");
});
