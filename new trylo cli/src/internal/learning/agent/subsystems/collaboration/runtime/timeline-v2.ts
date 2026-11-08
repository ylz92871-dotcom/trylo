import { contentHashOf } from "../../../../control/hash.js";
import type { CollaborationV2Context, CollaborationMetricsV2 } from "../domain/v2-contracts.js";
import type { Envelope } from "../../../../../protocol/envelope.js";
import type { CollaborationRound } from "../../../../../subagent/collaboration.js";
import type { ExposureV2, RuntimeEventInputV2, SessionOptionsV2 } from "./session-types-v2.js";

export function createCollaborationTimelineV2(options: SessionOptionsV2, wake: () => void) {
  const events = new Map<string, string[]>(), references = new Set<string>();
  const adoptions = new Map<string, string[]>();
  const usageSnapshots = new Map<string, number>(), costs = new Map<string, number>(), teamEpisodes = new Set<string>();
  const incompleteCosts = new Set<string>();
  const incompleteCostRef = "runtime:usage_evidence_incomplete";
  let writer = Promise.resolve(), pending = 0;
  const context = (round?: CollaborationRound): CollaborationV2Context => ({ scope: options.scope, teamRunId: options.team.runId,
    taskId: round?.taskId ?? options.team.runId, round: round?.round ?? 1, memberId: round?.memberId ?? "parent", role: round?.role ?? "parent",
    taskFamily: "unknown", dependency: round === undefined ? "unknown"
      : round.dependencies.length > 0 || round.handoff !== undefined ? "artifact" : "independent",
    coordinationMode: "unknown", difficulty: "unknown", taskConditionRefs: [`surface:${options.team.surface ?? "code"}`, `frozen-team:${options.team.runId}`],
    members: options.team.members.map(member => ({ memberId: member.memberId, role: member.baseRole,
      model: member.role.model !== undefined && member.role.model !== "inherit" ? member.role.model : options.resolvedModel ?? "unknown",
      capabilityRefs: [...(member.role.skills ?? []).map(name => `selected-skill:${name}`),
        ...(member.role.allowedTools ?? []).map(name => `configured-tool:${name}`)].slice(0, 32) })) });
  const key = (value: CollaborationV2Context) => contentHashOf([value.teamRunId, value.taskId, value.memberId, value.round]);
  const enqueue = async <T>(operation: () => Promise<T>, terminalMetadata = false): Promise<T | undefined> => {
    if (!options.enabled() || options.signal?.aborted && !terminalMetadata) return undefined;

    if (pending >= 128) {
      options.warn("collaboration_sensor_capacity");
      return undefined;
    }

    pending += 1;
    const previous = writer;
    let release!: () => void;

    writer = new Promise(resolve => { release = resolve; });
    await previous;

    // Facts admitted before execution cancellation remain owned evidence. Privacy
    // withdrawal still wins while queued; no new task body is admitted on abort.
    try { return options.enabled() ? await operation() : undefined; }
    catch {
      options.warn("collaboration_sensor_unavailable");
      return undefined;
    }
    finally {
      pending -= 1;
      release();
    }
  };
  const event = async (input: RuntimeEventInputV2): Promise<string | undefined> => enqueue(async () => {
    const factId = `cv2-event:${contentHashOf([options.scope, input.id])}`;
    const result = await options.subsystem.observe({ schemaVersion: 2, kind: "event", factId, scope: options.scope,
      recordedAt: options.now(), context: input.context, dimension: input.dimension, action: input.action,
      summary: input.summary.slice(0, 1500), source: input.source ?? "runtime", evidenceRefs: [...new Set(input.evidenceRefs ?? [])].slice(0, 32),
      causedBy: [...new Set(input.causedBy ?? [])].slice(0, 32), metrics: input.metrics ?? {} });
    if (!result.ok) {
      options.warn(`collaboration_event:${result.reason}`);
      return undefined;
    }

    const identity = key(input.context), current = events.get(identity) ?? [];
    if (!current.includes(factId)) events.set(identity, [...current, factId].slice(-32));

    if (events.size > 128) events.delete(events.keys().next().value ?? "");

    references.add(factId);
    for (const ref of input.evidenceRefs ?? []) references.add(ref);

    if (references.size > 2048) references.delete(references.values().next().value ?? "");

    if (input.source === "peer_report") wake();

    return factId;
  }, input.terminalMetadata);

  return {
    context, event,
    knownReference: (ref: string) => references.has(ref),
    knownEvent: (ref: string) => [...events.values()].some(ids => ids.includes(ref)),
    async expose(selection: ExposureV2["selection"], requestId: string): Promise<ExposureV2 | undefined> {
      return enqueue(async () => {
        const exposureId = `cv2-exposure:${contentHashOf([selection.selectionId, requestId])}`;
        const result = await options.subsystem.recordReceipt({ schemaVersion: 2, kind: "exposure", factId: exposureId,
          scope: options.scope, recordedAt: options.now(), context: selection.context, selectionId: selection.selectionId,
          versionId: selection.versionId, actionIds: selection.actions.map(action => action.actionId), audience: selection.audience,
          requestId, contentHash: selection.contentHash });
        if (!result.ok) {
          options.warn(`collaboration_exposure:${result.reason}`);
          return undefined;
        }

        return { selection, exposureId };
      });
    },
    async adopt(exposure: ExposureV2 | undefined, actionId: string | undefined, eventId: string | undefined): Promise<void> {
      if (exposure === undefined || actionId === undefined || eventId === undefined) return;
      await enqueue(async () => {
        const factId = `cv2-adoption:${contentHashOf([exposure.exposureId, actionId, eventId])}`;
        const result = await options.subsystem.recordReceipt({ schemaVersion: 2, kind: "adoption", factId,
          scope: options.scope, recordedAt: options.now(), exposureId: exposure.exposureId, actionId, eventIds: [eventId] });
        if (!result.ok) options.warn(`collaboration_adoption:${result.reason}`);
        else {
          const identity = key(exposure.selection.context);
          adoptions.set(identity, [...(adoptions.get(identity) ?? []), factId].slice(-32));
        }
      });
    },
    async usage(value: CollaborationV2Context, streamId: string, totalTokens: number): Promise<void> {
      if (!Number.isSafeInteger(totalTokens) || totalTokens < 0) {
        options.warn("collaboration_usage_invalid");
        return;
      }

      const prior = usageSnapshots.get(streamId);
      if (prior !== undefined && totalTokens <= prior) return;

      usageSnapshots.set(streamId, totalTokens);

      if (usageSnapshots.size > 256) usageSnapshots.delete(usageSnapshots.keys().next().value ?? "");

      const delta = totalTokens - (prior ?? 0);
      const partial = incompleteCosts.has(key(value));
      const id = await event({ id: `${streamId}:usage:${totalTokens}`, context: value, dimension: "assignment", action: "execution_usage", terminalMetadata: true,
        summary: `Canonical merged execution usage reported cumulative=${totalTokens}, prior observed=${prior ?? 0}; the event metric is delta=${delta}, not complete context cost.${partial ? " An earlier usage event was not persisted; this delta cannot establish complete context cost." : " Cumulative snapshots are differenced once per execution instance."}`,
        evidenceRefs: [`usage:${streamId}`, ...(partial ? [incompleteCostRef] : [])], metrics: { tokenCost: delta } });
      if (id !== undefined) costs.set(key(value), (costs.get(key(value)) ?? 0) + delta);
      else incompleteCosts.add(key(value));
    },
    async episode(value: CollaborationV2Context, inputMetrics: CollaborationMetricsV2, includeTeamEpisodes = false, terminalMetadata = false): Promise<void> {
      await enqueue(async () => {
        const identity = key(value), eventIds = events.get(identity) ?? [];
        if (eventIds.length === 0) return;

        const metrics = { ...inputMetrics, ...(costs.has(identity) ? { tokenCost: costs.get(identity)! } : {}) };
        const missingUsage = incompleteCosts.has(identity);
        if (missingUsage) delete metrics.tokenCost;

        const memberEpisodeIds = includeTeamEpisodes ? [...teamEpisodes].slice(-24) : [];
        const episodeId = `cv2-episode:${contentHashOf([options.scope, identity, eventIds])}`;
        const result = await options.subsystem.observe({ schemaVersion: 2, kind: "episode", factId: episodeId,
          scope: options.scope, recordedAt: options.now(), context: value, eventIds, metrics, source: "runtime", evidenceRefs: [...eventIds, ...memberEpisodeIds, ...(missingUsage ? [incompleteCostRef] : [])].slice(-32) });
        if (!result.ok) {
          options.warn(`collaboration_episode:${result.reason}`);
          return;
        }

        teamEpisodes.add(episodeId);
        if (teamEpisodes.size > 64) teamEpisodes.delete(teamEpisodes.values().next().value ?? "");

        const adoptionIds = adoptions.get(identity) ?? [];
        if (adoptionIds.length > 0) await options.subsystem.observe({ schemaVersion: 2, kind: "outcome",
          factId: `cv2-outcome:${contentHashOf([episodeId, adoptionIds])}`, scope: options.scope, recordedAt: options.now(),
          adoptionIds, episodeIds: [episodeId, ...memberEpisodeIds], metrics, source: "runtime", evidenceRefs: [...eventIds, ...(missingUsage ? [incompleteCostRef] : [])].slice(-32) });

        wake();
      }, terminalMetadata);
    },
    capture(envelope: Envelope, round?: CollaborationRound): void {
      if (envelope.kind !== "tool_result") return;

      const id = envelope.payload.toolCallId, status = envelope.payload.status;
      if (typeof id !== "string" || typeof status !== "string") return;

      const value = context(round);
      // Engine event counters are local to a turn, not globally unique evidence ids.
      const eventKey = contentHashOf([key(value), envelope.sessionId ?? null, envelope.turnId ?? null,
        envelope.attemptId ?? null, envelope.producerId, envelope.eventId]);

      void event({ id: eventKey, context: value, dimension: "assignment", action: "tool_result",
        summary: `Execution tool ${id.slice(0, 100)} returned ${status}${typeof envelope.payload.code === "string" ? ` (${envelope.payload.code.slice(0, 200)})` : ""}. This is an execution result, not independent task acceptance.`,
        evidenceRefs: [`tool:${id}`, `execution:${eventKey}`] });
    },
    async flush() { while (pending > 0) await writer; },
  };
}

export type CollaborationTimelineV2 = ReturnType<typeof createCollaborationTimelineV2>;
