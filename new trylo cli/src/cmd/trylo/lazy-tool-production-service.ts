import type { ToolProductionPort } from "../../internal/ports/tool-production.js";

/** Capability discovery stays synchronous; only actual use loads the checker. */
export function lazyToolProductionService(load: () => Promise<Required<ToolProductionPort>>): Required<ToolProductionPort> {
  let loading: Promise<Required<ToolProductionPort>> | undefined;
  const service = () => loading ??= load();

  return {
    authority: { verify: async (...args) => (await service()).authority.verify(...args) },
    check: async (...args) => (await service()).check(...args),
    execute: async (...args) => (await service()).execute(...args),
    inspectInstallation: async (...args) => (await service()).inspectInstallation(...args),
  };
}
