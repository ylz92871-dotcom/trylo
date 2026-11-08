import type { MemoryDocument, MemoryDocuments } from "../../../ports/memory.js";
import type { BoardState } from "../../../learning/control/state.js";
import { findActivation } from "../../../learning/control/state.js";
import type { Message } from "../../../contract/execution.js";
import { factDocumentId, factLines, type UserFactRecord } from "../../../learning/domains/user/memory-fact.js";

/**
 * Where a memory read gets its records: the ones this run already owns.
 *
 * Two sources, both read-only projections of state somebody else wrote:
 *
 *  - the learning board's **activated** assets — the same activation check the
 *    profile assembler performs, borrowed rather than reimplemented, so a memory
 *    hit can only ever name an asset the run would actually have been given.
 *    Reading a withdrawn or merely-proposed rule would put text in a model's
 *    context that the learning control plane has not agreed is true;
 *  - the project rule files the run adopted (`ProjectContext.sources`) — the
 *    same list that went into the seed messages, so a search result and the
 *    context the model already has cannot disagree about what the project said.
 *
 * What is deliberately absent: any write, any promotion, and any "this looks
 * important" judgement. Sedimentation and asset governance belong to the
 * learning control plane behind its own single writer. This module's entire
 * vocabulary is `read`.
 *
 * Both projections carry their provenance in `origin` and a real path in `path`,
 * so a hit a model quotes can be traced to the board asset or the rule file it
 * came from rather than floating free.
 */

export type MemorySourceInput = {
  /**
   * The board, when one was loaded. Absent — every run without `--learning`, and
   * every run whose board failed to load — yields no learning documents at all,
   * which is not the same as yielding empty ones.
   */
  readonly board?: BoardState;
  readonly projectContext?: MemoryProjectContext;
  /**
   * User facts the run may see (WP-CL / B). A thunk, because a save earlier in
   * this same turn must be visible to the next search — a captured array would
   * make "I just saved it" and "I cannot find it" both true.
   */
  readonly facts?: () => ReadonlyArray<UserFactRecord>;
};

/**
 * The assembled project context, described structurally rather than imported.
 *
 * The surface's own `ProjectContext` is the producer, but naming it here would
 * make an adapter in `adapters/**` depend on a type that lives in
 * `surface/cli/**` — the layering the architecture gate exists to keep. What this
 * module actually needs is two lists, and saying so here keeps the dependency
 * pointing the right way: the surface satisfies this shape, it does not define it.
 */
export type MemoryProjectContext = {
  readonly messages: ReadonlyArray<Message>;
  readonly sources: ReadonlyArray<{ readonly relativePath: string }>;
};

/** The path a board asset has. Assets live in the board, not on disk. */
const BOARD_PATH = "trylo://learning/board";

function linesOf(text: string): ReadonlyArray<string> {
  return text.split("\n");
}

/** Text carried by an asset, when the asset's content is text at all. */
function assetText(content: unknown): string | undefined {
  if (typeof content === "string") {
    return content;
  }

  if (typeof content === "object" && content !== null && "text" in content) {
    const text = (content as { text: unknown }).text;
    return typeof text === "string" ? text : undefined;
  }

  return undefined;
}

/**
 * The board's currently-active assets.
 *
 * The activation check is the load-bearing line. `findActivation` answers "is
 * this asset kind live for this scope", and an asset whose proposal is not
 * `active`, or whose activation points at a different version, is skipped. That
 * is what makes a memory search unable to surface a rule the run would not have
 * been given in its seeds — so "what did I learn" and "what am I following" have
 * one answer between them.
 */
function boardDocuments(state: BoardState): ReadonlyArray<MemoryDocument> {
  const documents: MemoryDocument[] = [];
  const liveProposals = new Set(
    state.proposals.filter((proposal) => proposal.lifecycle === "active").map((p) => p.proposalId),
  );

  for (const asset of state.assets) {
    if (asset.createdFromProposalId === undefined || !liveProposals.has(asset.createdFromProposalId)) {
      continue;
    }

    const activation = findActivation(state, asset.scope, asset.kind);
    if (activation?.pointer !== "active" || activation.versionId !== asset.versionId) {
      continue;
    }

    const text = assetText(asset.content);
    if (text === undefined || text.trim().length === 0) {
      continue;
    }

    documents.push({
      id: asset.versionId,
      path: BOARD_PATH,
      lines: linesOf(text),
      origin: `learning:${asset.kind}:${asset.scope}`,
    });
  }

  return documents;
}

/**
 * Project rule files as documents.
 *
 * `LocalRuleSource` carries the path and hash but not the text, and the text has
 * to come from somewhere: `ProjectContext.messages` already holds each adopted
 * rule, headed by a line naming its file. Rather than re-read every rule file
 * from disk — which would be a second read path over bytes the caller already
 * has — the text is taken from the assembled message and the path from the
 * source entry that describes it.
 */
function projectDocuments(context: MemoryProjectContext): ReadonlyArray<MemoryDocument> {
  const known = new Set(context.sources.map((source) => source.relativePath));
  const documents: MemoryDocument[] = [];

  for (const message of context.messages) {
    if (message.role !== "system") {
      continue;
    }

    const relativePath = leadingPathOf(message.content);
    if (relativePath === undefined || !known.has(relativePath)) {
      continue;
    }

    const body = message.content.split("\n").slice(1).join("\n");
    if (body.trim().length === 0) {
      continue;
    }

    documents.push({
      id: `project-rule:${relativePath}`,
      path: relativePath,
      lines: linesOf(body),
      origin: "project-rule",
    });
  }

  return documents;
}

/**
 * `Project instructions from <path> (<scope>).` — the first line of an assembled
 * rule message, whose shape `assemble.ts` owns.
 *
 * Parsed rather than pattern-matched loosely on purpose: if that sentence ever
 * changes, this returns `undefined` and the rule simply is not searchable, which
 * is a smaller failure than indexing some other message under the wrong path.
 */
function leadingPathOf(content: string): string | undefined {
  const match = /^Project instructions from (\S+) \(/.exec(content);
  return match?.[1];
}

/**
 * Build the document source the memory tools read from.
 *
 * Returns a function rather than a snapshot so every search sees the records as
 * they are *now*. A captured array would make a memory tool that answers "no
 * matches" forever after the first turn, and the model would have no way to tell
 * that from "nothing was ever learned".
 */
/**
 * User facts as documents.
 *
 * The origin names the memory domain rather than the file: a model quoting a hit
 * should be able to say "this is a Trylo user-memory fact", and a panel result
 * carries the same `recordId` the ledger uses, so "the panel shows it" and "the
 * model can read it" stop being two different facts.
 */
function factDocuments(facts: ReadonlyArray<UserFactRecord>): ReadonlyArray<MemoryDocument> {
  return facts.map((record) => ({
    id: factDocumentId(record.id),
    path: `trylo://learning/user/${record.id}`,
    lines: factLines(record),
    origin: "user-memory",
    recordKind: record.factKind,
  }));
}

export function memoryDocumentsFrom(input: MemorySourceInput): () => Promise<MemoryDocuments> {
  return async () => ({
    documents: [
      ...(input.board === undefined ? [] : boardDocuments(input.board)),
      ...(input.projectContext === undefined ? [] : projectDocuments(input.projectContext)),
      ...(input.facts === undefined ? [] : factDocuments(input.facts())),
    ],
  });
}

/** The same projection, resolved once — for a caller that already holds a board. */
export function memoryDocuments(input: MemorySourceInput): MemoryDocuments {
  return {
    documents: [
      ...(input.board === undefined ? [] : boardDocuments(input.board)),
      ...(input.projectContext === undefined ? [] : projectDocuments(input.projectContext)),
      ...(input.facts === undefined ? [] : factDocuments(input.facts())),
    ],
  };
}
