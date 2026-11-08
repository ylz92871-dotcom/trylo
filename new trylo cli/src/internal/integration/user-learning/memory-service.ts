import { createHash } from "node:crypto";
import {
  activeFacts,
  isFactRecord,
  hasPreviousFactCommand,
  foldProposals,
  pendingProposals,
  sameFact,
  scopeKey,
  visibleFacts,
  type MemoryFactKind,
  type MemoryScope,
  type MemoryProposal,
  type MemorySource,
  type UserFactRecord,
  type UserMemoryRecord,
} from "../../learning/domains/user/memory-fact.js";
import type { MemoryCommandResult } from "../../learning/domains/user/memory-command.js";
import type { UserFactStore } from "./facts-file.js";
import { allowsDurableMemorySource, comparableMemoryText as comparable, confirmsExplicitMemory, explicitRememberRequest, hasMemoryMutationIntent, isMemoryConfirmation as isConfirmation, memoryInstructionText } from "./memory-intent.js";

/**
 * 正式用户记忆的**唯一写入口**。
 *
 * 自动采集（`runtime.ts`）只写证据与信号，从不写事实；模型显式请求与面板修改都
 * 走这里。因此"谁能改用户记住的事"只有一个答案，也就不存在三个互不知情的 writer。
 *
 * 三条不可省的校验：
 *
 *  - **来源是宿主给的，不是模型声称的。** `turn` 里的事件身份由组合根注入，模型只能
 *    提交命题正文与作用域种类；
 *  - **命题必须出现在本轮用户原话里。** 模型改写成"用户希望被称作老板"这类加法，
 *    在这里被拒；这不是 NLP 语义识别，而是一个明确的下界：不加字的引用可以过，
 *    加字的不行；
 *  - **写后必读回。** append 成功不等于存储可恢复，所以每次提交后重新读一遍文件，
 *    确认最新版本真的在那里。读不回就报 `failed`，绝不报 `saved`。
 */

export type UserMemoryTurn = {
  readonly sessionId: string;
  readonly turnId: string;
  /** 本轮用户的原话；grounding 的唯一依据。 */
  readonly userText: string;
  /** 本轮用户事件的稳定身份（宿主注入）。 */
  readonly userEventId: string;
  /** Only the parsed management CLI injects this; model tool arguments cannot grant it. */
  readonly managementAction?: "correct" | "retract";
  /**
   * 本会话此前用户自己说过的话（按时间升序），只含 `user` 角色的文本。
   *
   * 存在的理由只有一个：用户先说"我是 YL Z"，下一句说"可以，记住也行"。第二句
   * 单独不含任何命题，确认的对象在上一句里。没有这份历史，模型要么无法保存，
   * 要么只能把确认句本身存成事实——那等于存了一句空话。
   */
  readonly priorUser?: ReadonlyArray<{ readonly text: string; readonly eventId: string }>;
};

export type UserMemoryDeps = {
  readonly store: UserFactStore;
  readonly userId: string;
  readonly workspaceId: string;
  readonly now: () => number;
  /** `--learning` 的实际取值。空串表示未开启。 */
  readonly switchValue: string;
  readonly turn: UserMemoryTurn;
};

export type RememberRequest = {
  /** 幂等键，由工具调用方生成（同一命令重试复用）。 */
  readonly commandId: string;
  readonly statement: string;
  readonly subject: string;
  readonly factKind: MemoryFactKind;
  readonly scopeKind: MemoryScope["kind"];
};

export type ReviseRequest = {
  readonly commandId: string;
  readonly recordId: string;
  readonly expectedVersion: number;
  readonly statement: string;
};

export type UserMemoryService = {
  readonly enabled: boolean;
  remember(request: RememberRequest): MemoryCommandResult;
  correct(request: ReviseRequest): MemoryCommandResult;
  retract(request: Omit<ReviseRequest, "statement">): MemoryCommandResult;
  /** 全部最新版本（含已撤回），供面板与诊断。 */
  facts(): ReadonlyArray<UserFactRecord>;
  /** 当前 run 可检索的有效事实。 */
  visible(): ReadonlyArray<UserFactRecord>;
};

function switchEnablesUser(value: string): boolean {
  return value === "user" || value === "all";
}

function newId(commandId: string): string {
  return `fact-${createHash("sha256").update(commandId).digest("hex").slice(0, 12)}`;
}

const PENDING_REASON = "用户只是陈述了这件事，还没有要求记住；下一句确认即可保存。";

/** A quoted claim needs an instruction outside its literal span, including on confirmation. */
function hasHumanClaimSource(text: string, statement: string, action: "remember" | "correct"): boolean {
  const dataInstruction = action === "correct" ? hasMemoryMutationIntent(text, "correct") : explicitRememberRequest(text);
  return dataInstruction || comparable(memoryInstructionText(text)).includes(comparable(statement));
}

export function createUserMemoryService(deps: UserMemoryDeps): UserMemoryService {
  const enabled = switchEnablesUser(deps.switchValue);

  function scopeFor(kind: MemoryScope["kind"]): MemoryScope {
    return kind === "user"
      ? { kind: "user", userId: deps.userId }
      : { kind: "project", workspaceId: deps.workspaceId };
  }

  function source(): MemorySource {
    return { kind: "user_statement", eventId: deps.turn.userEventId };
  }

  /**
   * 这条命题是谁说的、在哪一句里说的。
   *
   * 两条路，都要求**逐字出现**：
   *  - 就在本轮原话里 → `user_statement`；
   *  - 本轮是一句确认（"可以，记住也行"），且命题逐字出现在**此前用户自己**说过的
   *    话里 → `user_confirmation`，并绑上那句的 `eventId`。
   *
   * 第二条不是放宽：确认句单独没有命题，绑定的是上文那条**用户原话**，不是模型
   * 转述。找不到就拒绝，绝不允许"孤立的确认"变成一条事实。
   */
  function groundingOf(statement: string, action: "remember" | "correct" = "remember"): MemorySource | undefined {
    const explicitManagement = action === "correct" && deps.turn.managementAction === "correct";
    if (!explicitManagement && (!allowsDurableMemorySource(deps.turn.userText) || !allowsDurableMemorySource(statement))) return undefined;

    if (comparable(statement).length === 0) return undefined;

    if (!explicitManagement && !isConfirmation(deps.turn.userText)
      && !hasHumanClaimSource(deps.turn.userText, statement, action)) return undefined;

    if (comparable(deps.turn.userText).includes(comparable(statement))) return source();

    if (!isConfirmation(deps.turn.userText)) return undefined;

    const prior = deps.turn.priorUser?.at(-1);
    if (prior === undefined || !allowsDurableMemorySource(prior.text) || !comparable(prior.text).includes(comparable(statement))
      || !hasHumanClaimSource(prior.text, statement, action)) return undefined;

    if (!confirmsExplicitMemory(deps.turn.userText, prior.text)
      && !(action === "correct" && hasMemoryMutationIntent(prior.text, "correct"))) {
      const proposals = pendingProposals(readRecords() ?? []);
      if (!proposals.some((proposal) => mayManage(proposal) && comparable(proposal.statement) === comparable(statement)
        && proposal.source.eventId === prior.eventId)) return undefined;
    }

    return {
      kind: "user_confirmation", eventId: deps.turn.userEventId, confirmsEventId: prior.eventId,
    };
  }

  function readRecords(): ReadonlyArray<UserMemoryRecord> | undefined {
    const read = deps.store.read();
    return read.ok ? read.records : undefined;
  }

  /** 写进去之后再读一遍，确认这条版本真的能从磁盘恢复。 */
  function committed(record: UserFactRecord): boolean {
    const records = readRecords();
    if (records === undefined) return false;
    const latest = records
      .filter((candidate): candidate is UserFactRecord => isFactRecord(candidate) && candidate.id === record.id)
      .sort((left, right) => right.version - left.version)[0];
    return latest !== undefined && latest.version === record.version && latest.status === record.status;
  }

  /**
   * 一次命令 = 一个事务：读 → 校验 → 追加 在同一把锁里完成（B11）。
   *
   * 锁外再读一遍做 readback：`append` 成功不等于存储可恢复，而这一次读是独立于
   * 写入路径的（锁已释放），所以它证明的是"别人现在能读到"，不是"我刚才写了"。
   */
  function transact(
    body: (records: ReadonlyArray<UserMemoryRecord>) => { readonly result: MemoryCommandResult; readonly commit?: ReadonlyArray<UserMemoryRecord> },
  ): MemoryCommandResult {
    let written: UserFactRecord | undefined;
    const outcome = deps.store.transact((records) => {
      const step = body(records);
      const fact = step.commit?.find((item): item is UserFactRecord => isFactRecord(item));
      if (fact !== undefined) written = fact;
      return step.commit === undefined ? { result: step.result } : { result: step.result, commit: step.commit };
    });
    if (!outcome.ok) return { result: "failed", reason: outcome.reason, retryable: true };

    if (written !== undefined && !committed(written)) {
      return { result: "failed", reason: "readback_mismatch", retryable: true };
    }

    return outcome.value;
  }

  function commandIdOf(raw: string): string {
    return `${deps.turn.sessionId}:${deps.turn.turnId}:${raw}`;
  }

  function mutationAuthorized(action: "correct" | "retract"): boolean {
    if (deps.turn.managementAction === action) return true;
    if (!allowsDurableMemorySource(deps.turn.userText)) return false;
    if (hasMemoryMutationIntent(deps.turn.userText, action)) return true;
    const prior = deps.turn.priorUser?.at(-1);
    return isConfirmation(deps.turn.userText) && prior !== undefined && hasMemoryMutationIntent(prior.text, action);
  }

  function remember(request: RememberRequest): MemoryCommandResult {
    if (!enabled) return { result: "disabled", setting: "--learning=user" };

    const statement = request.statement.trim(), subject = request.subject.trim();
    if (statement.length === 0 || subject.length === 0) {
      return { result: "rejected", reason: "invalid_arguments", message: "需要非空的主体与命题正文。" };
    }

    const ground = groundingOf(statement);
    if (ground === undefined) {
      return {
        result: "rejected", reason: "statement_not_grounded",
        message: "命题缺少有效的持久保存来源：必须来自用户本轮原话或确认；临时、示例或明确禁止记忆的来源不保存。",
      };
    }

    const scope = scopeFor(request.scopeKind);
    // The turn identity is the host's, and it is what makes a retried command
    // report `already_saved` instead of writing a second fact.
    const commandId = commandIdOf(request.commandId);
    const requestDigest = createHash("sha256").update(JSON.stringify({ subject, statement, factKind: request.factKind, scope: scopeKey(scope) })).digest("hex");

    return transact((records) => {
      if (hasPreviousFactCommand(records, commandId)) {
        return { result: { result: "rejected" as const, reason: "command_conflict" as const, message: "请求属于已替代版本，请读取最新记忆。" } };
      }

      const replay = records.find((record) => record.commandId === commandId);
      if (replay !== undefined && isFactRecord(replay)) {
        const latest = latestOf(records, replay.id);
        const samePayload = replay.subject === subject && replay.statement === statement
          && replay.factKind === request.factKind && scopeKey(replay.scope) === scopeKey(scope);

        return {
          result: samePayload && latest?.version === replay.version && latest.status === "active"
            ? { result: "already_saved" as const, recordId: replay.id, version: replay.version }
            : { result: "rejected" as const, reason: "command_conflict" as const, message: "同一请求编号提交了不同内容，已拒绝。" },
        };
      }

      const proposal = foldProposals(records).find((candidate) => candidate.commandId === commandId);
      if (proposal !== undefined) {
        const samePayload = proposal.subject === subject && proposal.statement === statement
          && proposal.factKind === request.factKind && scopeKey(proposal.scope) === scopeKey(scope);
        return { result: samePayload && proposal.status === "pending"
          ? { result: "pending" as const, proposalId: proposal.id, reason: PENDING_REASON }
          : { result: "rejected" as const, reason: "command_conflict" as const, message: "该请求已提交为提案，内容或状态已变化。" } };
      }

      const aliasOwner = records.find((record): record is UserFactRecord => isFactRecord(record)
        && record.commandAliases?.some((alias) => alias.commandId === commandId) === true);
      if (aliasOwner !== undefined) {
        const alias = aliasOwner.commandAliases?.find((entry) => entry.commandId === commandId);
        const latest = latestOf(records, aliasOwner.id);
        return { result: alias?.requestDigest === requestDigest && latest?.version === aliasOwner.version && latest.status === "active"
          ? { result: "already_saved" as const, recordId: latest.id, version: latest.version }
          : { result: "rejected" as const, reason: "command_conflict" as const, message: "同一请求编号已消费，或记录已变化。" } };
      }

      // 语义去重也必须在锁内：另一个进程可能刚写了一条同义事实。
      const existing = activeFacts(records).find((record) =>
        sameFact({ factKind: request.factKind, subject, statement, scope }, record));
      if (existing !== undefined) {
        return { result: { result: "already_saved" as const, recordId: existing.id, version: existing.version },
          commit: [{ ...existing, commandAliases: [...(existing.commandAliases ?? []), { commandId, requestDigest }] }] };
      }

      // A statement the person merely said is not yet a memory. Without an
      // explicit 记住/remember in this turn, the answer is a proposal: it is not
      // retrievable, not versioned and not active until they confirm it.
      if (!explicitRememberRequest(deps.turn.userText) && ground.kind === "user_statement") {
        const proposalId = "prop-" + newId(commandId).slice("fact-".length);
        const proposal: MemoryProposal = {
          record: "memory_proposal", id: proposalId, status: "pending",
          factKind: request.factKind, subject, statement, scope, source: ground,
          commandId, createdAt: deps.now(),
        };

        return {
          result: { result: "pending" as const, proposalId,
            reason: PENDING_REASON },
          commit: [proposal],
        };
      }

      const record: UserFactRecord = {
        record: "user_fact", id: newId(commandId), version: 1, status: "active",
        factKind: request.factKind, subject, statement, scope, source: ground,
        commandId, createdAt: deps.now(),
      };

      return {
        result: {
          result: "saved" as const, recordId: record.id, version: record.version, scope: record.scope,
          factKind: record.factKind,
          // 协作偏好要经过 Evidence→Conclusion→Policy 资格链才能影响行为；身份与项目
          // 事实保存即可被检索。这里如实区分，不把"能读到"说成"已经在起作用"。
          effective: record.factKind !== "preference",
        },
        commit: [record, ...pendingProposals(records)
          .filter((proposal) => sameFact({ factKind: request.factKind, subject, statement, scope }, proposal))
          .map((proposal): MemoryProposal => ({ ...proposal, status: "committed", createdAt: deps.now() }))],
      };
    });
  }

  function latestOf(records: ReadonlyArray<UserMemoryRecord>, recordId: string): UserFactRecord | undefined {
    return records.filter((record): record is UserFactRecord => isFactRecord(record) && record.id === recordId)
      .sort((left, right) => right.version - left.version)[0];
  }

  function mayManage(record: Pick<UserFactRecord, "scope">): boolean {
    return record.scope.kind === "user" ? record.scope.userId === deps.userId : record.scope.workspaceId === deps.workspaceId;
  }

  function revisionReplay(records: ReadonlyArray<UserMemoryRecord>, request: Omit<ReviseRequest, "statement">, statement?: string): MemoryCommandResult | undefined {
    const key = commandIdOf(request.commandId);
    if (hasPreviousFactCommand(records, key) || records.some((record) => isFactRecord(record)
      && record.commandAliases?.some((alias) => alias.commandId === key) === true)) {
      return { result: "rejected", reason: "command_conflict", message: "请求属于已替代版本，请读取最新记忆。" };
    }

    const replay = records.find((record) => record.commandId === commandIdOf(request.commandId));
    if (replay === undefined || !isFactRecord(replay)) return undefined;

    const same = replay.id === request.recordId && replay.supersedes === request.expectedVersion
      && (statement === undefined ? replay.status === "retracted" : replay.status === "active" && replay.statement === statement)
      && mayManage(replay) && latestOf(records, replay.id)?.version === replay.version;

    return same ? { result: "already_saved", recordId: replay.id, version: replay.version }
      : { result: "rejected", reason: "command_conflict", message: "请求已提交或记录已变化，请读取最新版本。" };
  }

  function correct(request: ReviseRequest): MemoryCommandResult {
    if (!enabled) return { result: "disabled", setting: "--learning=user" };

    if (!mutationAuthorized("correct")) {
      return { result: "rejected", reason: "statement_not_grounded", message: "本轮没有明确更正记忆的有效用户请求，未更正。" };
    }

    const statement = request.statement.trim();
    if (statement.length === 0) {
      return { result: "rejected", reason: "invalid_arguments", message: "纠正后的正文不能为空。" };
    }

    const ground = groundingOf(statement, "correct");
    if (ground === undefined) {
      return { result: "rejected", reason: "statement_not_grounded", message: "纠正内容缺少有效的持久保存来源；临时、示例或明确禁止记忆的来源不更正。" };
    }

    return transact((records) => {
      const replay = revisionReplay(records, request, statement);
      if (replay !== undefined) return { result: replay };

      const current = latestOf(records, request.recordId);
      if (current === undefined) {
        return { result: { result: "rejected" as const, reason: "record_not_found" as const, message: "找不到这条记忆。" } };
      }

      if (!mayManage(current)) return { result: { result: "rejected" as const, reason: "scope_not_permitted" as const, message: "这条记忆不属于当前作用域。" } };

      if (current.version !== request.expectedVersion) {
        return { result: { result: "rejected" as const, reason: "version_conflict" as const,
          message: `当前版本是 v${current.version}，请基于最新版本修改。` } };
      }

      if (current.status === "retracted") {
        return { result: { result: "rejected" as const, reason: "version_conflict" as const,
          message: "这条记忆已撤回，不能再修改。" } };
      }

      const record: UserFactRecord = {
        record: "user_fact", id: current.id, version: current.version + 1, status: "active",
        factKind: current.factKind, subject: current.subject, statement, scope: current.scope,
        source: ground, commandId: commandIdOf(request.commandId), createdAt: deps.now(),
        supersedes: current.version,
      };

      return {
        result: { result: "saved" as const, recordId: record.id, version: record.version,
          scope: record.scope, factKind: record.factKind, effective: record.factKind !== "preference" },
        commit: [record],
      };
    });
  }

  function retract(request: Omit<ReviseRequest, "statement">): MemoryCommandResult {
    if (!enabled) return { result: "disabled", setting: "--learning=user" };

    if (!mutationAuthorized("retract")) {
      return { result: "rejected", reason: "statement_not_grounded", message: "本轮没有明确撤回记忆的有效用户请求，未撤回。" };
    }

    return transact((records) => {
      const replay = revisionReplay(records, request);
      if (replay !== undefined) return { result: replay };

      const current = latestOf(records, request.recordId);
      if (current === undefined) {
        return { result: { result: "rejected" as const, reason: "record_not_found" as const, message: "找不到这条记忆。" } };
      }

      if (!mayManage(current)) return { result: { result: "rejected" as const, reason: "scope_not_permitted" as const, message: "这条记忆不属于当前作用域。" } };

      if (current.version !== request.expectedVersion) {
        return { result: { result: "rejected" as const, reason: "version_conflict" as const,
          message: `当前版本是 v${current.version}。` } };
      }

      if (current.status === "retracted") {
        return { result: { result: "already_saved" as const, recordId: current.id, version: current.version } };
      }

      const record: UserFactRecord = {
        record: "user_fact", id: current.id, version: current.version + 1, status: "retracted",
        factKind: current.factKind, subject: current.subject, statement: current.statement,
        scope: current.scope, source: source(), commandId: commandIdOf(request.commandId), createdAt: deps.now(),
        supersedes: current.version,
      };

      return {
        result: { result: "saved" as const, recordId: record.id, version: record.version,
          scope: record.scope, factKind: record.factKind, effective: false },
        commit: [record],
      };
    });
  }

  function readableRecords(): ReadonlyArray<UserMemoryRecord> {
    const read = deps.store.read();
    if (!read.ok || read.unreadable > 0) throw new Error("user_memory_source_unavailable");
    return read.records;
  }

  return {
    enabled, remember, correct, retract,
    facts: () => readableRecords().filter((record): record is UserFactRecord => isFactRecord(record) && mayManage(record)),
    visible: () => visibleFacts(readableRecords(), { userId: deps.userId, workspaceId: deps.workspaceId }),
  };
}
