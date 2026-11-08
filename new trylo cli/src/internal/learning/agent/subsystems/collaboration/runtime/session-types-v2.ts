import type { createCollaborationSubsystemV2 } from "../domain/v2-service.js";
import type { CollaborationEventV2, CollaborationGrantV2, CollaborationSelectionV2, CollaborationV2Context } from "../domain/v2-contracts.js";
import type { SubagentTeam } from "../../../../../subagent/team.js";

export type CollaborationSubsystemV2 = ReturnType<typeof createCollaborationSubsystemV2>;

export type SessionOptionsV2 = {
  readonly subsystem: CollaborationSubsystemV2;
  readonly scope: string;
  readonly team: SubagentTeam;
  readonly turnId: string;
  readonly resolvedModel?: string;
  readonly requestId: string;
  readonly grant: CollaborationGrantV2;
  readonly now: () => string;
  readonly enabled: () => boolean;
  readonly signal?: AbortSignal;
  readonly warn: (reason: string) => void;
  readonly schedule?: import("../../../../../subagent/scheduler.js").TimerScheduler;
};

export type SelectedV2 = Extract<CollaborationSelectionV2, { readonly kind: "selected" }>;

export type ExposureV2 = { readonly selection: SelectedV2; readonly exposureId: string };

export type RuntimeEventInputV2 = {
  readonly terminalMetadata?: boolean;
  readonly id: string;
  readonly context: CollaborationV2Context;
  readonly dimension: CollaborationEventV2["dimension"];
  readonly action: string;
  readonly summary: string;
  readonly evidenceRefs?: readonly string[];
  readonly causedBy?: readonly string[];
  readonly metrics?: CollaborationEventV2["metrics"];
  readonly source?: CollaborationEventV2["source"];
};
