import test from "node:test";
import assert from "node:assert/strict";
import { retrieveToolReuseCandidates, type ToolReuseCandidate } from "./reuse-retrieval.js";

const catalog: readonly ToolReuseCandidate[] = [...Array.from({ length: 200 }, (_, index) => ({ toolId: `runtime:a-${index}`,
  name: `calendar_${index}`, description: "Read calendar events", capabilities: ["calendar scheduling"] })),
{ toolId: "runtime:zz-table", name: "table_parser", description: "Parse delimited tabular files and preserve missing cells",
  capabilities: ["CSV parsing", "表格数据清洗"], versionId: "table-v1" }];

test("task and capability retrieval finds a specialized tool after the former alphabetical cutoff", () => {
  const found = retrieveToolReuseCandidates({ candidates: catalog, query: "parse CSV tables with missing cells" });
  assert.equal(found[0]?.toolId, "runtime:zz-table");
  assert.equal(found[0]?.versionId, "table-v1");
  assert.ok(found.length <= 24);
  assert.ok(found[0]?.description.includes("CSV parsing"));
  const chinese = retrieveToolReuseCandidates({ candidates: catalog, query: "处理表格数据" });
  assert.equal(chinese[0]?.toolId, "runtime:zz-table");
});

test("exact target is retained while unmatched vocabulary keeps a few real alternatives for model comparison", () => {
  const target = retrieveToolReuseCandidates({ candidates: catalog, query: "calendar", targetVersionId: "table-v1" });
  assert.equal(target[0]?.toolId, "runtime:zz-table");
  const unfamiliar = retrieveToolReuseCandidates({ candidates: catalog, query: "quasar spectroscopy" });
  assert.equal(unfamiliar.length, 4);
  assert.equal(new Set(unfamiliar.map(item => item.toolId)).size, 4);
  assert.ok(unfamiliar.every(item => catalog.some(candidate => candidate.toolId === item.toolId)));
});
