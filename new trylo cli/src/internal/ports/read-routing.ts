/** Routing may choose only these two existing readers; it grants no file access. */
export type ReadRoutingPath = "whole" | "stream";

export type ReadRoutingConditions = {
  /** -1 means stat was unavailable: the existing path runs without policy adoption. */
  readonly fileBytes: number;
  readonly range: "bounded" | "all";
  readonly streaming: boolean;
};

export type ReadRoutingDecision = {
  readonly path: ReadRoutingPath;
  readonly reason: string;
  readonly versionId?: string;
};

export type ReadRoutingRecord = {
  readonly executionId: string;
  readonly conditions: ReadRoutingConditions;
  readonly decision: ReadRoutingDecision;
  readonly actualPath: ReadRoutingPath;
  readonly outcome: "completed" | "failed" | "cancelled";
  /** Actual input bytes consumed across attempts; whole-text compatibility counts UTF-8 decoded bytes. */
  readonly bytesRead: number;
  readonly latencyMs: number;
  readonly fallbackReason?: string;
};

export type ReadRoutingTrial = {
  readonly quality: "pass" | "fail" | "unknown";
  readonly path: ReadRoutingPath;
  readonly executed: boolean;
  readonly bytesRead: number;
  readonly latencyMs: number;
  readonly totalBytesRead: number;
  readonly totalLatencyMs: number;
  readonly proofRef: string;
  readonly reason?: string;
};

/** A task-local, ephemeral capability. It contains no executable strategy from a learned asset. */
export type ReadRoutingOpportunity = {
  readonly executionId: string;
  readonly conditions: ReadRoutingConditions;
  /** Conservative three-read reservation including one Node stream chunk of growth per read. */
  readonly requiredBytes: number;
  trial(path: ReadRoutingPath, signal: AbortSignal): Promise<ReadRoutingTrial>;
};

/** Runtime binds the execution identity to its session/turn and honors collection policy. */
export type ReadRoutingPort = {
  /** Synchronous cache only; no experiment or persistent write belongs on this callback. */
  offer?(opportunity: ReadRoutingOpportunity): void;
  choose(input: {
    readonly executionId: string;
    readonly conditions: ReadRoutingConditions;
    readonly signal: AbortSignal;
  }): Promise<ReadRoutingDecision>;
  record(input: ReadRoutingRecord, signal: AbortSignal): Promise<void>;
};
