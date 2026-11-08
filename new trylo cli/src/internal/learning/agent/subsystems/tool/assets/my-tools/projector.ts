import type {
  BoardActivationView,
  MyToolsEntry,
  ToolingEvent,
  ToolPackageVersion,
  ValidationRecord,
} from "../../../../../../tooling/contract/types.js";

export type ContributionStatus = "none" | "prepared" | "awaiting_review";

export type ProjectorInput = {
  readonly packages: readonly ToolPackageVersion[];
  readonly validations: readonly ValidationRecord[];
  readonly activations: readonly BoardActivationView[];
  readonly contributionByPackage: Readonly<Record<string, ContributionStatus>>;
  readonly healthByPackage?: Readonly<Record<string, "healthy" | "degraded" | "unknown">>;
  readonly effectByPackage?: Readonly<Record<string, "improved" | "regressed" | "unknown">>;
};

export function eventsFromSnapshot(input: ProjectorInput): readonly ToolingEvent[] {
  const events: ToolingEvent[] = [];
  let sequence = 1;

  for (const pkg of input.packages) {
    events.push({ kind: "package_recorded", sequence, pkg });
    sequence += 1;
  }

  for (const record of input.validations) {
    events.push({ kind: "validation_recorded", sequence, record });
    sequence += 1;
  }

  for (const [packageVersionId, status] of Object.entries(input.contributionByPackage)) {
    events.push({ kind: "contribution_recorded", sequence, packageVersionId, status });
    sequence += 1;
  }

  if (input.healthByPackage !== undefined) {
    for (const [packageVersionId, health] of Object.entries(input.healthByPackage)) {
      events.push({ kind: "health_recorded", sequence, packageVersionId, health });
      sequence += 1;
    }
  }

  if (input.effectByPackage !== undefined) {
    for (const [packageVersionId, effect] of Object.entries(input.effectByPackage)) {
      events.push({ kind: "effect_recorded", sequence, packageVersionId, effect });
      sequence += 1;
    }
  }

  return events;
}

export function projectFromEvents(
  events: readonly ToolingEvent[],
  activations: readonly BoardActivationView[],
): readonly MyToolsEntry[] {
  const packages = new Map<string, ToolPackageVersion>();
  const validations = new Map<string, ValidationRecord>();
  const contributions = new Map<string, ContributionStatus>();
  const health = new Map<string, "healthy" | "degraded" | "unknown">();
  const effects = new Map<string, "improved" | "regressed" | "unknown">();

  for (const event of events) {
    switch (event.kind) {
      case "package_recorded":
        packages.set(event.pkg.packageVersionId, event.pkg);
        break;
      case "validation_recorded":
        validations.set(event.record.packageVersionId, event.record);
        break;
      case "contribution_recorded":
        contributions.set(event.packageVersionId, event.status);
        break;
      case "health_recorded":
        health.set(event.packageVersionId, event.health);
        break;
      case "effect_recorded":
        effects.set(event.packageVersionId, event.effect);
        break;
      case "ui_command_emitted":
        break;
    }
  }

  return [...packages.values()].map((pkg) => {
    const activation = activations.find((item) => item.packageVersionId === pkg.packageVersionId);
    const validation = validations.get(pkg.packageVersionId);
    const previous = pkg.provenance.parentVersionId;
    const observedHealth = health.get(pkg.packageVersionId);
    const observedEffect = effects.get(pkg.packageVersionId);
    const verified =
      validation?.verdict === "pass" &&
      validation.actor === "verifier" &&
      pkg.catalogState !== "rejected";
    const entry: MyToolsEntry = {
      identity: pkg.identity,
      packageVersionId: pkg.packageVersionId,
      version: pkg.version,
      origin: pkg.origin,
      sourceUrl: pkg.provenance.sourceUrl,
      upstreamUrl: pkg.provenance.upstreamUrl,
      commit: pkg.provenance.commit,
      licenseSpdx: pkg.licenseSpdx,
      lifecycle: activation?.state ?? pkg.catalogState,
      capabilities: verified ? pkg.manifest.capabilities : [],
      permissionNeeds: verified ? pkg.manifest.permissions : [],
      rollbackAvailable: previous !== undefined,
      contributionBundleStatus: contributions.get(pkg.packageVersionId) ?? "none",
    };

    return {
      ...entry,
      ...(activation !== undefined ? { scopeBinding: activation.scope } : {}),
      ...(validation !== undefined ? { lastValidation: validation.verdict } : {}),
      ...(observedHealth !== undefined ? { health: observedHealth } : {}),
      ...(observedEffect !== undefined ? { effect: observedEffect } : {}),
      ...(previous !== undefined ? { previousVersionId: previous } : {}),
    };
  });
}

export function projectMyTools(input: ProjectorInput): readonly MyToolsEntry[] {
  return projectFromEvents(eventsFromSnapshot(input), input.activations);
}

export function myToolsWritableKeys(entry: MyToolsEntry): readonly string[] {
  return Object.keys(entry);
}
