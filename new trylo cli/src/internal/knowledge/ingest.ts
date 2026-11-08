import { randomUUID } from "node:crypto";
import type { Fragment } from "./fragment.js";
import type { FragmentStore } from "./store.js";

export type Ingest = {
  recordCorrection(text: string, why: string): Promise<Fragment>;
  appendCandidate(body: string): Promise<Fragment>;
  withdraw(id: string): Promise<Fragment>;
  remove(id: string): Promise<void>;
};

export function createIngest(store: FragmentStore): Ingest {
  return {
    async recordCorrection(text, why) {
      const body = requiredBody(text, "correction");
      const fragment: Fragment = {
        id: randomUUID(),
        type: "feedback",
        origin: "user-stated",
        scope: "user",
        version: 1,
        state: "active",
        body,
        ...(why.trim().length > 0 ? { why: why.trim() } : {}),
      };

      await store.write(fragment);

      return fragment;
    },
    async appendCandidate(body) {
      const text = requiredBody(body, "candidate");
      const fragment: Fragment = {
        id: randomUUID(),
        type: "method",
        origin: "inferred",
        scope: "candidate",
        version: 1,
        state: "pending",
        body: text,
      };

      await store.write(fragment);

      return fragment;
    },
    async withdraw(id) {
      const existing = (await store.readAll()).find((item) => item.id === id);
      if (existing === undefined) {
        throw new Error("fragment not found");
      }

      const next: Fragment = { ...existing, state: "withdrawn" };

      await store.write(next);

      return next;
    },
    async remove(id) {
      await store.remove(id);
    },
  };
}

function requiredBody(value: string, label: string): string {
  const body = value.trim();
  if (body.length === 0) {
    throw new Error(`${label} body is empty`);
  }
  return body;
}
