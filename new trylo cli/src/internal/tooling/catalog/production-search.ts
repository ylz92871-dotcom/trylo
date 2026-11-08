import type {
  BoardActivationView,
  ToolPackageVersion,
  ValidationRecord,
} from "../contract/types.js";
import type { SearchableTool } from "./keyword-score.js";
import { rankTools } from "./keyword-score.js";
import { sanitizeToolDescription } from "./description-guard.js";

export type ProductionSearchInput = {
  readonly packages: readonly ToolPackageVersion[];
  readonly validations: readonly ValidationRecord[];
  readonly activations: readonly BoardActivationView[];
  readonly descriptions: Readonly<Record<string, string>>;
};

export type ProductionTool = SearchableTool & {
  readonly packageVersionId: string;
  readonly origin: ToolPackageVersion["origin"];
};

function passedIndependentVerdict(record: ValidationRecord | undefined): boolean {
  if (record === undefined) {
    return false;
  }
  return record.actor === "verifier" && record.verdict === "pass";
}

function activationAllowsProduction(state: BoardActivationView["state"]): boolean {
  return state === "shadow" || state === "active";
}

export function listProductionTools(input: ProductionSearchInput): ProductionTool[] {
  const validationByPackage = new Map<string, ValidationRecord>();

  for (const record of input.validations) {
    validationByPackage.set(record.packageVersionId, record);
  }

  const activationByPackage = new Map<string, BoardActivationView>();

  for (const activation of input.activations) {
    activationByPackage.set(activation.packageVersionId, activation);
  }

  const visible: ProductionTool[] = [];

  for (const pkg of input.packages) {
    if (pkg.catalogState !== "verified" && pkg.catalogState !== "awaiting_activation_approval") {
      continue;
    }

    // Catalog admission, an independent verdict and activation must all agree.
    const validation = validationByPackage.get(pkg.packageVersionId);
    if (!passedIndependentVerdict(validation)) {
      continue;
    }

    const activation = activationByPackage.get(pkg.packageVersionId);
    if (activation === undefined || !activationAllowsProduction(activation.state)) {
      continue;
    }

    const rawDescription = input.descriptions[pkg.packageVersionId] ?? pkg.identity;
    const guarded = sanitizeToolDescription(rawDescription);
    if (!guarded.ok) {
      continue;
    }

    visible.push({
      packageVersionId: pkg.packageVersionId,
      origin: pkg.origin,
      name: pkg.identity,
      searchHint: pkg.manifest.capabilities.join(" "),
      description: guarded.text,
      shouldDefer: pkg.manifest.shouldDefer,
      alwaysLoad: pkg.manifest.alwaysLoad,
    });
  }

  return visible;
}

export function searchProductionTools(
  query: string,
  input: ProductionSearchInput,
): ProductionTool[] {
  const visible = listProductionTools(input);
  const ranked = rankTools(query, visible);

  return ranked.map((tool) => {
    const match = visible.find((item) => item.name === tool.name);
    if (match === undefined) {
      throw new Error("ranked tool missing from production set");
    }
    return match;
  });
}

export type DeferredAssembly = {
  readonly alwaysLoaded: readonly ProductionTool[];
  readonly deferredNames: readonly string[];
  readonly schemasSent: readonly string[];
};

export function assembleDeferredContext(tools: readonly ProductionTool[]): DeferredAssembly {
  // Deferred names are advertised here; their schemas are loaded separately.
  const alwaysLoaded = tools.filter((tool) => tool.alwaysLoad || !tool.shouldDefer);
  const deferred = tools.filter((tool) => tool.shouldDefer && !tool.alwaysLoad);

  return {
    alwaysLoaded,
    deferredNames: deferred.map((tool) => tool.name),
    schemasSent: alwaysLoaded.map((tool) => tool.name),
  };
}

export function schemaNotSentHint(toolName: string, assembled: DeferredAssembly): string | undefined {
  if (assembled.deferredNames.includes(toolName) && !assembled.schemasSent.includes(toolName)) {
    return `schema for ${toolName} was not sent; ToolSearch select:${toolName} first`;
  }
  return undefined;
}
