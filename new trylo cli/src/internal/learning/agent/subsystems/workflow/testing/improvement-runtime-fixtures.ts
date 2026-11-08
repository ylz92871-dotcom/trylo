import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { WorkflowLearningResult } from "../domain/trace-contracts.js";
import type { WorkflowImprovementModelPort, WorkflowImprovementProposal } from "../improvement/contracts.js";
import type { WorkflowImprovementEvidenceSnapshot } from "../runtime/improvement-contracts.js";
import { createFileWorkflowImprovementRuntime, fileWorkflowImprovementPorts, type FileWorkflowImprovementOptions } from "../adapters/improvement-composition.js";
import { searchImprovementFixture } from "./improvement-fixtures.js";
import { record } from "../domain/trace-parse.js";

export function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(complete => { resolve = complete; });
  return { promise, resolve };
}

export async function withImprovementBoard(run: (boardRoot: string) => Promise<void>) {
  const boardRoot = await mkdtemp(path.join(tmpdir(), "workflow-improvement-contract-"));
  try { await run(boardRoot); } finally { await rm(boardRoot, { recursive: true, force: true }); }
}

export function resultRecord(result: WorkflowLearningResult<unknown>): Record<string, unknown> {
  assert.ok(result.ok, result.ok ? "" : `${result.code}: ${result.message}`);
  assert.ok(record(result.value));
  return result.value;
}

export function deferredImprovementModel() {
  const started = deferred<void>(), response = deferred<WorkflowLearningResult<WorkflowImprovementProposal>>();
  let calls = 0, tokens = 0;
  const port: WorkflowImprovementModelPort = { async propose() {
    calls += 1;
    started.resolve();
    const result = await response.promise;
    tokens = 100;
    return result;
  }, usage: () => ({ calls, tokens, observedTokens: tokens, uncertain: false }) };

  return { started, response, port };
}

export function runtimeFixture(boardRoot: string, input: Partial<FileWorkflowImprovementOptions> = {}) {
  const fixture = searchImprovementFixture();
  const state: { snapshot: WorkflowImprovementEvidenceSnapshot } = { snapshot: {
    executionId: "session:contract/turn:training", watermark: 100, evidence: fixture.evidence, receipts: [],
  } };
  let calls = 0;
  const options: FileWorkflowImprovementOptions = { boardRoot, scope: fixture.opportunity.task.scope,
    sessionId: "session:contract", budgetId: "budget:contract", allowance: 16000,
    now: () => 1793728800000, publicData: () => true, warn: () => {}, closeGraceMs: 1000,
    readEvidence: async () => ({ ok: true, value: state.snapshot }),
    newModel: () => {
      let sent = 0;
      return { async propose() {
        calls += 1;
        sent += 1;
        return { ok: true, value: fixture.proposal };
      },
        usage: () => ({ calls: sent, tokens: sent * 100, observedTokens: sent * 100, uncertain: false }) };
    }, ...input };

  return { fixture, state, options, runtime: createFileWorkflowImprovementRuntime(options), ports: fileWorkflowImprovementPorts(options),
    calls: () => calls };
}
