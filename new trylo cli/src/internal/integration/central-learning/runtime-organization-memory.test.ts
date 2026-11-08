import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import type { CentralDeliberationRequest, CentralLearningIntentDraft } from "../../learning/central/runtime/contracts.js";
import type { OrganizationDecision } from "../../learning/central/organization/contracts.js";
import { emptyCentralRuntimeState } from "../../learning/central/runtime/records.js";
import { createCentralOrganizationService } from "./organization-service.js";
import { createCentralRuntimeOrganization } from "./runtime-organization.js";
import { createCentralRuntimeSource } from "./runtime-source.js";
import { centralOrganizationQueryRef, deliveredOrganizationRecallPacket } from "./runtime-organization-memory.js";

const scope = "workspace:organization-manual-memory", signal = new AbortController().signal;
const allowance = { schemaVersion: 2, unit: "total_model_tokens", maxTokens: 100, maxCalls: 1, maxSteps: 1, maxPromptChars: 4000 } as const;

test("canonical source reads another organization page and its actual delivered use survives a new runtime adapter", async () => {
  const root = await mkdtemp(join(tmpdir(), "trylo-organization-manual-"));
  assert.equal(dirname(root), resolve(tmpdir()));

  try {
    const options = { boardRoot: root, scope, enabled: () => true }, service = createCentralOrganizationService(options);
    const seed: OrganizationDecision = { kind: "decision", decisionRef: "decision:source", purposeRef: "intent:source",
      context: { purpose: "研究工具参数契约", conditionKeys: [], known: [], residual: ["路径解析条件"] },
      program: { programRef: "program:source", depth: "先读原参数约束", timing: "now" },
      expectation: { change: "区分参数与流程问题", uncertainties: ["真实后效未知"] }, alternatives: [], issueRefs: [], stageRefs: [],
      sourceRefs: ["business:source"], experienceUse: null };
    const first = await service.freezeDecision(seed, 0);
    assert.equal(first.status, "saved");
    if (first.status !== "saved") return;

    const feedback = await service.observe({ kind: "feedback", decisionRef: seed.decisionRef, unitRef: "business:progress", supersedes: null,
      sourceRefs: ["business:source"], result: { kind: "progress", summary: "只确认原参数条件，尚无业务采用", remaining: ["真实后效待观察"], resultRefs: [] } }, first.revision);

    assert.equal(feedback.status, "saved");
    if (feedback.status !== "saved") return;

    let revision = feedback.revision;

    for (let index = 0; index < 10; index++) {
      const saved = await service.reviseKnowledge({ kind: "knowledge", knowledgeId: `hypothesis:${index}`, supersedes: null,
        statement: `先检索路径参数契约条件${index}`, conditions: "相似问题仍需核对原条件", conditionKeys: [],
        exceptions: "原参数契约已验证时应查其它原因", exceptionKeys: [], implication: "考虑先读约束再改写流程",
        supportFactIds: [feedback.factId], counterexampleFactIds: [], state: "proposed" }, revision);
      assert.equal(saved.status, "saved");
      if (saved.status !== "saved") return;
      revision = saved.revision;
    }

    const source = createCentralRuntimeSource({ ...options, ports: [] });
    const purpose = "路径 参数 契约";
    const page = await source.read(scope, [centralOrganizationQueryRef(purpose)], 32768, signal);
    const material = page.find(row => row.ref.startsWith("organization-recall:"));
    assert.ok(material);
    const packet = deliveredOrganizationRecallPacket(material, scope, page);
    assert.ok(packet);
    assert.equal(packet.entries.length, 8);
    assert.equal(packet.navigation?.nextQuery?.offset, 8);
    const more = await source.read(scope, [centralOrganizationQueryRef(purpose, 8)], 32768, signal);
    const second = more.find(row => row.ref.startsWith("organization-recall:"));
    assert.ok(second);
    const recalled = deliveredOrganizationRecallPacket(second, scope, more);
    assert.ok(recalled);
    assert.equal(recalled.entries.length, 2);
    const intent: CentralLearningIntentDraft = { intentId: "intent:new", subject: { plane: "agent", domain: "tool", issueId: "issue:new" },
      goal: "先读原参数契约", rationale: "新任务原约束仍不清楚", conditions: [], knowledge: [], residual: ["原参数条件"],
      commitment: { purpose: "核对原条件", assumptions: [], reconsiderWhen: ["发现不匹配"] }, revisionReason: "采纳读到的条件性组织假设",
      sourceRefs: ["business:new"], continuation: { kind: "ready", operation: { kind: "read", operationId: "operation:read-contract",
        purpose: "读原契约", expectedChange: "核对前提", sourceRefs: ["business:new"], refs: ["business:new"], maximumChars: 4000 } } };
    const request: CentralDeliberationRequest = { schemaVersion: 1, scope, budgetId: "budget:original",
      configuration: { schemaVersion: 1, configurationRef: "config:original", authorizationRef: "auth:original", allowance },
      boardSequence: revision, resources: { boardSequence: revision, budgetId: "budget:original", limits: { tokens: 100, calls: 1, steps: 1 },
        occupied: { tokens: 0, calls: 0, steps: 0 }, available: { tokens: 100, calls: 1, steps: 1 }, status: "available", holdReason: null },
      stateRef: "state:actual-delivery", state: emptyCentralRuntimeState(scope), opportunities: [], materials: more, organization: [],
      operation: { kind: "think", operationId: "operation:reconsider", purpose: "比较实际读到的组织假设", expectedChange: "选择下一步", sourceRefs: ["business:new"] } };
    const runtime = createCentralRuntimeOrganization({ ...options, service });

    await runtime.recordDecision!({ request, decisionRef: "operation:read-contract", deliveryRef: "provider:actual-response",
      output: { schemaVersion: 1, intents: [intent], publicExplanation: "核对新任务前提后选择读原契约", sourceRefs: ["business:new"],
        organizationUse: { recallRef: recalled.recallRef, changes: [{ knowledgeFactId: recalled.entries[0]!.factId, choice: "program",
          before: "改写流程", after: "先读原参数契约", reason: "本任务仍有相同未解参数前提，已验证契约例外尚不成立" }] } } }, signal);
    const loaded = await service.read();
    assert.equal(loaded.status, "ready");
    if (loaded.status !== "ready") return;

    const used = loaded.projection.decisions.find(row => row.value.decisionRef === "operation:read-contract")?.value.experienceUse;

    assert.ok(used);
    assert.equal(used.packet.recallRef, recalled.recallRef);
    assert.equal(used.deliveryRef, "provider:actual-response");
    assert.equal(used.packet.query.offset, 8);
  } finally { await rm(root, { recursive: true, force: true }); }
});
