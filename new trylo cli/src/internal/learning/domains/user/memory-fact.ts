/**
 * 用户事实：一条用户明确要求（或确认）记住的长期命题。
 *
 * 与证据（`evidence`）的区别是**承诺 vs 观察**：证据是"这一拍用户说了什么"
 * 的系统观察，事实是"用户要求把这句话留下来"的显式动作。把两者混成一种记录，
 * 就会让自动采集的沉默观察变成用户从没做过的承诺。
 *
 * 与偏好（`conclusion` / `userModel` / `policy`）的区别是**可引用 vs 可执行**：
 * 事实只回答"用户是谁、用户说过什么"，不产生权限、不改变工具、不自动成为行为
 * 规则。身份事实因此不需要走资格链，也不该被资格链降级成"一次性任务要求"。
 *
 * 记录是追加型的：纠正与撤回都是新版本，旧版本留在账上。当前状态 = 按 id 取
 * 最大 version 的折叠，所以重启、压缩、备份恢复都不会复活旧版本。
 */

export const MEMORY_FACT_KINDS = ["identity_fact", "preference", "project_fact"] as const;

export type MemoryFactKind = (typeof MEMORY_FACT_KINDS)[number];

export const MEMORY_FACT_STATUSES = ["active", "retracted"] as const;

export type MemoryFactStatus = (typeof MEMORY_FACT_STATUSES)[number];

/**
 * 作用域：个人事实与项目事实分开。
 *
 * `user` 跨工作区可读（同一 userId）；`project` 只在同一 workspaceId 内可读。
 * 这个区分不是标签，是检索时的硬条件——把项目内的事实当成个人身份带走，比不
 * 记住它更糟。
 */
export type MemoryScope =
  | { readonly kind: "user"; readonly userId: string }
  | { readonly kind: "project"; readonly workspaceId: string };

/**
 * 来源：只有用户本人说过的话才算。
 *
 * `user_confirmation` 绑定被确认的那条命题（`confirmsEventId`），因为"可以，
 * 记住也行"单独存在时不含任何命题；把它当事实保存会存下一句空话。
 */
export type MemorySource =
  | { readonly kind: "user_statement"; readonly eventId: string }
  | { readonly kind: "user_confirmation"; readonly eventId: string; readonly confirmsEventId: string };

export type UserFactRecord = {
  readonly formatVersion?: 1 | 2;
  readonly record: "user_fact";
  /** recordId：稳定，跨版本不变。 */
  readonly id: string;
  readonly version: number;
  readonly status: MemoryFactStatus;
  readonly factKind: MemoryFactKind;
  /** 事实主体，例如 `YL Z`。 */
  readonly subject: string;
  /** 用户原话或可追溯命题。 */
  readonly statement: string;
  readonly scope: MemoryScope;
  readonly source: MemorySource;
  /** 幂等键：同一次请求重试不产生第二条有效事实。 */
  readonly commandId: string;
  /** Compaction retains superseded command keys so stale retries cannot create new facts. */
  readonly previousCommandIds?: ReadonlyArray<string>;
  /** Additional remember commands consumed by semantic dedupe at this version. */
  readonly commandAliases?: ReadonlyArray<{ readonly commandId: string; readonly requestDigest: string }>;
  readonly createdAt: number;
  /** 被本次纠正/撤回替代的版本号。 */
  readonly supersedes?: number;
};

export function scopeKey(scope: MemoryScope): string {
  return scope.kind === "user" ? `user:${scope.userId}` : `project:${scope.workspaceId}`;
}

/** 身份更正后的 subject 是历史标签；其他类别仍须区分主体，避免合并两个项目对象。 */
export function sameFact(
  fact: Pick<UserFactRecord, "subject" | "factKind" | "statement" | "scope">,
  other: Pick<UserFactRecord, "subject" | "factKind" | "statement" | "scope">,
): boolean {
  return fact.factKind === other.factKind && fact.statement === other.statement
    && (fact.factKind === "identity_fact" || fact.subject === other.subject)
    && scopeKey(fact.scope) === scopeKey(other.scope);
}

/**
 * 折叠成"每个 id 的最新版本"。
 *
 * 按 `version` 取最大，不按写入顺序：账本可能被重放或拼接，位置不是权威。
 * 版本号相同但内容不同（损坏或并发写）取较大的 `createdAt`，再相同则保留先到的
 * 那条——宁可少一个更新，也不要让两条互相矛盾的记录都"有效"。
 */
export function foldFacts(records: ReadonlyArray<UserMemoryRecord>): ReadonlyArray<UserFactRecord> {
  const latest = new Map<string, UserFactRecord>();

  for (const record of records) {
    if (!isFactRecord(record)) continue;
    const current = latest.get(record.id);
    if (current === undefined || record.version > current.version
      || (record.version === current.version && record.createdAt > current.createdAt)) {
      latest.set(record.id, record);
    }
  }

  const metadata = new Map<string, { readonly aliases: Map<string, string>; readonly previous: Set<string> }>();

  for (const candidate of records) {
    if (!isFactRecord(candidate) || latest.get(candidate.id)?.version !== candidate.version) continue;
    const merged = metadata.get(candidate.id) ?? { aliases: new Map<string, string>(), previous: new Set<string>() };
    for (const key of candidate.previousCommandIds ?? []) merged.previous.add(key);
    for (const alias of candidate.commandAliases ?? []) merged.aliases.set(alias.commandId, alias.requestDigest);
    metadata.set(candidate.id, merged);
  }

  return [...latest.values()].map((record) => {
    const { aliases, previous } = metadata.get(record.id) ?? { aliases: new Map<string, string>(), previous: new Set<string>() };
    return { ...record, ...(previous.size > 0 ? { previousCommandIds: [...previous].sort() } : {}),
      ...(aliases.size > 0 ? { commandAliases: [...aliases].map(([commandId, requestDigest]) => ({ commandId, requestDigest })) } : {}) };
  });
}

/** A compacted key is consumed, but its obsolete payload must never be replayed. */
export function hasPreviousFactCommand(records: ReadonlyArray<UserMemoryRecord>, commandId: string): boolean {
  return records.some((record) => isFactRecord(record) && record.previousCommandIds?.includes(commandId) === true);
}

/** Latest versions retain every consumed key; tombstones and final proposal states survive. */
export function compactMemoryRecords(records: ReadonlyArray<UserMemoryRecord>): ReadonlyArray<UserMemoryRecord> {
  const commands = new Map<string, Set<string>>();

  for (const record of records) {
    if (!isFactRecord(record)) continue;
    const keys = commands.get(record.id) ?? new Set<string>();
    keys.add(record.commandId);
    for (const key of record.previousCommandIds ?? []) keys.add(key);
    for (const alias of record.commandAliases ?? []) keys.add(alias.commandId);
    commands.set(record.id, keys);
  }

  const facts = foldFacts(records).map((record): UserFactRecord => {
    const keys = commands.get(record.id) ?? new Set<string>();
    keys.delete(record.commandId);
    for (const alias of record.commandAliases ?? []) keys.delete(alias.commandId);
    return { ...record, previousCommandIds: [...keys].sort() };
  });

  return [...facts, ...foldProposals(records)];
}

/** 当前有效（未被撤回）的事实，按创建时间升序，供检索与上场使用。 */
export function activeFacts(records: ReadonlyArray<UserMemoryRecord>): ReadonlyArray<UserFactRecord> {
  return foldFacts(records)
    .filter((record) => record.status === "active")
    .sort((left, right) => left.createdAt - right.createdAt);
}

/** 当前 run 能看到的事实：个人作用域 + 本工作区作用域。 */
export function visibleFacts(
  records: ReadonlyArray<UserMemoryRecord>,
  input: { readonly userId: string; readonly workspaceId: string },
): ReadonlyArray<UserFactRecord> {
  return activeFacts(records).filter((record) =>
    record.scope.kind === "user"
      ? record.scope.userId === input.userId
      : record.scope.workspaceId === input.workspaceId);
}

/**
 * 事实在检索结果里的稳定文档 id。
 *
 * 用 recordId 而不是路径：面板拿到的是一个 id，模型引用同一个 id，第三进程读回
 * 还是这个 id。路径会随 home 变化，不能当身份。
 */
export function factDocumentId(recordId: string): string {
  return `user-memory:${recordId}`;
}

/** 一条事实的可读正文。一行一句，让 `memory_search` 的行号有意义。 */
export function factLines(record: UserFactRecord): ReadonlyArray<string> {
  return [
    // The statement is the current claim. A stable subject label can contain
    // an old name after correction and must not contradict that claim.
    record.statement,
    `record_id: ${record.id}; expected_version: ${record.version}; 类别：${record.factKind}；作用域：${scopeKey(record.scope)}`,
  ];
}

/**
 * 待确认提案（B09）。
 *
 * 用户只是在陈述一件事（"我是 YL Z"），并没有要求记住它。此时模型不该直接写账，
 * 而应该留下一条**提案**：它还不是记忆，不可检索、不参与行为，等用户下一句确认。
 *
 * 提案与事实是两种记录而不是一个布尔字段：把"尚未同意"塞进 `status` 会让
 * `activeFacts` 的每个调用点都要记得排除它，而漏一处就等于偷偷记住了。
 */
export const MEMORY_PROPOSAL_STATUSES = ["pending", "committed", "discarded"] as const;

export type MemoryProposalStatus = (typeof MEMORY_PROPOSAL_STATUSES)[number];

export type MemoryProposal = {
  readonly formatVersion?: 1 | 2;
  readonly record: "memory_proposal";
  readonly id: string;
  readonly status: MemoryProposalStatus;
  readonly factKind: MemoryFactKind;
  readonly subject: string;
  readonly statement: string;
  readonly scope: MemoryScope;
  readonly source: MemorySource;
  readonly commandId: string;
  readonly createdAt: number;
};

/** 账本里的两种记录。一个文件，两个明确的种类，没有第三种。 */
export type UserMemoryRecord = UserFactRecord | MemoryProposal;

export function isFactRecord(record: UserMemoryRecord): record is UserFactRecord {
  return record.record === "user_fact";
}

export function isProposalRecord(record: UserMemoryRecord): record is MemoryProposal {
  return record.record === "memory_proposal";
}

/** 每个提案 id 的最新状态。同 id 多行时按写入时间取最后一条。 */
export function foldProposals(records: ReadonlyArray<UserMemoryRecord>): ReadonlyArray<MemoryProposal> {
  const latest = new Map<string, MemoryProposal>();

  for (const record of records) {
    if (!isProposalRecord(record)) continue;
    const current = latest.get(record.id);
    if (current === undefined || record.createdAt >= current.createdAt) latest.set(record.id, record);
  }

  return [...latest.values()];
}

export function pendingProposals(records: ReadonlyArray<UserMemoryRecord>): ReadonlyArray<MemoryProposal> {
  return foldProposals(records).filter((proposal) => proposal.status === "pending");
}
