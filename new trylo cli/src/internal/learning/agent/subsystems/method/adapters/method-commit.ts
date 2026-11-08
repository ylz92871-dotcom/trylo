import type { BoardCommand } from "../../../../control/commands.js";
import type { EvidenceBundle } from "../../../../control/contracts.js";
import { shortId } from "../../../../domains/shared/hash.js";
import { ACCOUNT_PROVENANCE, ADMISSION_PROVENANCE } from "../assets/archive.js";
import type { AccountInput, CommitCardInput } from "../port.js";

/**
 * 入档/记账命令的纯构造（无 IO）。
 *
 * 从 `board-writer.ts` 拆出，与 `method-fielding.ts`（上场/反馈命令）同构：写口
 * 适配器只剩「读档检查 + 发命令」的编排，而命令形状住在这里。体积预算
 * （`loop/method-line-budget.test.ts` 对 `board-writer.ts` 的 400 行上限）是拆分的
 * 直接原因，不是审美。
 */

/** 一张方法卡在控制板上的身份：`prompt` 域、`prompt_patch` 资产。 */
export const METHOD_DOMAIN = "prompt" as const;
export const METHOD_ASSET_KIND = "prompt_patch" as const;

/**
 * 一次入档的四个命令。
 *
 * 次序的依据是 `control/transitions.ts`：`draft → quarantined → evaluating` 是走
 * 到 shadow 的唯一一条合法路，且 `enter_shadow` 要求 `versionId` 已存在，所以
 * `commit_asset` 必须排在它前面（本包不发第五步，见 `board-writer.ts` 文件头）。
 *
 * `hypothesis` 取 `hint`：控制板要求提案例有一句话，而那张卡的课题本来就是一句
 * 话。`candidateRef` 指向版本，于是「这条提案在说哪个版本」在板上是可追溯的。
 */
export function commitCommands(input: CommitCardInput): ReadonlyArray<BoardCommand> {
  const issuedAt = input.observedAt;
  const id = (step: string): string => shortId("method-cmd", [input.writeId, step]);

  return [
    {
      type: "submit_proposal",
      commandId: id("submit"),
      issuedAt,
      proposal: {
        proposalId: input.proposalId,
        domain: METHOD_DOMAIN,
        scope: input.nicheId,
        assetKind: METHOD_ASSET_KIND,
        candidateRef: input.versionId,
        hypothesis: input.card.hint,
        observationRefs: [],
        risk: "low",
        requiredVerifiers: [],
        requestedAuthorities: [],
        source: "inferred",
      },
    },
    { type: "quarantine", commandId: id("quarantine"), issuedAt, proposalId: input.proposalId },
    { type: "start_evaluation", commandId: id("evaluate"), issuedAt, proposalId: input.proposalId },
    {
      type: "commit_asset",
      commandId: id("commit"),
      issuedAt,
      versionId: input.versionId,
      proposalId: input.proposalId,
      content: input.card,
      schemaVersion: input.card.schemaVersion,
      ...(input.parentVersionId === undefined ? {} : { parentVersionId: input.parentVersionId }),
    },
    {
      type: "record_evidence",
      commandId: id("admission"),
      issuedAt,
      evidence: admissionEvidence(input),
    },
  ];
}

/**
 * 一次记账。
 *
 * 记的是**已发生的事**：下一拍同类失败没复现是支持，复现了是反例，那一拍没有
 * 结算就什么都不记（沉默不是成功，也不是反例，`§7.5`）。
 *
 * `commandId` 由 `evidenceId` 而不是只由 `writeId` + `outcome` 派生：同一张卡
 * 的第二次反例与第一次是**两件事**，若两者派生出同一个 `commandId`，reducer 会
 * 把第二次当成重放，于是「两个反例才休眠」永远到不了。用一个每次记账都不同的
 * 身份，重放仍然幂等（同一条记账事件重放时 `evidenceId` 不变），而两次真实的
 * 记账各自落地。
 */
export function accountCommand(input: AccountInput): BoardCommand {
  return {
    type: "record_evidence",
    commandId: shortId("method-cmd", [input.writeId, input.outcome, input.evidenceId]),
    issuedAt: input.observedAt,
    evidence: accountEvidence(input),
  };
}

function accountEvidence(input: AccountInput): EvidenceBundle {
  return {
    evidenceId: input.evidenceId,
    proposalId: input.proposalId,
    kinds: [METHOD_EVIDENCE_KIND],
    dataVersion: "1",
    failureSamples: input.samples,
    provenance: `${ACCOUNT_PROVENANCE}:${input.outcome}`,
  };
}

function admissionEvidence(input: CommitCardInput): EvidenceBundle {
  return {
    evidenceId: input.evidenceId,
    proposalId: input.proposalId,
    kinds: [METHOD_EVIDENCE_KIND],
    dataVersion: String(input.card.schemaVersion),
    failureSamples: [input.sample],
    provenance: ADMISSION_PROVENANCE,
  };
}

/**
 * 本包能写的唯一一种证据。
 *
 * **不能是 `execution_fact`。** `control/apply-asset.ts::isTraceableIndependentEvidence`
 * 把 `execution_fact` 也算作「声称独立裁决」，于是它必须带 `receipt` 坐标，且
 * `provenance` 必须恰好是 `receipt:<id>`；而没有独立验证器就产不出收据
 * （`OPEN-M2-6`）。实测拒绝码是 `unverifiable_evidence_provenance`（`M-RUN.md`
 * §入档落点有原始输出）。
 *
 * 取 `llm_critique` 不是绕过，而是**唯一说得对的那一种**：它是闭集里唯一不携带
 * 独立权威的证据种类，而这正是记账与入档该有的自我定位——它们是**自评**，不是
 * 验证。它换不来任何晋升，也不该换得来：`§15` 明令不得声称方法卡经过外部验证。
 * 判定在写口就成立，而不是留一句注释指望以后有人记得。
 */
export const METHOD_EVIDENCE_KIND = "llm_critique" as const;
