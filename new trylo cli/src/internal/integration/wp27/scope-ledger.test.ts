import assert from "node:assert/strict";
import test from "node:test";
import {
  checkLedgerIntegrity,
  checkPrerequisitesAcyclic,
  classifyScope,
  findDanglingPrerequisites,
} from "./scope-ledger.js";

test("WP27.1: 172 行分类为 170 在范围内 + C80/A05 排除", () => {
  const rows = [
    { id: "C01", primaryWorkPackage: "WP23" },
    { id: "C80", primaryWorkPackage: "WP26" },
    { id: "A05", primaryWorkPackage: "WP26" },
  ];
  const scoped = classifyScope(rows, ["C80", "A05"]);

  assert.equal(scoped.filter((item) => item.scope === "in_scope").length, 1);
  assert.equal(scoped.filter((item) => item.scope === "excluded_by_user").length, 2);
  const verdict = checkLedgerIntegrity(rows, ["C80", "A05"]);

  assert.equal(verdict.kind, "complete");

  if (verdict.kind === "complete") {
    assert.equal(verdict.total, 3);
    assert.equal(verdict.inScopeCount, 1);
    assert.equal(verdict.excludedCount, 2);
  }
});

test("WP27.1 红例：重 ID 必须显式 incomplete，不按数量通过", () => {
  const verdict = checkLedgerIntegrity(
    [
      { id: "C01", primaryWorkPackage: "WP23" },
      { id: "C01", primaryWorkPackage: "WP23" },
    ],
    [],
  );

  assert.equal(verdict.kind, "incomplete");

  if (verdict.kind === "incomplete") {
    assert.ok(verdict.failures.some((failure) => failure.code === "duplicate_id"));
  }
});

test("WP27.1 红例：缺主责与未知排除项分别显式失败", () => {
  const missing = checkLedgerIntegrity([{ id: "C01", primaryWorkPackage: "  " }], []);

  assert.equal(missing.kind, "incomplete");
  const unknown = checkLedgerIntegrity([{ id: "C01", primaryWorkPackage: "WP23" }], ["ZZ9"]);

  assert.equal(unknown.kind, "incomplete");

  if (unknown.kind === "incomplete") {
    assert.ok(unknown.failures.some((failure) => failure.code === "unknown_excluded_id"));
  }
});

test("WP27.1: 前置 DAG 无环通过，循环被显式指出", () => {
  const clean = checkPrerequisitesAcyclic([
    { id: "WP01", prerequisites: [] },
    { id: "WP02", prerequisites: ["WP01"] },
    { id: "WP27", prerequisites: ["WP01", "WP02"] },
  ]);

  assert.equal(clean.kind, "acyclic");
  const looped = checkPrerequisitesAcyclic([
    { id: "WP-A", prerequisites: ["WP-B"] },
    { id: "WP-B", prerequisites: ["WP-A"] },
  ]);

  assert.equal(looped.kind, "cyclic");

  if (looped.kind === "cyclic") {
    assert.ok(looped.cycle.length >= 2);
  }
});

test("WP27.1 红例：悬空前置边必须显式指出，不能当作叶子", () => {
  const dangling = findDanglingPrerequisites([
    { id: "WP01", prerequisites: [] },
    { id: "WP27", prerequisites: ["WP01", "GHOST"] },
  ]);

  assert.equal(dangling.length, 1);
  const only = dangling[0];

  assert.ok(only !== undefined);
  assert.equal(only.id, "WP27");
  assert.equal(only.missing, "GHOST");
  const clean = findDanglingPrerequisites([
    { id: "WP01", prerequisites: [] },
    { id: "WP27", prerequisites: ["WP01"] },
  ]);

  assert.deepEqual(clean, []);
});

test("WP27.1 红例：排除项重复登记必须显式失败", () => {
  const verdict = checkLedgerIntegrity(
    [
      { id: "C01", primaryWorkPackage: "WP23" },
      { id: "C80", primaryWorkPackage: "WP26" },
    ],
    ["C80", "C80"],
  );

  assert.equal(verdict.kind, "incomplete");

  if (verdict.kind === "incomplete") {
    assert.ok(verdict.failures.some((failure) => failure.code === "duplicate_excluded_id"));
  }
});

test("WP27.1: 计数自洽 —— 排除项只按登记到的行计一次", () => {
  const rows = [
    { id: "C01", primaryWorkPackage: "WP23" },
    { id: "C80", primaryWorkPackage: "WP26" },
    { id: "A05", primaryWorkPackage: "WP26" },
  ];
  const verdict = checkLedgerIntegrity(rows, ["C80", "A05"]);

  assert.equal(verdict.kind, "complete");

  if (verdict.kind === "complete") {
    assert.equal(verdict.total, verdict.inScopeCount + verdict.excludedCount);
    assert.equal(verdict.excludedCount, 2);
    assert.equal(verdict.inScopeCount, 1);
  }
});
