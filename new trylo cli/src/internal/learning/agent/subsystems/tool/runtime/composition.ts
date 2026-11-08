import { createBoardReader } from "../../../../../adapters/learning-store/file-event-store.js";
import { checkJsonFunctionSource } from "../../../../../adapters/tool-evolution/json-function-policy.js";
import type { BoardState } from "../../../../control/state.js";
import type { ToolEvolutionRequest } from "../domain/evolution/contracts.js";
import { compileToolComposition } from "../domain/evolution/composition.js";
import { parseToolEvolutionRequest, parseToolRuntimeDescriptor } from "../domain/evolution/parse.js";
import { candidateFromBoard } from "./evolution-reader.js";
import { acceptToolEvolutionCandidate, type ToolEvolutionRuntimeOptions, type ToolEvolutionOutcome } from "./evolution-runtime.js";

/** Board is the only source authority. Candidate reuse is not production approval of this derived version. */
export function compositionFromBoard(state: BoardState, request: ToolEvolutionRequest, descriptor: unknown) {
  const parsedDescriptor = parseToolRuntimeDescriptor(descriptor);
  if (!parsedDescriptor.ok) return parsedDescriptor;

  if (request.composition === undefined) return { ok: false as const, code: "composition_required", message: "request has no composition plan" };

  const components: { readonly versionId: string; readonly source: string }[] = [];

  for (const versionId of new Set(request.composition.steps.map(step => step.versionId))) {
    const selected = candidateFromBoard(state, versionId);
    if (!selected.ok) return selected;
    if (selected.artifact.request.scope !== request.scope) return { ok: false as const, code: "composition_scope_mismatch", message: "component and derived tool must share the same scope" };
    if (!checkJsonFunctionSource(selected.artifact.candidate.source).ok) return { ok: false as const, code: "composition_profile_unsupported", message: "only admitted confined JSON function sources can be statically composed" };
    components.push({ versionId, source: selected.artifact.candidate.source });
  }

  const compiled = compileToolComposition(request.composition, parsedDescriptor.value, components);
  if (compiled.ok && !checkJsonFunctionSource(compiled.value.source).ok) return { ok: false as const, code: "composition_profile_unsupported", message: "compiled dataflow must preserve the confined JSON profile" };

  return compiled;
}

export async function prepareToolComposition(boardRoot: string, raw: unknown, descriptor: unknown) {
  const request = parseToolEvolutionRequest(raw);
  if (!request.ok) return request;
  const loaded = await createBoardReader(boardRoot).load();
  if (!loaded.ok) return { ok: false as const, code: loaded.reason, message: loaded.detail };
  const compiled = compositionFromBoard(loaded.state, request.value, descriptor);
  return compiled.ok ? { ok: true as const, request: request.value, candidate: compiled.value } : compiled;
}

/** No model call is needed after choosing the dataflow. Fresh checks and normal archive/approval gates still apply. */
export function createToolCompositionRuntime(options: Omit<ToolEvolutionRuntimeOptions, "runner"> & { readonly boardRoot: string }) {
  return {
    async compose(raw: unknown, descriptor: unknown, signal: AbortSignal): Promise<ToolEvolutionOutcome> {
      if (signal.aborted) return { kind: "cancelled", attempts: 0 };
      const prepared = await prepareToolComposition(options.boardRoot, raw, descriptor);
      if (!prepared.ok) return { kind: "failed", code: prepared.code, message: prepared.message, attempts: 0 };
      return acceptToolEvolutionCandidate(options, prepared.request, prepared.candidate, signal, 0);
    },
  };
}
