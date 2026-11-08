import type { CapabilityKey } from "./capabilities.js";

/**
 * Per-model capability catalog (WP18.1: C70).
 *
 * Reuse: Codex model directory (`core/src/thread_manager.rs:815` models
 * listing; `core/src/tools/spec_plan.rs:1255/:629` capability-driven tool
 * exposure; TUI model popup) and the legacy provider/model layer, narrowed to
 * a Trylo-owned DTO.
 *
 * Why a second vocabulary beside `capabilities.ts`: the closed four
 * (`streaming/reasoning/tools/cancellation`) describe what a *provider entry*
 * may be asked for and are fail-closed by `requireCapability`. A model card
 * describes what one *model* behind that endpoint supports — input modalities,
 * context ceiling, reasoning effort, hosted tool kinds, structured output —
 * so a run sends only what the model can honour. The catalog never widens the
 * closed set; it refines the decision inside it.
 *
 * An empty card list means "not declared", exactly like an empty `models`
 * list: the endpoint decides, and no refusal is invented.
 */

export const INPUT_MODALITIES = ["text", "image", "audio", "video", "pdf"] as const;

export type InputModality = (typeof INPUT_MODALITIES)[number];

export function isInputModality(value: string): value is InputModality {
  return (INPUT_MODALITIES as readonly string[]).includes(value);
}

export const REASONING_EFFORTS = ["none", "low", "medium", "high"] as const;

export type ReasoningEffort = (typeof REASONING_EFFORTS)[number];

export function isReasoningEffort(value: string): value is ReasoningEffort {
  return (REASONING_EFFORTS as readonly string[]).includes(value);
}

/** Hosted tool kinds a model may be offered (Codex `spec_plan` hosted tools). */
export const MODEL_TOOL_KINDS = ["function", "web_search", "code_interpreter", "image_generation"] as const;

export type ModelToolKind = (typeof MODEL_TOOL_KINDS)[number];

export function isModelToolKind(value: string): value is ModelToolKind {
  return (MODEL_TOOL_KINDS as readonly string[]).includes(value);
}

/**
 * One model's declared abilities. Every field besides `id` is optional:
 * absent means "not declared for this model", never a default the run may
 * rely on.
 */
export type ModelCard = {
  readonly id: string;
  readonly displayName?: string;
  readonly inputModalities?: ReadonlyArray<InputModality>;
  readonly contextWindow?: number;
  readonly reasoningEffort?: ReasoningEffort;
  readonly toolKinds?: ReadonlyArray<ModelToolKind>;
  /** Whether the model honours schema-constrained final output (C74/L67). */
  readonly structuredOutput?: boolean;
};

export type ModelCatalog = {
  readonly models: ReadonlyArray<ModelCard>;
};

export function emptyCatalog(): ModelCatalog {
  return { models: [] };
}

/**
 * A catalog built from a declaration's model list: ids only, no abilities.
 *
 * This is the correct integration point in `prepareRun`: a declared model
 * with no card passes every demand (the endpoint decides), and the day a
 * declaration carries rich cards the same gate refuses without new plumbing.
 * A `--model` override that names nothing declared is *not* refused here —
 * overrides are legitimate — so this constructor only ever sees declared ids.
 */
export function catalogFromDeclaredModels(models: ReadonlyArray<string>): ModelCatalog {
  return { models: models.map((id) => ({ id })) };
}

export function findModel(catalog: ModelCatalog, id: string): ModelCard | undefined {
  return catalog.models.find((card) => card.id === id);
}

export type ModelDemand =
  | { readonly kind: "modality"; readonly modality: InputModality }
  | { readonly kind: "capability"; readonly capability: CapabilityKey }
  | { readonly kind: "structured" }
  | { readonly kind: "toolKind"; readonly toolKind: ModelToolKind };

export type ModelDenial =
  | { readonly code: "unknown_model"; readonly modelId: string; readonly known: ReadonlyArray<string> }
  | { readonly code: "unsupported_modality"; readonly modelId: string; readonly modality: InputModality }
  | { readonly code: "unsupported_capability"; readonly modelId: string; readonly capability: CapabilityKey }
  | { readonly code: "unsupported_structured_output"; readonly modelId: string }
  | { readonly code: "unsupported_tool_kind"; readonly modelId: string; readonly toolKind: ModelToolKind };

/**
 * Demand something of a catalogued model, and be told no when it is not
 * there. Uncatalogued models pass every demand: with no declaration there is
 * nothing to refuse against, and refusing would be the endpoint's own lie told
 * in advance. The caller that needs a guarantee declares the model first.
 */
export function demandModel(
  catalog: ModelCatalog,
  modelId: string,
  demand: ModelDemand,
): { readonly ok: true } | { readonly ok: false; readonly denial: ModelDenial } {
  const card = findModel(catalog, modelId);
  if (card === undefined) {
    return {
      ok: false,
      denial: { code: "unknown_model", modelId, known: catalog.models.map((entry) => entry.id) },
    };
  }

  switch (demand.kind) {
    case "modality":
      if (card.inputModalities !== undefined && !card.inputModalities.includes(demand.modality)) {
        return {
          ok: false,
          denial: { code: "unsupported_modality", modelId, modality: demand.modality },
        };
      }
      return { ok: true };
    case "capability":
      // The closed provider set stays authoritative for streaming/tools/
      // cancellation; the card only narrows reasoning: a model that declares
      // no effort never receives a reasoning channel.
      if (demand.capability === "reasoning" && card.reasoningEffort === "none") {
        return { ok: false, denial: { code: "unsupported_capability", modelId, capability: "reasoning" } };
      }
      return { ok: true };
    case "structured":
      if (card.structuredOutput === false) {
        return { ok: false, denial: { code: "unsupported_structured_output", modelId } };
      }
      return { ok: true };
    case "toolKind":
      if (card.toolKinds !== undefined && !card.toolKinds.includes(demand.toolKind)) {
        return {
          ok: false,
          denial: { code: "unsupported_tool_kind", modelId, toolKind: demand.toolKind },
        };
      }
      return { ok: true };
  }
}

/**
 * Whether a schema may be sent for this model: refused only when the catalog
 * positively says the model cannot honour one. Undeclared stays pass-through;
 * see the module comment for why the absence is not a refusal.
 */
export function demandStructuredSupport(
  catalog: ModelCatalog,
  modelId: string,
): { readonly ok: true } | { readonly ok: false; readonly denial: ModelDenial } {
  const card = findModel(catalog, modelId);
  if (card === undefined) {
    return { ok: true };
  }
  return demandModel(catalog, modelId, { kind: "structured" });
}

const JSON_OBJECT_FORMATS = Object.freeze(["json_object"] as const);
const NO_RESPONSE_FORMATS = Object.freeze([] as const);
const ARK_CHAT_JSON_MODELS: Readonly<Record<string, readonly string[]>> = Object.freeze({
  "https://ark.cn-beijing.volces.com/api/v3/chat/completions": Object.freeze([
    "deepseek-v4-1-flash-261017", "deepseek-v4-1-flash-260910",
  ]),
  "https://ark.cn-beijing.volces.com/api/plan/v3/chat/completions": Object.freeze(["deepseek-v4.1-flash"]),
});

/** Documented Chat JSON mode only, separate from json_schema support.
 * https://console.volcengine.com/ark/region:cn-beijing/docs/model-list (2026-11-02)
 * https://console.volcengine.com/ark/region:cn-beijing/docs/structured-output-beta (2026-10-16)
 * https://console.volcengine.com/ark/region:cn-beijing/docs/agent-plan-personal-zcode (2026-11-04)
 * Plan compatibility is advertised, not a claim of a successful provider probe;
 * an actual refusal remains terminal rather than selecting a paid fallback. */
export function knownChatResponseFormats(endpoint: string, model: string): readonly "json_object"[] {
  try {
    const url = new URL(endpoint), models = ARK_CHAT_JSON_MODELS[url.href];
    return models?.includes(model) === true ? JSON_OBJECT_FORMATS : NO_RESPONSE_FORMATS;
  } catch {
    return NO_RESPONSE_FORMATS; // A malformed connection has no documented format capability.
  }
}
