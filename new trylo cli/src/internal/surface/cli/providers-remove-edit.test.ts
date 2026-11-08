import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { EXIT_CODES } from "../../protocol/cli-stream.js";
import { decodeDocument } from "../../adapters/provider/providers-file.js";
import type { CliContext } from "./context.js";
import { handleLogin } from "./commands-auth.js";
import { parseProviders } from "./args-providers.js";
import {
  handleProvidersAdd,
  handleProvidersEdit,
  handleProvidersRemove,
  handleProvidersSwitch,
} from "./commands-providers.js";

/**
 * D5 P2-3: `providers remove` / `providers edit` ——声明改错的 CLI 修复面。
 *
 * 合同（已拍板）：remove 严格拒绝（未知 id→exit 2 + known 列表；内建 id→exit 2；
 * 删掉选中项→清除 selected 并明示）；edit 缺席=保持原值（只有显式 --account 才
 * 重绑，密钥不许被静默指到新 host）；edit 只收 endpoint/model/account，不收 kind。
 *
 * 成熟对照：gemini `mcp remove` 缺席软成功、add 全量覆盖；codex 同形；本仓库
 * `mcp remove` 本就是拒绝式，且 `add` 明确"不是 set"（防密钥串 host），所以
 * remove 取严格拒绝、edit 取"保留旧绑定"而非 add 式回落当前账号。
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
  const home = mkdtempSync(join(tmpdir(), "trylo-rmedit-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  return home;
}

/** 一条已声明、已选中、已绑账号的 provider：真实 add+switch 走出来的。 */
async function withLab(home: string): Promise<Recorded> {
  const fx = recorded(home);

  assert.equal(await handleLogin(fx.ctx, { provider: "openai-compatible", account: "acc-old" }), EXIT_CODES.OK);
  assert.equal(await handleLogin(fx.ctx, { provider: "openai-compatible", account: "acc-new" }), EXIT_CODES.OK);
  assert.equal(
    handleProvidersAdd(fx.ctx, {
      id: "lab",
      kind: "openai-compatible",
      endpoint: "https://old.example/v1",
      model: "lab-7b",
      account: "acc-old",
    }),
    EXIT_CODES.OK,
  );
  assert.equal(handleProvidersSwitch(fx.ctx, { id: "lab" }), EXIT_CODES.OK);
  fx.out.length = 0;
  fx.err.length = 0;

  return fx;
}

function declaredOf(fx: Recorded, id: string): { endpoint: string; model: string; accountId?: string } {
  const raw = fx.files.get(docPath(fx));

  assert.equal(typeof raw, "string", "expected the providers file to exist");
  const decoded = decodeDocument(raw ?? "");

  assert.equal(decoded.ok, true);

  if (!decoded.ok) {
    throw new Error("unreachable");
  }

  const found = decoded.value.providers.find((entry) => entry.id === id);

  assert.notEqual(found, undefined, `expected ${id} to be declared`);

  return { endpoint: found?.endpoint ?? "", model: found?.model ?? "", ...(found?.accountId === undefined ? {} : { accountId: found.accountId }) };
}

test("remove parses to its own command", () => {
  const parsed = parseProviders(["remove", "lab"]);
  assert.equal(parsed.kind, "providers_remove");
  if (parsed.kind !== "providers_remove") {
    throw new Error("unreachable");
  }
  assert.equal(parsed.options.id, "lab");
});

test("edit parses flags, refuses an empty change and refuses --kind", () => {
  const parsed = parseProviders(["edit", "lab", "--model", "lab-70b"]);

  assert.equal(parsed.kind, "providers_edit");

  if (parsed.kind !== "providers_edit") {
    throw new Error("unreachable");
  }

  assert.deepEqual(parsed.options, { id: "lab", model: "lab-70b" });
  assert.equal(parseProviders(["edit", "lab"]).kind, "error");
  assert.equal(parseProviders(["edit", "lab", "--kind", "openai-compatible"]).kind, "error");
});

test("remove deletes the declaration and clears it as the selection", async (t) => {
  const fx = await withLab(tempHome(t));

  assert.equal(handleProvidersRemove(fx.ctx, { id: "lab" }), EXIT_CODES.OK);
  assert.match(fx.out.join(""), /removed provider lab/);
  const raw = fx.files.get(docPath(fx));
  const decoded = decodeDocument(raw ?? "");

  assert.equal(decoded.ok, true);

  if (!decoded.ok) {
    return;
  }

  assert.equal(decoded.value.providers.some((entry) => entry.id === "lab"), false);
  assert.equal(decoded.value.selected, undefined);
});

test("remove refuses unknown and built-in ids, and writes nothing on refusal", async (t) => {
  const fx = await withLab(tempHome(t));
  const before = fx.files.get(docPath(fx));

  assert.equal(handleProvidersRemove(fx.ctx, { id: "nosuch" }), EXIT_CODES.USAGE);
  assert.match(fx.err.join(""), /unknown provider: nosuch/);
  assert.match(fx.err.join(""), /known providers:.*lab/);
  assert.equal(handleProvidersRemove(fx.ctx, { id: "fixture" }), EXIT_CODES.USAGE);
  assert.match(fx.err.join(""), /built-in/);
  assert.equal(fx.files.get(docPath(fx)), before);
});

test("edit changes only the named fields and keeps the old account binding", async (t) => {
  const fx = await withLab(tempHome(t));

  assert.equal(
    handleProvidersEdit(fx.ctx, { id: "lab", endpoint: "https://new.example/v1" }),
    EXIT_CODES.OK,
  );
  const after = declaredOf(fx, "lab");

  assert.equal(after.endpoint, "https://new.example/v1");
  assert.equal(after.model, "lab-7b");
  // 关键：没给 --account 就必须保留 acc-old，而不是回落 family 当前（空账本里是
  // undefined，add 式回落会把绑定丢掉——密钥归属不许这样动）。
  assert.equal(after.accountId, "acc-old");
});

test("edit rebinds only with an explicit --account, and refuses unknown ids", async (t) => {
  const fx = await withLab(tempHome(t));

  assert.equal(handleProvidersEdit(fx.ctx, { id: "lab", account: "acc-new" }), EXIT_CODES.OK);
  assert.equal(declaredOf(fx, "lab").accountId, "acc-new");
  assert.match(fx.out.join(""), /bound to account acc-new/);

  const before = fx.files.get(docPath(fx));

  assert.equal(handleProvidersEdit(fx.ctx, { id: "nosuch", model: "x" }), EXIT_CODES.USAGE);
  assert.match(fx.err.join(""), /unknown provider: nosuch/);
  assert.match(fx.err.join(""), /known providers:.*lab/);
  assert.equal(handleProvidersEdit(fx.ctx, { id: "fixture", model: "x" }), EXIT_CODES.USAGE);
  assert.match(fx.err.join(""), /built-in/);
  assert.equal(fx.files.get(docPath(fx)), before);
});
