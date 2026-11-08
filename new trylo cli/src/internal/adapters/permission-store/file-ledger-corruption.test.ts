import assert from "node:assert/strict";
import { closeSync, openSync, unlinkSync } from "node:fs";
import { appendFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";
import type {
  ApprovalConsumptionOutcome,
  ApprovalConsumptionRequest,
  GrantIssuanceInput,
} from "../../ports/approval-consumption.js";
import { canonicalJson, sha256Hex } from "../../learning/control/hash.js";
import {
  decodeStoreLedger,
  encodeStoreEvent,
  grantConsumedEvent,
  PERMISSION_STORE_FORMAT_VERSION,
} from "./codec.js";
import { createFilePermissionStore, type FilePermissionStore } from "./file-ledger.js";

/**
 * durable Permission store 的**损坏与故障**证据：checksum、格式版本、torn tail、
 * 未知/畸形键、单 writer 锁、跨进程故障注入，以及「损坏不得被转写成服务不可用」。
 *
 * 拆自 `file-ledger.test.ts`（外审 R3 §3 P3-3 的文件长度纪律）：正常语义留在那边，
 * 本文件只放 fail-closed 面。断言一条未减少。
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
  const root = await mkdtemp(path.join(os.tmpdir(), "trylo-approval-corrupt-"));
  const storePath = path.join(root, "nested", "permission.ndjson");

  try {
    await run(createFilePermissionStore({ path: storePath }), storePath);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

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

test("checksum corruption in the store fails closed", async () => {
  await withStore(async (store, storePath) => {
    const { grantId } = await issuedRef(store);
    const raw = await readFile(storePath, "utf8");
    const broken = raw.replace("cand-mit", "cand-mit-");
    await writeFile(storePath, broken, "utf8");
    assert.equal(codeOf(await store.consume(request({ token: { grantId } }))), "ledger_corrupt");
  });
});

test("a well-checksummed but malformed record is rejected by the schema (P1-8)", async () => {
  await withStore(async (_store, storePath) => {
    await mkdir(path.dirname(storePath), { recursive: true });
    // checksum 对自身 payload 正确、但字段畸形（未知 kind、非法枚举）的记录必须被拒。
    const malformedPayloads = [
      { formatVersion: PERMISSION_STORE_FORMAT_VERSION, kind: "grant_reissued", sequence: 1, grantId: "grant:x" },
      {
        formatVersion: PERMISSION_STORE_FORMAT_VERSION,
        kind: "grant_issued",
        sequence: 1,
        grantId: "grant:x",
        action: "fly_to_the_moon",
        candidateId: "cand",
        packageVersionId: "pkg",
        scope: "docs",
        issuedAt: "2026-09-01T00:00:00Z",
        expiry: "2026-12-01T00:00:00Z",
      },
    ];

    for (const payload of malformedPayloads) {
      const text = canonicalJson(payload);

      await appendFile(storePath, `${sha256Hex(text)} ${text}\n`, "utf8");
      const decoded = decodeStoreLedger(await readFile(storePath, "utf8"));

      assert.equal(decoded.ok, false);

      if (!decoded.ok) {
        assert.equal(decoded.reason, "ledger_corrupt");
      }

      await writeFile(storePath, "", "utf8");
    }
  });
});

test("an unsupported format version refuses the whole store", async () => {
  await withStore(async (store, storePath) => {
    await issuedRef(store);
    const raw = await readFile(storePath, "utf8");

    await writeFile(
      storePath,
      raw.replaceAll(`"formatVersion":${String(PERMISSION_STORE_FORMAT_VERSION)}`, '"formatVersion":99'),
      "utf8",
    );
    const next = createFilePermissionStore({ path: storePath });

    assert.equal(codeOf(await next.consume(request())), "ledger_corrupt");
  });
});

test("a torn tail fails closed instead of guessing", async () => {
  await withStore(async (store, storePath) => {
    const { grantId } = await issuedRef(store);

    assert.equal((await store.consume(request({ token: { grantId } }))).ok, true);
    await appendFile(
      storePath,
      encodeStoreEvent(grantConsumedEvent({
        sequence: 3,
        kind: "grant_consumed",
        grantId: "grant:torn",
        action: "acquire",
        candidateId: "cand-mit",
        packageVersionId: "pkg:pdf-lint:1.0.0",
        scope: "docs",
        consumedAt: NOW,
      })).slice(0, 40),
      "utf8",
    );
    const next = createFilePermissionStore({ path: storePath });

    assert.equal(codeOf(await next.consume(request())), "ledger_torn_tail");
  });
});

test("a blank line between records is corruption, not something to skip", async () => {
  await withStore(async (store, storePath) => {
    const { grantId } = await issuedRef(store);

    assert.equal((await store.consume(request({ token: { grantId } }))).ok, true);
    const raw = await readFile(storePath, "utf8");
    const lines = raw.split("\n");

    // [issued, consumed, ""] —— 在两条记录之间插入一个空行。
    assert.equal(lines.length, 3, "two records plus the trailing terminator");
    await writeFile(storePath, `${lines[0] ?? ""}\n\n${lines[1] ?? ""}\n`, "utf8");

    // 旧实现用 `filter(line => line.length > 0)`，空行在逐行校验前就被丢掉，
    // 于是 `rec1\n\nrec2\n` 与 `rec1\nrec2\n` 无法区分（外审 R3 §3 P3-2）。
    const decoded = decodeStoreLedger(await readFile(storePath, "utf8"));

    assert.equal(decoded.ok, false);

    if (!decoded.ok) {
      assert.equal(decoded.reason, "ledger_corrupt");
      assert.match(decoded.detail, /blank line/);
    }

    // 读路径、查询路径与写路径保持同一口径。
    const lookup = await store.getGrant(grantId);

    assert.equal(lookup.ok, false);

    if (!lookup.ok) {
      assert.equal(lookup.code, "ledger_corrupt");
    }

    assert.equal(codeOf(await store.consume(request({ token: { grantId } }))), "ledger_corrupt");
    const issued = await store.issue(issuanceInput());

    assert.equal(issued.ok, false);

    if (!issued.ok) {
      assert.equal(issued.code, "ledger_corrupt");
    }
  });
});

test("a held single-writer lock is reported, not waited out or ignored", async () => {
  await withStore(async (store, storePath) => {
    const { grantId } = await issuedRef(store);
    const lockPath = `${storePath}.lock`;
    const fd = openSync(lockPath, "wx");

    try {
      assert.equal(codeOf(await store.consume(request({ token: { grantId } }))), "ledger_lock_conflict");
    } finally {
      closeSync(fd);
      unlinkSync(lockPath);
    }

    assert.equal((await store.consume(request({ token: { grantId } }))).ok, true);
  });
});

test("cross-process fault injection: a crashed writer leaves a stale lock that fails closed", async () => {
  await withStore(async (store, storePath) => {
    const { grantId } = await issuedRef(store);
    // 子进程持有锁后直接退出（模拟崩溃），锁文件遗留。
    const holder = spawnSync(
      process.execPath,
      ["-e", 'const fs=require("node:fs"); fs.openSync(process.argv[1], "wx");', `${storePath}.lock`],
      { encoding: "utf8", timeout: 15000 },
    );

    assert.equal(holder.status, 0, String(holder.stderr));
    assert.equal(codeOf(await store.consume(request({ token: { grantId } }))), "ledger_lock_conflict");
    unlinkSync(`${storePath}.lock`);
    assert.equal((await store.consume(request({ token: { grantId } }))).ok, true);
  });
});

test("cross-process fault injection: a child crash mid-append leaves a torn tail that fails closed", async () => {
  await withStore(async (store, storePath) => {
    const { grantId } = await issuedRef(store);
    // 子进程以原始 fs 追加半行（无换行符）后立即退出——真实的跨进程 torn write。
    const appender = spawnSync(
      process.execPath,
      [
        "-e",
        'const fs=require("node:fs"); fs.appendFileSync(process.argv[1], \'{"formatVersion":1,"kind":"grant_\', "utf8");',
        storePath,
      ],
      { encoding: "utf8", timeout: 15000 },
    );

    assert.equal(appender.status, 0, String(appender.stderr));
    assert.equal(codeOf(await store.consume(request({ token: { grantId } }))), "ledger_torn_tail");
  });
});

test("cross-process double consume: a second process refuses the grant the first consumed", async () => {
  await withStore(async (store, storePath) => {
    const { grantId } = await issuedRef(store);
    const modDir = path.dirname(fileURLToPath(import.meta.url));
    const script = `
      const { pathToFileURL } = await import("node:url");
      const { createFilePermissionStore } = await import(pathToFileURL(process.argv[3] + "/file-ledger.js"));
      const store = createFilePermissionStore({ path: process.argv[1] });
      const result = await store.consume({
        token: { grantId: process.argv[2] },
        action: "acquire",
        candidateId: "cand-mit",
        packageVersionId: "pkg:pdf-lint:1.0.0",
        scope: "docs",
        now: "2026-09-12T00:00:00Z",
      });
      console.log(JSON.stringify(result));
    `;
    const first = spawnSync(process.execPath, ["-e", script, storePath, grantId, modDir], {
      encoding: "utf8",
      timeout: 30000,
    });

    assert.equal(first.status, 0, String(first.stderr));
    const second = spawnSync(process.execPath, ["-e", script, storePath, grantId, modDir], {
      encoding: "utf8",
      timeout: 30000,
    });

    assert.equal(second.status, 0, String(second.stderr));
    const firstOutcome = JSON.parse((first.stdout.trim().split("\n").pop() ?? "{}")) as { ok: boolean };
    const secondOutcome = JSON.parse((second.stdout.trim().split("\n").pop() ?? "{}")) as { ok: boolean; code?: string };

    assert.equal(firstOutcome.ok, true);
    assert.equal(secondOutcome.ok, false);
    assert.equal(secondOutcome.code, "replayed");
  });
});

test("a corrupted ledger does not leak the writer lock", async () => {
  await withStore(async (store, storePath) => {
    const { grantId } = await issuedRef(store);
    const original = await readFile(storePath, "utf8");
    const corrupted = original.replace("grant:", "grantX");

    assert.notEqual(corrupted, original, "the corruption must land on disk");
    await writeFile(storePath, corrupted, "utf8");

    const first = await store.consume(request({ token: { grantId } }));

    assert.equal(codeOf(first), "ledger_corrupt");

    // 修复前这里会返回 ledger_lock_conflict：解码失败分支直接 return，跳过了锁释放，
    // 于是损坏的账本把锁永久留给本进程，并且掩盖了真正的失败原因。
    const second = await store.consume(request({ token: { grantId } }));

    assert.equal(codeOf(second), "ledger_corrupt");

    const third = await store.issue(issuanceInput());

    assert.equal(third.ok, false);

    if (!third.ok) {
      assert.equal(third.code, "ledger_corrupt");
    }

    await assert.rejects(readFile(`${storePath}.lock`, "utf8"), /ENOENT/);
  });
});
