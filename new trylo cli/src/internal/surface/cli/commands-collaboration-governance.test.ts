import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createFileCollaborationBoard } from "../../integration/collaboration-learning/board-port.js";
import { createCollaborationSubsystemV2 } from "../../learning/domains/collaboration/v2-service.js";
import type { CollaborationV2Context } from "../../learning/domains/collaboration/v2-contracts.js";
import { handleCollaborationGovernance } from "./commands-collaboration-governance.js";
import { parseArgs } from "./args.js";
import type { CliContext } from "./context.js";

test("explicit user governance persists scope-matched suspend/restore without starting a provider or team", async () => {
  const root = mkdtempSync(join(tmpdir(), "collaboration-governance-")), home = join(root, "profile");
  const out: string[] = [];
  let id = 0;
  const unexpected = (): never => { throw new Error("governance constructed unrelated IO"); };
  const ctx: CliContext = { env: { TRYLO_HOME: home }, homeDir: root, cwd: root, nodeVersion: "v24.0.0", stdinIsTty: false,
    readFile: unexpected, readDir: unexpected, writeFile: unexpected, isDirectory: path => path === root,
    readStdin: unexpected, readLine: unexpected, readSecret: unexpected, stdout: s => out.push(s), stderr: unexpected,
    now: () => 1793635200000, newId: () => `user-correction-${++id}` };
  const context: CollaborationV2Context = { scope: root, teamRunId: "team", taskId: "task", round: 1, memberId: "worker",
    role: "worker", taskFamily: "mapping", dependency: "artifact", coordinationMode: "sequential", difficulty: "unknown",
    members: [{ memberId: "worker", role: "worker" }, { memberId: "reviewer", role: "reviewer" }] };
  const board = createFileCollaborationBoard(join(home, "learning", "board"));
  const service = createCollaborationSubsystemV2({ board, ownerId: "seed-owner", now: () => "2026-11-03T00:00:00.000Z", analyzer: {
    async analyze({ window }) { return { status: "proposed", tokenCost: 50, usage: { status: "reported", totalTokens: 50, elapsedMs: 1 },
      proposals: [{ familyId: "missing-reference", title: "Ask for the missing reference", hypothesis: "Missing references may explain observed waiting.",
        alternatives: [{ cause: "coordination", explanation: "The reference was not shared.", evidenceRefs: ["actual-request"] },
          { cause: "unknown", explanation: "Member capability has not been established.", evidenceRefs: ["actual-request"] }],
        discriminator: { observation: "Compare the next delivered reference with the next independent result.", distinguishes: ["coordination", "unknown"] },
        conditions: { dependency: "artifact", taskFamilies: ["mapping"], roles: [], coordinationModes: [], difficulty: [], minimumMembers: 2 },
        actions: [{ actionId: "request-reference", dimension: "handoff", audience: "member", operation: "request_context",
          instruction: "Request the producer reference before dependent work.", expectedObservable: "A context request is actually delivered." }],
        failureConditions: ["The complete reference is already present."], sourceEventIds: window.events.map(e => e.factId),
        sourceEpisodeIds: [], sourceOutcomeIds: [] }] }; },
  } });
  const command = (...args: string[]) => {
    const parsed = parseArgs(["learn", "collaboration", ...args]);
    assert.equal(parsed.kind, "learn");
    if (parsed.kind !== "learn" || !("operation" in parsed.options)) throw new Error("Expected explicit governance command");
    return handleCollaborationGovernance(ctx, parsed.options);
  };

  try {
    const observed = await service.observe({ schemaVersion: 2, kind: "event", factId: "actual-request", scope: root,
      recordedAt: "2026-11-03T00:00:00.000Z", context, dimension: "handoff", action: "request_context", summary: "Requested missing reference.",
      source: "runtime", evidenceRefs: ["runtime:delivered"], causedBy: [], metrics: {} });

    assert.equal(observed.ok, true, JSON.stringify(observed));
    assert.equal((await service.invoke({ subsystem: "collaboration", scope: root, requestId: "seed",
      grant: { maxSteps: 1, maxModelCalls: 1, maxModelTokens: 2000, maxPromptChars: 3000 } })).ok, true);
    assert.equal((await service.prepareActions(context, "member", 3000)).kind, "selected");
    assert.equal(await command("status", "--json"), 0);
    assert.equal(JSON.parse(out.at(-1)!).practices[0].status, "trial");
    assert.equal(JSON.parse(out.at(-1)!).usageTotals.chargedTokens, 50);
    assert.equal(id, 0, "read-only status must not allocate an identity");
    const base = ["correct", "--family", "missing-reference", "--evidence-ref", "user:wrong-context", "--json"];

    assert.equal(await command(...base, "--action", "suspend", "--scope", "workspace"), 0);
    const correctionId = JSON.parse(out.at(-1)!).correctionId;

    assert.equal((await service.prepareActions(context, "member", 3000)).kind, "skip");
    assert.equal(await command("status", "--workspace", root, "--json"), 0);
    assert.equal(JSON.parse(out.at(-1)!).practices[0].status, "suspended");
    assert.equal(await command(...base, "--action", "restore", "--scope", "class", "--task-family", "mapping", "--role", "worker", "--replaces", correctionId), 1);
    assert.equal(JSON.parse(out.at(-1)!).reason, "correction_restore_scope_mismatch");
    assert.equal(await command(...base, "--action", "restore", "--scope", "workspace", "--replaces", correctionId), 0);
    assert.equal((await service.prepareActions(context, "member", 3000)).kind, "selected");
    assert.equal(await command(...base.map(s => s === "missing-reference" ? "unknown-family" : s), "--action", "suspend", "--scope", "workspace"), 1);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
