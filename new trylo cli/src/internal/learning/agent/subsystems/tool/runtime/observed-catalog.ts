import type { ToolBinding } from "../../../../../ports/tools.js";
import { bindingHash } from "../../../../../tooling/library/resolution.js";
import type { ToolObservedCapability } from "../domain/awareness/observed-catalog.js";
import type { ToolOpportunityReport } from "../domain/awareness/opportunity.js";
import { retrieveToolReuseCandidates } from "../domain/evolution/reuse-retrieval.js";

/** Copy descriptors already exposed by the host. Never start a server or resolve new capabilities here. */
export function captureObservedCatalog(bindings: readonly ToolBinding[]): readonly ToolObservedCapability[] {
  return bindings.slice(0, 512).filter(binding => binding.name !== "tool_learning_report").map(binding => ({
    tool: binding.name, description: binding.description.slice(0, 700) || binding.name, bindingHash: bindingHash(binding),
    ...(binding.versionId === undefined ? {} : { versionId: binding.versionId }) }));
}

export function selectObservedCatalog(catalog: readonly ToolObservedCapability[], report: ToolOpportunityReport,
  calledTools: readonly string[]): readonly ToolObservedCapability[] {
  const selected = retrieveToolReuseCandidates({ candidates: catalog.map(row => ({ toolId: row.tool, name: row.tool,
    description: row.description, capabilities: [], ...(row.versionId === undefined ? {} : { versionId: row.versionId }) })),
    query: `${report.need} ${report.reason}`, ...(report.tool === undefined ? {} : { target: report.tool }), limit: 24 });
  const priority = [...catalog.filter(row => calledTools.includes(row.tool)), ...selected.flatMap(row => catalog.filter(item => item.tool === row.toolId))];
  return priority.filter((row, index) => priority.findIndex(other => other.tool === row.tool) === index).slice(0, 24);
}
