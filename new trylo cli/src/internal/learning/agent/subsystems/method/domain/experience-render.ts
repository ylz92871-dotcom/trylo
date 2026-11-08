import { renderCompiledProcedure, type CompiledProcedure } from "./procedure.js";

type CompilationContent = {
  readonly compact: { readonly when: string; readonly action: string; readonly exceptions: string };
  readonly procedure?: CompiledProcedure;
};

/** Leaves room in the existing 1200-character slot for the reference, feedback
 * protocol and adoption instruction. The full delivered message is also metered. */
export const MAX_COMPILED_EXPERIENCE_CHARS = 550;

export function renderExperience(content: CompilationContent): string {
  const compact = content.compact;
  return content.procedure === undefined ?
    `[稳定经验 兼容表达] 条件:${compact.when}；做法:${compact.action}；例外:${compact.exceptions}` :
    `[过程经验 可撤销默认起点] 条件:${compact.when}；例外:${compact.exceptions}\n${renderCompiledProcedure(content.procedure)}`;
}

export function compilationDeliveryError(content: CompilationContent): string | undefined {
  return content.procedure !== undefined && renderExperience(content).length > MAX_COMPILED_EXPERIENCE_CHARS
    ? "method_compilation_slot_limit" : undefined;
}
