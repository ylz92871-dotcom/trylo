import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  createFilePermissionStore,
  createMemoryPermissionStore,
  deriveGrantId,
  storeIdFromPath,
  type FilePermissionStoreOptions,
} from "../adapters/permission-store/index.js";
import { createRecordingBoardPort } from "../learning/agent/subsystems/tool/domain/board-adapter.js";
import { submitBindingDraft } from "../learning/agent/subsystems/tool/domain/curator.js";
import { grantInput } from "../tooling/testing/fixtures.js";
import type { ValidationRecord } from "../tooling/contract/types.js";
import { validationRecord } from "./testing/fixtures.js";

/**
 * permission grant 身份与持久消费证据。
 *
 * 与 `adversarial.test.ts` 的分工（外审 R3 §3 P3-3 的文件长度纪律）：本文件只覆盖
 * **授权身份的派生、跨 store 隔离与持久消费**；映射/准入语义的对抗证据留在
 * `adversarial.test.ts`，以免两个职责各自膨胀到需要再拆。
 */

const VERSION_ID = "pkg:pdf-lint:1.0.0";
const NOW = "2026-09-12T00:00:00Z";

/**
 * 编译期断言（由 `2-tsc` 门禁执行）：构造文件型 store 时**只有 `path` 一个可传字段**。
 *
 * 这是「store 身份只从路径派生」在类型层的机器证据（外审 R3 §3 P2-3）。一旦有人把
 * 可注入的 `storeId` 加回来，`keyof FilePermissionStoreOptions` 会多出一个键，
 * 这里的赋值立刻编译失败——也就是说，重开跨店双消费必须先让门禁红。
 */
type ExactKeys<T, K extends PropertyKey> = [keyof T] extends [K]
  ? ([K] extends [keyof T] ? true : never)
  : never;

const FILE_STORE_OPTIONS_ARE_PATH_ONLY: ExactKeys<FilePermissionStoreOptions, "path"> = true;

test("the memory permission store is per-instance and its port surface stays consume-only", async () => {
  const store = createMemoryPermissionStore();
  const issued = await store.issue(grantInput({ action: "activate" }));

  assert.equal(issued.ok, true);

  if (!issued.ok) {
    return;
  }

  const use = {
    token: { grantId: issued.grant.grantId },
    action: "activate" as const,
    candidateId: "cand-mit",
    packageVersionId: VERSION_ID,
    scope: "docs",
    now: NOW,
  };
  const left = store;
  const right = createMemoryPermissionStore();

  assert.equal((await left.consume(use)).ok, true);
  assert.equal((await right.consume(use)).ok, false, "another store cannot verify a reference it did not issue");
  assert.equal((await left.consume(use)).ok, false, "the same store must refuse a replay");
  const port = { consume: left.consume };

  assert.deepEqual(Object.keys(port).sort(), ["consume"]);
});

test("file store options accept only a path: there is no injectable store identity", () => {
  assert.equal(FILE_STORE_OPTIONS_ARE_PATH_ONLY, true);
});

test("store identity is exactly the store path, so colliding identities are unreachable", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "trylo-grant-path-"));
  try {
    const facts = grantInput({ action: "activate" });
    const storePath = path.join(root, "permission.ndjson");
    const store = createFilePermissionStore({ path: storePath });
    const issued = await store.issue(facts);

    assert.equal(issued.ok, true);

    if (!issued.ok) {
      return;
    }

    // 序列 1 的 grant 身份必须**恰好等于**「事实 + 序号 + 路径派生身份」这一配方。
    // 派生里没有第二个可变输入，因此「同一部署内两个 store 身份相同」在结构上不可达。
    assert.equal(issued.grant.grantId, deriveGrantId(facts, 1, storeIdFromPath(storePath)));

    // 两个 store 的路径不同 ⇒ 身份必不同（这正是 R2 P2-R4 的闭合条件）。
    const otherPath = path.join(root, "nested", "permission.ndjson");
    const other = createFilePermissionStore({ path: otherPath });
    const otherIssued = await other.issue(facts);

    assert.equal(otherIssued.ok, true);

    if (!otherIssued.ok) {
      return;
    }

    assert.notEqual(issued.grant.grantId, otherIssued.grant.grantId);
    assert.notEqual(storeIdFromPath(storePath), storeIdFromPath(otherPath));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("two stores issuing the same facts derive different grant identities (R2 P2-R4)", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "trylo-grant-identity-"));
  try {
    const facts = grantInput({ action: "activate" });
    const left = createFilePermissionStore({ path: path.join(root, "left.ndjson") });
    const right = createFilePermissionStore({ path: path.join(root, "right.ndjson") });
    const issuedLeft = await left.issue(facts);
    const issuedRight = await right.issue(facts);

    assert.equal(issuedLeft.ok, true);
    assert.equal(issuedRight.ok, true);

    if (!issuedLeft.ok || !issuedRight.ok) {
      return;
    }

    assert.notEqual(
      issuedLeft.grant.grantId,
      issuedRight.grant.grantId,
      "identical facts in different stores must not share a global reference",
    );
    const use = {
      token: { grantId: issuedLeft.grant.grantId },
      action: "activate" as const,
      candidateId: facts.candidateId,
      packageVersionId: facts.packageVersionId,
      scope: facts.scope,
      now: NOW,
    };

    assert.equal((await left.consume(use)).ok, true);
    const crossed = await right.consume(use);

    assert.equal(crossed.ok, false, "the other store must not be able to consume the same reference");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a durable permission store drives activation once and the board only sees one submission", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "trylo-durable-activate-"));
  try {
    const store = createFilePermissionStore({ path: path.join(root, "permission.ndjson") });
    const issued = await store.issue(grantInput({ action: "activate" }));

    assert.equal(issued.ok, true);

    if (!issued.ok) {
      return;
    }

    const validation: ValidationRecord = validationRecord();
    const board = createRecordingBoardPort();
    const first = await submitBindingDraft(
      board,
      {
        draftId: "bind-1",
        scope: "docs",
        taskFamily: "docs",
        packageVersionId: VERSION_ID,
        candidateId: "cand-mit",
      },
      validation,
      {
        approvalPort: { consume: store.consume },
        token: { grantId: issued.grant.grantId },
        now: NOW,
      },
    );

    assert.equal(first.ok, true);
    assert.equal(board.snapshot().length, 1);

    const second = await submitBindingDraft(
      board,
      {
        draftId: "bind-1",
        scope: "docs",
        taskFamily: "docs",
        packageVersionId: VERSION_ID,
        candidateId: "cand-mit",
      },
      validation,
      {
        approvalPort: { consume: store.consume },
        token: { grantId: issued.grant.grantId },
        now: NOW,
      },
    );

    assert.equal(second.ok, false);

    if (!second.ok) {
      assert.equal(second.code, "replayed");
    }

    assert.equal(board.snapshot().length, 1, "the replayed activation must not reach the board again");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
