import assert from "node:assert/strict";
import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { createBoardReader } from "../../adapters/learning-store/file-event-store.js";
import { readCentralPursuitObservations } from "../../integration/learning-allocation/pursuit-observations.js";
import { readContentRecords } from "../../integration/learning-content/records.js";
import { readCollaborationNoChange } from "../../learning/agent/subsystems/collaboration/orchestration/no-change-receipt.js";
import { centralLearningSpent } from "../../learning/control/coordination-contract.js";
import { centralBudgetProjection } from "../../learning/control/central-budget-state.js";
import { contentHashOf } from "../../learning/control/hash.js";
import { isContentBatch } from "../../learning/central/content/material-parse.js";
import type { KnownApplicationDraft, ResidualReviewDraft } from "../../learning/central/content/process-contract.js";
import type { ProviderEvent, ProviderPort, ProviderRequest } from "../../ports/provider.js";
import type { JsonObject } from "../../protocol/envelope.js";
import { centralLearningTurnFactory } from "./central-learning-turn.js";
import type { CliContext } from "./context.js";
import { executeTurn, isTurnFailure } from "./host.js";
import { methodBoardRoot } from "./learning-sink.js";
import { createDenyAllPermission } from "./permission.js";
import { isRunFailure, prepareRun } from "./run-command.js";
import { scaffoldAfterTurn } from "./turn-threading.js";

const originalRequirement = "The known rule gives 2 + 2 = 4 under A. Determine whether it extends to B.";
const at = Date.parse("2026-11-04T14:00:00.000Z");

type Row = Record<string, unknown>;

type NextCall = { readonly name: string; readonly arguments: JsonObject };

function row(value: unknown): Row {
  assert.ok(value !== null && typeof value === "object" && !Array.isArray(value), JSON.stringify(value));
  return value as Row;
}

function text(value: unknown): string {
  assert.equal(typeof value, "string");
  return value as string;
}

function rows(value: unknown): Row[] {
  assert.ok(Array.isArray(value));
  return value.map(row);
}

function lastResult(request: ProviderRequest): Row {
  const message = [...request.messages].reverse().find(item => item.role === "tool");
  assert.ok(message, "the normal loop must return the real prior tool result");
  return row(JSON.parse(message.content));
}

function tool(name: string, args: JsonObject = {}): NextCall { return { name, arguments: args }; }

function central(args: JsonObject): NextCall { return tool("central_learning", args); }

/** Pages are consumed only through real tool results. A semantic callback sees
 * the reconstructed JSON after every UTF-8 cursor and the source hash agree. */
function responseReader() {
  let pending: { ref: string; hash: string; total: number; end: number; parts: string[] } | undefined;
  const count = (value: unknown): number => {
    assert.ok(typeof value === "number" && Number.isSafeInteger(value) && value >= 0);
    return value;
  };

  return (result: Row): { readonly call: NextCall } | { readonly result: Row } => {
    let page: Row;

    if (result.status === "paged_response") {
      assert.equal(pending, undefined, "a new response cannot replace an incomplete one");
      page = row(result.firstPage);
      pending = { ref: text(result.responseRef), hash: text(page.sourceHash), total: count(result.totalBytes), end: 0, parts: [] };
      assert.match(pending.hash, /^[a-f0-9]{64}$/);
      assert.equal(pending.ref, `central-response:${pending.hash}`);
    } else if (pending !== undefined) {
      page = result;
    } else return { result };

    const reading = pending;
    assert.ok(reading);
    assert.equal(page.status, "response_page");
    assert.equal(page.unit, "utf8_bytes");
    assert.equal(page.responseRef, reading.ref);
    assert.equal(page.sourceHash, reading.hash);
    assert.equal(count(page.totalBytes), reading.total);
    assert.equal(count(page.start), reading.end);
    const fragment = text(page.text), bytes = Buffer.from(fragment, "utf8"), end = count(page.end);

    assert.equal(bytes.toString("utf8"), fragment, "a page must preserve complete UTF-8 characters");
    assert.equal(end, reading.end + bytes.length);
    assert.ok(end > reading.end && end <= reading.total);
    reading.parts.push(fragment);
    reading.end = end;

    if (end < reading.total) {
      assert.equal(count(page.nextStart), end);
      return { call: central({ operation: "read_response", responseRef: reading.ref, start: end }) };
    }

    assert.equal(page.nextStart, null);
    const complete = reading.parts.join("");
    assert.equal(Buffer.byteLength(complete, "utf8"), reading.total);
    assert.equal(contentHashOf(complete), reading.hash);
    pending = undefined;

    return { result: row(JSON.parse(complete)) };
  };
}

function inspectedIssue(result: Row): Row { return rows(row(result.state).issues)[0]!; }

function focus(result: Row): NextCall {
  assert.equal(result.ok, true, JSON.stringify(result));
  const issue = inspectedIssue(result);
  return tool("collaboration_decide", { inspectionId: text(result.inspectionId), issueId: text(issue.issueId),
    expectedRevision: Number(issue.revision), decision: "focused_learning", reason: "A is supported; the B requirement still needs investigation.", sourceRefs: [] });
}

function applyKnown(stage: Row, humanText = originalRequirement): NextCall {
  assert.equal(stage.status, "apply_known", JSON.stringify(stage));
  const request = row(stage.request), packet: unknown = row(JSON.parse(text(request.materialJson))).packet;

  assert.ok(isContentBatch(packet));
  const source = packet.records.find(record => record.origin === "user_statement" && record.text.includes(humanText));

  assert.ok(source, "semantic output cites the actual normal-session user statement");
  const application: KnownApplicationDraft = { schemaVersion: 1, knowledge: [{ id: "known:A", statement: "The answer is 4 under A.", conditions: "A only",
    citations: [{ evidenceRef: source.ref, quote: "2 + 2 = 4 under A" }] }], applications: [{ id: "apply:A", requirementRefs: [source.ref], answerRefs: [source.ref],
    binding: "The original A condition", result: "4", conditions: "A only", citations: [{ evidenceRef: source.ref, quote: "2 + 2 = 4 under A" }] }],
    relations: [{ id: "question:B", question: "Does the known answer extend to B?", whenRelevant: "The original B requirement", expectedChange: "Use the rule within supported conditions.",
      citations: [{ evidenceRef: source.ref, quote: "whether it extends to B" }] }], preparations: [] };

  return central({ operation: "apply_known", domain: text(stage.domain), stageRef: text(stage.stageRef), inputHash: text(request.inputHash), applicationJson: JSON.stringify(application) });
}

function review(stage: Row, kind: "continue" | "end"): NextCall {
  assert.equal(stage.status, "residual_review", JSON.stringify(stage));
  const request = row(stage.request), material = row(JSON.parse(text(request.materialJson)));

  assert.equal(row(rows(row(material.applied).applications)[0]).result, "4");
  const review: ResidualReviewDraft = { schemaVersion: 1, assessments: [{ relationId: "question:B", disposition: "residual", applicationIds: ["apply:A"], reason: "A does not establish B." }],
    comparisons: [], selectedRelationId: "question:B", recommendation: { kind, reason: kind === "continue"
      ? "The original B requirement remains." : "Return the unsupported B requirement to PA without further investment.", citations: [] } };

  return central({ operation: "residual_review", domain: text(stage.domain), stageRef: text(stage.stageRef), inputHash: text(request.inputHash), reviewJson: JSON.stringify(review) });
}

/** The only substituted boundary is transport. Original tools, content source,
 * admission, models, workers, Board writers and accounting remain mounted. */
async function withNormalHost(run: (fx: {
  readonly boardRoot: string; readonly scope: string; readonly learningRequests: ProviderRequest[];
  turn(next: (request: ProviderRequest, step: number, result?: Row) => NextCall | undefined, humanText?: string): Promise<void>;
}) => Promise<void>) {
  const temporaryRoot = path.resolve(tmpdir()), root = await mkdtemp(path.join(temporaryRoot, "trylo-central-normal-"));
  let ids = 0;
  const ctx: CliContext = { homeDir: root, cwd: root, env: { TRYLO_HOME: path.join(root, "profile") },
    nodeVersion: "v24.0.0", stdinIsTty: false, now: () => at, newId: prefix => `${prefix}-${++ids}`,

    readFile(file) { try { return readFileSync(file, "utf8"); } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    } },

    isDirectory(file) { try { return statSync(file).isDirectory(); } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw error;
    } },

    readDir: () => [], writeFile(file, value) {
      mkdirSync(path.dirname(file), { recursive: true });
      writeFileSync(file, value);
      return true;
    },

    stdout() {}, stderr() {}, readStdin: async () => "", readLine: async () => undefined, readSecret: async () => undefined };
  let closePrepared = async () => {}, preserveFailure = false;

  try {
    const initial = await prepareRun(ctx, { sink: ctx, permissionMode: "non_interactive", options: {
      message: [], readStdin: false, provider: "fixture", session: "central-normal", format: "stream-json",
      centralLearning: { schemaVersion: 2, unit: "total_model_tokens", maxTokens: 100000, maxCalls: 2, maxSteps: 2, maxPromptChars: 100000 } } });

    assert.ok(!isRunFailure(initial), JSON.stringify(initial));
    if (isRunFailure(initial)) throw new Error("normal_preparation_failed");

    let scaffold = initial;

    closePrepared = async () => { try { await scaffold.close(); } finally { await scaffold.execution?.close(); } };
    assert.ok(scaffold.session);
    assert.ok(scaffold.centralLearningContextForIssue);
    const boardRoot = methodBoardRoot(ctx.homeDir, ctx.env), learningRequests: ProviderRequest[] = [];

    await run({ boardRoot, scope: scaffold.workspaceRoot, learningRequests, async turn(next, humanText = originalRequirement) {
      let step = 0, transportOrdinal = 0;
      const receive = responseReader();
      const provider = (): ProviderPort => ({ fork: () => provider(), async *stream(request): AsyncIterable<ProviderEvent> {
        yield { type: "stream_start", providerId: "fixture", model: request.model, warnings: [] };
        const learning = request.messages.some(message => message.role === "system" && message.content.includes("bounded collaboration-learning loop"));
        if (learning) {
          learningRequests.push(request);
          const body = row(JSON.parse(request.messages.find(message => message.role === "user")!.content));
          const refs = row(body.sourceHandles), sourceRef = text(Object.values(refs)[0]);

          assert.ok(text(row(row(body.material).centralContent).text).includes("The answer is 4 under A."));
          yield { type: "text_delta", blockId: "learn", text: JSON.stringify({ kind: "no_change", reason: "The original A evidence does not support a reusable extension to B.", sourceRefs: [sourceRef] }) };
          yield { type: "usage", usage: { mode: "snapshot", inputTokens: 1000, outputTokens: 500, totalTokens: 1500,
            cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0 } };
        } else {
          assert.ok(request.tools.some(binding => binding.name === "central_learning"));
          // read_response adds ordinary transport calls, without consuming a
          // semantic step or altering the actual request/journal tool messages.
          const received = step === 0 ? undefined : receive(lastResult(request));
          const call = received !== undefined && "call" in received ? received.call
            : next(request, step++, received?.result);
          if (call !== undefined) {
            const toolCallId = `${turnId}:normal:${++transportOrdinal}`;
            yield { type: "tool_input_start", toolCallId, name: call.name };
            yield { type: "tool_input_delta", toolCallId, argumentsText: JSON.stringify(call.arguments) };
            yield { type: "tool_input_end", toolCallId };
            yield { type: "finish", reason: "tool_calls", rawReason: "tool_calls", requiresFollowUp: true };
            return;
          }

          yield { type: "text_delta", blockId: "answer", text: "The answer is 4 under A; B remains unsupported." };
        }

        yield { type: "finish", reason: "stop", rawReason: "stop", requiresFollowUp: false };
      } });
      const turnId = ctx.newId("turn");
      const outcome = await executeTurn({ text: humanText, sessionId: scaffold.sessionId, turnId, correlationId: ctx.newId("cor"),
        workspaceRoot: scaffold.workspaceRoot, workspaceId: scaffold.workspaceId, checkpointRoot: scaffold.checkpointRoot,
        providerId: scaffold.providerId, providerKind: scaffold.providerKind, model: scaffold.model, endpoint: scaffold.endpoint, apiKey: scaffold.apiKey,
        session: scaffold.session!, execution: scaffold.execution!, permission: createDenyAllPermission(), format: "stream-json", sink: ctx, now: ctx.now,
        ...(scaffold.resumeTranscript === undefined ? {} : { resumeTranscript: scaffold.resumeTranscript }),
        ...(scaffold.resumeView === undefined ? {} : { resumeView: scaffold.resumeView }),
        ...(scaffold.resumeRecords === undefined ? {} : { resumeRecords: scaffold.resumeRecords }),
        maxIterations: 16, providerGuard: () => provider(),
        collaborationLearning: { homeDir: ctx.homeDir, env: ctx.env },
        centralLearning: centralLearningTurnFactory({ ctx, scaffold, turnId, permissionChoice: {} }) });
      const evidence = path.join(root, `${turnId}.outcome.json`);

      writeFileSync(evidence, JSON.stringify(outcome));

      if (isTurnFailure(outcome)) assert.fail(JSON.stringify({ status: "host_failure", reason: outcome.message, exitCode: outcome.exitCode, evidence }));

      assert.equal(outcome.result.status, "completed", JSON.stringify({ status: outcome.result.status,
        reason: outcome.result.finishReason, exitCode: outcome.exitCode, evidence }));
      const nextScaffold = await scaffoldAfterTurn(scaffold, outcome);

      assert.ok(!isRunFailure(nextScaffold));
      if (isRunFailure(nextScaffold)) throw new Error(nextScaffold.message);

      scaffold = nextScaffold;
    } });
  } catch (error) {
    preserveFailure = true;
    if (error instanceof Error) error.message += `; normal_fixture_evidence=${root}`;
    throw error;
  } finally {
    try { await closePrepared(); } finally {
      assert.equal(path.dirname(path.resolve(root)), temporaryRoot);
      assert.ok(path.basename(root).startsWith("trylo-central-normal-"));
      if (!preserveFailure) await rm(root, { recursive: true, force: true });
    }
  }
}

test("normal PA content stages reach the funded worker and its no-change feedback updates the next actual H prediction and allocation", async () => withNormalHost(async fx => {
  const learnIssue = async (problemKey: string, humanText: string) => {
    let issueId = "";
    const dispatches: Row[] = [];

    await fx.turn((request, step, received) => {
      if (step === 0) return tool("collaboration_report", { problemKey, facts: ["The current handoff requires B; the known answer is supported only under A."], evidenceRefs: [] });

      const result = received ?? lastResult(request);

      if (step === 1) {
        assert.equal(result.ok, true);
        issueId = text(row(result.issue).issueId);
        return tool("collaboration_inspect", { issueId });
      }

      if (step === 2) return focus(result);

      if (step === 3) {
        assert.equal(result.ok, true, JSON.stringify(result));
        return applyKnown(row(result.central), humanText);
      }

      if (step === 4) return review(result, "continue");

      assert.equal(step, 5);
      assert.equal(row(result.content).status, "published");
      const dispatch = row(result.central);
      assert.equal(dispatch.status, "dispatched", JSON.stringify(dispatch));
      assert.equal(row(dispatch.result).status, "completed");
      dispatches.push(dispatch);
      return undefined;
    }, humanText);
    assert.equal(dispatches.length, 1);
    return { issueId, decision: row(dispatches[0]!.decision) };
  };
  const evaluation = (decision: Row, issueId: string) => {
    assert.equal(decision.mode, "stage_objective_pursuit");
    const valuation = row(decision.valuation);
    const selected = rows(valuation.evaluations).find(value => row(row(value.candidate).source).issueId === issueId);
    assert.ok(selected, JSON.stringify(decision));
    return { valuation, selected, prediction: row(selected.prediction), plan: row(valuation.plan) };
  };
  const first = await learnIssue("conditional-rule-handoff", originalRequirement), firstValue = evaluation(first.decision, first.issueId);

  assert.equal(firstValue.prediction.model, "resource_model_average_v1");
  assert.ok(Math.abs(Number(firstValue.prediction.mean) - 0.5) < 1e-12);
  assert.equal(firstValue.prediction.noResult, 0);
  assert.equal(row(firstValue.plan.decision).kind, "offer");
  assert.equal(fx.learningRequests.length, 1);
  const loaded = await createBoardReader(fx.boardRoot).load();
  assert.ok(loaded.ok);
  const grant = loaded.state.centralLearningGrants?.[0];
  assert.ok(grant);
  assert.equal(loaded.state.centralLearningGrants?.length, 1);
  assert.equal(grant.issueId, first.issueId);
  assert.equal(grant.status, "closed");
  assert.ok(grant.budgetId);
  assert.deepEqual(centralLearningSpent(grant), { tokens: 1500, calls: 1, steps: 1 });
  assert.equal(readContentRecords(loaded.state.rewardV2Facts ?? [], fx.scope, loaded.state.sequence).length, 1);
  const observed = readCentralPursuitObservations(loaded.state, fx.scope);
  assert.equal(observed.status, "ready");
  assert.equal(observed.observations.length, 1);
  const observation = observed.observations[0]!;

  assert.equal(observation.outcome, "closed_no_result");
  assert.equal(observation.grantId, grant.grantId);
  assert.ok(readCollaborationNoChange(loaded.state, fx.scope, observation.sourceRef));
  assert.equal(loaded.state.assets.length, 0);
  assert.equal(loaded.state.activations.length, 0);
  const secondRequest = `${originalRequirement} This is another actual handoff under the same A/B conditions; investigate its remaining B requirement.`;
  const second = await learnIssue("conditional-rule-next-handoff", secondRequest), secondValue = evaluation(second.decision, second.issueId);

  assert.notEqual(second.issueId, first.issueId);
  const firstOpportunity = row(row(firstValue.selected.candidate).opportunity), secondOpportunity = row(row(secondValue.selected.candidate).opportunity);

  assert.equal(secondOpportunity.conditionRef, firstOpportunity.conditionRef, "new source instances retain the real reusable owner/host/protocol condition class");
  assert.notEqual(secondOpportunity.sourceRef, firstOpportunity.sourceRef);
  assert.equal(row(row(firstOpportunity.offer).reserve).calls, 2);
  assert.equal(row(row(secondOpportunity.offer).reserve).calls, 1);
  assert.notEqual(row(secondValue.prediction.resourceModel).treatmentRef, row(firstValue.prediction.resourceModel).treatmentRef);
  assert.equal(secondValue.prediction.noResult, 1);
  assert.equal(secondValue.prediction.support, "updated_reference_model");
  // The actual first no_change updates the shared H component. With one real
  // call left, this is a new cap treatment: its separate component stays prior.
  assert.ok(Math.abs(Number(secondValue.prediction.mean) - 0.375) < 1e-12, JSON.stringify(secondValue.prediction));
  assert.equal(row(secondValue.plan.decision).kind, "offer");
  assert.notEqual(secondValue.plan.planId, firstValue.plan.planId);
  assert.ok(Number(secondValue.plan.netPolicyValue) < Number(firstValue.plan.netPolicyValue));
  assert.ok(Math.abs(Number(secondValue.plan.netPolicyValue) - Number(secondValue.prediction.mean)) < 1e-12);
  assert.equal(fx.learningRequests.length, 2);
  const after = await createBoardReader(fx.boardRoot).load();
  assert.ok(after.ok);
  const grants = after.state.centralLearningGrants ?? [];
  assert.equal(grants.length, 2);
  assert.equal(after.state.centralLearningBudgets?.length, 1);
  assert.ok(grants.every(value => value.budgetId === grant.budgetId && value.status === "closed"));
  assert.deepEqual(grants.map(centralLearningSpent), [{ tokens: 1500, calls: 1, steps: 1 }, { tokens: 1500, calls: 1, steps: 1 }]);
  const pool = centralBudgetProjection(after.state, grant.budgetId!);
  assert.ok(pool);
  assert.deepEqual(pool.occupied, { tokens: 3000, calls: 2, steps: 2 });
  assert.equal(pool.available.calls, 0);
  assert.deepEqual(pool.historicalExternalGrantIds, []);
  const nextObserved = readCentralPursuitObservations(after.state, fx.scope);
  assert.equal(nextObserved.status, "ready");
  assert.equal(nextObserved.observations.length, 2);
  assert.ok(nextObserved.observations.every(value => value.outcome === "closed_no_result"));
  assert.equal(readContentRecords(after.state.rewardV2Facts ?? [], fx.scope, after.state.sequence).length, 2);
}));

test("normal resume requests missing content without funding and reopens semantic review for a later user correction", async () => withNormalHost(async fx => {
  let issueId = "", initialStage = "";

  await fx.turn((request, step, received) => {
    if (step === 0) return tool("collaboration_report", { problemKey: "conditional-rule-review", facts: ["Only A is supported and B is still requested."], evidenceRefs: [] });

    const result = received ?? lastResult(request);

    if (step === 1) {
      issueId = text(row(result.issue).issueId);
      return tool("collaboration_inspect", { issueId });
    }

    if (step === 2) return focus(result);

    if (step === 3) {
      initialStage = text(row(result.central).stageRef);
      return central({ operation: "resume" });
    }

    if (step === 4) {
      assert.equal(result.status, "waiting_content", JSON.stringify(result));
      const missing = rows(result.contentRequests)[0]!;
      assert.equal(missing.stageRef, initialStage);
      return applyKnown(missing);
    }

    if (step === 5) return review(result, "end");

    assert.equal(step, 6);
    assert.equal(row(result.content).status, "published");
    assert.equal(result.central, undefined);
    return undefined;
  });
  const beforeFeedback = await createBoardReader(fx.boardRoot).load();
  assert.ok(beforeFeedback.ok);
  assert.equal(beforeFeedback.state.centralLearningGrants?.length ?? 0, 0);
  await fx.turn((request, step, received) => {
    if (step === 0) return tool("collaboration_inspect", { issueId });

    const result = received ?? lastResult(request);

    if (step === 1) {
      const issue = inspectedIssue(result);
      return tool("collaboration_report", { problemKey: "conditional-rule-review", issueId, expectedRevision: Number(issue.revision),
        facts: ["The user correction still requires B; the A-only answer does not satisfy that requirement."], evidenceRefs: [] });
    }

    if (step === 2) {
      assert.equal(result.ok, true);
      return central({ operation: "resume" });
    }

    assert.equal(step, 3);
    assert.equal(result.status, "waiting_content", JSON.stringify(result));
    const admission = rows(result.admissions)[0]!;
    assert.equal(admission.reason, "content_new_issue_reports_require_review");
    const refreshed = rows(result.contentRequests)[0]!;
    assert.equal(refreshed.status, "apply_known");
    assert.notEqual(refreshed.stageRef, initialStage);
    assert.match(text(row(refreshed.request).materialJson), /Correction: I still require B/);
    return undefined;
  }, "Correction: I still require B; the A-only answer does not satisfy it.");
  const loaded = await createBoardReader(fx.boardRoot).load();
  assert.ok(loaded.ok);
  assert.equal(loaded.state.centralLearningGrants?.length ?? 0, 0);
  assert.equal(loaded.state.jobs.length, 0);
  assert.equal(fx.learningRequests.length, 0);
  assert.equal(loaded.state.learningIssues?.find(issue => issue.issueId === issueId)?.reports.length, 2);
}));
