import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";

// Exercise the installed command boundary. A read-only probe must work even
// when execution/TUI modules cannot load; this also prevents startup regressions
// from being hidden by faster developer machines or a raised Desktop timeout.
for (const args of [["providers", "list", "--json"], ["status", "--json"]]) {
  test(`${args.join(" ")} does not initialize the run or TUI runtime`, (t) => {
    const root = mkdtempSync(join(tmpdir(), "trylo-readonly-startup-"));

    t.after(() => rmSync(root, { recursive: true, force: true }));
    const home = join(root, "home");

    mkdirSync(home);
    const loader = join(root, "readonly-loader.mjs");

    writeFileSync(loader, `
export async function load(url, context, nextLoad) {
  if (/\\/surface\\/cli\\/(?:run-command|run-stdio|doctor-run|commands-checkpoint)\\.js$/.test(url)
      || url.includes('/surface/cli/tui/')) {
    throw new Error('READONLY_RUNTIME_LOADED: ' + url);
  }
  return nextLoad(url, context);
}
`);
    const entry = fileURLToPath(new URL("../../../cmd/trylo/main.js", import.meta.url));
    const result = spawnSync(process.execPath,
      ["--experimental-loader", pathToFileURL(loader).href, entry, ...args], {
        cwd: root, windowsHide: true, encoding: "utf8", timeout: 20_000,
        env: { TRYLO_HOME: home, USERPROFILE: home, HOME: home },
      });

    assert.equal(result.error, undefined);
    assert.equal(result.status, 0, result.stderr);
    const response: unknown = JSON.parse(result.stdout);

    assert.equal(typeof response, "object", "the probe retains its JSON contract");
    assert.notEqual(response, null);
  });
}
