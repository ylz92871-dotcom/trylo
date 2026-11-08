import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { canonicalJson, sha256Hex } from "../../learning/control/hash.js";
import { createFilePermissionStore } from "./file-ledger.js";
import { decodeStoreLedger } from "./codec.js";

/**
 * 独立 negative fixtures（外审 2026-09-13 §4/§5）：攻击样本放在
 * `testdata/approval/**`，与实现源码不同源；这里只负责加载并断言
 * 每个反例都被对应的失败码拒绝。
 */
function approvalAttackDir(): string {
  return path.join(fileURLToPath(new URL(".", import.meta.url)), "..", "..", "..", "..", "testdata", "approval");
}

type ApprovalAttack = {
  readonly id: string;
  readonly kind: string;
  readonly issuance?: Record<string, unknown>;
  readonly input?: Record<string, unknown>;
  readonly payload?: Record<string, unknown>;
  readonly expect: { readonly ok: false; readonly code: string };
};

test("testdata/approval negative fixtures all fail closed", async () => {
  const dir = approvalAttackDir();
  const files = (await readdir(dir)).filter((name) => name.endsWith(".json")).sort();

  assert.equal(files.length >= 6, true, "the approval attack corpus must be non-trivial");

  for (const file of files) {
    const attack = JSON.parse(await readFile(path.join(dir, file), "utf8")) as ApprovalAttack;
    const outcome = await runApprovalAttack(attack);

    assert.deepEqual(
      { ok: outcome.ok, code: outcome.ok ? "ok" : outcome.code },
      { ok: attack.expect.ok, code: attack.expect.code },
      `${attack.id} (${file})`,
    );
  }
});

async function runApprovalAttack(
  attack: ApprovalAttack,
): Promise<{ ok: boolean; code?: string }> {
  const root = await mkdtemp(path.join(os.tmpdir(), "trylo-attack-"));
  try {
    const store = createFilePermissionStore({ path: path.join(root, "permission.ndjson") });
    switch (attack.kind) {
      case "forged-grant-reference": {
        const input = attack.input ?? {};
        const result = await store.consume({
          token: { grantId: String(input.grantId) },
          action: "acquire",
          candidateId: String(input.candidateId),
          packageVersionId: String(input.packageVersionId),
          scope: String(input.scope),
          now: String(input.now),
        });

        return { ok: result.ok, ...(result.ok ? {} : { code: result.code }) };
      }
      case "cross-binding-facts":
      case "second-store-reference": {
        const issuance = attack.issuance ?? {};
        const issued = await store.issue({
          action: "acquire",
          candidateId: String(issuance.candidateId),
          packageVersionId: String(issuance.packageVersionId),
          scope: String(issuance.scope),
          issuedAt: String(issuance.issuedAt),
          expiry: String(issuance.expiry),
        });
        if (!issued.ok) {
          return { ok: false, code: issued.code };
        }

        const input = attack.input ?? {};
        const action = String(input.action) as "acquire" | "modify" | "activate" | "contribute";

        if (attack.kind === "second-store-reference") {
          const other = createFilePermissionStore({ path: path.join(root, "second.ndjson") });
          const result = await other.consume({
            token: { grantId: issued.grant.grantId },
            action,
            candidateId: String(input.candidateId),
            packageVersionId: String(input.packageVersionId),
            scope: String(input.scope),
            now: String(input.now),
          });

          return { ok: result.ok, ...(result.ok ? {} : { code: result.code }) };
        }

        const result = await store.consume({
          token: { grantId: issued.grant.grantId },
          action,
          candidateId: String(input.candidateId),
          packageVersionId: String(input.packageVersionId),
          scope: String(input.scope),
          now: String(input.now),
        });

        return { ok: result.ok, ...(result.ok ? {} : { code: result.code }) };
      }
      case "invalid-calendar-date": {
        const issuance = attack.issuance ?? {};
        const issued = await store.issue({
          action: "modify",
          candidateId: String(issuance.candidateId),
          packageVersionId: String(issuance.packageVersionId),
          scope: String(issuance.scope),
          issuedAt: String(issuance.issuedAt),
          expiry: String(issuance.expiry),
        });

        return { ok: issued.ok, ...(issued.ok ? {} : { code: issued.code }) };
      }
      case "corrupt-ledger-line": {
        const payload = canonicalJson(attack.payload);

        await writeFile(
          path.join(root, "permission.ndjson"),
          `${sha256Hex(payload)} ${payload}\n`,
          "utf8",
        );
        const decoded = decodeStoreLedger(`${sha256Hex(payload)} ${payload}\n`);

        return { ok: decoded.ok, ...(decoded.ok ? {} : { code: decoded.reason }) };
      }
      default:
        throw new Error(`unknown attack kind ${attack.kind}`);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}
