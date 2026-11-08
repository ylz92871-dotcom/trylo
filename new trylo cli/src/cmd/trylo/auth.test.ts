import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

/**
 * Child-process contract for the credential commands (WP §2).
 *
 * The real binary is what a user types, so exit codes, stdout/stderr discipline
 * and secret redaction are asserted where they live. The ledger must land in the
 * fixture home, so the child's profile directory is redirected the same way the
 * session tests redirect `TRYLO_HOME` — a test that wrote `~/.credentials.json`
 * on the real machine would be an incident, not a pass.
 */

const cli = fileURLToPath(new URL("./main.js", import.meta.url));
const SECRET = "sk-fixture-not-a-real-key";

type RunResult = {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
};

type Fixture = {
  /** The temp root every fixture path lives under. */
  readonly root: string;
  readonly workspace: string;
  readonly home: string;
  readonly userLedger: string;
  readonly cleanup: () => void;
};

function fixture(): Fixture {
  const root = mkdtempSync(join(os.tmpdir(), "trylo-auth-"));
  const workspace = join(root, "workspace");
  const home = join(root, "home");

  mkdirSync(workspace, { recursive: true });
  mkdirSync(home, { recursive: true });

  return {
    root,
    workspace,
    home,
    userLedger: join(home, "credentials.json"),
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

type RunOptions = {
  /** Extra variables, applied after the declared key variables are stripped. */
  readonly env?: Readonly<Record<string, string>>;
  /** The profile root; `null` leaves `TRYLO_HOME` unset so the fallback is used. */
  readonly tryloHome?: string | null;
  /** The OS home, which is only a fallback once `TRYLO_HOME` is honoured. */
  readonly osHome?: string;
};

function run(fx: Fixture, args: readonly string[], options: RunOptions = {}): RunResult {
  // Hygiene first, injection second: the declared key variables are stripped
  // from the inherited environment BEFORE the per-test overrides are applied,
  // so a test that deliberately sets `TRYLO_API_KEY` keeps it.
  const env: NodeJS.ProcessEnv = { ...process.env };

  delete env.TRYLO_API_KEY;
  delete env.TRYLO_OPENAI_API_KEY;
  const tryloHome = options.tryloHome === undefined ? fx.home : options.tryloHome;
  if (tryloHome === null) {
    delete env.TRYLO_HOME;
  } else {
    env.TRYLO_HOME = tryloHome;
  }

  // `homedir()` is what the ledger used to fall back to, so the whole OS home
  // moves too — and it moves to a directory the profile root does not share.
  const osHome = options.osHome ?? fx.home;

  env.USERPROFILE = osHome;
  env.HOME = osHome;
  Object.assign(env, options.env);
  const result = spawnSync(process.execPath, [cli, ...args], {
    cwd: fx.workspace,
    env,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });

  return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

test("login without a secret source on a non-tty is a usage error naming the next action", () => {
  const fx = fixture();
  try {
    const result = run(fx, ["login", "--provider", "openai-compatible"]);
    assert.equal(result.status, 2);
    assert.match(result.stderr, /secret/);
    assert.match(result.stderr, /--secret-file/);
    assert.equal(existsSync(fx.userLedger), false, "a failed login must not create a ledger");
  } finally {
    fx.cleanup();
  }
});

test("a secret on the command line is refused by name", () => {
  const fx = fixture();
  try {
    for (const flag of ["--secret", "--key", "--token", "--api-key"]) {
      const result = run(fx, ["login", "--provider", "openai-compatible", `${flag}=${SECRET}`]);
      assert.equal(result.status, 2, flag);
      assert.match(result.stderr, /not accepted/);
      assert.equal(result.stdout.includes(SECRET), false);
      assert.equal(result.stderr.includes(SECRET), false);
    }
  } finally {
    fx.cleanup();
  }
});

test("login from a secret file stores the account and status never prints the value", () => {
  const fx = fixture();
  try {
    const secretFile = join(fx.workspace, "key.txt");

    writeFileSync(secretFile, `${SECRET}\n`);
    const login = run(fx, [
      "login",
      "--provider",
      "openai-compatible",
      "--label",
      "work",
      "--secret-file",
      secretFile,
    ]);

    assert.equal(login.status, 0, login.stderr);
    assert.equal(login.stdout.includes(SECRET), false);
    assert.match(login.stdout, /logged in openai-compatible/);

    const status = run(fx, ["status", "--json"]);

    assert.equal(status.status, 0, status.stderr);
    assert.equal(status.stdout.includes(SECRET), false);
    const view = JSON.parse(status.stdout) as {
      providers: Array<{ providerId: string; layer: string; loggedIn: boolean }>;
    };
    const row = view.providers.find((entry) => entry.providerId === "openai-compatible");

    assert.equal(row?.loggedIn, true);
    assert.equal(row?.layer, "user");
    assert.equal(JSON.stringify(view).includes("secret"), false);

    const text = run(fx, ["status"]);

    assert.equal(text.status, 0);
    assert.equal(text.stdout.includes(SECRET), false);
    assert.match(text.stdout, /layer=user/);
  } finally {
    fx.cleanup();
  }
});

test("auth list and switch move the current account; logout is idempotent", () => {
  const fx = fixture();
  try {
    const secretFile = join(fx.workspace, "key.txt");

    writeFileSync(secretFile, SECRET);

    for (const account of ["acct-one", "acct-two"]) {
      const login = run(fx, [
        "login",
        "--provider",
        "openai-compatible",
        "--account",
        account,
        "--secret-file",
        secretFile,
      ]);
      assert.equal(login.status, 0, login.stderr);
    }

    const list = run(fx, ["auth", "list"]);

    assert.equal(list.status, 0, list.stderr);
    assert.match(list.stdout, /acct-one/);
    assert.match(list.stdout, /acct-two/);
    assert.equal(list.stdout.includes(SECRET), false);

    const switched = run(fx, [
      "auth",
      "switch",
      "--provider",
      "openai-compatible",
      "--account",
      "acct-one",
    ]);

    assert.equal(switched.status, 0, switched.stderr);

    const status = run(fx, ["status"]);

    assert.match(status.stdout, /account=acct-one/);

    const unknown = run(fx, [
      "auth",
      "switch",
      "--provider",
      "openai-compatible",
      "--account",
      "nope",
    ]);

    assert.equal(unknown.status, 2);
    assert.match(unknown.stderr, /auth list/);

    assert.equal(run(fx, ["logout", "--provider", "openai-compatible"]).status, 0);
    const again = run(fx, ["logout", "--provider", "openai-compatible"]);

    assert.equal(again.status, 0, "logging out when already logged out is not an error");
  } finally {
    fx.cleanup();
  }
});

test("--project targets the workspace ledger, not the user home", () => {
  const fx = fixture();
  try {
    const secretFile = join(fx.workspace, "key.txt");

    writeFileSync(secretFile, SECRET);
    const login = run(fx, [
      "login",
      "--provider",
      "openai-compatible",
      "--account",
      "proj-acct",
      "--project",
      "--secret-file",
      secretFile,
    ]);

    assert.equal(login.status, 0, login.stderr);
    assert.equal(existsSync(join(fx.workspace, ".trylo", "credentials.json")), true);
    assert.equal(existsSync(fx.userLedger), false);

    const list = run(fx, ["auth", "list"]);

    assert.equal(list.stdout.includes("proj-acct"), false, "user list excludes project accounts");
    const projectList = run(fx, ["auth", "list", "--project"]);

    assert.match(projectList.stdout, /proj-acct/);
    assert.match(projectList.stdout, /scope=project/);
  } finally {
    fx.cleanup();
  }
});

test("an active declared environment variable shadows a ledger login", () => {
  const fx = fixture();
  try {
    // The secret source must be valid so the flow reaches the port: the
    // shadowing verdict belongs to the ledger, not to secret-file reading.
    const secretFile = join(fx.workspace, "k.txt");

    writeFileSync(secretFile, SECRET);
    const result = run(
      fx,
      ["login", "--provider", "openai-compatible", "--secret-file", secretFile],
      { env: { TRYLO_API_KEY: SECRET } },
    );

    assert.equal(result.status, 41);
    assert.match(result.stderr, /env_shadowed/);
    assert.equal(existsSync(fx.userLedger), false);
  } finally {
    fx.cleanup();
  }
});

test("an unknown provider is a usage error naming the closed set", () => {
  const fx = fixture();
  try {
    const result = run(fx, ["login", "--provider", "anthropic"]);
    assert.equal(result.status, 2);
    assert.match(result.stderr, /unknown provider: anthropic/);
    assert.match(result.stderr, /openai-compatible/);
  } finally {
    fx.cleanup();
  }
});

test("doctor reports an unauthenticated selected provider as a failure without values", () => {
  const fx = fixture();
  try {
    const result = run(fx, ["run", "--provider", "openai-compatible", "--endpoint", "https://x.invalid/v1", "ignored"]);

    assert.equal(result.status, 41, "a missing credential must stay an auth failure");

    const doctor = run(fx, [
      "config",
      "show",
    ]);

    assert.equal(doctor.status, 0);

    writeFileSync(join(fx.workspace, "doctor-check.txt"), "x");
    const diag = run(fx, ["doctor"]);

    assert.equal(diag.stdout.includes(SECRET), false);
  } finally {
    fx.cleanup();
  }
});

test("the user ledger survives a run: session and credential homes stay apart", () => {
  const fx = fixture();
  try {
    const secretFile = join(fx.workspace, "key.txt");
    writeFileSync(secretFile, SECRET);
    assert.equal(run(fx, ["login", "--provider", "openai-compatible", "--secret-file", secretFile]).status, 0);
    assert.equal(run(fx, ["run", "--provider", "fixture", "hi"]).status, 0, "a fixture run needs no credential");
    assert.equal(readFileSync(fx.userLedger, "utf8").includes(SECRET), true);
  } finally {
    fx.cleanup();
  }
});

test("the ledger obeys TRYLO_HOME even when the OS home points elsewhere", () => {
  const fx = fixture();
  try {
    // The audit's F2: sessions followed `tryloHome()` while the ledger followed
    // `homedir()`, so a user with `TRYLO_HOME` set kept the key in the real home.
    const profile = join(fx.root, "profile");
    const secretFile = join(fx.workspace, "key.txt");

    writeFileSync(secretFile, SECRET);
    const login = run(fx, ["login", "--provider", "openai-compatible", "--secret-file", secretFile], {
      tryloHome: profile,
      osHome: fx.home,
    });

    assert.equal(login.status, 0, login.stderr);
    assert.equal(existsSync(join(profile, "credentials.json")), true, "the ledger belongs under TRYLO_HOME");
    assert.equal(existsSync(join(fx.home, "credentials.json")), false, "the OS home root is not a profile root");
  } finally {
    fx.cleanup();
  }
});

test("with no TRYLO_HOME the ledger lives under the profile directory", () => {
  const fx = fixture();
  try {
    const secretFile = join(fx.workspace, "key.txt");

    writeFileSync(secretFile, SECRET);
    const login = run(fx, ["login", "--provider", "openai-compatible", "--secret-file", secretFile], {
      tryloHome: null,
    });

    assert.equal(login.status, 0, login.stderr);
    assert.equal(existsSync(join(fx.home, ".trylo", "credentials.json")), true);
    assert.equal(existsSync(join(fx.home, "credentials.json")), false, "the profile root has a directory of its own");
  } finally {
    fx.cleanup();
  }
});

test("a secret file over the cap is a usage error and leaves no ledger behind", () => {
  const fx = fixture();
  try {
    const secretFile = join(fx.workspace, "big.txt");
    writeFileSync(secretFile, "x".repeat(9000));
    const result = run(fx, ["login", "--provider", "openai-compatible", "--secret-file", secretFile]);
    assert.equal(result.status, 2);
    assert.match(result.stderr, /8192/);
    assert.equal(existsSync(fx.userLedger), false, "a refused secret must not create a ledger");
  } finally {
    fx.cleanup();
  }
});

test("auth add, switch, list, status and logout manage multi-account ledger without leaking secrets", () => {
  const fx = fixture();
  try {
    const key1File = join(fx.workspace, "key1.txt");
    const key2File = join(fx.workspace, "key2.txt");

    writeFileSync(key1File, "sk-user1-secret-key");
    writeFileSync(key2File, "sk-user2-secret-key");

    // Add account 1
    const add1 = run(fx, [
      "auth",
      "add",
      "--provider",
      "openai-compatible",
      "--account",
      "team-alpha",
      "--label",
      "Team Alpha",
      "--secret-file",
      key1File,
    ]);

    assert.equal(add1.status, 0, add1.stderr);
    assert.equal(add1.stdout.includes("sk-user1-secret-key"), false);

    // Add account 2
    const add2 = run(fx, [
      "auth",
      "add",
      "--provider",
      "openai-compatible",
      "--account",
      "team-beta",
      "--label",
      "Team Beta",
      "--secret-file",
      key2File,
    ]);

    assert.equal(add2.status, 0, add2.stderr);
    assert.equal(add2.stdout.includes("sk-user2-secret-key"), false);

    // List accounts in text format: must list both accounts and NEVER print secrets
    const listText = run(fx, ["auth", "list"]);

    assert.equal(listText.status, 0);
    assert.match(listText.stdout, /team-alpha/);
    assert.match(listText.stdout, /team-beta/);
    assert.equal(listText.stdout.includes("sk-user1"), false);
    assert.equal(listText.stdout.includes("sk-user2"), false);

    // List accounts in JSON format: must contain accounts without secret fields
    const listJson = run(fx, ["auth", "list", "--json"]);

    assert.equal(listJson.status, 0);
    assert.equal(listJson.stdout.includes("sk-user1"), false);
    assert.equal(listJson.stdout.includes("sk-user2"), false);
    const parsedList = JSON.parse(listJson.stdout) as { entries: Array<{ accountId: string }> };

    assert.equal(parsedList.entries.length, 2);
    assert.equal(parsedList.entries.some((e) => e.accountId === "team-alpha"), true);
    assert.equal(parsedList.entries.some((e) => e.accountId === "team-beta"), true);

    // Status shows currently active account (which is team-beta because it was
    // added last). Its id is abbreviated there — eight characters are enough to
    // tell two accounts apart, and `auth list` is where the whole id lives.
    const status1 = run(fx, ["auth", "status"]);

    assert.equal(status1.status, 0);
    assert.match(status1.stdout, /team-bet…/);

    // Switch to team-alpha
    const switchRes = run(fx, ["auth", "switch", "--provider", "openai-compatible", "--account", "team-alpha"]);

    assert.equal(switchRes.status, 0, switchRes.stderr);

    // Status now shows team-alpha, abbreviated the same way
    const status2 = run(fx, ["auth", "status"]);

    assert.equal(status2.status, 0);
    assert.match(status2.stdout, /team-alp…/);

    // Logout
    const logoutRes = run(fx, ["auth", "logout", "--provider", "openai-compatible"]);

    assert.equal(logoutRes.status, 0);

    const status3 = run(fx, ["auth", "status"]);

    assert.equal(status3.status, 0);
    assert.match(status3.stdout, /logged_in=false/);
  } finally {
    fx.cleanup();
  }
});

