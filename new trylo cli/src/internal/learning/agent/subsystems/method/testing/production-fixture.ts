import { testScratchPath } from "../../../../../testing/scratch.js";
import assert from "node:assert/strict";
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { wirePorts } from "../../../../../surface/cli/wiring.js";
import { methodBoardRoot } from "../../../../../surface/cli/learning-sink.js";
import { createFakePermission } from "../../../../../loop/fakes.js";
import { runTurn, type RunTurnResult } from "../../../../../loop/runner.js";
import type { ProviderEvent, ProviderPort, ProviderRequest } from "../../../../../ports/provider.js";
import { emptyUsage } from "../../../../../ports/provider.js";
import type { JsonObject } from "../../../../../protocol/envelope.js";
import { createBoardReader } from "../../../../../adapters/learning-store/file-event-store.js";
import { createMethodBoardWriter } from "../adapters/board-writer.js";
import type { MethodCard } from "../domain/contracts.js";
import { nicheOf } from "../domain/niche.js";
import { experienceSourceOf } from "../domain/experience-source.js";
import type { ExperienceReview, ExperienceReviewRequest } from "../experience-port.js";
import { procedureFixture } from "./procedure-fixture.js";

/** Engineering acceptance only: scripted provider, actual host/tools/Board/feedback/central quota. */
const AT_MS = 1793678400000;
const AT = new Date(AT_MS).toISOString();
const VERSION = "production-index-method";
const ORIGINAL = "For schema-v1 keyed JSON, read data/{key}.json directly. If absent, consult index.json and read its mapped path. Ignore README unless schema unknown.";
const COMPACT = { when: "schema-v1 keyed JSON", action: "Read data/{key}.json directly.", exceptions: "Unknown schema: inspect first." };
const REPAIRED = { ...COMPACT, exceptions: "If direct file is absent, read index.json and its mapped path." };
const CARD: MethodCard = { schemaVersion: 1, hint: ORIGINAL, appliesWhen: { tools: ["read_file"] },
  labels: ["containment"], family: "containment", lineage: { createdFrom: { turnId: "origin", beat: 1, reason: "containment" } } };

type Fixture = { readonly root: string; readonly workspace: string; readonly home: string; readonly board: string };

type Metrics = { readonly label: string; readonly requests: number; readonly promptChars: number;
  readonly reviewPromptChars: number; readonly readPaths: readonly string[]; readonly answer: string;
  readonly stable: boolean; readonly reviewDecisions: readonly string[] };

type Mode = "ordinary" | "outside" | "block";

type RunOptions = { readonly learning?: boolean; readonly mode?: Mode; readonly review?: "defer" | "promote" | "expression" };

const FIXTURE_PARENT = testScratchPath("method-production-runs");

function fixture(): Fixture {
  mkdirSync(FIXTURE_PARENT, { recursive: true });
  const root = mkdtempSync(path.join(FIXTURE_PARENT, "trylo-method-production-"));
  const workspace = path.join(root, "workspace"), home = path.join(root, "home");

  mkdirSync(path.join(workspace, "data"), { recursive: true });
  mkdirSync(path.join(workspace, "moved"), { recursive: true });
  mkdirSync(home, { recursive: true });
  writeFileSync(path.join(workspace, "README.md"), "The schema-v1 dataset stores keyed JSON documents. Consult index.json for the current path.\n" + "Background on document discovery, schema history, and nonessential alternatives.\n".repeat(80));
  const entries = Object.fromEntries(Array.from({ length: 16 }, (_, index) => [`k${index + 1}`, `data/k${index + 1}.json`]));

  writeFileSync(path.join(workspace, "index.json"), JSON.stringify({ schema: "v1", entries, notes: "Index metadata and provenance. ".repeat(100) }));

  for (let index = 1; index <= 16; index += 1) writeFileSync(path.join(workspace, "data", `k${index}.json`), JSON.stringify({ key: `k${index}`, value: index * 17 }));

  return { root, workspace, home, board: methodBoardRoot(home, { TRYLO_HOME: home }) };
}

async function seed(fx: Fixture) {
  const result = await createMethodBoardWriter(fx.board).commitCard({ card: CARD, nicheId: nicheOf(CARD),
    versionId: VERSION, proposalId: "production-proposal", evidenceId: "production-origin", writeId: "production-origin",
    sample: "schema-v1 known-key lookup", observedAt: AT });
  assert.ok(result.ok, JSON.stringify(result));
}

type ResponseContent = string | { readonly name: string; readonly arguments: JsonObject };

function events(request: ProviderRequest, content: ResponseContent, ordinal = 0): ProviderEvent[] {
  const result: ProviderEvent[] = [{ type: "stream_start", providerId: "scripted-contract", model: request.model, warnings: [] }];

  if (typeof content === "string") result.push({ type: "text_start", blockId: "answer" },
    { type: "text_delta", blockId: "answer", text: content }, { type: "text_end", blockId: "answer" });
  else result.push({ type: "tool_call", toolCallId: `call-${request.attemptId}-${ordinal}`, name: content.name, arguments: content.arguments });

  const inputTokens = Math.ceil(JSON.stringify({ messages: request.messages, tools: request.tools }).length / 4), outputTokens = Math.ceil(JSON.stringify(content).length / 4);

  result.push({ type: "usage", usage: { ...emptyUsage(), inputTokens, outputTokens, totalTokens: inputTokens + outputTokens } },
    { type: "finish", reason: typeof content === "string" ? "stop" : "tool_calls",
      rawReason: typeof content === "string" ? "stop" : "tool_calls", requiresFollowUp: typeof content !== "string" });

  return result;
}

function scriptProvider(key: string, options: RunOptions, requests: ProviderRequest[], reviews: ExperienceReviewRequest[], reviewRequests: ProviderRequest[]) {
  let stage = 0, versionId = "", scopeId = "", features: JsonObject = {}, selected = false, blocked = false;
  let paths: string[] = [], readIndex = 0;
  const call = (operation: string, extra: JsonObject = {}) => ({ name: "method_context", arguments: { operation, ...extra } });
  const provider: ProviderPort = {
    fork: () => ({ async *stream(request) {
      reviewRequests.push(request);
      const material = JSON.parse(request.messages.find(message => message.role === "user")!.content) as ExperienceReviewRequest;

      reviews.push(material);
      const decision = options.review ?? "promote";
      const review: ExperienceReview = { decision, score: decision === "defer" ? .35 : .93,
        reason: decision === "expression" ? "Restore the original missing-file fallback omitted by compilation." : "Scripted engineering contract decision; no empirical calibration claim.",
        sources: [material.versionId], ...(decision === "defer" ? {} : { compact: decision === "expression" ? REPAIRED : COMPACT,
          procedure: procedureFixture(material, decision === "expression" ? "Read index.json and its mapped path if direct file is absent." : COMPACT.action,
            "schema-v1 keyed JSON", "JSON key and current task key match") }) };

      yield* events(request, JSON.stringify(review));
    } }),
    async *stream(request) {
      requests.push(request);
      const respond = (content: ResponseContent) => events(request, content, requests.length);
      const hasHook = request.tools.some(tool => tool.name === "method_context");
      const text = request.messages.map(message => message.content).join("\n");
      if (text.includes("[过程经验 可撤销默认起点]")) assert.equal(text.includes(ORIGINAL), false,
        "normal stable planning must replace the original method body, rather than append its summary");

      if (stage === 0 && hasHook) {
        const catalogLine = text.split("\n").find(line => line.startsWith('{"versionId":'));

        assert.ok(catalogLine, "normal planning request must contain the scope catalog before exploration");
        const catalog = JSON.parse(catalogLine) as { versionId: string; scopeId: string; predicate: { all: { feature: string; value: string }[] } };

        versionId = catalog.versionId;
        scopeId = catalog.scopeId;
        features = options.mode === "outside" ? {} : Object.fromEntries(catalog.predicate.all.map(item => [item.feature, item.value]));
        stage = 1;
        yield* respond(call("context", { situation: options.mode === "outside" ? "CSV import outside JSON scope" : "Read one keyed schema-v1 JSON value", opportunityId: "lookup", features }));

        return;
      }

      if (stage === 1) {
        const response = request.messages.filter(message => message.role === "tool").at(-1)!;
        const output = JSON.parse(response.content) as { selected: { versionId: string; scopeId: string }[] };
        selected = output.selected.length > 0;
        stage = 2;
        if (selected) {
          yield* respond(call("adopt", { versionId, scopeId, reason: "Use the supplied method as the initial plan before exploration." }));
          return;
        }
      }

      if (stage <= 2) {
        const repaired = text.includes(REPAIRED.exceptions);
        paths = selected ? (options.mode === "block" && repaired ? ["index.json", `moved/${key}.json`] : [`data/${key}.json`])
          : ["README.md", "index.json", `data/${key}.json`];
        stage = 3;
      }

      if (options.mode === "block" && selected && !blocked && readIndex > 0 && !text.includes(REPAIRED.exceptions)) {
        blocked = true;
        yield* respond(call("block", { versionId, scopeId, reason: "Compiled text omitted the source method's missing-file fallback.", step: "s1", facts: "read_file data/key.json returned file_not_found after relocation" }));
        return;
      }

      if (blocked && stage === 3) {
        stage = 4;
        yield* respond(call("context", { situation: "Resume the same lookup after a method blockage", opportunityId: "lookup", features }));
        return;
      }

      if (stage === 4) {
        const response = JSON.parse(request.messages.filter(message => message.role === "tool").at(-1)!.content) as { selected: unknown[] };
        assert.deepEqual(response.selected, [], "the blocked version must not return during this task");
        paths = ["index.json", `moved/${key}.json`];
        readIndex = 0;
        stage = 5;
      }

      if (readIndex < paths.length) {
        yield* respond({ name: "read_file", arguments: { path: paths[readIndex++]! } });
        return;
      }

      const read = request.messages.filter(message => message.role === "tool").at(-1)!.content;
      const value = /"value"\s*:\s*(\d+)/.exec(read)?.[1];

      assert.ok(value, "final answer must be grounded in a successful actual read_file output");
      const feedback = selected && !blocked ? '\n```trylo-method-feedback\n{"items":[{"ref":"m1","helped":true}]}\n```' : "";

      yield* respond(`value=${value}${feedback}`);
    },
  };

  return provider;
}

async function run(fx: Fixture, label: string, key: string, options: RunOptions = {}): Promise<{ result: RunTurnResult; metrics: Metrics }> {
  const requests: ProviderRequest[] = [], reviews: ExperienceReviewRequest[] = [], reviewRequests: ProviderRequest[] = [];
  const provider = scriptProvider(key, options, requests, reviews, reviewRequests);
  const tracedProvider: ProviderPort = { ...provider, stream(request, signal) {
    appendFileSync(path.join(fx.root, `trace-${label}.ndjson`), JSON.stringify({ attemptId: request.attemptId,
      toolMessages: request.messages.filter(message => message.role === "tool").map(message => message.content),
      toolNames: request.tools.map(tool => tool.name) }) + "\n");
    return provider.stream(request, signal);
  } };
  const learning = options.learning !== false;
  const wiring = wirePorts({ providerId: "fixture", model: "contract-model", endpoint: "", apiKey: undefined,
    workspaceRoot: fx.workspace, turnId: label, nowMs: AT_MS, permission: createFakePermission("approved"),
    providerGuard: () => tracedProvider, toolSelection: ["read_file", ...(learning ? ["method_context"] : [])],
    ...(learning ? { learning: { switch: "method", homeDir: fx.home, env: { TRYLO_HOME: fx.home }, emit: () => {} } } : {}) });

  assert.ok(!("code" in wiring));
  let result: RunTurnResult;

  try {
    result = await runTurn(wiring.ports, { sessionId: `session-${label}`, turnId: label, correlationId: `origin-${label}`,
      text: `Read the exact numeric value for ${key} in this schema-v1 dataset.`, model: "contract-model",
      budget: { maxIterations: 12 }, cancelSignal: AbortSignal.timeout(30000) });
  } finally { await wiring.close(); }

  const answer = result.transcript.filter(item => item.kind === "assistant_text").map(item => item.text).join("").trim();

  assert.equal(answer, `value=${Number(key.slice(1)) * 17}`, JSON.stringify(result.state));
  const reads = result.transcript.flatMap(item => item.kind === "tool_call" && item.name === "read_file" ? [String(item.arguments.path)] : []);
  const reviewDecisions = reviews.map(review => review.repair === undefined ? options.review ?? "promote" : "expression");
  const promptChars = (items: readonly ProviderRequest[]) => items.reduce((sum, request) => sum + JSON.stringify({ messages: request.messages, tools: request.tools }).length, 0);

  return { result, metrics: { label, requests: requests.length, promptChars: promptChars(requests), reviewPromptChars: promptChars(reviewRequests),
    readPaths: reads, answer, stable: requests.some(request => request.messages.some(message => message.content.includes("[过程经验 可撤销默认起点]"))), reviewDecisions } };
}

async function source(fx: Fixture) {
  const loaded = await createBoardReader(fx.board).load();
  assert.ok(loaded.ok);
  return experienceSourceOf(loaded.state);
}


export function cleanupFixture(fx: Fixture): void {
  assert.equal(path.dirname(fx.root), FIXTURE_PARENT);
  rmSync(fx.root, { recursive: true, force: true });
}

export { fixture, seed, run, source, VERSION, ORIGINAL, COMPACT, REPAIRED };
export type { Fixture, Metrics, RunOptions };
