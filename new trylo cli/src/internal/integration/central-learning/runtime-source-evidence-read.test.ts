import { testScratchPath } from "../../testing/scratch.js";
import assert from "node:assert/strict";
import test from "node:test";
import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { createBoardReader, withBoardWriter } from "../../adapters/learning-store/file-event-store.js";
import { createNdjsonSessionStore } from "../../adapters/session-store/ndjson.js";
import type { SessionPort } from "../../ports/session.js";
import type { CentralDeliberationRequest, CentralRuntimeMaterial } from "../../learning/central/runtime/contracts.js";
import { emptyCentralRuntimeState, initialCentralRuntimeRef } from "../../learning/central/runtime/records.js";
import { canonicalJson, contentHashOf } from "../../learning/control/hash.js";
import { createCentralRuntimeMaterials } from "../../surface/cli/central-runtime-materials.js";
import type { CliContext } from "../../surface/cli/context.js";
import { methodBoardRoot } from "../../surface/cli/learning-sink.js";
import { sessionPath } from "../../surface/cli/session-paths.js";
import { sessionContentAddress } from "../learning-content/sources/session.js";
import { createCentralChangeView, type CentralChangeInput } from "./change-input.js";
import { CENTRAL_CHANGE_INPUT_VERSION, LEGACY_CENTRAL_CHANGE_INPUT_VERSION } from "./change-input-contract.js";
import { compileCentralLearningChange } from "./change-compile.js";
import { CentralDeliberationError } from "./deliberation-contract.js";
import { centralMaterialFromPage, centralMaterialPageRef } from "./deliberation-material.js";
import { decodeCentralDeliberation } from "./deliberation-prompt.js";
import { createOrganizationPublicationFragment, organizationPublicationHeadReadRef } from "./organization-publication-view.js";
import { createCentralRuntimeSource } from "./runtime-source.js";

function materialReads(input: CentralChangeInput, ref: string): readonly { readonly handle: string; readonly address: string }[] {
  const entry = input.dictionary.entries.find(row => row.ref === ref && row.kind === "source")
    ?? input.dictionary.entries.find(row => row.ref === ref && row.kind === "reference");
  assert.ok(entry);
  const rows = input.view.materials;
  assert.ok(Array.isArray(rows));
  const material = rows.find(row => row !== null && typeof row === "object" && !Array.isArray(row) && row.handle === entry.handle);

  assert.ok(material !== null && typeof material === "object" && !Array.isArray(material));
  const reads = material.reads;
  assert.ok(Array.isArray(reads));

  return reads.map(row => {
    assert.ok(row !== null && typeof row === "object" && !Array.isArray(row));
    assert.equal(typeof row.handle, "string");
    assert.equal(typeof row.address, "string");
    return { handle: String(row.handle), address: String(row.address) };
  });
}

test("formal issue evidence exposes request-only session reads while body JSON and reference handles cannot grant reads or workspace access", async t => {
  const parent = testScratchPath("central-source-evidence-read-tests");
  await mkdir(parent, { recursive: true });
  const root = await mkdtemp(path.join(parent, "case-")), sessions: SessionPort[] = [];

  t.after(async () => {
    for (const session of sessions) await session.release();
    assert.equal(path.dirname(path.resolve(root)), parent);
    assert.ok(path.basename(root).startsWith("case-"));
    await rm(root, { recursive: true, force: true });
  });
  const at = "2026-11-06T00:00:00.000Z", workspaceId = "workspace-c17-evidence", signal = new AbortController().signal;
  const ctx: CliContext = { homeDir: root, cwd: path.join(root, "workspace"), env: { TRYLO_HOME: path.join(root, "home") },
    nodeVersion: "v24.0.0", stdinIsTty: false, now: () => 0, newId: prefix => `${prefix}-evidence-test`,
    readFile(file) { try { return readFileSync(file, "utf8"); } catch { return undefined; } },
    isDirectory(file) { try { return statSync(file).isDirectory(); } catch { return false; } },

    readDir(directory) { try { return readdirSync(directory).map(name => {
      const stat = statSync(path.join(directory, name));
      return { name, bytes: stat.size, modifiedAtMs: stat.mtimeMs };
    }); } catch { return []; } },

    writeFile(file, value) {
      mkdirSync(path.dirname(file), { recursive: true });
      writeFileSync(file, value);
      return true;
    },

    stdout() {}, stderr() {}, readStdin: async () => "", readLine: async () => undefined, readSecret: async () => undefined };
  const localId = "c17-local-evidence", foreignId = "c17-foreign-evidence", turnId = `turn-${localId}`;
  const localRef = sessionContentAddress({ sessionId: localId, turnId, journalSequence: 2 });
  const foreignRef = sessionContentAddress({ sessionId: foreignId, turnId: `turn-${foreignId}`, journalSequence: 2 });
  const opaqueRef = "opaque:evidence-only";
  const bodyJson = JSON.stringify({ readRef: localRef, nextRef: foreignRef,
    evidenceRefs: [localRef, foreignRef], sourceRefs: [foreignRef, localRef] });
  const originalText = `Preserve the sender unit unless the receiver explicitly requests conversion.\n${bodyJson}`;

  for (const [id, originalWorkspace, text] of [[localId, workspaceId, originalText],
    [foreignId, "workspace-c17-foreign", "A foreign original must remain outside the current workspace."]] as const) {
    const session = createNdjsonSessionStore({ path: sessionPath(ctx.homeDir, ctx.env, id) });
    sessions.push(session);
    assert.ok((await session.start({ sessionId: id, createdAt: at, fingerprint: { schemaVersion: "1", workspaceId: originalWorkspace,
      providerId: "local", model: "local", toolCatalogHash: "catalog" } })).ok);
    assert.ok((await session.append({ type: "turn_start", sessionId: id, turnId: `turn-${id}`, at, payload: { userSourceAvailable: true } })).ok);
    assert.ok((await session.append({ type: "turn_input", sessionId: id, turnId: `turn-${id}`, at, payload: { text } })).ok);
  }

  const boardRoot = methodBoardRoot(ctx.homeDir, ctx.env), issueId = "issue:c17-original-evidence";
  const reported = await withBoardWriter(boardRoot, board => board.apply({ type: "coordinate_learning", commandId: "report:c17-original-evidence", issuedAt: at,
    action: { kind: "report", scope: ctx.cwd, issueId, problemKey: "handoff:unit-evidence", report: {
      reportId: "report:c17-evidence", source: { subsystem: "tool", taskId: turnId, versionId: localId },
      facts: ["The original report points to its source-owned session evidence.", bodyJson], evidenceRefs: [localRef, foreignRef, opaqueRef] } } }));

  assert.ok(reported.ok);
  const host = createCentralRuntimeMaterials({ ctx, workspaceId, enabled: () => true });
  const source = createCentralRuntimeSource({ boardRoot, scope: ctx.cwd, ports: [], enabled: () => true,
    pageReader: host.pageReader, peerSources: [host] });
  const issueMaterials = await source.read(ctx.cwd, [issueId], 8192, signal);
  assert.equal(issueMaterials.length, 1);
  const issueMaterial = issueMaterials[0]!;

  for (const ref of [localRef, foreignRef, opaqueRef]) assert.ok(issueMaterial.sourceRefs.includes(ref));

  const board = await createBoardReader(boardRoot).load();
  assert.ok(board.ok);
  const request = (materials: readonly CentralRuntimeMaterial[]): CentralDeliberationRequest => ({
    schemaVersion: 1, scope: ctx.cwd, budgetId: "budget:c17-evidence", boardSequence: board.state.sequence,
    stateRef: initialCentralRuntimeRef(ctx.cwd), state: emptyCentralRuntimeState(ctx.cwd),
    configuration: { schemaVersion: 1, configurationRef: "configuration:c17-evidence", authorizationRef: "test-only:c17-evidence",
      allowance: { schemaVersion: 2, unit: "total_model_tokens", maxTokens: 10000, maxCalls: 2, maxSteps: 2, maxPromptChars: 32000 } },
    resources: { boardSequence: board.state.sequence, budgetId: "budget:c17-evidence", limits: { tokens: 10000, calls: 2, steps: 2 },
      occupied: { tokens: 0, calls: 0, steps: 0 }, available: { tokens: 10000, calls: 2, steps: 2 }, status: "available", holdReason: null },
    materials, organization: [], opportunities: [], operation: { kind: "think", operationId: "thought:c17-original-evidence",
      purpose: "Inspect original source evidence before proposing a learning goal.", expectedChange: "Obtain original body evidence.", sourceRefs: materials.map(row => row.ref) },
  });
  const input = request(issueMaterials), rendered = createCentralChangeView(input), reads = materialReads(rendered, issueMaterial.ref);
  const localRead = reads.find(row => row.address === localRef), foreignRead = reads.find(row => row.address === foreignRef);

  assert.ok(localRead, "a formal outer session source reference must have its own read capability");
  assert.ok(foreignRead);
  assert.equal(rendered.dictionary.read(localRead.handle), localRef);
  assert.equal(rendered.dictionary.source(localRead.handle), undefined);
  assert.equal(rendered.dictionary.citation(localRead.handle, originalText), undefined, "a read address does not deliver or authorize a quotation");
  assert.equal(reads.some(row => row.address === opaqueRef), false, "an opaque source reference is not a reader address");
  assert.equal(rendered.exposure.some(row => row.ref === localRef || row.ref === foreignRef), false);
  assert.ok(rendered.exposure.find(row => row.ref === issueMaterial.ref)?.readRefs.includes(localRef));
  const submission = (handle: string, view: CentralChangeInput) => ({ checkpoint: view.view.checkpoint,
    changes: [], explanation: "Request only the original addressed source.", inspect: {
    purpose: "Inspect the source-owned original", expectedChange: "Obtain its exact available body", refs: [handle], maximumChars: 8192 } });
  const compile = (handle: string) => decodeCentralDeliberation(compileCentralLearningChange(submission(handle, rendered), input, rendered.dictionary), input, []);
  const selected = compile(localRead.handle).agendaRead;
  assert.ok(selected);
  assert.deepEqual(selected.refs, [localRef]);
  const actual = await source.read(ctx.cwd, selected.refs, selected.maximumChars, signal);
  assert.equal(actual.length, 1);
  const page: unknown = JSON.parse(actual[0]!.text);

  assert.ok(page !== null && typeof page === "object" && "owner" in page && "text" in page && "originalScope" in page && "sourceHash" in page);
  assert.equal(page.owner, "session");
  assert.equal(page.originalScope, ctx.cwd);
  assert.equal(page.text, originalText);
  assert.equal(page.sourceHash, contentHashOf(originalText));
  const reference = rendered.dictionary.entries.find(row => row.kind === "reference" && row.ref === localRef);
  assert.ok(reference);

  for (const rawOrReference of [localRef, reference.handle]) assert.throws(() => compile(rawOrReference), error =>
    error instanceof CentralDeliberationError && error.reason === "central_learning_change_handle_unbound");

  const foreign = compile(foreignRead.handle).agendaRead;
  assert.ok(foreign);
  assert.deepEqual(foreign.refs, [foreignRef]);
  await assert.rejects(source.read(ctx.cwd, foreign.refs, foreign.maximumChars, signal), /scope/u,
    "a formally presented read address still passes through the original host's workspace permission boundary");

  const snapshot = await source.snapshot(ctx.cwd, signal);
  const catalog = snapshot.materials.find(row => row.ref.startsWith("central-runtime-catalog:"));
  assert.ok(catalog);
  const catalogView = createCentralChangeView(request([catalog]));
  assert.equal(catalogView.version, CENTRAL_CHANGE_INPUT_VERSION);
  const issueRead = materialReads(catalogView, catalog.ref).find(row => row.address === issueMaterial.ref);
  assert.ok(issueRead);
  assert.equal(catalogView.dictionary.read(issueRead.handle), issueMaterial.ref,
    "the original source-owned catalog still advertises its canonical issue read address");

  const prefix = originalText.slice(0, 48), partial = centralMaterialFromPage({ ref: localRef, originalRef: localRef,
    originalScope: ctx.cwd, owner: "session", origin: "user_statement", coordinate: { runId: localId, sequence: 2 },
    start: 0, end: prefix.length, totalChars: originalText.length, text: prefix, sourceHash: contentHashOf(originalText) });
  const assertContinuation = (material: CentralRuntimeMaterial, nextRef: string) => {
    const normal = createCentralChangeView(request([material]));
    const next = materialReads(normal, material.ref).find(row => row.address === nextRef);
    assert.ok(next);
    assert.equal(normal.dictionary.read(next.handle), nextRef);
    const packet: unknown = JSON.parse(material.text);
    assert.ok(packet !== null && typeof packet === "object" && !Array.isArray(packet));
    const tampered = { ...material, text: canonicalJson({ ...packet, nextRef: foreignRef }) };
    const rejected = createCentralChangeView(request([tampered]));

    assert.equal(rejected.dictionary.entries.some(row => row.kind === "read" && row.ref === foreignRef), false,
      "changing only nextRef under the original page identity cannot advertise another source");
    assert.equal(materialReads(rejected, tampered.ref).some(row => row.address === foreignRef), false);
  };

  assertContinuation(partial, centralMaterialPageRef(localRef, prefix.length));
  // The runtime wrapper's owner formula binds the original, offset and literal
  // fragment independently of its added nextRef field.
  const fragmentNext = `central-runtime-page:${prefix.length}:${encodeURIComponent(localRef)}`;
  const fragment: CentralRuntimeMaterial = { ref: `central-runtime-fragment:${contentHashOf([localRef, 0, prefix])}`,
    kind: "source", sourceRefs: [localRef], text: canonicalJson({ originalRef: localRef, start: 0, end: prefix.length,
      totalChars: originalText.length, text: prefix, nextRef: fragmentNext }) };

  assertContinuation(fragment, fragmentNext);

  const publicationFact = `organization-record:${contentHashOf("c17-original-publication-fact")}`;
  const headReadRef = organizationPublicationHeadReadRef(publicationFact, 0);
  const headText = "Earlier original organizing hypothesis. ".repeat(1000) + "This exact tail still requires source-bound review.";
  const tailText = headText.slice(-48);
  const tailBody = { originalRef: `organization-knowledge-view:${contentHashOf({ scope: ctx.cwd, text: headText })}`,
    originalReadRef: headReadRef, sourceHash: contentHashOf(headText), start: headText.length - tailText.length,
    end: headText.length, totalChars: headText.length, text: tailText, nextRef: null };
  const publicationTail = createOrganizationPublicationFragment(ctx.cwd, tailBody, [publicationFact]);
  const publicationInput = request([publicationTail]), publicationView = createCentralChangeView(publicationInput);
  const originalHead = materialReads(publicationView, publicationTail.ref).find(row => row.address === headReadRef);
  assert.ok(originalHead);
  assert.equal(publicationView.dictionary.read(originalHead.handle), headReadRef,
    "an original publication tail advertises its source-bound head starting address even when nextRef is null");
  const legacyTail = createCentralChangeView(publicationInput, LEGACY_CENTRAL_CHANGE_INPUT_VERSION);

  assert.equal(materialReads(legacyTail, publicationTail.ref).some(row => row.address === headReadRef), false,
    "the frozen v1 inventory does not acquire the new owner-specific originalReadRef capability");
  const otherHead = organizationPublicationHeadReadRef(`organization-record:${contentHashOf("c17-other-publication-fact")}`, 0);

  for (const changedReadRef of [foreignRef, otherHead]) {
    const tampered = { ...publicationTail, text: canonicalJson({ role: "organization_publication_fragment_not_read_body",
      ...tailBody, originalReadRef: changedReadRef }) };
    const rejected = createCentralChangeView(request([tampered]));
    assert.equal(rejected.dictionary.entries.some(row => row.kind === "read" && row.ref === changedReadRef), false,
      "changing the publication starting address under its original fragment identity cannot grant another read");
  }

  const wrongOwner = createOrganizationPublicationFragment(ctx.cwd, { ...tailBody, originalReadRef: otherHead }, [publicationFact]);

  assert.equal(createCentralChangeView(request([wrongOwner])).dictionary.entries.some(row => row.kind === "read" && row.ref === otherHead), false,
    "a recomputed fragment hash cannot replace the formal source fact which owns the head address");
  const ordinaryPublication: CentralRuntimeMaterial = { ref: "source:ordinary-publication-json", kind: "source",
    text: canonicalJson({ originalReadRef: headReadRef }), sourceRefs: [] };

  assert.equal(createCentralChangeView(request([ordinaryPublication])).dictionary.entries.some(row => row.kind === "read" && row.ref === headReadRef), false,
    "ordinary JSON cannot advertise a publication originalReadRef");

  const generic: CentralRuntimeMaterial = { ref: "source:ordinary-user-json", kind: "source", text: bodyJson, sourceRefs: [] };
  const genericInput = request([generic]), genericView = createCentralChangeView(genericInput);

  assert.deepEqual(materialReads(genericView, generic.ref).map(row => row.address), [generic.ref]);
  assert.deepEqual(genericView.exposure[0]?.readRefs, [generic.ref]);

  for (const ref of [localRef, foreignRef]) {
    assert.equal(genericView.dictionary.entries.some(row => row.kind === "read" && row.ref === ref), false);
    assert.throws(() => compileCentralLearningChange(submission(ref, genericView), genericInput, genericView.dictionary), error =>
      error instanceof CentralDeliberationError && error.reason === "central_learning_change_handle_unbound");
  }

  const together = createCentralChangeView(request([...issueMaterials, generic]));

  assert.ok(together.dictionary.entries.some(row => row.kind === "read" && row.ref === localRef));
  assert.deepEqual(materialReads(together, generic.ref).map(row => row.address), [generic.ref],
    "a read granted by another material's formal source relationship cannot be attributed to this ordinary JSON body");
});
