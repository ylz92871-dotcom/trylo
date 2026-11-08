import { testScratchPath } from "../../testing/scratch.js";
import assert from "node:assert/strict";
import test from "node:test";
import { mkdirSync, mkdtempSync, rmSync, statSync } from "node:fs";
import path from "node:path";
import { handleLibraryCommand } from "./commands-library.js";
import { openCliLibraryHosts } from "./library-host-wiring.js";
import { parseArgs } from "./args.js";
import type { CliContext } from "./context.js";

test("stdio mode selects original interactive Permission and only a correlated host reply authorizes actual library creation", async () => {
  const prefix = testScratchPath("collaboration-library-host-20261103", "expert-stdio-fixture-");

  mkdirSync(path.dirname(prefix), { recursive: true });

  for (const allow of [true, false]) {
    const root = mkdtempSync(prefix), out: unknown[] = [];
    let failure: unknown;
    const command = JSON.stringify({ operation: "submit", origin: "settings", instruction: "Create a financial handoff expert", requestId: "request-fixture" });
    let next: ((line: string | undefined) => void) | undefined;
    const lines: string[] = [command];
    let id = 0;
    const feed = (line: string) => { if (next) {
      const settle = next;
      next = undefined;
      settle(line);
    }else lines.push(line); };
    const ctx: CliContext = { env: { TRYLO_HOME: path.join(root, "profile") }, homeDir: root, cwd: root, nodeVersion: "v24", stdinIsTty: false,
      readFile: () => undefined, readDir: () => [], writeFile: () => false, isDirectory: name => { try { return statSync(name).isDirectory(); }catch { return false; } },
      readStdin: async () => { throw new Error("Framed mode must not consume stdin to EOF"); },
      readLine: async () => lines.shift() ?? new Promise(resolve => { next = resolve; }), readSecret: async () => undefined,

      stdout: text => { const frame = JSON.parse(text);
      out.push(frame);
        if (frame.type === "control_request") feed(JSON.stringify({ type: "control_response", response: { subtype: "success",
          request_id: frame.request_id, response: { behavior: allow ? "allow" : "deny" } } })); },

      stderr: () => {}, now: () => 100, newId: name => `${name}-${++id}`,

      libraryHosts: async input => {
        const hosts = await openCliLibraryHosts(ctx, input).catch(error => {
          failure = error;
          throw error;
        });
        const catalog = await hosts.tool!.execute({ memberId: "personal_agent", scope: root }, { operation: "query", filter: { text: "web_fetch" } }, input.signal);
        assert.match(JSON.stringify(catalog), /runtime:web_fetch/, "The independent library host needs a real permission-gated web resource declaration");
        return hosts;
      } };

    try {
      const parsed = parseArgs(["library", "expert", "--workspace", root, "--permission-prompt-tool", "stdio", "-"]);

      assert.equal(parsed.kind, "library");
      if (parsed.kind !== "library") return;

      assert.equal(await handleLibraryCommand(ctx, parsed.options), 0, `${String(failure)} ${JSON.stringify(out)}`);
      const requests = out.filter(value => typeof value === "object" && value !== null && "type" in value && value.type === "control_request");

      assert.equal(requests.length, 1);
      const result = out.at(-1) as { state: string; creationAuthorization?: string };

      assert.equal(result.state, allow ? "authorized" : "rejected");
      assert.equal(typeof result.creationAuthorization === "string", allow);
    } finally {
      assert.equal(path.resolve(root).startsWith(prefix), true);
      rmSync(root, { recursive: true, force: true });
    }
  }
});
