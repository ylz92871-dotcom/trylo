import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { emptyBoardState } from "../learning/control/state.js";
import { candidate, pkg } from "../tooling/testing/fixtures.js";
import type { ToolCandidate, ValidationRecord } from "../tooling/contract/types.js";
import type { EvaluationEvidenceDraft } from "../evaluation/types.js";
import { productionToolsFromBoard } from "./activation/read-model.js";
import { mapContentDraft } from "./content/index.js";
import { admitContentEvidence, admitToolEvidence } from "./contract/gateway.js";
import { mapToolCommandDraft } from "../learning/agent/subsystems/tool/adapters/board/index.js";
import {
  evidenceDraft,
  proposalAdmission,
  toolEvidenceAdmission,
  withdrawDraft,
} from "./testing/fixtures.js";
import { openRegistryHarness, type RegistryHarness } from "./testing/authority-fixtures.js";
import type {
  ContentEvidenceAdmission,
  ToolEvidenceAdmission,
  ToolPackageAdmission,
  WithdrawAdmission,
} from "./contract/admission.js";

/**
 * 独立 negative fixtures（外审 2026-09-13 §4/§5 与 R2 §6.6）：跨包映射与投影的
 * 攻击样本放在 `testdata/integration/**`，与实现源码不同源；这里加载并断言每个
 * 反例都被对应失败原因拒绝。
 *
 * WP-F 变化：证据类攻击不再注入「假装存在的验证记录」。夹具改为驱动
 * **真实** 的 Verification Authority registry（临时目录里的持久实现），
 * 因此「伪造引用被拒」这一结论有真实存储参与，而不是同源假绿。
 *
 * 每个 attack kind 一个具名处理函数（R3 §13.8 单函数长度纪律，R4 追加）：
 * 分派表本身保持可读，各分支的输入形状与期望理由分别就地可查。
 */
function integrationAttackDir(): string {
  return path.join(fileURLToPath(new URL(".", import.meta.url)), "..", "..", "..", "testdata", "integration");
}

type IntegrationAttack = {
  readonly id: string;
  readonly kind: string;
  readonly draft?: Record<string, unknown>;
  readonly admission?: Record<string, unknown>;
  readonly activation?: Record<string, unknown>;
  readonly package?: Record<string, unknown>;
  readonly validation?: Record<string, unknown>;
  readonly candidateOverrides?: Record<string, unknown>;
  readonly draftOverrides?: Record<string, unknown>;
  readonly receiptRef?: string;
  readonly inputs?: readonly unknown[];
  readonly expect: { readonly ok: false; readonly reason?: string };
};

type AttackOutcome = { readonly ok: boolean; readonly reason?: string };

test("testdata/integration negative fixtures all fail closed", async () => {
  const dir = integrationAttackDir();
  const files = (await readdir(dir)).filter((name) => name.endsWith(".json")).sort();

  assert.equal(files.length >= 6, true, "the integration attack corpus must be non-trivial");
  const harness = await openRegistryHarness();

  try {
    for (const file of files) {
      const attack = JSON.parse(await readFile(path.join(dir, file), "utf8")) as IntegrationAttack;
      const outcome = await runIntegrationAttack(attack, harness);
      assert.equal(outcome.ok, false, `${attack.id} (${file}) must fail closed`);
      if (attack.expect.reason !== undefined) {
        assert.equal(outcome.reason, attack.expect.reason, `${attack.id} (${file})`);
      }
    }
  } finally {
    await harness.close();
  }
});

async function runIntegrationAttack(
  attack: IntegrationAttack,
  harness: RegistryHarness,
): Promise<AttackOutcome> {
  switch (attack.kind) {
    case "self-reported-verdict":
      return attackSelfReportedVerdict(attack, harness);
    case "forged-activation-record":
      return attackForgedActivationRecord(attack);
    case "withdraw-target-mismatch":
      return attackWithdrawTargetMismatch(attack);
    case "smuggled-permissions":
      return attackSmuggledPermissions(attack);
    case "mixed-anchors":
      return attackMixedAnchors(attack, harness);
    case "untrusted-entry":
      return attackUntrustedEntry(attack, harness);
    default:
      throw new Error(`unknown attack kind ${attack.kind}`);
  }
}

/** admission 是运行期不可信输入（旧版本 JSON 可能携带已废弃字段）。走真实 gateway
 * + 真实 registry：伪造引用在权威侧不存在 → 拒绝。 */
async function attackSelfReportedVerdict(
  attack: IntegrationAttack,
  harness: RegistryHarness,
): Promise<AttackOutcome> {
  const result = await admitToolEvidence(
    harness.registry,
    attack.draft as Parameters<typeof admitToolEvidence>[1],
    attack.admission as unknown as ToolEvidenceAdmission,
  );
  return { ok: result.ok, ...(result.ok ? {} : { reason: result.reason }) };
}

async function attackForgedActivationRecord(attack: IntegrationAttack): Promise<AttackOutcome> {
  const result = productionToolsFromBoard({
    board: {
      ...emptyBoardState(),
      activations: [attack.activation] as never,
    },
    packages: [pkg(attack.package)],
    validations: [attack.validation as unknown as ValidationRecord],
    descriptions: {},
  });
  return { ok: result.ok, ...(result.ok ? {} : { reason: result.reason }) };
}

async function attackWithdrawTargetMismatch(attack: IntegrationAttack): Promise<AttackOutcome> {
  const result = mapContentDraft(withdrawDraft(), attack.admission as unknown as WithdrawAdmission);
  return { ok: result.ok, ...(result.ok ? {} : { reason: result.reason }) };
}

async function attackSmuggledPermissions(attack: IntegrationAttack): Promise<AttackOutcome> {
  const result = await mapToolCommandDraft(
    {
      kind: "submit_candidate",
      candidate: candidate({
        name: "audit-tool",
        ...attack.candidateOverrides,
      } as Partial<ToolCandidate> & Pick<ToolCandidate, "name" | "candidateId">),
    },
    attack.admission as unknown as ToolPackageAdmission,
  );
  return { ok: result.ok, ...(result.ok ? {} : { reason: result.reason }) };
}

async function attackMixedAnchors(
  attack: IntegrationAttack,
  harness: RegistryHarness,
): Promise<AttackOutcome> {
  const admission: ContentEvidenceAdmission = {
    commandId: "cmd-3",
    issuedAt: "2026-09-13T00:00:00.000Z",
    evidenceId: "ev-1",
    dataVersion: "evalset-2026-09-13",
    candidateVersion: "cand-1",
    scope: "ts-unit-fix",
    receiptRef: attack.receiptRef ?? "receipt:attacker-made-up",
  };
  const result = await admitContentEvidence(
    harness.registry,
    evidenceDraft(attack.draftOverrides as Partial<EvaluationEvidenceDraft>),
    admission,
  );

  return { ok: result.ok, ...(result.ok ? {} : { reason: result.reason }) };
}

async function attackUntrustedEntry(
  attack: IntegrationAttack,
  harness: RegistryHarness,
): Promise<AttackOutcome> {
  for (const garbage of attack.inputs ?? []) {
    const content = mapContentDraft(garbage, proposalAdmission());
    assert.equal(content.ok, false, `${attack.id}: mapContentDraft must fail closed`);
    const tool = await mapToolCommandDraft(garbage, toolEvidenceAdmission(), harness.registry);
    assert.equal(tool.ok, false, `${attack.id}: mapToolCommandDraft must fail closed`);
  }
  return { ok: false, reason: "untrusted_input_rejected" };
}

/** 夹具集合本身必须覆盖 WP-F 的四类攻击，防止语料静默收缩。 */
test("the integration corpus names every WP-F attack class", async () => {
  const dir = integrationAttackDir();
  const files = (await readdir(dir)).filter((name) => name.endsWith(".json"));
  const kinds = new Set<string>();

  for (const file of files) {
    const attack = JSON.parse(await readFile(path.join(dir, file), "utf8")) as IntegrationAttack;
    kinds.add(attack.kind);
  }

  for (const required of [
    "self-reported-verdict",
    "forged-activation-record",
    "withdraw-target-mismatch",
    "smuggled-permissions",
    "mixed-anchors",
    "untrusted-entry",
  ]) {
    assert.equal(kinds.has(required), true, `the corpus must still cover ${required}`);
  }
});
