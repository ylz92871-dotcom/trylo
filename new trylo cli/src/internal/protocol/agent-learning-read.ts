/** Versioned read-only projection. Immutable version identities never imply human approval. */
export type AgentLearningDomain = "method" | "workflow" | "collaboration";

export type AgentLearningEntry = {
  readonly domain: AgentLearningDomain;
  readonly id: string;
  readonly versionId: string;
  readonly title: string;
  readonly summary: string;
  readonly status: string;
  readonly source: string;
  readonly scope: string;
  readonly createdAt?: string;
  readonly content: Readonly<Record<string, unknown>>;
  readonly related?: readonly Readonly<Record<string, unknown>>[];
};

export type AgentLearningDocument = AgentLearningEntry & { readonly markdown: string; readonly raw: string };

export type AgentLearningReadReply =
  | { readonly schemaVersion: 1; readonly ok: true; readonly domain: AgentLearningDomain; readonly entries: readonly AgentLearningDocument[] }
  | { readonly schemaVersion: 1; readonly ok: false; readonly reason: string };
