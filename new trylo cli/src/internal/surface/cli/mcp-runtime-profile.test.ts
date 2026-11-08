import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { encodeDocument } from "../../adapters/mcp-registry/document.js";
import { createCliMcpRegistry } from "./mcp-wiring.js";

test("run registry overrides the browser without modifying user or project configuration", async () => {
  const root = mkdtempSync(join(tmpdir(), "trylo-runtime-profile-"));
  const home = join(root, "home"), cwd = join(root, "workspace");

  mkdirSync(home);
  mkdirSync(join(cwd, ".trylo"), { recursive: true });
  const entry = (name: string, command: string) => ({ name, transport: "stdio" as const, command, args: [], env: {}, enabled: true });
  const user = join(home, "mcp-servers.json"), project = join(cwd, ".trylo/mcp-servers.json"), runtime = join(root, "runtime.json");

  writeFileSync(user, encodeDocument([entry("private", "user-server")]));
  writeFileSync(project, encodeDocument([entry("trylo-browser", "old-browser")]));
  writeFileSync(runtime, encodeDocument([entry("trylo-browser", "observed-browser")]));
  const before = [readFileSync(user, "utf8"), readFileSync(project, "utf8")];
  const ctx = { homeDir: home, cwd, env: { TRYLO_HOME: home, TRYLO_MCP_RUNTIME_REGISTRY: runtime } };
  const merged = createCliMcpRegistry(ctx);

  assert.deepEqual(await merged.names(), { ok: true, value: ["private", "trylo-browser"] });
  const browser = await merged.resolve("trylo-browser");

  assert.equal(browser.ok && browser.value.entry.command, "observed-browser");
  const isolated = createCliMcpRegistry({ ...ctx, env: { ...ctx.env, TRYLO_MCP_RUNTIME_MODE: "exclusive" } });

  assert.deepEqual(await isolated.names(), { ok: true, value: ["trylo-browser"] });
  assert.equal((await createCliMcpRegistry({ ...ctx, env: { ...ctx.env, TRYLO_MCP_RUNTIME_MODE: "invalid" } }).names()).ok, false);
  writeFileSync(runtime, "corrupt");
  assert.equal((await merged.names()).ok, false);
  assert.equal((await isolated.resolve("private")).ok, false);
  unlinkSync(runtime);
  assert.equal((await merged.names()).ok, false);
  assert.deepEqual([readFileSync(user, "utf8"), readFileSync(project, "utf8")], before);
});
