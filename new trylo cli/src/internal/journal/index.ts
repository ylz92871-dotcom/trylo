import {
  projectFacts,
  type ExecutionFact,
  type LearningProjection,
} from "./projection.js";

export type { ExecutionFact, LearningProjection } from "./projection.js";
export { toExecutionFact } from "./adapter.js";
export type { CanonicalExecutionEvent } from "./adapter.js";

export type ProjectFilter = {
  readonly collect: boolean;
};

export type ProjectedEvent = {
  readonly eventId: string;
  readonly kind: string;
};

export type JournalProjection = ReadonlyArray<ProjectedEvent>;

export type JournalOptions = {
  readonly maxObservations?: number;
};

export type Journal = {
  record(event: ProjectedEvent): void;
  project(filter: ProjectFilter): JournalProjection;
  recordFact(fact: ExecutionFact): void;
  projectLearning(filter: ProjectFilter): LearningProjection;
  tombstone(eventId: string): void;
};

export function createJournal(options: JournalOptions = {}): Journal {
  const events: ProjectedEvent[] = [];
  const facts: ExecutionFact[] = [];
  const tombstones = new Set<string>();

  return {
    record(event) {
      events.push(event);
    },
    project(filter) {
      if (filter.collect === false) {
        return [];
      }
      return events.filter((event) => !tombstones.has(event.eventId));
    },
    recordFact(fact) {
      facts.push(fact);
      const max = options.maxObservations;
      if (max === undefined || facts.length <= max) {
        return;
      }

      const overflow = facts.length - max;

      for (let index = 0; index < overflow; index += 1) {
        const old = facts[index];
        if (old !== undefined) {
          tombstones.add(old.eventId);
        }
      }
    },
    projectLearning(filter) {
      if (filter.collect === false) {
        return { ok: true, observations: [] };
      }
      const live = facts.filter((fact) => !tombstones.has(fact.eventId));
      return projectFacts(live, true);
    },
    tombstone(eventId) {
      tombstones.add(eventId);
    },
  };
}
