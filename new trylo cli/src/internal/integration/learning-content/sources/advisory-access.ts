import type { BoardState } from "../../../learning/control/state.js";
import type { ContentEvidenceRecord } from "../../../learning/central/content/material-contract.js";
import { canonicalJson, contentHashOf } from "../../../learning/control/hash.js";
import { readContentRecords } from "../records.js";
import { contentRecordMaterialBatch } from "../source.js";
import { boardArtifactMaterialBatch, boardAssetContentRef, mapBoardContentArtifacts } from "./artifact.js";
import { readBoardContentMaterial } from "./artifact-read.js";
import { contentRecallMaterialBatch } from "./content-recall.js";
import { canReadNativeAsset, canReadNativeContentRecord, type NativeKnowledgeAccess } from "./native-knowledge.js";
import type { CentralAdvisorySourceAccess } from "./native-central-advisory.js";
import type { SessionContentSource } from "./session-contract.js";
import { readSessionContentAddress, readSessionTaskAddress } from "./session-address.js";
import { readSessionPublicTurnAddress } from "./session-public-turn.js";
import { readCentralMaterialPageRef } from "../../central-learning/deliberation-material.js";

type Verdict = Awaited<ReturnType<CentralAdvisorySourceAccess>>;

type StoredContent = ReturnType<typeof readContentRecords>[number];

type Source = { readonly ref: string; readonly version?: string; readonly evidence?: ContentEvidenceRecord };

type Projection = { readonly owner: StoredContent; readonly evidence: ContentEvidenceRecord };

const verdict = (status: Verdict["status"], refs: readonly string[]): Verdict => ({ status, sourceRefs: [...new Set(refs)] });
const identity = (ref: unknown): ref is string => typeof ref === "string" && ref.trim().length > 0;
const addressed = (source: Source): boolean => readSessionContentAddress(source.ref) !== undefined
  || readSessionPublicTurnAddress(source.ref) !== undefined || readSessionTaskAddress(source.ref) !== undefined;

/** A PA consumer checks original owners, never a publisher's access claim or a
 * summary's prose. The captured Board and bound session reader belong to this
 * consumer instance; no authorization is shared across tasks or snapshots. */
export function createCentralAdvisorySourceAccess(input: { readonly board: BoardState; readonly scope: string;
  readonly sessionSource: Pick<SessionContentSource, "readMaterial">; readonly nativeAccess?: NativeKnowledgeAccess;
  readonly enabled: () => boolean }): CentralAdvisorySourceAccess {
  const { board, scope } = input;
  let index: { readonly records: readonly StoredContent[]; readonly mappings: ReturnType<typeof mapBoardContentArtifacts>;
    readonly projections: ReadonlyMap<string, readonly Projection[]> } | undefined;
  const memo = new Map<string, Verdict>();
  const active = (signal: AbortSignal) => input.enabled() && !signal.aborted;

  function sourceIndex() {
    if (index !== undefined) return index;

    const records = readContentRecords(board.rewardV2Facts ?? [], scope, board.sequence);
    const projections = new Map<string, Projection[]>();

    for (const owner of records) {
      const originals = new Set(owner.packet.records.map(row => row.ref));
      const generated = [...contentRecordMaterialBatch(owner, scope).records, ...contentRecallMaterialBatch(owner, scope).records]
        .filter(row => !originals.has(row.ref));

      for (const evidence of generated) {
        const entries = projections.get(evidence.ref) ?? [];
        if (!entries.some(row => row.owner.factId === owner.factId && canonicalJson(row.evidence) === canonicalJson(evidence))) {
          entries.push({ owner, evidence });
          projections.set(evidence.ref, entries);
        }
      }
    }

    index = { records, projections, mappings: mapBoardContentArtifacts(board, scope) };
    return index;
  }

  async function all(sources: readonly Source[], signal: AbortSignal, path: ReadonlySet<string>): Promise<Verdict> {
    let status: Verdict["status"] = "allowed";
    const refs: string[] = [];
    // Explicit native addresses load and verify their source journals before
    // opaque aliases are located. Apply this to every retained ancestry batch,
    // not only the top-level publication's declared source order.
    const ordered = [...sources.filter(addressed), ...sources.filter(source => !addressed(source))];

    for (const source of ordered) {
      if (!active(signal)) return verdict("denied", [...refs, source.ref]);
      const checked = await visit(source, signal, path);
      refs.push(...checked.sourceRefs);
      if (checked.status === "denied") status = "denied";
      else if (checked.status === "unknown" && status === "allowed") status = "unknown";
    }

    return verdict(status, refs);
  }

  async function content(owner: StoredContent, signal: AbortSignal, path: ReadonlySet<string>): Promise<Verdict> {
    if (!canReadNativeContentRecord(board, scope, owner, input.nativeAccess)) return verdict("denied", [owner.factId]);

    // Every retained original is checked, including sources not cited by the
    // short result. Artifact links retain their original version binding.
    const artifacts = [...owner.packet.answers.flatMap(row => row.artifactRefs),
      ...owner.packet.materials.flatMap(row => row.links.artifactRefs)];
    const sources: Source[] = [...owner.packet.records.map(evidence => ({ ref: evidence.ref, evidence })),
      ...artifacts.map(row => ({ ref: row.id, version: row.version }))];
    if (sources.length === 0) return verdict("unknown", [owner.factId]);

    const checked = await all(sources, signal, path);

    return verdict(checked.status, [owner.factId, ...checked.sourceRefs]);
  }

  async function session(source: Source, signal: AbortSignal): Promise<Verdict> {
    // The actual session source owns registry/workspace validation and excludes
    // private producer records before locating public material. Neither a ref
    // prefix nor JSON in the returned text can establish those permissions.
    // Central page addresses retain their original session owner. They are
    // read coordinates, not separate business records or an access grant.
    let ref = source.ref, start = 0;

    for (let depth = 0; ref.startsWith("central-page:"); depth += 1) {
      if (depth >= 16) return verdict("unknown", [source.ref]);
      const page = readCentralMaterialPageRef(ref);
      if (page === undefined || !Number.isSafeInteger(start + page.start)) return verdict("unknown", [source.ref]);
      start += page.start;
      ref = page.ref;
    }

    const read = await input.sessionSource.readMaterial(ref, signal, start, 2);

    if (!active(signal)) return verdict("denied", [source.ref]);

    if (!read.ok) return verdict(read.reason === "collect_disabled" || read.reason === "content_material_cancelled"
      || read.reason === "content_material_scope" ? "denied" : "unknown", [source.ref]);

    const page = read.value;
    if (page.originalScope !== scope) return verdict("denied", [source.ref]);

    if (source.version !== undefined) return verdict("unknown", [source.ref]);

    if (source.evidence !== undefined) {
      const expected = source.evidence, coordinate = page.coordinate ?? { runId: page.sessionId, sequence: page.journalSequence };
      if (expected.scope !== page.originalScope || expected.origin !== page.origin || expected.runId !== coordinate.runId
        || expected.sequence !== coordinate.sequence || expected.text.length !== page.totalChars
        || contentHashOf(expected.text) !== page.sourceHash) return verdict("unknown", [source.ref]);
    }

    return verdict("allowed", [source.ref]);
  }

  async function resolve(source: Source, signal: AbortSignal, path: ReadonlySet<string>): Promise<Verdict> {
    const known = sourceIndex();
    const asset = board.assets.find(row => source.ref === row.versionId || source.ref === `asset:${row.versionId}`
      || source.ref === boardAssetContentRef(row));
    if (asset !== undefined) {
      if (asset.kind === "user_rule" || board.tombstones.some(row => row.entityId === asset.versionId
        || row.entityId === asset.createdFromProposalId)) return verdict("denied", [source.ref]);

      const mapping = known.mappings.find(row => row.ref === asset.versionId && row.version === asset.versionId);
      if (mapping === undefined || contentHashOf(asset.content) !== asset.contentHash
        || source.version !== undefined && source.version !== mapping.version) return verdict("unknown", [source.ref]);

      if (!canReadNativeAsset(board, scope, asset.versionId, input.nativeAccess)) return verdict("denied", [source.ref]);

      if (asset.scope !== scope) {
        const proposal = board.proposals.find(row => row.proposalId === asset.createdFromProposalId);
        const addresses = new Set([asset.versionId, ...(proposal === undefined ? [] : [proposal.proposalId, proposal.candidateRef])]);
        if (!board.jobs.some(job => job.scope === scope && job.coordination?.resultRefs?.some(ref => addresses.has(ref)))) {
          return verdict("denied", [source.ref]);
        }
      }

      if (source.evidence !== undefined) {
        const actual = boardArtifactMaterialBatch(board, scope, mapping).records.find(row => row.ref === source.ref);
        if (actual === undefined || canonicalJson(actual) !== canonicalJson(source.evidence)) return verdict("unknown", [source.ref]);
      }

      const proposal = board.proposals.find(row => row.proposalId === asset.createdFromProposalId);
      if (asset.createdFromProposalId !== undefined && proposal === undefined) return verdict("unknown", [source.ref]);

      const ancestry = [...(asset.parentVersionId === undefined ? [] : [asset.parentVersionId]),
        ...(proposal?.baseVersionId === undefined ? [] : [proposal.baseVersionId]), ...(proposal?.observationRefs ?? []), ...mapping.contentFactIds];
      const checked = await all([...new Set(ancestry)].map(ref => ({ ref })), signal, path);

      return verdict(checked.status, [source.ref, ...checked.sourceRefs]);
    }

    if (source.ref.startsWith("board-asset-receipts:")) {
      for (const mapping of known.mappings.filter(row => !row.contentFactIds.includes(row.ref))) {
        const receipt = boardArtifactMaterialBatch(board, scope, mapping).records.find(row => row.ref === source.ref);
        if (receipt === undefined) continue;
        if (source.evidence !== undefined && canonicalJson(source.evidence) !== canonicalJson(receipt)) return verdict("unknown", [source.ref]);
        const checked = await visit({ ref: mapping.ref, ...(source.version === undefined ? {} : { version: source.version }) }, signal, path);
        return verdict(checked.status, [source.ref, ...checked.sourceRefs]);
      }
      return verdict("unknown", [source.ref]);
    }

    const owner = known.records.find(row => row.factId === source.ref);
    if (owner !== undefined) {
      if (source.version !== undefined && source.version !== owner.output.processId) return verdict("unknown", [source.ref]);

      if (source.evidence !== undefined) {
        const actual = readBoardContentMaterial(board, scope, source.ref, 0, 2), expected = source.evidence;
        if (!actual.ok || expected.scope !== actual.value.originalScope || expected.origin !== actual.value.origin
          || expected.runId !== actual.value.coordinate.runId || expected.sequence !== actual.value.coordinate.sequence
          || expected.text.length !== actual.value.totalChars || contentHashOf(expected.text) !== actual.value.contentHash) {
          return verdict("unknown", [source.ref]);
        }
      }

      return content(owner, signal, path);
    }

    const projected = known.projections.get(source.ref);
    if (projected !== undefined) {
      if (projected.length !== 1 || source.version !== undefined && source.version !== projected[0]!.owner.output.processId
        || source.evidence !== undefined && canonicalJson(source.evidence) !== canonicalJson(projected[0]!.evidence)) {
        return verdict("unknown", [source.ref]);
      }
      return content(projected[0]!.owner, signal, path);
    }

    // Unsupported native facts, parent/summary addresses and missing original
    // records remain unknown. Only the bound session owner's actual registry
    // can recognize an otherwise opaque original session/event/tool reference.
    return session(source, signal);
  }

  async function visit(source: Source, signal: AbortSignal, path: ReadonlySet<string>): Promise<Verdict> {
    if (!active(signal)) return verdict("denied", [source.ref]);

    if (!identity(source.ref)) return verdict("unknown", [source.ref]);

    const key = canonicalJson([source.ref, source.version ?? null, source.evidence ?? null]);
    if (path.has(key)) return verdict("unknown", [source.ref]);

    const cached = memo.get(key);
    if (cached !== undefined) return cached;

    let checked: Verdict;

    try { checked = await resolve(source, signal, new Set([...path, key])); }
    catch { checked = verdict(active(signal) ? "unknown" : "denied", [source.ref]); }

    if (!active(signal)) return verdict("denied", [source.ref]);

    // Another candidate may supply the canonical address that loads an opaque
    // source's original journal. A current miss is never permanent authority.
    if (checked.status !== "unknown") memo.set(key, checked);

    return checked;
  }

  return async function check(advisory, signal): Promise<Verdict> {
    const refs = [...new Set([...advisory.sourceRefs, ...(advisory.accessSourceRefs ?? [])])];
    if (!active(signal)) return verdict("denied", refs);
    if (!identity(advisory.ref) || !identity(advisory.version) || refs.length === 0 || !refs.every(identity)) return verdict("unknown", refs);
    const checked = await all(refs.map(ref => ({ ref })), signal, new Set());
    return active(signal) ? checked : verdict("denied", checked.sourceRefs);
  };
}
