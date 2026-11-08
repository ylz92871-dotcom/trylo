import { canonicalJson, sha256Hex } from "../../../../../control/hash.js";
import type { ToolCompositionPlan, ToolEvolutionCandidate } from "./contracts.js";
import type { ToolRuntimeDescriptor } from "../../../../../../tooling/contract/descriptor.js";
import { parseToolEvolutionCandidate } from "./parse.js";

export type ToolCompositionComponent = { readonly versionId: string; readonly source: string };

/** Static linking keeps the confined JSON execution profile. Nothing resolves a tool name or host capability at runtime. */
export function compileToolComposition(plan: ToolCompositionPlan, descriptor: ToolRuntimeDescriptor, components: readonly ToolCompositionComponent[]) {
  const sourceByVersion = new Map(components.map(component => [component.versionId, component.source]));
  if (plan.steps.some(step => !sourceByVersion.has(step.versionId))) return { ok: false as const, code: "composition_component_missing", message: "each step must bind one immutable source" };

  const sources = [...new Set(plan.steps.map(step => step.versionId))].map(versionId => ({ versionId, source: sourceByVersion.get(versionId)! }));
  const manifest = sources.map(component => ({ versionId: component.versionId, sourceHash: sha256Hex(component.source) }));
  const expressions = sources.map(component => /^\s*module\s*\.\s*exports\s*=\s*([\s\S]+?)\s*;?\s*$/u.exec(component.source)?.[1]);
  if (expressions.some(expression => expression === undefined)) return { ok: false as const, code: "composition_profile_unsupported", message: "components must export a confined function expression" };

  const functions = expressions.map(expression => `(${expression})`);
  const indices = plan.steps.map(step => sources.findIndex(component => component.versionId === step.versionId));
  const source = [
    'module.exports = (() => {',
    `// Trylo static JSON composition v1 ${canonicalJson(manifest)}`,
    `const functions = [${functions.join(",\n")}];`,
    `const plan = ${canonicalJson(plan)};`,
    `const indices = ${JSON.stringify(indices)};`,
    'const fail = code => { throw Object.assign(new Error(code), { code }); };',
    'const clone = value => { if (value === undefined) fail("composition_result_invalid"); return JSON.parse(JSON.stringify(value)); };',
    'function bind(binding, input, results) {',
    '  if (binding.from === "literal") return clone(binding.value);',
    '  if (binding.from === "object") return Object.fromEntries(Object.entries(binding.fields).map(([key, value]) => [key, bind(value, input, results)]));',
    '  let value = binding.from === "input" ? input : results[binding.stepId];',
    '  for (const key of binding.path) {',
    '    if (value === null || typeof value !== "object" || !Object.prototype.hasOwnProperty.call(value, key)) fail("composition_input_missing");',
    '    value = value[key];',
    '  }',
    '  return clone(value);',
    '}',
    'return async function(input) {',
    '  const results = Object.create(null);',
    '  for (let index = 0; index < plan.steps.length; index += 1) {',
    '    const step = plan.steps[index], execute = functions[indices[index]];',
    '    if (typeof execute !== "function") fail("composition_component_invalid");',
    '    results[step.stepId] = clone(await execute(bind(step.input, input, results)));',
    '  }',
    '  return bind(plan.output, input, results);',
    '};',
    '})();',
  ].join("\n");

  return parseToolEvolutionCandidate(JSON.stringify({ ...descriptor, source } satisfies ToolEvolutionCandidate));
}
