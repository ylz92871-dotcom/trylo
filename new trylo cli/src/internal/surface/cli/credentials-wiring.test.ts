import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { EXIT_CODES, type ExitCode } from "../../protocol/cli-stream.js";
import type { CredentialFailureCode } from "../../ports/credentials.js";
import { parseArgs } from "./args.js";
import {
  createCliCredentialPort,
  credentialExitCode,
  resolveProviderCredential,
} from "./credentials-wiring.js";
import { handleAuthStatus, handleLogin } from "./commands-auth.js";
import type { CliContext } from "./context.js";

/**
 * Composition-root contracts for the credential wiring (WP §0.2) and the
 * adversarial cases that cannot be shown with a child process alone (WP §6).
 *
 * The ledger adapter writes real files, so every login here runs against a
 * per-test temp directory: a test that touched the real `~/.credentials.json`
 * would be an incident, not a pass.
 *
 * Evidence strength note: these tests run the handlers in-process against an
 * injected context. The child-process half of the same contract lives in
 * `cmd/trylo/auth.test.ts`; the two together cover parse, port and projection.
 */

function tempRoot(): { readonly home: string; readonly cwd: string; readonly cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), "trylo-cred-"));
  return {
    home: join(root, "home"),
    cwd: join(root, "workspace"),
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

function ctxOf(
  overrides: Partial<CliContext> = {},
): { readonly ctx: CliContext; readonly out: string[]; readonly err: string[] } {
  const out: string[] = [];
  const err: string[] = [];
  const ctx: CliContext = {
    env: {},
    homeDir: tempRoot().home,
    cwd: tempRoot().cwd,
    nodeVersion: "v22.0.0",
    stdinIsTty: false,
    readFile: () => undefined,
    isDirectory: () => true,
    readDir: () => [],
    writeFile: () => true,
    readStdin: async () => "",
    readLine: async () => undefined,
    readSecret: async () => undefined,
    stdout: (text) => out.push(text),
    stderr: (text) => err.push(text),
    now: () => 0,
    newId: (prefix) => `${prefix}-1`,
    ...overrides,
  };

  return { ctx, out, err };
}

test("every port failure code maps to a documented exit code", () => {
  // Usage bucket: the invocation was wrong.
  for (const code of [
    "unknown_provider",
    "invalid_account_id",
    "missing_secret",
    "unknown_account",
    "duplicate_account",
    "not_logged_in",
    "current_account_protected",
    "confirm_required",
  ] as ReadonlyArray<CredentialFailureCode>) {
    assert.equal(credentialExitCode(code), EXIT_CODES.USAGE, code);
  }

  // Auth bucket: the ledger cannot prove it is safe or intact.
  for (const code of [
    "credentials_corrupt",
    "credentials_insecure",
    "env_shadowed",
    "keyring_unavailable",
    "lock_conflict",
    "path_escape",
    "directory_unavailable",
    "read_failed",
    "write_failed",
  ] as ReadonlyArray<CredentialFailureCode>) {
    assert.equal(credentialExitCode(code), EXIT_CODES.AUTH, code);
  }

  assert.equal(credentialExitCode("credentials_corrupt"), 41);
  assert.equal(credentialExitCode("unknown_account"), 2);
});

test("the environment table resolves the key, and the specific name wins", () => {
  const generic = createCliCredentialPort(ctxOf().ctx);
  const { ctx: envCtx } = ctxOf({ env: { TRYLO_API_KEY: "generic-key" } });
  const genericResolved = resolveProviderCredential(createCliCredentialPort(envCtx), "openai-compatible");

  assert.equal(genericResolved.ok, true);
  assert.equal(genericResolved.ok && genericResolved.apiKey, "generic-key");
  void generic;

  const { ctx: bothCtx } = ctxOf({
    env: { TRYLO_API_KEY: "generic-key", TRYLO_OPENAI_API_KEY: "specific-key" },
  });
  const both = resolveProviderCredential(createCliCredentialPort(bothCtx), "openai-compatible");

  assert.equal(both.ok && both.apiKey, "specific-key");
  assert.equal(both.ok && both.layer, "env");
  assert.equal(both.ok && both.accountId, "env");
});

test("a ledger login resolves the key; nothing resolved is a miss, not an error", () => {
  const root = tempRoot();
  try {
    const { ctx } = ctxOf({ homeDir: root.home, cwd: root.cwd });
    const port = createCliCredentialPort(ctx);

    const before = resolveProviderCredential(port, "openai-compatible");

    assert.equal(before.ok, true);
    assert.equal(before.ok && before.apiKey, undefined);
    assert.equal(before.ok && before.layer, "none");

    const login = port.login({ providerId: "openai-compatible", secret: "ledger-key", label: "work" });

    assert.equal(login.ok, true);
    const after = resolveProviderCredential(port, "openai-compatible");

    assert.equal(after.ok, true);
    assert.equal(after.ok && after.apiKey, "ledger-key");
    assert.equal(after.ok && after.layer, "user");
  } finally {
    root.cleanup();
  }
});

test("a login without a tty and without a secret file refuses explicitly", async () => {
  const root = tempRoot();
  try {
    const { ctx, err } = ctxOf({ homeDir: root.home, cwd: root.cwd });
    const code = await handleLogin(ctx, { provider: "openai-compatible" });
    assert.equal(code, EXIT_CODES.USAGE);
    assert.equal(err.join("").includes("--secret-file"), true);
  } finally {
    root.cleanup();
  }
});

test("a tty login reads the secret from the prompt and never echoes it", async () => {
  const root = tempRoot();
  try {
    const { ctx, out, err } = ctxOf({
      homeDir: root.home,
      cwd: root.cwd,
      stdinIsTty: true,
      readSecret: async () => "typed-secret",
    });
    const code = await handleLogin(ctx, { provider: "openai-compatible" });

    assert.equal(code, EXIT_CODES.OK);
    assert.equal(out.join("").includes("typed-secret"), false);
    assert.equal(err.join("").includes("typed-secret"), false);
    // The round trip through the stored ledger proves the secret really landed.
    // The path follows the profile root, which the audit's F2 moved: what is
    // asserted is the round trip, not the directory the ledger happens to use.
    assert.equal(
      readFileSync(join(root.home, ".trylo", "credentials.json"), "utf8").includes("typed-secret"),
      true,
    );
  } finally {
    root.cleanup();
  }
});

test("status --json is secret-free by shape, not by filtering", async () => {
  const root = tempRoot();
  try {
    // The login needs its own context so the status render below is the ONLY
    // thing in its stdout buffer: the JSON.parse would otherwise see the
    // login banner mixed into the buffer and fail for the wrong reason.
    const { ctx: loginCtx } = ctxOf({
      homeDir: root.home,
      cwd: root.cwd,
      stdinIsTty: true,
      readSecret: async () => "typed-secret",
    });

    await handleLogin(loginCtx, { provider: "openai-compatible", account: "acct-a" });

    const { ctx: statusCtx, out } = ctxOf({ homeDir: root.home, cwd: root.cwd });
    const code = handleAuthStatus(statusCtx, true);

    assert.equal(code, EXIT_CODES.OK);
    const rendered = out.join("");

    assert.equal(rendered.includes("typed-secret"), false);
    const view = JSON.parse(rendered) as { providers: Array<Record<string, unknown>> };

    for (const row of view.providers) {
      assert.equal("secret" in row, false);
    }
  } finally {
    root.cleanup();
  }
});

test("no CLI file reaches exportSecrets", () => {
  // The port has the verb; the CLI must never expose it. The scan looks for a
  // call or an import of the verb (comments naming it are fine and deliberate),
  // and it counts the files it saw so a wrong path cannot pass silently.
  const cliDir = join(process.cwd(), "src", "internal", "surface", "cli");
  const cmdDir = join(process.cwd(), "src", "cmd", "trylo");
  const files: string[] = [];

  for (const dir of [cliDir, cmdDir]) {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      if (statSync(full).isFile() && entry.endsWith(".ts") && !entry.endsWith(".test.ts")) {
        files.push(full);
      }
    }
  }

  assert.equal(files.length > 10, true, `scan saw ${files.length} files`);
  const offenders = files.filter((file) => {
    const text = readFileSync(file, "utf8");
    return /\bexportSecrets\s*\(/.test(text) || /import\s*\{[^}]*exportSecrets/.test(text);
  });

  assert.deepEqual(offenders, []);
});

test("argv parsing refuses secrets and accepts the documented flag surface", () => {
  for (const argv of [
    ["login", "--secret", "x"],
    ["login", "--secret=x"],
    ["login", "--api-key=x"],
    ["login", "--token", "x"],
    ["login", "--password=x"],
  ]) {
    const parsed = parseArgs(argv);
    assert.equal(parsed.kind, "error", argv.join(" "));
  }

  const login = parseArgs([
    "login",
    "--provider",
    "openai-compatible",
    "--account",
    "acct-1",
    "--project",
    "--label",
    "work",
    "--secret-file",
    "k.txt",
  ]);

  assert.equal(login.kind, "login");

  if (login.kind === "login") {
    assert.equal(login.options.provider, "openai-compatible");
    assert.equal(login.options.account, "acct-1");
    assert.equal(login.options.project, true);
    assert.equal(login.options.label, "work");
    assert.equal(login.options.secretFile, "k.txt");
  }

  const status = parseArgs(["status", "--json"]);

  assert.equal(status.kind, "auth_status");
  const list = parseArgs(["auth", "list", "--project"]);

  assert.equal(list.kind, "auth_list");
  const badSub = parseArgs(["auth", "remove"]);

  assert.equal(badSub.kind, "error");
  const noAccount = parseArgs(["auth", "switch", "--provider", "fixture"]);

  assert.equal(noAccount.kind, "error");
  void (0 as unknown as ExitCode);
});

test("the ledger root is the same profile root the sessions use", () => {
  // The audit's F2, at the wiring layer: the port must be handed the profile
  // root, not the OS home, or the key and the transcript end up on different
  // volumes for anyone who sets TRYLO_HOME.
  const root = tempRoot();
  try {
    const profile = join(root.home, "profile");
    const port = createCliCredentialPort({
      homeDir: root.home,
      cwd: root.cwd,
      env: { TRYLO_HOME: profile },
      now: () => 0,
    });

    assert.equal(port.login({ providerId: "openai-compatible", secret: "ledger-key" }).ok, true);
    assert.equal(existsSync(join(profile, "credentials.json")), true);
    assert.equal(existsSync(join(root.home, "credentials.json")), false);
  } finally {
    root.cleanup();
  }
});

test("with no TRYLO_HOME the ledger lands under the profile directory, not the home root", () => {
  const root = tempRoot();
  try {
    const port = createCliCredentialPort({ homeDir: root.home, cwd: root.cwd, env: {}, now: () => 0 });
    assert.equal(port.login({ providerId: "openai-compatible", secret: "ledger-key" }).ok, true);
    assert.equal(existsSync(join(root.home, ".trylo", "credentials.json")), true);
    assert.equal(existsSync(join(root.home, "credentials.json")), false);
  } finally {
    root.cleanup();
  }
});

test("a secret file over the cap is a usage error that creates no ledger", async () => {
  const root = tempRoot();
  try {
    const { ctx, err } = ctxOf({ homeDir: root.home, cwd: root.cwd, readFile: () => "x".repeat(9000) });
    const code = await handleLogin(ctx, { provider: "openai-compatible", secretFile: "big.txt" });
    assert.equal(code, EXIT_CODES.USAGE);
    assert.match(err.join(""), /8192/);
    assert.equal(existsSync(join(root.home, ".trylo")), false, "a refused secret must not create a ledger");
  } finally {
    root.cleanup();
  }
});

test("the login secret never comes from a readline question", () => {
  // The audit's F1: readline with `terminal: false` silences readline and
  // leaves the terminal driver echoing the keystrokes. The two files that can
  // read a secret must not reach for a line reader at all.
  const cliDir = join(process.cwd(), "src", "internal", "surface", "cli");
  const cmdDir = join(process.cwd(), "src", "cmd", "trylo");
  // The caller must not name a line reader at all: any mention means the
  // generic reader has crept back into the secret path.
  const caller = readFileSync(join(cliDir, "commands-auth.ts"), "utf8");

  assert.equal(/readline|readLine/i.test(caller), false, "commands-auth.ts still reaches for a line reader");
  // The reader itself must not import or call one. Prose naming readline is
  // fine and deliberate — that is where the reason it is absent is recorded.
  const reader = readFileSync(join(cliDir, "secret-prompt.ts"), "utf8");

  for (const pattern of [
    /from\s+["']node:readline["']/,
    /\bcreateInterface\s*\(/,
    /\.question\s*\(/,
    /\breadLine\s*\(/,
  ]) {
    assert.equal(pattern.test(reader), false, `secret-prompt.ts still reaches for ${String(pattern)}`);
  }

  // The process layer keeps its generic line reader for the repl and the
  // permission prompt, so the fix is pinned rather than assumed: the secret is
  // bound to the raw-mode reader over the same stdin. And a reader that cannot
  // name an output stream cannot echo into one.
  const main = readFileSync(join(cmdDir, "main.ts"), "utf8");

  assert.match(main, /readSecret:\s*\(\)\s*=>\s*readSecretLine\(\s*process\.stdin\s*\)/);
  // And the reader has no output member at all; this scan keeps it that way.
  assert.equal(/process\.(stdout|stderr)\.|console\.(log|error|warn)\(/.test(reader), false);
});

test("WP18: login --device parses, refuses --oauth company, and needs an endpoint", async () => {
  const device = parseArgs(["login", "--provider", "openai-compatible", "--device"]);

  assert.equal(device.kind, "login");

  if (device.kind === "login") {
    assert.equal(device.options.device, true);
    assert.equal(device.options.oauth, undefined);
  }

  const both = parseArgs(["login", "--provider", "openai-compatible", "--oauth", "--device"]);

  assert.equal(both.kind, "error");
  const root = tempRoot();

  try {
    const { ctx } = ctxOf({ homeDir: root.home, cwd: root.cwd, env: {} });
    const code = await handleLogin(ctx, { provider: "openai-compatible", device: true });
    assert.equal(code, EXIT_CODES.AUTH);
  } finally {
    root.cleanup();
  }
});
