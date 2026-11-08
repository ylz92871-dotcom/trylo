import { readFile } from "node:fs/promises";
import path from "node:path";
import type { RecordCollaborationV2Command } from "../../learning/control/commands.js";
import { factPositionsV2 } from "../../learning/domains/collaboration/v2-retention.js";
import { collaborationEvidenceClosureV2 } from "../../learning/domains/collaboration/v2-evidence.js";
import type { CollaborationArchiveQueryV2, CollaborationCycleV2 } from "../../learning/domains/collaboration/v2-contracts.js";
import { isCollaborationPracticeV2, isCollaborationV2Fact } from "../../learning/domains/collaboration/v2-parse.js";
import { isLearningOpportunityV2 } from "../../learning/domains/collaboration/v2-window.js";
import { createBoardReader } from "./file-event-store.js";
import { decodeLog } from "./codec.js";

/** Historical lookup is a read of the SAME Board log, including its explicit hot-compaction payloads. */
export async function readCollaborationV2Archive(root: string, query: CollaborationArchiveQueryV2) {
  if (typeof query.scope !== "string" || !query.scope || [query.factIds, query.versionIds, query.excludeRequestIds].some(ids =>
    ids !== undefined && (!Array.isArray(ids) || ids.length > 256 || ids.some(id => typeof id !== "string" || !id)))) {
    return { ok: false as const, reason: "archive_query_invalid" };
  }
  try {
    const loaded = await createBoardReader(root).load();
    if (!loaded.ok) return loaded;

    const parsed = decodeLog(await readFile(path.join(root, "board-events.ndjson"), "utf8"));
    if (!parsed.ok) return parsed;

    const factsById = new Map((loaded.state.collaborationV2Facts ?? []).map(f => [f.factId, f]));
    const originals = new Map<string, RecordCollaborationV2Command>();

    for (const record of parsed.records) {
      if (record.command.type === "record_collaboration_v2") {
        originals.set(record.command.fact.factId, record.command);
        factsById.set(record.command.fact.factId, record.command.fact);
      }
      if (record.command.type === "rehydrate_collaboration_v2") for (const original of record.command.records) {
        originals.set(original.fact.factId, original);
        factsById.set(original.fact.factId, original.fact);
      }
      for (const event of record.events) if (event.type === "collaboration_v2_compacted") {
        if (!Array.isArray(event.archivedFacts) || !event.archivedFacts.every(isCollaborationV2Fact)) return { ok: false as const, reason: "archive_payload_invalid" };
        for (const fact of event.archivedFacts) factsById.set(fact.factId, fact);
      }
    }

    const positions = factPositionsV2(loaded.state);
    const facts = [...factsById.values()].filter(f => f.scope === query.scope).sort((a, b) => (positions.get(a.factId) ?? 0) - (positions.get(b.factId) ?? 0));
    // Select evidence roots before expanding their transitive relationships.
    const roots = new Set(query.factIds ?? []), cycles = new Map<string, CollaborationCycleV2[]>();

    for (const fact of facts) if (fact.kind === "cycle") cycles.set(fact.cycleId, [...(cycles.get(fact.cycleId) ?? []), fact]);

    if (query.cycleId !== undefined) for (const f of cycles.get(query.cycleId) ?? []) roots.add(f.factId);

    if (query.pending) {
      const heads = [...cycles.values()].flatMap(c => c.at(-1) ?? []).filter(c => !query.excludeRequestIds?.includes(c.requestId));
      const head = heads.find(c => c.phase === "reserved" || c.phase === "running") ?? heads.find(c => c.phase === "waiting_evidence");
      if (head !== undefined) for (const f of cycles.get(head.cycleId) ?? []) roots.add(f.factId);
    }

    if (query.afterSequence !== undefined) for (const f of facts.filter(f => (positions.get(f.factId) ?? 0) > query.afterSequence! && isLearningOpportunityV2(f, facts)).slice(0, 12)) roots.add(f.factId);

    for (const asset of loaded.state.assets) if (query.versionIds?.includes(asset.versionId) && asset.scope === query.scope && isCollaborationPracticeV2(asset.content)) {
      const practice = asset.content;

      for (const id of [...practice.sourceEventIds, ...practice.sourceEpisodeIds, ...practice.sourceOutcomeIds]) roots.add(id);

      for (const fact of facts) if (fact.kind === "analysis" && fact.cycleId === practice.cycleId && fact.sourceWindowHash === practice.sourceWindowHash) roots.add(fact.factId);

      const exposures = new Set(facts.filter(f => f.kind === "exposure" && f.versionId === asset.versionId).map(f => f.factId));
      const adoptions = new Set(facts.filter(f => f.kind === "adoption" && exposures.has(f.exposureId)).map(f => f.factId));
      const negative = facts.filter(f => f.kind === "outcome" && (f.source === "external_checker" || f.source === "user")
        && f.metrics.delivery === "failed" && f.adoptionIds.some(id => adoptions.has(id))).at(-1);
      if (negative !== undefined) roots.add(negative.factId);
    }

    // Evidence and cycle links may reveal more roots; stop only at a fixed point.
    for (;;) {
      const before = roots.size;

      for (const fact of collaborationEvidenceClosureV2(facts, [...roots])) roots.add(fact.factId);

      for (const fact of facts) if (roots.has(fact.factId)) {
        if (fact.kind === "episode") {
          // Attribution follows the frozen runtime outcome, never later same-context operations.
          for (const outcome of facts) if (outcome.kind === "outcome" && outcome.source === "runtime" && outcome.episodeIds.includes(fact.factId)) roots.add(outcome.factId);
        }

        if (fact.kind === "analysis") {
          for (const id of [...fact.basis.eventIds, ...fact.basis.episodeIds, ...fact.basis.outcomeIds, ...fact.basis.exposureIds, ...fact.basis.adoptionIds]) roots.add(id);
          for (const cycle of cycles.get(fact.cycleId) ?? []) roots.add(cycle.factId);
        }

        if (fact.kind === "cycle") {
          for (const cycle of cycles.get(fact.cycleId) ?? []) roots.add(cycle.factId);
          if (cycles.get(fact.cycleId)?.at(-1)?.factId === fact.factId && fact.phase === "reserved") for (const analysis of facts) {
            if (analysis.kind === "analysis" && analysis.cycleId === fact.cycleId && analysis.step === fact.step) roots.add(analysis.factId);
          }
        }
      }

      if (roots.size === before) break;
    }

    const selected = facts.filter(f => roots.has(f.factId));
    if (selected.length > 8192) return { ok: false as const, reason: "archive_closure_size" };

    const records = selected.map(fact => {
      const original = originals.get(fact.factId);
      if (original !== undefined) return original;
      const chain = fact.kind === "cycle" ? cycles.get(fact.cycleId) ?? [] : [];
      const previous = fact.kind === "cycle" ? chain[chain.findIndex(f => f.factId === fact.factId) - 1] : undefined;
      return { type: "record_collaboration_v2" as const, commandId: `collaboration-v2:${fact.factId}`, issuedAt: fact.recordedAt, fact,
        ...(previous === undefined ? {} : { expectedCycleFactId: previous.factId }) };
    });

    return { ok: true as const, records };
  } catch { return { ok: false as const, reason: "archive_unavailable" }; }
}
