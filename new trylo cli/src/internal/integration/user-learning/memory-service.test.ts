import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createFileFactStore, USER_FACTS_FILE, type UserFactStore } from "./facts-file.js";
import { createUserMemoryService, type UserMemoryDeps } from "./memory-service.js";
import { activeFacts, type UserFactRecord } from "../../learning/domains/user/memory-fact.js";

/**
 * WP-CL / B：正式用户记忆。
 *
 * 这些用例钉住的是一条线：用户说了 → 有正式记录 → 新进程读得到 → 撤回后读不到。
 * 任何一条断掉，"记好了"就是一句没有依据的话。
 */

const USER_TEXT = "我是 YL Z，Trylo 的开发者，请记住";

function withService(
  body: (service: ReturnType<typeof createUserMemoryService>, root: string, deps: UserMemoryDeps) => void,
  overrides: Partial<UserMemoryDeps> = {},
): void {
  const root = mkdtempSync(path.join(tmpdir(), "wpcl-facts-"));
  try {
    const deps: UserMemoryDeps = {
      store: createFileFactStore(root),
      userId: "local-user",
      workspaceId: "ws-a",
      now: () => 1_760_000_000_000,
      switchValue: "user",
      turn: { sessionId: "s1", turnId: "t1", userText: USER_TEXT, userEventId: "s1:t1:user" },
      ...overrides,
    };
    body(createUserMemoryService(deps), root, deps);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

const REMEMBER = {
  commandId: "call-1",
  subject: "YL Z",
  statement: "我是 YL Z，Trylo 的开发者，请记住",
  factKind: "identity_fact" as const,
  scopeKind: "user" as const,
};

test("an explicit request is saved to the ledger and readable from a second reader", () => {
  withService((service, root) => {
    const result = service.remember(REMEMBER);

    assert.equal(result.result, "saved");
    assert.ok(existsSync(path.join(root, USER_FACTS_FILE)), "the fact must exist on disk, not only in memory");

    // A second service over the same root is what a new process sees.
    const reopened = createUserMemoryService({
      store: createFileFactStore(root), userId: "local-user", workspaceId: "ws-a",
      now: () => 1_760_000_000_100, switchValue: "user",
      turn: { sessionId: "s2", turnId: "t2", userText: "", userEventId: "s2:t2:user" },
    });
    const visible = reopened.visible();

    assert.equal(visible.length, 1);
    assert.equal(visible[0]?.statement, REMEMBER.statement);
  });
});

test("the same request is idempotent and a different payload under one command is a conflict", () => {
  withService((service) => {
    const first = service.remember(REMEMBER);

    assert.equal(first.result, "saved");
    const again = service.remember(REMEMBER);

    assert.equal(again.result, "already_saved");
    const conflict = service.remember({ ...REMEMBER, subject: "另一个主体" });

    assert.equal(conflict.result, "rejected");
    assert.equal(conflict.result === "rejected" ? conflict.reason : "", "command_conflict");
    assert.equal(service.facts().length, 1);
  });
});

test("a semantic duplicate does not create a second active fact", () => {
  withService((service) => {
    assert.equal(service.remember(REMEMBER).result, "saved");
    const other = service.remember({ ...REMEMBER, commandId: "call-2" });
    assert.equal(other.result, "already_saved");
    assert.equal(activeFacts(service.facts()).length, 1);
  });
});

test("a statement the user never said is refused, including an added title", () => {
  withService((service) => {
    const added = service.remember({ ...REMEMBER, statement: "用户希望被称作老板" });
    assert.equal(added.result, "rejected");
    assert.equal(added.result === "rejected" ? added.reason : "", "statement_not_grounded");
    assert.equal(service.facts().length, 0, "nothing may be written for an ungrounded request");
  });
});

test("a disabled switch writes nothing at all", () => {
  withService((service, root) => {
    const result = service.remember(REMEMBER);
    assert.equal(result.result, "disabled");
    assert.equal(existsSync(path.join(root, USER_FACTS_FILE)), false);
  }, { switchValue: "" });
});

test("correct bumps the version and retract stops the fact from being visible", () => {
  withService((service, _root, deps) => {
    const saved = service.remember(REMEMBER);

    assert.equal(saved.result, "saved");
    const recordId = saved.result === "saved" ? saved.recordId : "";
    const version = saved.result === "saved" ? saved.version : 0;

    const correcting = createUserMemoryService({ ...deps, turn: { ...deps.turn, userText: `请更正这条记忆为：${USER_TEXT}` } });
    const stale = correcting.correct({ commandId: "call-2", recordId, expectedVersion: version + 4,
      statement: "我是 YL Z，Trylo 的开发者，请记住" });

    assert.equal(stale.result === "rejected" ? stale.reason : "", "version_conflict");

    const corrected = correcting.correct({ commandId: "call-3", recordId, expectedVersion: version,
      statement: "我是 YL Z，Trylo 的开发者，请记住" });

    assert.equal(corrected.result, "saved");
    assert.equal(corrected.result === "saved" ? corrected.version : 0, version + 1);
    assert.equal(service.visible().length, 1);

    const retracted = createUserMemoryService({ ...deps, turn: { ...deps.turn, userText: "请撤回这条记忆" } })
      .retract({ commandId: "call-4", recordId, expectedVersion: version + 1 });

    assert.equal(retracted.result, "saved");
    assert.equal(service.visible().length, 0, "a retracted fact must not be retrievable");
    assert.equal(service.facts().length, 3, "every version stays in the ledger as history");
  });
});

test("a retracted fact does not come back after a reopen", () => {
  const root = mkdtempSync(path.join(tmpdir(), "wpcl-facts-"));
  try {
    const deps = (turnId: string): UserMemoryDeps => ({
      store: createFileFactStore(root), userId: "local-user", workspaceId: "ws-a",
      now: () => 1_760_000_000_000, switchValue: "user",
      turn: { sessionId: "s1", turnId, userText: USER_TEXT, userEventId: `s1:${turnId}:user` },
    });
    const first = createUserMemoryService(deps("t1"));
    const saved = first.remember(REMEMBER);
    const recordId = saved.result === "saved" ? saved.recordId : "";

    createUserMemoryService({ ...deps("retract"), turn: { ...deps("retract").turn, userText: "请撤回这条记忆" } })
      .retract({ commandId: "call-9", recordId, expectedVersion: 1 });

    const reopened = createUserMemoryService(deps("t2"));

    assert.equal(reopened.visible().length, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("project scope does not leak into another workspace", () => {
  withService((service, root) => {
    assert.equal(service.remember({ ...REMEMBER, factKind: "project_fact", scopeKind: "project" }).result, "saved");
    const otherWorkspace = createUserMemoryService({
      store: createFileFactStore(root), userId: "local-user", workspaceId: "ws-b",
      now: () => 1_760_000_000_000, switchValue: "user",
      turn: { sessionId: "s1", turnId: "t1", userText: USER_TEXT, userEventId: "s1:t1:user" },
    });

    assert.equal(otherWorkspace.visible().length, 0);
  });
});

test("two writers on one root cannot both win the same version", () => {
  const root = mkdtempSync(path.join(tmpdir(), "wpcl-race-"));
  try {
    const open = () => createUserMemoryService({
      store: createFileFactStore(root), userId: "local-user", workspaceId: "ws-a",
      now: () => 1_760_000_000_000, switchValue: "user",
      turn: { sessionId: "s1", turnId: "t1", userText: `${USER_TEXT}；请更正这条记忆`, userEventId: "s1:t1:user" },
    });
    const first = open();
    const saved = first.remember(REMEMBER);
    const recordId = saved.result === "saved" ? saved.recordId : "";

    // Both processes read v1 before either writes. The second one must lose the
    // race loudly: a silent second v2 is a lost update the user cannot see.
    const winner = first.correct({ commandId: "c-a", recordId, expectedVersion: 1, statement: REMEMBER.statement });

    assert.equal(winner.result, "saved");
    const loser = open().correct({ commandId: "c-b", recordId, expectedVersion: 1, statement: REMEMBER.statement });

    assert.equal(loser.result, "rejected");
    assert.equal(loser.result === "rejected" ? loser.reason : "", "version_conflict");
    assert.equal(open().facts().length, 2, "one create + one correction, no phantom version");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a held lock is a structured refusal, not a silent write", () => {
  const root = mkdtempSync(path.join(tmpdir(), "wpcl-lock-"));
  try {
    // A crashed writer leaves this behind; the next command must refuse rather
    // than guess whether the interrupted append happened.
    writeFileSync(path.join(root, "facts.lock"), "");
    const service = createUserMemoryService({
      store: createFileFactStore(root), userId: "local-user", workspaceId: "ws-a",
      now: () => 1_760_000_000_000, switchValue: "user",
      turn: { sessionId: "s1", turnId: "t1", userText: USER_TEXT, userEventId: "s1:t1:user" },
    });
    const result = service.remember(REMEMBER);

    assert.equal(result.result, "failed");
    assert.match(result.result === "failed" ? result.reason : "", /facts_locked/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a bare confirmation saves nothing on its own", () => {
  withService((service) => {
    const result = service.remember(REMEMBER);
    assert.equal(result.result, "rejected");
    assert.equal(result.result === "rejected" ? result.reason : "", "statement_not_grounded");
    assert.equal(service.facts().length, 0, "a confirmation without its proposition is not a fact");
  }, { turn: { sessionId: "s1", turnId: "t2", userText: "可以，记住也行，记不住也行", userEventId: "s1:t2:user" } });
});

test("a confirmation binds to the sentence the user actually said earlier", () => {
  withService((service) => {
    const result = service.remember(REMEMBER);
    assert.equal(result.result, "saved");
    const record = service.facts()[0];
    assert.equal(record?.source.kind, "user_confirmation");
    assert.equal(record?.source.kind === "user_confirmation" ? record.source.confirmsEventId : "", "s1:t1:user");
  }, {
    turn: {
      sessionId: "s1", turnId: "t2", userText: "可以，记住也行，记不住也行", userEventId: "s1:t2:user",
      priorUser: [{ text: USER_TEXT, eventId: "s1:t1:user" }],
    },
  });
});

test("a confirmation cannot bind to something the user never said", () => {
  withService((service) => {
    const result = service.remember(REMEMBER);
    assert.equal(result.result, "rejected");
  }, {
    turn: {
      sessionId: "s1", turnId: "t2", userText: "可以", userEventId: "s1:t2:user",
      priorUser: [{ text: "帮我看看这个报错", eventId: "s1:t1:user" }],
    },
  });
});

test("a new instruction that merely starts with 可以 is not a confirmation", () => {
  withService((service) => {
    const result = service.remember(REMEMBER);
    assert.equal(result.result, "rejected");
    assert.equal(result.result === "rejected" ? result.reason : "", "statement_not_grounded");
  }, {
    turn: {
      sessionId: "s1", turnId: "t2", userText: "可以，帮我把这个函数改一下", userEventId: "s1:t2:user",
      priorUser: [{ text: USER_TEXT, eventId: "s1:t1:user" }],
    },
  });
});

test("a home directory with a space in it still saves and reads back", () => {
  // B15: TRYLO_HOME is user-controlled and Windows profiles routinely contain
  // spaces. A path bug here would look like "memory silently does not work".
  const parent = mkdtempSync(path.join(tmpdir(), "wpcl-space-"));
  const root = path.join(parent, "try lo home", "learning", "user");

  try {
    const deps: UserMemoryDeps = {
      store: createFileFactStore(root), userId: "local-user", workspaceId: "ws-a",
      now: () => 1_760_000_000_000, switchValue: "user",
      turn: { sessionId: "s1", turnId: "t1", userText: USER_TEXT, userEventId: "s1:t1:user" },
    };
    const service = createUserMemoryService(deps);

    assert.equal(service.remember(REMEMBER).result, "saved");
    const reopened = createUserMemoryService(deps);

    assert.equal(reopened.visible().length, 1);
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

test("a statement the user did not ask to remember becomes a proposal, not a memory", () => {
  // B09: "我是 YL Z" is a fact about the person, but they did not ask to keep it.
  // Saving it outright would be remembering on their behalf.
  const root = mkdtempSync(path.join(tmpdir(), "wpcl-proposal-"));
  try {
    const plain = "我是 YL Z，Trylo 的开发者";
    const service = createUserMemoryService({
      store: createFileFactStore(root), userId: "local-user", workspaceId: "ws-a",
      now: () => 1_760_000_000_000, switchValue: "user",
      turn: { sessionId: "s1", turnId: "t1", userText: plain, userEventId: "s1:t1:user" },
    });
    const result = service.remember({ ...REMEMBER, statement: plain });

    assert.equal(result.result, "pending");
    assert.match(result.result === "pending" ? result.proposalId : "", /^prop-/);
    assert.equal(service.visible().length, 0, "a proposal must not be retrievable");
    assert.equal(service.facts().length, 0, "a proposal is not a fact");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the next confirmation turns a pending proposal into the saved fact", () => {
  const root = mkdtempSync(path.join(tmpdir(), "wpcl-confirm-"));
  try {
    const plain = "我是 YL Z，Trylo 的开发者";
    const first = createUserMemoryService({
      store: createFileFactStore(root), userId: "local-user", workspaceId: "ws-a",
      now: () => 1_760_000_000_000, switchValue: "user",
      turn: { sessionId: "s1", turnId: "t1", userText: plain, userEventId: "s1:t1:user" },
    });

    assert.equal(first.remember({ ...REMEMBER, statement: plain }).result, "pending");

    const second = createUserMemoryService({
      store: createFileFactStore(root), userId: "local-user", workspaceId: "ws-a",
      now: () => 1_760_000_001_000, switchValue: "user",
      turn: {
        sessionId: "s1", turnId: "t2", userText: "可以，记住也行", userEventId: "s1:t2:user",
        priorUser: [{ text: plain, eventId: "s1:t1:user" }],
      },
    });
    const confirmed = second.remember({ ...REMEMBER, commandId: "call-2", statement: plain });

    assert.equal(confirmed.result, "saved");
    assert.equal(second.visible().length, 1);
    assert.equal(second.visible()[0]?.source.kind, "user_confirmation");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("old facts survive hundreds of later writes", () => {
  withService((service, root) => {
    const saved = service.remember(REMEMBER);

    assert.equal(saved.result, "saved");
    const store = createFileFactStore(root);
    const noise: UserFactRecord[] = [];

    for (let index = 0; index < 600; index += 1) {
      noise.push({
        record: "user_fact", id: `noise-${index}`, version: 1, status: "active", factKind: "project_fact",
        subject: "noise", statement: `noise ${index}`, scope: { kind: "project", workspaceId: "ws-a" },
        source: { kind: "user_statement", eventId: "e" }, commandId: `noise-${index}`, createdAt: 1,
      });
    }

    assert.equal(store.append(noise).ok, true);
    const visible = service.visible();

    assert.ok(visible.some((fact) => fact.statement === REMEMBER.statement), "the fact must not scroll out");
    assert.equal(JSON.parse(readFileSync(path.join(root, USER_FACTS_FILE), "utf8").split("\n")[0]!).record, "user_fact");
  });
});

/**
 * B08 的故障注入点只有一个：`store` 是服务唯一的落盘依赖，替换它就等于模拟
 * 磁盘拒绝写（EACCES / 只读目录 / 配额耗尽在服务端是同一件事）。
 *
 * 失败的是**整笔事务**，不是追加的一半：真实写失败要么整笔发生要么不发生，
 * 只让 `append` 失败会造出一种服务永远遇不到的"读得到但写不进"状态。
 */
function failingStore(inner: UserFactStore, budget: { remaining: number }): UserFactStore {
  return {
    read: () => inner.read(),
    append: (records) => inner.append(records),

    transact: (step) => {
      if (budget.remaining > 0) {
        budget.remaining -= 1;
        return { ok: false, reason: "fact_write_failed:EACCES" };
      }
      return inner.transact(step);
    },
  };
}

test("a write the disk refuses is reported as a failure, not as a save", () => {
  // B08: the failure that matters is not "the tool errored", it is "the model
  // must not have anything it could call a receipt". A rejected write that came
  // back as saved is exactly the 记好了 we are removing.
  const root = mkdtempSync(path.join(tmpdir(), "wpcl-fail-"));
  try {
    const budget = { remaining: 1 };
    const service = createUserMemoryService({
      store: failingStore(createFileFactStore(root), budget),
      userId: "local-user", workspaceId: "ws-a",
      now: () => 1_760_000_000_000, switchValue: "user",
      turn: { sessionId: "s1", turnId: "t1", userText: USER_TEXT, userEventId: "s1:t1:user" },
    });
    const result = service.remember(REMEMBER);

    assert.equal(result.result, "failed");
    assert.match(result.result === "failed" ? result.reason : "", /fact_write_failed/,
      "the reason must be distinguishable from a rejection or a disabled switch");
    assert.equal(service.visible().length, 0);
    assert.equal(existsSync(path.join(root, USER_FACTS_FILE)), false, "nothing may be written");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a retry after a refused write saves exactly once", () => {
  // B08: "重试可查提交结果" — the first attempt left nothing behind, so the
  // retry must produce one record, not a duplicate and not a second version.
  const root = mkdtempSync(path.join(tmpdir(), "wpcl-retry-"));
  try {
    const budget = { remaining: 1 };
    const store = failingStore(createFileFactStore(root), budget);
    const deps: UserMemoryDeps = {
      store, userId: "local-user", workspaceId: "ws-a",
      now: () => 1_760_000_000_000, switchValue: "user",
      turn: { sessionId: "s1", turnId: "t1", userText: USER_TEXT, userEventId: "s1:t1:user" },
    };

    assert.equal(createUserMemoryService(deps).remember(REMEMBER).result, "failed");
    const retried = createUserMemoryService(deps).remember(REMEMBER);

    assert.equal(retried.result, "saved");
    const reopened = createUserMemoryService({ ...deps, store: createFileFactStore(root) });

    assert.equal(reopened.visible().length, 1, "one fact, not one per attempt");
    assert.equal(reopened.facts().length, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("another profile does not read this profile's identity, and another home neither", () => {
  // B12: the same disk, a different person. A user-scoped identity fact is the
  // most sensitive thing in the ledger, so the filter has to be on the record's
  // own scope — not on "who happened to write last".
  const home = mkdtempSync(path.join(tmpdir(), "wpcl-home-a-"));
  const otherHome = mkdtempSync(path.join(tmpdir(), "wpcl-home-b-"));

  try {
    const inHome = (root: string, userId: string): UserMemoryDeps => ({
      store: createFileFactStore(root), userId, workspaceId: "ws-a",
      now: () => 1_760_000_000_000, switchValue: "user",
      turn: { sessionId: "s1", turnId: "t1", userText: USER_TEXT, userEventId: "s1:t1:user" },
    });

    assert.equal(createUserMemoryService(inHome(home, "local-user")).remember(REMEMBER).result, "saved");

    const otherProfile = createUserMemoryService(inHome(home, "someone-else"));

    assert.equal(otherProfile.visible().length, 0, "a different profile on the same home sees nothing");

    const otherHomeService = createUserMemoryService(inHome(otherHome, "local-user"));

    assert.equal(otherHomeService.visible().length, 0, "a different home has its own ledger");

    // And saving under the other profile must not disturb this one.
    const mine = createUserMemoryService(inHome(home, "local-user"));

    assert.equal(mine.visible().length, 1, "the original profile's fact survives the neighbour's write");
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(otherHome, { recursive: true, force: true });
  }
});

test("a user-scoped identity fact follows the person to another workspace", () => {
  // B12, the other half: identity is not a project note. The same person in a
  // different workspace must still be recognised, or "remember who I am" only
  // works in the directory where they said it.
  const root = mkdtempSync(path.join(tmpdir(), "wpcl-cross-ws-"));
  try {
    const inWorkspace = (workspaceId: string): UserMemoryDeps => ({
      store: createFileFactStore(root), userId: "local-user", workspaceId,
      now: () => 1_760_000_000_000, switchValue: "user",
      turn: { sessionId: "s1", turnId: "t1", userText: USER_TEXT, userEventId: "s1:t1:user" },
    });

    assert.equal(createUserMemoryService(inWorkspace("ws-a")).remember(REMEMBER).result, "saved");
    const moved = createUserMemoryService(inWorkspace("ws-b"));

    assert.equal(moved.visible().length, 1);
    assert.equal(moved.visible()[0]?.statement, REMEMBER.statement);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
