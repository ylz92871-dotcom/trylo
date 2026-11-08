import assert from "node:assert/strict";
import type { CentralDeliberationRequest, CentralLearningIntentDraft, CentralLearningOperation } from "../../learning/central/runtime/contracts.js";
import type { JsonObject } from "../../protocol/envelope.js";
import type { ProviderEvent, ProviderUsage } from "../../ports/provider.js";
import type { CentralLearningChange } from "./change-contract.js";
import { CENTRAL_LEARNING_CHANGE_TOOL } from "./change-contract.js";
import type { CentralInputPresentedMaterial } from "./change-input-render.js";
import { createCentralLearningChangeView } from "./change-prompt.js";
import { centralLearningChangeSchema } from "./change-schema.js";

/** Test-only access to what the fake provider actually received. Never converts
 * a complete canonical agenda into an implicitly accepted legacy response. */
export interface LearningChangeTestView {
  readonly role: "central_learning_public_input";
  readonly checkpoint: string;
  readonly current: CentralLearningOperation;
  readonly agenda: readonly { readonly intentId: string; readonly goal: string;
    readonly continuation: CentralLearningIntentDraft["continuation"] }[];
  readonly opportunities: readonly { readonly handle: string; readonly description: string }[];
  readonly materials: readonly CentralInputPresentedMaterial[];
  readonly agendaNavigation?: { readonly entries: readonly { readonly read: { readonly handle: string; readonly address: string } }[];
    readonly next: { readonly handle: string; readonly address: string } | null };
}

interface TestWire {
  readonly messages: readonly { readonly role: string; readonly content: string }[];
  readonly tools: readonly { readonly name?: string; readonly parameters?: unknown;
    readonly function?: { readonly name: string; readonly parameters: unknown } }[];
  readonly response_format?: unknown;
  readonly responseSchema?: unknown;
}

function wireObject(value: unknown): TestWire {
  const wire: unknown = typeof value === "string" ? JSON.parse(value) : value;
  assert.ok(wire && typeof wire === "object" && "messages" in wire && "tools" in wire
    && Array.isArray(wire.messages) && Array.isArray(wire.tools), "actual provider request required");
  return wire as TestWire;
}

export function readLearningChangeWire(value: unknown): LearningChangeTestView {
  const wire = wireObject(value);

  assert.equal(wire.tools.length, 1, "only the advertised learning change tool is allowed");
  const tool = wire.tools[0]!;

  assert.equal(tool.function?.name ?? tool.name, CENTRAL_LEARNING_CHANGE_TOOL);
  assert.equal(wire.response_format, undefined);
  assert.equal(wire.responseSchema, undefined);
  const views = wire.messages.filter(row => row.role === "user").flatMap(row => {
    if (!row.content.startsWith("{")) return [];
    const parsed = JSON.parse(row.content);
    return parsed?.role === "central_learning_public_input" ? [parsed] : [];
  });

  assert.equal(views.length, 1, "the real request must advertise one change input");
  const view: LearningChangeTestView = views[0];

  assert.equal(typeof view.checkpoint, "string");
  assert.ok(view.current);
  assert.ok(Array.isArray(view.agenda) && Array.isArray(view.materials) && Array.isArray(view.opportunities));

  return view;
}

export function learningChangeBody(view: LearningChangeTestView,
  match: string | ((material: CentralInputPresentedMaterial) => boolean)): CentralInputPresentedMaterial {
  const found = view.materials.filter(row => row.delivery === "body" && (typeof match === "string" ? row.text === match : match(row)));
  assert.equal(found.length, 1, "one actually delivered original body must match");
  return found[0]!;
}

export function learningChangeRead(view: LearningChangeTestView, address: string): string {
  const reads = [...view.materials.flatMap(row => row.reads),
    ...(view.agendaNavigation?.entries.map(row => row.read) ?? []),
    ...(view.agendaNavigation?.next == null ? [] : [view.agendaNavigation.next])];
  const handles = [...new Set(reads.filter(row => row.address === address).map(row => row.handle))];
  assert.equal(handles.length, 1, `original read address must be advertised: ${address}`);
  return handles[0]!;
}

export function learningChangeIntent(view: LearningChangeTestView, goal: string): string {
  const found = view.agenda.filter(row => row.goal === goal);
  assert.equal(found.length, 1, `one current purpose must match: ${goal}`);
  return found[0]!.intentId;
}

function organizationCapability(view: LearningChangeTestView, kind: "feedback" | "knowledge", factId: string): string {
  const handles = [...new Set(view.materials.flatMap(row => row.capabilities)
    .filter(row => row.kind === kind && row.factId === factId).map(row => row.handle))];
  assert.equal(handles.length, 1, `one actually delivered ${kind} capability must match: ${factId}`);
  return handles[0]!;
}

export const learningChangeFeedback = (view: LearningChangeTestView, factId: string): string => organizationCapability(view, "feedback", factId);
export const learningChangeKnowledge = (view: LearningChangeTestView, factId: string): string => organizationCapability(view, "knowledge", factId);

export function assertLearningChangeWireMatches(value: unknown, request: CentralDeliberationRequest): LearningChangeTestView {
  const wire = wireObject(value), view = readLearningChangeWire(value), expected = createCentralLearningChangeView(request);
  assert.deepEqual(view, expected.view, "actual wire must carry the prepared request's exact change projection");
  const tool = wire.tools[0]!;
  assert.deepEqual(tool.function?.parameters ?? tool.parameters, centralLearningChangeSchema(request, expected.dictionary));
  return view;
}

const DEFAULT_USAGE: ProviderUsage = { mode: "snapshot", inputTokens: 90, outputTokens: 70, totalTokens: 160,
  cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0 };

export function learningChangeResponse(change: CentralLearningChange, usage: ProviderUsage | "unknown" = DEFAULT_USAGE): Response {
  const frames: unknown[] = [
    { choices: [{ delta: { tool_calls: [{ index: 0, id: "tool:learning-change", type: "function",
      function: { name: CENTRAL_LEARNING_CHANGE_TOOL, arguments: JSON.stringify(change) } }] }, finish_reason: null }] },
    { choices: [{ delta: {}, finish_reason: "tool_calls" }] },
  ];

  if (usage !== "unknown") frames.push({ choices: [], usage: { prompt_tokens: usage.inputTokens,
    completion_tokens: usage.outputTokens, total_tokens: usage.totalTokens } });

  return new Response(frames.map(frame => `data: ${JSON.stringify(frame)}\n\n`).join("") + "data: [DONE]\n\n",
    { status: 200, headers: { "content-type": "text/event-stream" } });
}

export function learningChangeEvents(change: CentralLearningChange, usage: ProviderUsage = DEFAULT_USAGE): readonly ProviderEvent[] {
  const args: JsonObject = JSON.parse(JSON.stringify(change));
  return [{ type: "tool_input_start", toolCallId: "tool:learning-change", name: CENTRAL_LEARNING_CHANGE_TOOL },
    { type: "tool_call", toolCallId: "tool:learning-change", name: CENTRAL_LEARNING_CHANGE_TOOL, arguments: args },
    { type: "tool_input_end", toolCallId: "tool:learning-change" }, { type: "usage", usage },
    { type: "finish", reason: "tool_calls", rawReason: "tool_calls", requiresFollowUp: false }];
}
