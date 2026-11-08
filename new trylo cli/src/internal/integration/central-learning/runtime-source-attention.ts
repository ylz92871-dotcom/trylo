import type { BoardState } from "../../learning/control/state.js";
import { isCollaborationRuntimeReceipt } from "../../learning/control/collaboration-runtime-parse.js";
import type { ExperienceBoundaryReceipt } from "../../protocol/collaboration-experience.js";
import type { CentralRuntimeMaterial, CentralRuntimeSourcePort } from "../../learning/central/runtime/contracts.js";
import { readCentralRuntimeRecords } from "../../learning/central/runtime/records.js";
import { canonicalJson, contentHashOf } from "../../learning/control/hash.js";
import type { ContentDomainFeedbackChange } from "../learning-content/sources/domain-feedback.js";
import { centralSourceReadScopes, nativeChangeReadRef } from "./runtime-source-changes.js";

type Query = NonNullable<Parameters<CentralRuntimeSourcePort["snapshot"]>[2]>;

type Entry = { readonly change: ContentDomainFeedbackChange; readonly receipt: ExperienceBoundaryReceipt; readonly order: number };

type Chain = { readonly ref: string; readonly issueId: string; readonly unitRef: string; readonly entries: Entry[] };

const CHAIN = "central-runtime-native-catalog:chain:", INDEX = "central-runtime-native-catalog:attention:";
const ROLE = "original_native_feedback_change_catalog_not_read_body", PAGE = 16;
export const isNativeExposureAttentionRef = (ref: string): boolean => ref.startsWith(CHAIN) || ref.startsWith(INDEX);

function boundaryReceipt(value: unknown): value is ExperienceBoundaryReceipt {
  return isCollaborationRuntimeReceipt(value) && (value.phase === "loaded" || value.phase === "dispatched")
    && value.owner.kind === "personal_agent" && value.boundary.role === "personal_agent"
    && typeof value.boundary.configurationRef === "string" && value.boundary.configurationRef.trim().length > 0;
}

/** This identity proves only the same native exposure boundary. Unrecorded
 * business conditions, following guidance, quality and benefit remain unknown. */
function chainsFrom(board: BoardState, scope: string, changes: readonly ContentDomainFeedbackChange[], compatibleScopes: readonly string[]): readonly Chain[] {
  const allowed = centralSourceReadScopes(scope, compatibleScopes);
  const issueScopes = new Map<string, Set<string>>();

  for (const issue of board.learningIssues ?? []) if (allowed.has(issue.scope)) {
    const scopes = issueScopes.get(issue.issueId) ?? new Set<string>();
    scopes.add(issue.scope);
    issueScopes.set(issue.issueId, scopes);
  }

  const receipts = new Map<string, { readonly receipt: ExperienceBoundaryReceipt; readonly order: number }>();
  const ambiguous = new Set<string>();

  for (const [order, receipt] of (board.collaborationRuntimeReceipts ?? []).entries()) {
    if (!boundaryReceipt(receipt) || !allowed.has(receipt.scope)) continue;

    const key = canonicalJson([receipt.scope, receipt.receiptId]), previous = receipts.get(key);
    if (ambiguous.has(key)) continue;

    if (previous !== undefined && canonicalJson(previous.receipt) !== canonicalJson(receipt)) {
      receipts.delete(key);
      ambiguous.add(key);
      continue;
    }

    if (previous === undefined) receipts.set(key, { receipt, order });
  }

  const chains = new Map<string, Chain>();

  for (const change of changes) {
    if (change.domain !== "collaboration" || change.kind !== "delivery" || change.factRef !== change.revisionRef) continue;

    const scopes = issueScopes.get(change.issueId);
    if (scopes?.size !== 1) continue;

    const original = receipts.get(canonicalJson([[...scopes][0], change.factRef]));
    if (original === undefined || !original.receipt.versionIds.includes(change.unitRef)) continue;

    const receipt = original.receipt, { round: _round, requestId: _request, ...boundary } = receipt.boundary;
    const identity = { scope: receipt.scope, issueId: change.issueId, unitRef: change.unitRef, owner: receipt.owner,
      ownerFingerprint: receipt.ownerFingerprint, phase: receipt.phase, boundary, versions: [...receipt.versionIds].sort() };
    const ref = `${CHAIN}${contentHashOf(identity)}:0`;
    const chain = chains.get(ref) ?? { ref, issueId: change.issueId, unitRef: change.unitRef, entries: [] };

    chain.entries.push({ change, ...original });
    chains.set(ref, chain);
  }

  for (const chain of chains.values()) chain.entries.sort((a, b) => a.order - b.order);

  return [...chains.values()];
}

function navigation(entries: readonly unknown[], start: number, header: Record<string, unknown>, next: (offset: number) => string): CentralRuntimeMaterial {
  if (!Number.isSafeInteger(start) || start < 0 || start >= entries.length && start !== 0) throw new Error("central_runtime_source_page_invalid");

  const page: unknown[] = [];
  const render = () => canonicalJson({ role: ROLE, attention: "repeated_pa_phase_navigation", ...header,
    entries: page, nextReadRef: start + page.length < entries.length ? next(start + page.length) : null,
    interpretation: "Native receipt navigation only. Repeated rounds and decision relationships are not independent business samples, following, quality or benefit. Listed receipt bodies remain unread; use their original read references." });

  for (const entry of entries.slice(start, start + PAGE)) {
    page.push(entry);
    if (render().length > 32768) {
      page.pop();
      break;
    }
  }

  if (page.length === 0 && entries.length > 0) throw new Error("central_runtime_native_change_capacity");

  const text = render();
  // Only chain query identities are exposed here. Never acknowledge the later
  // original receipt/revision refs merely because their directory was shown.
  const sourceRefs = [...new Set(page.flatMap(entry => typeof entry === "object" && entry !== null && "chainRef" in entry
    && typeof entry.chainRef === "string" ? [entry.chainRef] : []))];

  if (typeof header.chainRef === "string") sourceRefs.push(header.chainRef);

  return { ref: `central-runtime-native-catalog:${contentHashOf(text)}`, kind: "source", text, sourceRefs };
}

/** Passive coordination only. Original projectors, receipts and exact reads
 * retain every phase and round. No observed position is written by this view. */
export function createNativeExposureAttention(board: BoardState, scope: string,
  changes: readonly ContentDomainFeedbackChange[], query?: Query, compatibleScopes: readonly string[] = []) {
  const chains = chainsFrom(board, scope, changes, compatibleScopes), byRef = new Map(chains.map(chain => [chain.ref, chain]));
  const listeners = new Set((query?.purposes ?? []).flatMap(purpose => purpose.sourceRefs.filter(ref => byRef.has(ref))));
  const acknowledged = query !== undefined && chains.some(chain => chain.entries.length > 1)
    ? new Set(readCentralRuntimeRecords(board.rewardV2Facts ?? [], scope, board.sequence).history.consumedSourceRefs) : new Set<string>();
  const suppressed = new Set<string>();

  for (const chain of chains) {
    const first = chain.entries[0]!;
    if (listeners.has(chain.ref) || !acknowledged.has(first.change.revisionRef) || !acknowledged.has(first.change.unitRef)) continue;

    const counts = new Map<number, number>();

    for (const entry of chain.entries) counts.set(entry.receipt.boundary.round, (counts.get(entry.receipt.boundary.round) ?? 0) + 1);

    let previousRound = first.receipt.boundary.round, sequential = counts.get(previousRound) === 1;

    for (const entry of chain.entries.slice(1)) {
      const round = entry.receipt.boundary.round;
      // A repeated or backwards round breaks proof of one sequential stream.
      // Retain the anomaly and all later notices in this boundary.
      sequential = sequential && round > previousRound && counts.get(round) === 1;
      if (sequential) suppressed.add(nativeChangeReadRef(entry.change));
      previousRound = round;
    }
  }

  const relatedQuery = query === undefined ? undefined : { ...query, purposes: (query.purposes ?? []).map(purpose => ({ ...purpose,
    sourceRefs: [...new Set([...purpose.sourceRefs, ...purpose.sourceRefs.flatMap(ref => {
      const chain = byRef.get(ref);
      return chain === undefined ? [] : [chain.issueId, chain.unitRef];
    })])] })) };
  const issueChains = (issueId: string) => chains.filter(chain => chain.issueId === issueId);
  const issueKey = (issueId: string) => contentHashOf([scope, issueId]);
  const index = (issueId: string, start: number) => {
    const own = issueChains(issueId);
    const entries = own.map(chain => {
      const first = chain.entries[0]!, last = chain.entries.at(-1)!, receipt = first.receipt;
      return { chainRef: chain.ref, readRef: chain.ref, phase: receipt.phase, ownerFingerprint: receipt.ownerFingerprint,
        executionHash: contentHashOf(receipt.boundary.executionId), taskHash: contentHashOf(receipt.boundary.taskId),
        configurationHash: contentHashOf(receipt.boundary.configurationRef), unitRef: chain.unitRef,
        versionSetHash: contentHashOf([...receipt.versionIds].sort()), versionCount: receipt.versionIds.length,
        receiptCount: chain.entries.length, firstRound: receipt.boundary.round, lastRound: last.receipt.boundary.round };
    });

    return navigation(entries, start, { issueId, totalChains: own.length, browseReadRef: `${INDEX}${issueKey(issueId)}:0` },
      offset => `${INDEX}${issueKey(issueId)}:${offset}`);
  };

  return {
    changes: changes.filter(change => !suppressed.has(nativeChangeReadRef(change))),
    query: relatedQuery,

    navigation(issueIds: readonly string[]) {
      return [...new Set(issueIds)].flatMap(issueId => {
        const own = issueChains(issueId);
        return own.length === 0 ? [] : [index(issueId, Math.max(0, own.length - PAGE))];
      });
    },

    read(ref: string): CentralRuntimeMaterial | undefined {
      if (ref.startsWith(INDEX)) {
        const match = /^([a-f0-9]{64}):(\d+)$/.exec(ref.slice(INDEX.length));
        if (match === null) return undefined;
        const issueId = chains.find(chain => issueKey(chain.issueId) === match[1])?.issueId;
        return issueId === undefined ? undefined : index(issueId, Number(match[2]));
      }

      if (!ref.startsWith(CHAIN)) return undefined;

      const match = /^([a-f0-9]{64}):(\d+)$/.exec(ref.slice(CHAIN.length));
      if (match === null) return undefined;

      const chain = byRef.get(`${CHAIN}${match[1]}:0`);
      if (chain === undefined) return undefined;

      return navigation(chain.entries.map(entry => ({ ...entry.change, readRef: nativeChangeReadRef(entry.change),
        round: entry.receipt.boundary.round })), Number(match[2]), { chainRef: chain.ref, issueId: chain.issueId,
        totalReceipts: chain.entries.length, phase: chain.entries[0]!.receipt.phase }, offset => `${CHAIN}${match[1]}:${offset}`);
    },
  };
}
