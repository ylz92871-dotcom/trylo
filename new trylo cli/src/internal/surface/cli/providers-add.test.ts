import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { EXIT_CODES } from "../../protocol/cli-stream.js";
import { decodeDocument } from "../../adapters/provider/providers-file.js";
import type { CliContext } from "./context.js";
import { handleLogin } from "./commands-auth.js";
import { handleProvidersAdd, handleProvidersConfig, handleProvidersSwitch } from "./commands-providers.js";
import { parseProviders } from "./args-providers.js";

/**
 * `providers add`: the one writer in the providers family.
 *
 * The contract is not "a file gets written". It is that a person can go from
 * nothing to a *selected, bound, resolvable* provider without opening an editor,
 * and that every way of getting it wrong is refused before the disk is touched —
 * because a half-written declaration is a key on its way to the wrong host.
 */

type Recorded = {
  readonly ctx: CliContext;
  readonly out: string[];
  readonly err: string[];
  readonly files: Map<string, string>;
  readonly home: string;
};

function docPath(fx: Recorded): string {
  return `${fx.home}/.trylo/providers.json`;
}

function recorded(homeDir: string, files: Map<string, string> = new Map()): Recorded {
  const out: string[] = [];
  const err: string[] = [];
  // 凭据账本走真实 fs（以 homeDir 为根）：必须用真临时目录，
  // "/home/user" 会落盘（D:\home）并毒化同 home 的其它测试。
  const ctx: CliContext = {
    env: {},
    homeDir: homeDir,
    cwd: "/workspace",
    nodeVersion: "v22.0.0",
    stdinIsTty: true,
    readFile: (path) => files.get(path),
    isDirectory: () => true,
    readDir: () => [],

    writeFile: (path, text) => {
      files.set(path, text);
      return true;
    },

    readStdin: async () => "",
    readLine: async () => undefined,
    readSecret: async () => "seed-secret",
    stdout: (text) => out.push(text),
    stderr: (text) => err.push(text),
    now: () => 0,
    newId: (prefix) => `${prefix}-1`,
  };

  return { ctx, out, err, files, home: homeDir };
}

/** 真临时 home（账本落真盘，用完即删）。 */
function tempHome(t: { after: (fn: () => void) => void }): string {
  const home = mkdtempSync(join(tmpdir(), "trylo-add-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  return home;
}

test("add writes a declaration, and it reads back through the real decoder", async (t) => {
  const fx = recorded(tempHome(t));

  assert.equal(await handleLogin(fx.ctx, { provider: "openai-compatible", account: "work" }), EXIT_CODES.OK);
  const code = handleProvidersAdd(fx.ctx, {
    id: "amd",
    kind: "openai-compatible",
    endpoint: "https://amd.example/api/v1/chat/completions",
    model: "deepseek-v4",
    account: "work",
  });

  assert.equal(code, EXIT_CODES.OK);
  assert.equal(fx.out.join("").includes("declared provider amd"), true);
  assert.equal(fx.out.join("").includes("bound to account work"), true);

  const raw = fx.files.get(docPath(fx));

  assert.equal(typeof raw, "string");
  const decoded = decodeDocument(raw ?? "");

  assert.equal(decoded.ok, true);

  if (!decoded.ok) {
    return;
  }

  const declared = decoded.value.providers.find((entry) => entry.id === "amd");

  assert.equal(declared?.endpoint, "https://amd.example/api/v1/chat/completions");
  assert.equal(declared?.model, "deepseek-v4");
  assert.equal(declared?.accountId, "work");
  // The declared model is also the declared list, so `providers models` has
  // something true to say about a provider this CLI did not ship.
  assert.deepEqual(declared?.capabilities.models, ["deepseek-v4"]);
});

test("add then switch selects it, and config reports the bound account", async (t) => {
  const fx = recorded(tempHome(t));

  assert.equal(await handleLogin(fx.ctx, { provider: "openai-compatible", account: "work" }), EXIT_CODES.OK);
  assert.equal(
    handleProvidersAdd(fx.ctx, {
      id: "amd",
      kind: "openai-compatible",
      endpoint: "https://amd.example/api/v1/chat/completions",
      model: "deepseek-v4",
      account: "work",
    }),
    EXIT_CODES.OK,
  );
  assert.equal(handleProvidersSwitch(fx.ctx, { id: "amd" }), EXIT_CODES.OK);
  fx.out.length = 0;
  fx.err.length = 0;
  const code = handleProvidersConfig(fx.ctx, { id: "amd", json: true });

  assert.equal(code, EXIT_CODES.OK);
  const payload = JSON.parse(fx.out.join("")) as {
    id: string;
    endpoint: string;
    model: string;
    origin: string;
    credential: { readonly account: string; readonly bound?: boolean; readonly loggedIn: boolean };
  };

  assert.equal(payload.id, "amd");
  assert.equal(payload.endpoint, "https://amd.example/api/v1/chat/completions");
  assert.equal(payload.model, "deepseek-v4");
  assert.equal(payload.origin, "providers.json");
  // 绑的是账本里真实存在的账号：悬空绑定在 add 这一步就被拒了，
  // 不再是"记下来、run 时再报 credential 问题"。
  assert.equal(payload.credential.account, "work");
  assert.equal(payload.credential.bound, true);
  assert.equal(payload.credential.loggedIn, true);
});

test("a built-in id, a duplicate and a missing endpoint are all refused before any write", (t) => {
  const fx = recorded(tempHome(t));
  const first = {
    id: "amd",
    kind: "openai-compatible" as const,
    endpoint: "https://amd.example/api/v1/chat/completions",
    model: "deepseek-v4",
  };

  assert.equal(handleProvidersAdd(fx.ctx, first), EXIT_CODES.OK);
  const before = fx.files.get(docPath(fx));
  const cases: ReadonlyArray<[Parameters<typeof handleProvidersAdd>[1], string]> = [
    [{ ...first, id: "fixture" }, "built-in"],
    [{ ...first, id: "openai-compatible" }, "built-in"],
    [first, "already exists"],
    [{ ...first, id: "amd", endpoint: "" }, "--endpoint"],
    [{ ...first, id: "amd", model: "" }, "--model"],
  ];

  for (const [options, expected] of cases) {
    const code = handleProvidersAdd(fx.ctx, options);
    assert.equal(code, EXIT_CODES.USAGE, JSON.stringify(options));
    assert.equal(fx.err.join("").includes(expected), true, expected);
  }

  // Nothing was written by any refusal.
  assert.equal(fx.files.get(docPath(fx)), before);
});

test("a provider id that could not be typed back is refused, not normalised", (t) => {
  const fx = recorded(tempHome(t));

  for (const id of ["", "1abc", "has space", "a=b"]) {
    const code = handleProvidersAdd(fx.ctx, {
      id,
      kind: "openai-compatible",
      endpoint: "https://x.example",
      model: "m",
    });
    assert.equal(code, EXIT_CODES.USAGE, id);
  }

  assert.equal(fx.files.get(docPath(fx)), undefined);
});

test("the parser takes the id positionally and the rest as flags", () => {
  const parsed = parseProviders([
    "add",
    "amd",
    "--kind",
    "openai-compatible",
    "--endpoint=https://x.example",
    "--model",
    "m",
    "--account",
    "work",
  ]);

  assert.equal(parsed.kind, "providers_add");

  if (parsed.kind !== "providers_add") {
    return;
  }

  assert.deepEqual(parsed.options, {
    id: "amd",
    kind: "openai-compatible",
    endpoint: "https://x.example",
    model: "m",
    account: "work",
  });
});

test("the parser refuses an unknown kind, a missing id and a stray flag", () => {
  for (const argv of [
    ["add", "amd", "--kind", "mystery", "--endpoint", "u", "--model", "m"],
    ["add", "--kind", "openai-compatible"],
    ["add", "amd", "--secret", "x"],
  ]) {
    const parsed = parseProviders(argv);
    assert.equal(parsed.kind, "error", argv.join(" "));
  }
});
