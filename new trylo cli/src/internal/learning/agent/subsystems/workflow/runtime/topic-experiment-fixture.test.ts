import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";
import type { Envelope, JsonObject } from "../../../../../protocol/envelope.js";
import type { WorkflowTask, WorkflowTrace } from "../domain/trace-contracts.js";
import { contentHashOf } from "../../../../control/hash.js";
import { createNdjsonSessionStore } from "../../../../../adapters/session-store/ndjson.js";
import { runWorkflowLearning } from "./runtime.js";
import { readWorkflowVersion } from "./archive.js";
import { selectWorkflowPath } from "../domain/trace-select.js";
import { commitWorkflowAdoption, completeWorkflowAdoption } from "./run-adoption.js";
import { createWorkflowExecution } from "./execution.js";
import type { WorkflowStudyArm } from "./topic-experiment-evidence.js";
import { workflowTopicConditionHash, type WorkflowTopicExperimentOptions } from "./topic-experiment.js";

export const studyTask: WorkflowTask = { scope: "project:workflow-pair", taskFamily: { id: "fixture-report", intentClass: "compile", checkKind: "acceptance" }, conditions: { format: "json" } };

export type StudyFault = "none" | "uncertain" | "wrong_input" | "wrong_task" | "wrong_version" | "extra_turn" | "refused" | "bad_seal" | "overrun" | "check_failed" | "throws";

const at = "2026-11-03T00:00:00.000Z";

function seedTrace(id: string, candidate: boolean): WorkflowTrace {
  return { ...studyTask, schemaVersion: 1, traceId: id, source: "imported", outcome: "success", conditionEvidenceRefs: [`${id}:input`],
    steps: [...(candidate ? [] : [{ nodeId: "prepare", input: "source.json", output: "prepared.json", dependsOn: [], check: "node check-prepare.cjs", status: "passed" as const, evidenceRefs: [`${id}:prepare`] }]),
      { nodeId: "finish", input: candidate ? "source.json" : "prepared.json", output: "output.json", dependsOn: candidate ? [] : ["prepare"], check: "node check-finish.cjs", status: "passed", evidenceRefs: [`${id}:finish`] }] };
}

export async function workflowStudyFixture(fault: StudyFault = "none") {
  const root = await mkdtemp(path.join(os.tmpdir(), "workflow-topic-")), boardRoot = path.join(root, "board");
  const learn = (id: string, trace: WorkflowTrace, parentVersionId?: string) => runWorkflowLearning({ boardRoot, issuedAt: at,
    request: { ...studyTask, requestId: id, subsystem: "workflow", collect: true, budget: { maxEpisodes: 8, maxSteps: 32, maxTokens: 16000 }, traces: [trace],
      ...(parentVersionId === undefined ? {} : { parentVersionId }) } });
  const baseline = await learn("baseline", seedTrace("seed-baseline", false));
  assert.ok(baseline.ok);
  const candidate = await learn("candidate", seedTrace("seed-candidate", true), baseline.value.versionId);
  assert.ok(candidate.ok);
  const candidateVersionId = candidate.value.versionId;
  let calls = 0, reads = 0, collect = true;
  const session = (id: string) => createNdjsonSessionStore({ path: path.join(root, "sessions", `${id}.ndjson`) });
  const options: WorkflowTopicExperimentOptions = { boardRoot, baselineVersionId: baseline.value.versionId, candidateVersionId: candidate.value.versionId,
    task: studyTask, sourceCase: { id: "new-input", inputText: "Produce the checked report from the same new input." },
    descriptor: { ref: "workflow.fixture.frozen-pair", version: "1", domain: "workflow", purpose: "Fixture-only explicit objective over real local checks." },
    // Normalize the declared two-use worst-case utility (2 * max(|-2|, |2|)).
    policy: { conditionHash: "", futureUses: 2, utilityScale: 4, experimentUnits: 1, deltaBounds: { minimum: -2, maximum: 2 }, priorStrength: 1, priorWeights: [0.25, 0.25, 0.25, 0.25] },
    checkerVersion: "fixture-real-node-check-v1", executionVersion: "fixture-session-host-v1", issuedAt: at, probeTimeoutMs: 60000,
    outputAllowance: { unit: "provider_output_tokens", grantId: "host-output-grant", pairMaxOutputTokens: 40, baselineMaxOutputTokens: 20, candidateMaxOutputTokens: 20 },
    objective: { version: "fixture-only-objective-v1", utilityUnit: "fixture-check-utility", costBasis: "explicit fixture provider usage; not a real-provider bill",
      utility: arm => (arm.trace.outcome === "success" ? 1 : 0) - arm.trace.steps.length * 0.01,
      studyCost: pair => (pair.baseline.trace.cost!.tokens + pair.candidate.trace.cost!.tokens) * 0.001 },
    collect: () => collect, signal: new AbortController().signal,
    host: { readRecords: id => {
      reads++;
      return session(id).readRecords();
    }, executeOnce: async arm => {
      calls++;
      if (fault === "throws") throw new Error("host unavailable");
      await execute(arm);
    } } };
  const inputOptions = { ...options, policy: { ...options.policy, conditionHash: workflowTopicConditionHash(options) } };

  async function execute(arm: WorkflowStudyArm) {
    const store = session(arm.sessionId), workspace = path.join(root, arm.sessionId);
    await mkdir(workspace, { recursive: true });
    const started = await store.start({ sessionId: arm.sessionId, createdAt: at, fingerprint: { schemaVersion: "1", providerId: "fixture", model: "fixture", toolCatalogHash: "fixture", workspaceId: studyTask.scope } });

    assert.ok(started.ok, "existing SessionPort rejects duplicate execution");

    try {
      const versionId = fault === "wrong_version" ? candidateVersionId : arm.versionId;
      const artifact = await readWorkflowVersion(boardRoot, versionId);
      assert.ok(artifact.ok);
      const selected = selectWorkflowPath(artifact.value, studyTask);
      assert.ok(selected.ok);
      const task = fault === "wrong_task" ? { ...studyTask, conditions: { format: "csv" } } : studyTask;
      const adoption = { versionId, task, instanceId: `instance-${arm.sessionId}`, artifactHash: contentHashOf(artifact.value),
        ...(selected.value.adoptedBranchId === undefined ? {} : { adoptedBranchId: selected.value.adoptedBranchId }), budget: { maxOutputTokens: arm.maxOutputTokens } };

      assert.ok((await commitWorkflowAdoption(store, arm.sessionId, adoption, at)).ok);
      const turnId = "fixture-turn";

      assert.ok((await store.append({ type: "turn_start", sessionId: arm.sessionId, turnId, at, payload: {} })).ok);
      assert.ok((await store.append({ type: "transcript_item", sessionId: arm.sessionId, turnId, at,
        payload: { kind: "user", sequence: 1, text: fault === "wrong_input" ? "other input" : arm.inputText } })).ok);
      const execution = createWorkflowExecution({ artifact: selected.value.artifact, versionId, traceId: `trace-${arm.sessionId}`, sessionId: arm.sessionId,
        executionId: adoption.instanceId, ...(selected.value.adoptedBranchId === undefined ? {} : { adoptedBranchId: selected.value.adoptedBranchId }),
        ...(task.conditions === undefined ? {} : { conditions: task.conditions, conditionEvidenceRefs: ["fixture:input"] }),
        outputDigest: reference => createHash("sha256").update(readFileSync(path.join(workspace, reference))).digest("hex") });
      let sequence = 0;
      const emit = async (kind: string, payload: JsonObject) => {
        sequence++;
        const event: Envelope = { protocolVersion: "0.0", eventId: `fixture-${sequence}`, sequence, timestamp: `2026-11-03T00:00:${String(sequence).padStart(2, "0")}.000Z`, sessionId: arm.sessionId,
          turnId, producerId: "loop", producerSequence: sequence, kind, payload };
        assert.ok((await store.append({ type: "envelope", sessionId: arm.sessionId, turnId, at: event.timestamp, payload: { envelope: { ...event } } })).ok);
        execution.observe(event);
      };

      await emit("api_call", {});

      if (fault !== "uncertain") await emit("usage", { inputTokens: 100, outputTokens: fault === "overrun" ? 21 : 5, totalTokens: fault === "overrun" ? 121 : 105 });

      await emit("stream_end", {});

      if (fault === "refused") await emit("permission_denied", { toolCallId: "refused-call", refused: true });

      for (const node of selected.value.artifact.nodes) {
        const output = path.join(workspace, node.output);
        await writeFile(output, JSON.stringify({ value: fault === "check_failed" ? 9 : 7 }));
        const checker = path.join(workspace, `check-${node.id}.cjs`);

        await writeFile(checker, `const a=require('node:assert/strict'),f=require('node:fs');a.equal(JSON.parse(f.readFileSync(${JSON.stringify(output)},'utf8')).value,7);`);
        const callId = `check-${node.id}`;
        await emit("tool_use", { toolCallId: callId, name: "run_shell", arguments: { command: node.check } });
        let exitCode = 0;
        try { execFileSync(process.execPath, [checker], { stdio: "ignore" }); } catch { exitCode = 1; }

        await emit("tool_result", { toolCallId: callId, status: exitCode === 0 ? "succeeded" : "failed", value: { exitCode } });
        const args = { nodeId: node.id, input: node.input, output: node.output, checkToolCallId: callId };

        await emit("tool_use", { toolCallId: `record-${node.id}`, name: "workflow_record_step", arguments: args });
        const result = await execution.tools.execute({ name: "workflow_record_step", toolCallId: `record-${node.id}`, arguments: args }, new AbortController().signal);
        if (result.outcome === "result") await emit("tool_result", { toolCallId: `record-${node.id}`, status: "succeeded", value: result.value });
      }

      await emit("terminal", { reason: "completed" });

      if (execution.trace().outcome === "success") {
        if (fault === "bad_seal") await store.append({ type: "execution_extension", sessionId: arm.sessionId, at, payload: { schemaVersion: 1, owner: "workflow", instanceId: adoption.instanceId,
          configuration: { schemaVersion: 1, kind: "completed", stepDigest: "0".repeat(64), terminalTurnId: turnId } } });
        else assert.ok((await completeWorkflowAdoption(store, arm.sessionId, adoption, execution.trace(), turnId, at)).ok);
      }

      if (fault === "extra_turn") await store.append({ type: "turn_start", sessionId: arm.sessionId, turnId: "earlier-or-extra", at, payload: {} });
    } finally { await store.release(); }
  }

  return { root, boardRoot, options: inputOptions, baselineVersionId: baseline.value.versionId, candidateVersionId: candidate.value.versionId,
    calls: () => calls, reads: () => reads, setCollect: (value: boolean) => { collect = value; },
    cleanup: () => rm(root, { recursive: true, force: true }), session,
    file: (name: string) => readFile(path.join(root, name), "utf8") };
}
