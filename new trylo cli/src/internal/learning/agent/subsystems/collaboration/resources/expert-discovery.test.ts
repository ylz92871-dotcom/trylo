import assert from "node:assert/strict";
import test from "node:test";
import { ExpertLibrary, type ExpertConfiguration, type ExpertLibrarySnapshot, type ExpertRecord } from "../../../../../subagent/experts/index.js";
import { discoverCollaborationExperts } from "./expert-discovery.js";

const configuration = (specialty = "CSV warehouse handoff", patch: Partial<ExpertConfiguration> = {}): ExpertConfiguration => ({
  displayName: "Warehouse specialist", specialty, baseRole: "worker", situations: ["Exporting inventory artifacts"],
  responsibilities: ["State exact artifact contracts and unfinished work"], constraints: ["Respect the current explicit consumer contract"],
  collaboration: ["Give the consumer evidence and dependencies"], role: { name: "worker", description: "Artifact specialist", prompt: "p".repeat(8000) },
  toolRefs: ["runtime:read_file"], methods: [{ title: "Contract handoff", instructions: "i".repeat(8000), sourceUris: ["user:warehouse-policy"] }],
  sources: [{ kind: "user", title: "Warehouse policy", uri: "user:warehouse-policy", excerpt: "e".repeat(8000) }], ...patch,
});
const record = (id: string, config = configuration(), status: ExpertRecord["status"] = "active"): ExpertRecord => ({
  expertId: id, experienceKey: `experience:${id}`, status, versions: [{ expertId: id, experienceKey: `experience:${id}`, version: 1,
    requestId: `request:${id}`, createdAt: 1, configuration: config }],
});

function libraryFor(experts: readonly ExpertRecord[]) {
  const snapshot: ExpertLibrarySnapshot = { schemaVersion: 1, sequence: 1, experts, requests: [] };
  let reads = 0;
  const unexpected = (): never => { throw new Error("Discovery cannot create, authorize, edit or persist experts"); };
  const library = new ExpertLibrary({ store: { read: () => {
    reads++;
    return snapshot;
  }, update: unexpected },
    authorization: { authorize: unexpected }, builder: { build: unexpected } });
  return { library, snapshot, reads: () => reads };
}

test("a lexical miss reveals a bounded active catalogue instead of implying that no reusable experts exist", () => {
  const h = libraryFor([record("warehouse"), record("review", configuration("Independent API review")), record("archived", configuration(), "archived")]);
  const before = structuredClone(h.snapshot);
  const result = discoverCollaborationExperts(h.library, { query: "这个较长的自然语言查询没有任何词面上与英文专家配置一致的内容" });

  assert.equal(result.mode, "catalogue_fallback");
  assert.equal(result.queryMatch, false);
  assert.equal(result.total, 2);
  assert.equal(result.omitted, 0);
  assert.deepEqual(result.items.map(item => item.expertId), ["warehouse", "review"]);
  assert.deepEqual(result.sourceRefs, ["expert:warehouse@1", "expert:review@1"]);
  assert.equal(h.reads(), 2);
  assert.deepEqual(h.snapshot, before);
  assert.match(result.note, /not semantic matching/);
  assert.ok(!JSON.stringify(result).includes("p".repeat(100)) && !JSON.stringify(result).includes("i".repeat(100)) && !JSON.stringify(result).includes("e".repeat(100)));
  assert.deepEqual(result.items[0]?.getCommand, { operation: "get", expertId: "warehouse", version: 1 });
  assert.deepEqual(result.items[0]?.toolRefs, ["runtime:read_file"]);
  assert.deepEqual(result.items[0]?.methods, [{ title: "Contract handoff", sourceUris: ["user:warehouse-policy"] }]);
  assert.ok(result.omittedFields.includes("methods.instructions"));
});

test("actual public lexical matches retain their result set and avoid an unnecessary whole-catalogue read", () => {
  const h = libraryFor([record("warehouse"), record("review", configuration("Independent API review"))]);
  const result = discoverCollaborationExperts(h.library, { query: "CSV" });

  assert.equal(result.mode, "query_matches");
  assert.equal(result.queryMatch, true);
  assert.equal(result.total, 1);
  assert.deepEqual(result.items.map(item => item.expertId), ["warehouse"]);
  assert.equal(h.reads(), 1);
  const item = result.items[0]!;

  assert.equal(item.experienceKey, "experience:warehouse");
  assert.equal(item.specialty, "CSV warehouse handoff");
  assert.deepEqual(item.situations, ["Exporting inventory artifacts"]);
  assert.equal(item.baseRole, "worker");
});

test("item and character bounds omit whole candidates while preserving every returned identity and source URI", () => {
  const uri = `https://example.test/policy/${"x".repeat(1900)}`, id = `expert-${"z".repeat(170)}`;
  const large = record("oversized", configuration("Large configuration", { situations: Array.from({ length: 8 }, () => "s".repeat(2000)) }));
  const compact = record(id, configuration("Compact full source reference", { methods: [{ title: "Source-backed method", instructions: "do work", sourceUris: [uri] }],
    sources: [{ kind: "official", title: "Source", uri, excerpt: "Source details" }] }));
  const h = libraryFor([large, compact]);
  const result = discoverCollaborationExperts(h.library, { query: "完全未匹配的目录发现" });

  assert.equal(result.total, 2);
  assert.equal(result.omitted, 1);
  assert.equal(result.items.length, 1);
  assert.equal(result.items[0]?.expertId, id);
  assert.deepEqual(result.items[0]?.methods[0]?.sourceUris, [uri]);
  assert.deepEqual(result.sourceRefs, [`expert:${id}@1`]);
  assert.ok(JSON.stringify(result).length <= 12000);
  const catalogue = libraryFor(Array.from({ length: 15 }, (_, index) => record(`small-${index}`)));
  const bounded = discoverCollaborationExperts(catalogue.library, { query: "完全未匹配的目录发现" });

  assert.ok(bounded.items.length <= 8);
  assert.equal(bounded.omitted, 15 - bounded.items.length);
  const larger = discoverCollaborationExperts(catalogue.library, { query: "完全未匹配的目录发现", limit: 12 });

  assert.ok(larger.items.length <= 12);
  assert.equal(larger.omitted, 15 - larger.items.length);
  assert.ok(JSON.stringify(larger).length <= 12000);
});

test("empty active catalogue stays distinguishable from omitted candidates and invalid inputs do not read the library", () => {
  const h = libraryFor([record("archived", configuration(), "archived")]);
  const empty = discoverCollaborationExperts(h.library, { query: "inventory" });

  assert.equal(empty.mode, "catalogue_fallback");
  assert.equal(empty.total, 0);
  assert.equal(empty.omitted, 0);
  assert.deepEqual(empty.items, []);
  const reads = h.reads();

  for (const limit of [0, 13, 1.5]) assert.throws(() => discoverCollaborationExperts(h.library, { query: "inventory", limit }), /expert_discovery_input_invalid/);

  assert.throws(() => discoverCollaborationExperts(h.library, { query: "x".repeat(1501) }), /expert_discovery_input_invalid/);
  assert.equal(h.reads(), reads);
});
