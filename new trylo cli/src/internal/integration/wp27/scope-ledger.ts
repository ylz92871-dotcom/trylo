/**
 * WP27.1 矩阵与来源完整性台账。
 *
 * 意图：把“172 行历史登记 + 用户排除决定”变成可机检的纯函数，而不是
 * 靠人工数行或靠 completed 数量代替当前范围验收。用户 2026-10-07 决定：
 * C80/A05 两个整项 excluded_by_user，不是暂缓或欠账；其余 170 个 ID 按
 * 批准子能力验收，私有子项与另建远端平台分支排除。
 *
 * 边界：本模块只判定范围归属与台账结构完整性（无漏项/重主责/环），不判定
 * 某 ID 的成熟度（那是主能力矩阵 + 证据的 owner 事，不在本表另造 writer）。
 */

export type MappingRow = {
  readonly id: string;
  readonly primaryWorkPackage: string;
};

export type ScopeKind = "in_scope" | "excluded_by_user";

export type ScopedCapability = {
  readonly id: string;
  readonly scope: ScopeKind;
  readonly primaryWorkPackage: string;
};

export type LedgerFailureCode =
  | "duplicate_id"
  | "missing_primary"
  | "unknown_excluded_id"
  | "duplicate_excluded_id"
  | "excluded_without_owner";

export type LedgerFailure = {
  readonly code: LedgerFailureCode;
  readonly detail: string;
};

export type LedgerVerdict =
  | {
      readonly kind: "complete";
      readonly total: number;
      readonly inScopeCount: number;
      readonly excludedCount: number;
    }
  | {
      readonly kind: "incomplete";
      readonly failures: readonly LedgerFailure[];
    };

export type PackageEdge = {
  readonly id: string;
  readonly prerequisites: readonly string[];
};

export type AcyclicVerdict =
  | { readonly kind: "acyclic" }
  | { readonly kind: "cyclic"; readonly cycle: readonly string[] };

function isNonEmpty(value: string): boolean {
  return value.trim().length > 0;
}

function collectLedgerFailures(
  rows: readonly MappingRow[],
  excludedIds: readonly string[],
): readonly LedgerFailure[] {
  const failures: LedgerFailure[] = [];
  const seen = new Set<string>();

  for (const row of rows) {
    if (seen.has(row.id)) {
      failures.push({ code: "duplicate_id", detail: `duplicate capability id: ${row.id}` });
      continue;
    }

    seen.add(row.id);

    if (!isNonEmpty(row.primaryWorkPackage)) {
      failures.push({ code: "missing_primary", detail: `missing primaryWorkPackage: ${row.id}` });
    }
  }

  const excludedSeen = new Set<string>();

  for (const excluded of excludedIds) {
    if (!seen.has(excluded)) {
      failures.push({ code: "unknown_excluded_id", detail: `excluded id not in ledger: ${excluded}` });
      continue;
    }

    if (excludedSeen.has(excluded)) {
      failures.push({ code: "duplicate_excluded_id", detail: `excluded id listed twice: ${excluded}` });
      continue;
    }

    excludedSeen.add(excluded);
  }

  return failures;
}

/**
 * 按用户排除决定分类 172 行。分类本身不失败；结构问题由
 * checkLedgerIntegrity 报告，调用方不得把分类成功当验收通过。
 */
export function classifyScope(
  rows: readonly MappingRow[],
  excludedIds: readonly string[],
): readonly ScopedCapability[] {
  const excluded = new Set(excludedIds);
  return rows.map((row) => ({
    id: row.id,
    scope: excluded.has(row.id) ? "excluded_by_user" : "in_scope",
    primaryWorkPackage: row.primaryWorkPackage,
  }));
}

/**
 * 台账结构完整性：无重 ID、无缺主责、排除项必须落在登记内。
 * 通过时同时给出 total/inScope/excluded 计数，供 WP27.1 验收断言
 * total=172、excluded=2、inScope=170（当前批准范围）。
 */
export function checkLedgerIntegrity(
  rows: readonly MappingRow[],
  excludedIds: readonly string[],
): LedgerVerdict {
  const failures = collectLedgerFailures(rows, excludedIds);
  if (failures.length > 0) {
    return { kind: "incomplete", failures };
  }

  const excluded = new Set(excludedIds);
  const excludedRows = rows.filter((row) => excluded.has(row.id)).length;

  return {
    kind: "complete",
    total: rows.length,
    inScopeCount: rows.length - excludedRows,
    excludedCount: excludedRows,
  };
}

/**
 * A prerequisite naming a package that is not in the table is indistinguishable
 * from a leaf to a graph walk, so `checkPrerequisitesAcyclic` alone would answer
 * "acyclic" about a dependency nobody can satisfy. This is reported separately
 * because it is a different defect from a cycle: the graph is fine, the edge is
 * fiction.
 */
export function findDanglingPrerequisites(
  packages: readonly PackageEdge[],
): readonly { readonly id: string; readonly missing: string }[] {
  const known = new Set(packages.map((pkg) => pkg.id));
  const dangling: { id: string; missing: string }[] = [];

  for (const pkg of packages) {
    for (const dep of pkg.prerequisites) {
      if (!known.has(dep)) {
        dangling.push({ id: pkg.id, missing: dep });
      }
    }
  }

  return dangling;
}

/**
 * 接口前置 DAG 无环检查。WP27 依赖 WP01–WP26 全体，前置表必须是无环 DAG；
 * “双方等对方整包完成”的循环不允许以联验名义存在。悬空前置边由
 * findDanglingPrerequisites 单独报告。
 */
export function checkPrerequisitesAcyclic(packages: readonly PackageEdge[]): AcyclicVerdict {
  const edges = new Map<string, readonly string[]>();

  for (const pkg of packages) {
    edges.set(pkg.id, pkg.prerequisites);
  }

  const permanent = new Set<string>();
  const temporary = new Set<string>();
  const trail: string[] = [];

  function visit(id: string): readonly string[] | undefined {
    if (permanent.has(id)) {
      return undefined;
    }

    if (temporary.has(id)) {
      const start = trail.indexOf(id);
      return start < 0 ? [id] : [...trail.slice(start), id];
    }

    temporary.add(id);
    trail.push(id);
    const next = edges.get(id) ?? [];

    for (const dep of next) {
      const cycle = visit(dep);
      if (cycle !== undefined) {
        return cycle;
      }
    }

    temporary.delete(id);
    trail.pop();
    permanent.add(id);

    return undefined;
  }

  for (const pkg of packages) {
    const cycle = visit(pkg.id);
    if (cycle !== undefined) {
      return { kind: "cyclic", cycle };
    }
  }

  return { kind: "acyclic" };
}
