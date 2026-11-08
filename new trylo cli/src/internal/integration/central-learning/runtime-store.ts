import { createRewardV2BoardPort } from "../reward/v2-board-port.js";
import { buildCentralRuntimeRecord, lookupCentralRuntimeRecords, readCentralRuntimeRecords } from "../../learning/central/runtime/records.js";
import type { CentralRuntimeLookup, CentralRuntimeLookupResult, CentralRuntimeRead, CentralRuntimeRecordInput } from "../../learning/central/runtime/records.js";
import { sequence } from "../../validation/json-shape.js";
import { buildCentralRuntimeMaterialRecord } from "../../learning/central/runtime/material-record.js";
import type { CentralRuntimeMaterial } from "../../learning/central/runtime/contracts.js";

export type CentralRuntimeAppend = CentralRuntimeRecordInput & { readonly expectedRevision: number };

export type CentralRuntimeAppendResult = { readonly status: "written"; readonly revision: number; readonly stateRef: string }
  | { readonly status: "stale" };

/** The existing Board remains the sole writer. Unknown write outcomes propagate without retries. */
export function createCentralRuntimeStore(options: { readonly boardRoot: string; readonly enabled: () => boolean }) {
  const board = createRewardV2BoardPort(options.boardRoot, options.enabled);
  const read = async (scope: string): Promise<CentralRuntimeRead> => {
    if (!options.enabled()) throw new Error("collect_disabled");
    const snapshot = await board.read();
    if (!options.enabled()) throw new Error("collect_disabled");
    return readCentralRuntimeRecords(snapshot.facts, scope, snapshot.revision);
  };
  const lookupMany = async (scope: string, queries: readonly CentralRuntimeLookup[]): Promise<readonly CentralRuntimeLookupResult[]> => {
    if (!options.enabled()) throw new Error("collect_disabled");
    const snapshot = await board.read();
    if (!options.enabled()) throw new Error("collect_disabled");
    return lookupCentralRuntimeRecords(snapshot.facts, scope, snapshot.revision, queries);
  };

  return Object.freeze({ read, lookupMany,

    async appendMaterial(input: { readonly expectedRevision: number; readonly scope: string; readonly material: CentralRuntimeMaterial }) {
      if (!options.enabled()) throw new Error("collect_disabled");

      if (!sequence(input.expectedRevision)) throw new Error("central_runtime_revision_invalid");

      const fact = buildCentralRuntimeMaterialRecord(input.scope, input.material), snapshot = await board.read();

      if (!options.enabled()) throw new Error("collect_disabled");

      if (snapshot.revision !== input.expectedRevision) return { status: "stale" as const };

      const existing = snapshot.facts.find(row => row.id === fact.id);

      // Validate source identity conflicts before admitting an immutable fact.
      readCentralRuntimeRecords(existing === undefined ? [...snapshot.facts, { ...fact, sequence: snapshot.revision + 1 }]
        : snapshot.facts, input.scope, snapshot.revision + (existing === undefined ? 1 : 0));

      if (!options.enabled()) throw new Error("collect_disabled");

      const result = await board.append(input.expectedRevision, fact);

      return result.status === "stale" ? result : { status: "written" as const, revision: result.revision, materialFactRef: fact.id };
    },

    async lookup(scope: string, query: CentralRuntimeLookup): Promise<CentralRuntimeLookupResult> {
      const result = (await lookupMany(scope, [query]))[0];
      if (result === undefined) throw new Error("central_runtime_lookup_invalid");
      return result;
    },

    async append(input: CentralRuntimeAppend): Promise<CentralRuntimeAppendResult> {
      if (!options.enabled()) throw new Error("collect_disabled");

      const { expectedRevision, ...record } = input;

      if (!sequence(expectedRevision)) throw new Error("central_runtime_revision_invalid");

      const fact = buildCentralRuntimeRecord(record);
      const snapshot = await board.read();

      if (!options.enabled()) throw new Error("collect_disabled");

      const current = readCentralRuntimeRecords(snapshot.facts, input.state.scope, snapshot.revision);
      if (current.revision !== expectedRevision || current.stateRef !== input.previousRef) return { status: "stale" };

      // Validate the prospective chain before committing. A bad archived identity
      // must never become a durable poison record which only the next read detects.
      readCentralRuntimeRecords([...snapshot.facts, { ...fact, sequence: expectedRevision + 1 }], input.state.scope, expectedRevision + 1);

      if (!options.enabled()) throw new Error("collect_disabled");

      const result = await board.append(expectedRevision, fact);

      // RewardV2 permits exact command replay. Runtime snapshots retain the
      // stronger first-write CAS: another caller's committed head must be reread.
      return result.status === "stale" || result.idempotent ? { status: "stale" }
        : { status: "written", revision: result.revision, stateRef: fact.id };
    },
  });
}
