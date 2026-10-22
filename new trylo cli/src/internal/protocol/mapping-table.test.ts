import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { ACP_ROWS } from "./acp-map.js";
import { AGUI_ROWS } from "./agui-map.js";
import { FRAME_DERIVATIONS } from "./frame-fields.js";
import { EVENT_KINDS, type EventKind } from "./kinds.js";
import { PAYLOAD_CONTRACTS, PAYLOAD_FIELD_TYPES, checkPayload } from "./payload-contract.js";
import { ACP_STOP_REASONS, TERMINAL_STOP_REASON } from "./terminal-map.js";
import { TERMINAL_REASONS } from "./envelope.js";
import type { JsonObject } from "./envelope.js";

/**
 * P1：映射表合同。
 *
 * 这一组用例是「27 行全覆盖」的机器化形式（WP §5 第 2 条禁止只测子集）。
 * 夹具是**独立数据**：表改了而夹具没跟上、或夹具多出一个 kind，
 * 都会在这里红——两张表不能互相迁就。
 */

type Fixture = { readonly kind: string; readonly envelope: Record<string, unknown> };

function loadFixtures(): ReadonlyArray<Fixture> {
  const path = join(process.cwd(), "testdata", "protocol", "projection", "envelopes.json");
  return JSON.parse(readFileSync(path, "utf8")) as ReadonlyArray<Fixture>;
}

const FIXTURES = loadFixtures();

test("夹具覆盖全部事件，包括非终态的子智能体轮次更新", () => {
  assert.equal(EVENT_KINDS.length, 28);
  assert.equal(FIXTURES.length, EVENT_KINDS.length);
  const fixtureKinds = FIXTURES.map((item) => item.kind).sort();
  assert.deepEqual(fixtureKinds, [...EVENT_KINDS].sort());
});

test("每条夹具的声明 kind 与 envelope.kind 一致（防止复制粘贴错行）", () => {
  for (const fixture of FIXTURES) {
    assert.equal(fixture.envelope.kind, fixture.kind);
  }
});

test("ACP_ROWS 覆盖全部 kind，不多不少", () => {
  const rows = Object.keys(ACP_ROWS).sort();
  assert.deepEqual(rows, [...EVENT_KINDS].sort());
});

test("AGUI_ROWS 覆盖全部 kind，不多不少", () => {
  const rows = Object.keys(AGUI_ROWS).sort();
  assert.deepEqual(rows, [...EVENT_KINDS].sort());
});

test("两列每一个 kind 都写了非空的有损说明（漏行/留空即失败）", () => {
  for (const kind of EVENT_KINDS) {
    assert.equal(ACP_ROWS[kind].note.trim().length > 0, true, `${kind} 缺 ACP 有损说明`);
    assert.equal(AGUI_ROWS[kind].note.trim().length > 0, true, `${kind} 缺 ag-ui 有损说明`);
  }
});

test("ACP 行的形状自洽：custom ⇔ primitive=custom，且只有 session_update/notice 带变体名", () => {
  for (const kind of EVENT_KINDS) {
    const row = ACP_ROWS[kind];
    if (row.disposition === "custom") {
      assert.equal(row.primitive, "custom", kind);
      assert.equal(row.variant, null, kind);
      continue;
    }
    assert.notEqual(row.primitive, "custom", kind);
    if (row.primitive === "request_permission") {
      // 请求原语本身就是形状，没有「变体」这一层（approval_requested 走这里）。
      assert.equal(row.variant, null, kind);
    } else {
      if (typeof row.variant !== "string") {
        assert.fail(`${kind} 的 primitive=${row.primitive} 必须给出变体名`);
      }
      assert.equal(row.variant.trim().length > 0, true, kind);
    }
  }
});

test("ACP 行的 body 规格合法：字段名与派生名都来自闭集", () => {
  for (const kind of EVENT_KINDS) {
    for (const spec of ACP_ROWS[kind].body) {
      assert.equal(spec.as.trim().length > 0, true, `${kind} 有一条规格没有目标字段名`);
      if (spec.kind === "derived") {
        assert.equal(FRAME_DERIVATIONS.includes(spec.name), true, `${kind} → ${spec.name}`);
      }
    }
  }
});

test("自定义帧的规格必须能重建：custom 行带 name 与 custom 载体", () => {
  for (const kind of EVENT_KINDS) {
    const row = ACP_ROWS[kind];
    if (row.disposition !== "custom") {
      continue;
    }
    const names = row.body.map((spec) => spec.as);
    assert.equal(names.includes("name"), true, `${kind} 的 CUSTOM 没有名字`);
    assert.equal(names.includes("custom"), true, `${kind} 的 CUSTOM 没有载荷载体`);
  }
});

test("ag-ui 每一行的 body 非空，字段名合法", () => {
  for (const kind of EVENT_KINDS) {
    const row = AGUI_ROWS[kind];
    assert.equal(row.body.length > 0, true, `${kind} 的 ag-ui 行是空 body`);
    assert.equal(row.type.trim().length > 0, true, `${kind} 的 ag-ui 行没有事件类型`);
    for (const spec of row.body) {
      assert.equal(spec.as.trim().length > 0, true, `${kind} 有一条规格没有目标字段名`);
    }
  }
});

test("ag-ui 的 custom 行必须落 CUSTOM 事件且带 name/value 两段", () => {
  for (const kind of EVENT_KINDS) {
    const row = AGUI_ROWS[kind];
    if (row.disposition !== "custom") {
      continue;
    }
    assert.equal(row.type, "CUSTOM", kind);
    const names = row.body.map((spec) => spec.as);
    assert.deepEqual([...names].sort(), ["name", "value"], kind);
  }
});

test("需要按终态分流的行必须覆盖全部终态（不许只写一半映射）", () => {
  let users = 0;
  for (const kind of EVENT_KINDS) {
    const table = AGUI_ROWS[kind].typeByTerminalReason;
    if (table === undefined) {
      continue;
    }
    users += 1;
    assert.deepEqual(Object.keys(table).sort(), [...TERMINAL_REASONS].sort(), kind);
    for (const reason of TERMINAL_REASONS) {
      assert.equal(table[reason].trim().length > 0, true, `${kind}/${reason}`);
    }
  }
  assert.equal(users > 0, true, "typeByTerminalReason 机制必须真的被用到，不能是死代码");
});

test("omitted 列表里的每一格都是非空字符串且不重复", () => {
  for (const kind of EVENT_KINDS) {
    for (const list of [ACP_ROWS[kind].omitted, AGUI_ROWS[kind].omitted]) {
      assert.equal(new Set(list).size, list.length, `${kind} 的 omitted 有重复项`);
      for (const field of list) {
        assert.equal(typeof field === "string" && field.trim().length > 0, true, kind);
      }
    }
  }
});

test("PAYLOAD_CONTRACTS 覆盖全部 kind，required 是 types 的子集", () => {
  assert.deepEqual(Object.keys(PAYLOAD_CONTRACTS).sort(), [...EVENT_KINDS].sort());
  for (const kind of EVENT_KINDS) {
    const contract = PAYLOAD_CONTRACTS[kind];
    const declared = new Set([
      ...Object.keys(contract.types),
      ...contract.required,
      ...contract.optional,
    ]);
    for (const field of contract.required) {
      assert.equal(declared.has(field), true, kind);
      assert.notEqual(contract.types[field], undefined, `${kind}.${field} 没有声明类型`);
    }
    for (const field of Object.keys(contract.types)) {
      assert.equal(declared.has(field), true, kind);
    }
  }
});

test("契约里声明的 JSON 类型都来自闭集（防手滑写错类型名）", () => {
  for (const kind of EVENT_KINDS) {
    for (const [field, type] of Object.entries(PAYLOAD_CONTRACTS[kind].types)) {
      assert.equal(
        (PAYLOAD_FIELD_TYPES as readonly string[]).includes(type),
        true,
        `${kind}.${field} 声明了未知类型 ${type}`,
      );
    }
  }
});

test("夹具里每一条 envelope 都满足自己的 payload 契约（表与现实不脱节）", () => {
  for (const fixture of FIXTURES) {
    const kind = fixture.kind as EventKind;
    const payload = fixture.envelope.payload;
    assert.equal(typeof payload, "object");
    assert.notEqual(payload, null);
    const check = checkPayload(kind, payload as JsonObject);
    assert.equal(check.ok, true, `${kind}: ${check.ok ? "" : check.detail}`);
  }
});

test("ACP 停止原因词表在表里被用到的值都合法", () => {
  for (const reason of TERMINAL_REASONS) {
    assert.equal(
      (ACP_STOP_REASONS as readonly string[]).includes(TERMINAL_STOP_REASON[reason].stopReason),
      true,
      reason,
    );
  }
});
