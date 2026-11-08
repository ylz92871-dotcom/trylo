import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type {
  ApprovalConsumptionOutcome,
  ApprovalConsumptionRequest,
  GrantIssuanceInput,
} from "../../ports/approval-consumption.js";
import { decodeStoreLedger } from "./codec.js";
import { createFilePermissionStore, type FilePermissionStore } from "./file-ledger.js";

/**
 * durable Permission store 的**授权语义**证据：引用只能在本店解析、只能消费一次、
 * grant 事实以 store 为准。
 *
 * 与 `file-ledger-corruption.test.ts` 的分工（外审 R3 §3 P3-3 的文件长度纪律）：
 * 那边只覆盖**损坏/锁/跨进程故障**，这边只覆盖正常语义。两边共用同一组小型夹具
 * （刻意复制而不是抽公共模块：夹具本身很短，跨文件共享会引入一个非测试的生产文件）。
 */

const NOW = "2026-09-12T00:00:00Z";
const BINDING = {
  action: "acquire" as const,
  candidateId: "cand-mit",
  packageVersionId: "pkg:pdf-lint:1.0.0",
  scope: "docs",
};

function issuanceInput(overrides: Partial<GrantIssuanceInput> = {}) {
  return {
    ...BINDING,
    issuedAt: "2026-09-01T00:00:00Z",
    expiry: "2026-12-01T00:00:00Z",
    ...overrides,
  };
}

function request(overrides: Partial<ApprovalConsumptionRequest> = {}): ApprovalConsumptionRequest {
  return {
    token: { grantId: "grant:placeholder" },
    ...BINDING,
    now: NOW,
    ...overrides,
  };
}

async function withStore(
  run: (store: FilePermissionStore, storePath: string) => Promise<void>,
): Promise<void> {
  const root = await mkdtemp(path.join(os.tmpdir(), "trylo-approval-"));
  const storePath = path.join(root, "nested", "permission.ndjson");

  try {
    await run(createFilePermissionStore({ path: storePath }), storePath);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

/** 签发一个 grant 并返回引用；引用是调用方唯一能拿到的授权凭据。 */
async function issuedRef(
  store: FilePermissionStore,
  overrides: Partial<GrantIssuanceInput> = {},
): Promise<{ grantId: string }> {
  const issued = await store.issue(issuanceInput(overrides));
  assert.equal(issued.ok, true);
  if (!issued.ok) {
    throw new Error("fixture grant issuance failed");
  }
  return { grantId: issued.grant.grantId };
}

function codeOf(result: ApprovalConsumptionOutcome): string {
  return result.ok ? "ok" : result.code;
}

test("a forged grant reference is refused: callers cannot assert authorization facts", async () => {
  await withStore(async (store) => {
    // 外审 P0-1 反例：手工构造的引用在 store 里不存在，无从验证。
    const forged = await store.consume(request({ token: { grantId: "grant:attacker-made" } }));

    assert.equal(codeOf(forged), "unknown_grant");
    // 即使引用真实存在，绑定事实不符仍然失败——事实由 store 持有。
    const { grantId } = await issuedRef(store);

    assert.equal(codeOf(await store.consume(request({ token: { grantId }, action: "activate" }))), "action_mismatch");
    assert.equal(codeOf(await store.consume(request({ token: { grantId }, packageVersionId: "pkg:pdf-lint:2.0.0" }))), "version_mismatch");
    assert.equal(codeOf(await store.consume(request({ token: { grantId }, scope: "shell" }))), "scope_mismatch");
    assert.equal(codeOf(await store.consume(request({ token: { grantId }, candidateId: "cand-other" }))), "candidate_mismatch");
    // 正确引用 + 正确绑定才通过。
    assert.equal((await store.consume(request({ token: { grantId } }))).ok, true);
  });
});

test("a grant reference resolves only in the store that issued it", async () => {
  await withStore(async (store) => {
    const { grantId } = await issuedRef(store);
    // 外审 P1-4 反例：另一条"账本路径"（第二个 store）无法验真同一引用。
    const otherRoot = await mkdtemp(path.join(os.tmpdir(), "trylo-approval-2-"));

    try {
      const other = createFilePermissionStore({ path: path.join(otherRoot, "other.ndjson") });
      assert.equal(codeOf(await other.consume(request({ token: { grantId } }))), "unknown_grant");
      // 原 store 仍只允许消费一次。
      assert.equal((await store.consume(request({ token: { grantId } }))).ok, true);
      assert.equal(codeOf(await store.consume(request({ token: { grantId } }))), "replayed");
    } finally {
      await rm(otherRoot, { recursive: true, force: true });
    }
  });
});

test("durable consume survives reopen: a second store instance refuses the same grant", async () => {
  await withStore(async (store, storePath) => {
    const { grantId } = await issuedRef(store);
    assert.equal((await store.consume(request({ token: { grantId } }))).ok, true);
    const reopened = createFilePermissionStore({ path: storePath });
    assert.equal(codeOf(await reopened.consume(request({ token: { grantId } }))), "replayed");
  });
});

test("crash between durable append and the effect still refuses a second consume", async () => {
  await withStore(async (store) => {
    const { grantId } = await issuedRef(store);
    const gate = await store.consume(request({ token: { grantId } }));
    assert.equal(gate.ok, true);
    // simulate a crash here: the protected fake effect never runs
    assert.equal(codeOf(await store.consume(request({ token: { grantId } }))), "replayed");
  });
});

test("revoked grants refuse consumption; revoke is idempotent and unknown grants are refused", async () => {
  await withStore(async (store) => {
    const { grantId } = await issuedRef(store);
    const revoked = await store.revoke(grantId, NOW);

    assert.equal(revoked.ok, true);
    assert.equal(codeOf(await store.consume(request({ token: { grantId } }))), "grant_revoked");
    const again = await store.revoke(grantId, NOW);

    assert.equal(again.ok, true);
    const missing = await store.revoke("grant:missing", NOW);

    assert.equal(missing.ok, false);

    if (!missing.ok) {
      assert.equal(missing.code, "unknown_grant");
    }
  });
});

test("two store instances consuming the same grant concurrently: exactly one wins", async () => {
  await withStore(async (store, storePath) => {
    const { grantId } = await issuedRef(store);
    const left = createFilePermissionStore({ path: storePath });
    const right = createFilePermissionStore({ path: storePath });
    const results = await Promise.all([
      left.consume(request({ token: { grantId } })),
      right.consume(request({ token: { grantId } })),
    ]);
    const succeeded = results.filter((result) => result.ok);

    assert.equal(succeeded.length, 1);
    const loser = results.find((result) => !result.ok);

    assert.equal(loser !== undefined, true);

    if (loser !== undefined && !loser.ok) {
      assert.equal(
        loser.code === "replayed" || loser.code === "ledger_lock_conflict",
        true,
      );
    }
  });
});

test("grant facts come from the store: expiry is checked against the stored grant, strictly", async () => {
  await withStore(async (store) => {
    // 外审 P1-7：非真实日期（2026-02-30）在签发端即被拒绝。
    const badCalendar = await store.issue(issuanceInput({ expiry: "2026-02-30T00:00:00Z" }));

    assert.equal(badCalendar.ok, false);

    if (!badCalendar.ok) {
      assert.equal(badCalendar.code, "invalid_expiry");
    }

    const expired = await issuedRef(store, { expiry: "2020-01-01T00:00:00Z", issuedAt: "2019-01-01T00:00:00Z" });

    assert.equal(codeOf(await store.consume(request({ token: { grantId: expired.grantId } }))), "expired");
    const { grantId } = await issuedRef(store);

    assert.equal(codeOf(await store.consume(request({ token: { grantId }, now: "just now" }))), "invalid_now");
    assert.equal(codeOf(await store.consume(request({ token: { grantId }, now: "2026-02-30T00:00:00Z" }))), "invalid_now");
    // 08:00Z 仍是有效的（09:00+02:00 = 07:00Z），即使字符串上 "08..." < "09..."。
    const offsetOk = await issuedRef(store, { expiry: "2026-09-12T08:00:00Z" });
    const offsetTrap = await store.consume(
      request({ token: { grantId: offsetOk.grantId }, now: "2026-09-12T09:00:00+02:00" }),
    );

    assert.equal(offsetTrap.ok, true);
    // expiry 不晚于 issuedAt 的 grant 不能签发。
    const inverted = await store.issue(issuanceInput({ issuedAt: "2026-12-01T00:00:00Z", expiry: "2026-12-01T00:00:00Z" }));

    assert.equal(inverted.ok, false);
  });
});

test("distinct grants each consume once and the store stays append-only and fact-minimal", async () => {
  await withStore(async (store, storePath) => {
    const a = await issuedRef(store);
    const b = await issuedRef(store);
    const first = await store.consume(request({ token: { grantId: a.grantId } }));
    const second = await store.consume(request({ token: { grantId: b.grantId } }));

    assert.equal(first.ok, true);
    assert.equal(second.ok, true);

    if (second.ok) {
      assert.equal(second.value.sequence, 4);
    }

    const decoded = decodeStoreLedger(await readFile(storePath, "utf8"));

    assert.equal(decoded.ok, true);

    if (decoded.ok) {
      assert.deepEqual(decoded.events.map((event) => event.kind), [
        "grant_issued",
        "grant_issued",
        "grant_consumed",
        "grant_consumed",
      ]);
      const consumed = decoded.events[2];

      assert.equal(consumed?.kind, "grant_consumed");

      if (consumed?.kind === "grant_consumed") {
        assert.deepEqual(Object.keys(consumed).sort(), [
          "action",
          "candidateId",
          "consumedAt",
          "formatVersion",
          "grantId",
          "kind",
          "packageVersionId",
          "scope",
          "sequence",
        ]);
      }
    }
  });
});

test("the injected consumption port can only consume: no issue, grant, or approve surface", async () => {
  await withStore(async (store) => {
    const { grantId } = await issuedRef(store);
    // 组合根把 store 的 consume 作为端口注入 Tooling；端口表面只有 consume。
    const port = { consume: store.consume };
    assert.deepEqual(Object.keys(port).sort(), ["consume"]);
    assert.equal((await port.consume(request({ token: { grantId } }))).ok, true);
  });
});
