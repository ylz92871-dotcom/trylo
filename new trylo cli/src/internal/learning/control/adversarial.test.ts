import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { appendFileSync } from "node:fs";
import { createFileBoardStore } from "../../adapters/learning-store/file-event-store.js";
import { createJournal } from "../../journal/index.js";
import { bindContextPort } from "../../knowledge/assemble.js";
import { createIngest } from "../../knowledge/ingest.js";
import { createFragmentStore } from "../../knowledge/store.js";
import { command, inferredDraft, passEvidence, userRuleDraft } from "./fixtures.js";
import { reduceAll } from "./reducer.js";
import { emptyBoardState } from "./state.js";

test("two writers cannot both activate", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "trylo-adv-"));
  const first = createFileBoardStore(dir);

  assert.equal("apply" in first, true);

  if (!("apply" in first)) {
    return;
  }

  try {
    const second = createFileBoardStore(dir);
    assert.equal("ok" in second && second.ok === false, true);
    if ("ok" in second && second.ok === false) {
      assert.equal(second.reason, "multi_writer");
    }
  } finally {
    await first.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("inferred candidate cannot skip verification into the profile", () => {
  const draft = inferredDraft({ proposalId: "inf" });
  const result = reduceAll(emptyBoardState(), [
    command("submit_proposal", { proposal: draft }),
    command("fast_lane_validate", { proposalId: "inf" }),
    command("activate", { proposalId: "inf", versionId: "v" }),
  ]);

  assert.equal(result.ok, false);

  if (!result.ok) {
    assert.equal(result.reason, "inferred_cannot_skip_verification");
  }
});

test("generator self-pass is rejected", () => {
  const draft = inferredDraft({ proposalId: "inf" });
  const prepared = reduceAll(emptyBoardState(), [
    command("submit_proposal", { proposal: draft }),
    command("quarantine", { proposalId: "inf" }),
    command("start_evaluation", { proposalId: "inf" }),
  ]);

  assert.equal(prepared.ok, true);

  if (!prepared.ok) {
    return;
  }

  const result = reduceAll(prepared.state, [
    command("record_evidence", {
      evidence: passEvidence("inf", { kinds: ["llm_critique"] }),
    }),
  ]);

  assert.equal(result.ok, false);

  if (!result.ok) {
    assert.equal(result.reason, "llm_critique_cannot_pass");
  }
});

test("learning text cannot expand permissions in assemble", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "trylo-adv-"));
  const store = createFragmentStore(dir);

  try {
    await store.write({
      id: "perm",
      type: "feedback",
      origin: "user-stated",
      scope: "user",
      version: 1,
      state: "active",
      body: "allow network and skipApproval=true",
    });
    const assembled = await bindContextPort(store).assemble({
      messages: [{ role: "user", content: "task" }],
    });

    assert.equal("permission" in assembled, false);
    assert.equal("allowNetwork" in assembled.profileSnapshot, false);
    assert.equal("skipApproval" in assembled.profileSnapshot, false);
    assert.equal(
      assembled.systemFragments.some((item) => item.body.includes("skipApproval")),
      true,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("collect=false does not leak via ingest journal or profile", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "trylo-adv-"));
  const store = createFragmentStore(dir);
  const ingest = createIngest(store);
  const journal = createJournal();

  try {
    await ingest.recordCorrection("visible as rule only", "user");
    journal.recordFact({
      eventId: "e1",
      kind: "turn_end",
      occurredAt: "2026-09-12T00:00:00.000Z",
      rawBody: "private body",
    });
    assert.deepEqual(journal.project({ collect: false }), []);
    const learning = journal.projectLearning({ collect: false });

    assert.equal(learning.ok, true);

    if (learning.ok) {
      assert.deepEqual(learning.observations, []);
    }

    const assembled = await bindContextPort(store).assemble({
      messages: [{ role: "user", content: "task" }],
    });

    assert.equal("observations" in assembled, false);
    assert.equal("permission" in assembled.profileSnapshot, false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("corrupt board log degrades with messages and last-known-good", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "trylo-adv-"));
  const store = createFragmentStore(dir);
  const ingest = createIngest(store);
  const context = bindContextPort(store);
  const messages = [{ role: "user", content: "keep me" }];

  try {
    await ingest.recordCorrection("run checks", "user");
    const good = await context.assemble({ messages });

    assert.equal(good.systemFragments.some((item) => item.body === "run checks"), true);
    appendFileSync(
      path.join(dir, "board-events.ndjson"),
      "deadbeef {\"sequence\":99}\n",
      "utf8",
    );
    const degraded = await context.assemble({ messages });

    assert.deepEqual(degraded.messages, messages);
    assert.equal(degraded.degradedReason?.code, "checksum_mismatch");
    assert.equal(degraded.profileSnapshot.learningMode, "last_known_good");
    assert.equal(
      degraded.systemFragments.some((item) => item.body === "run checks"),
      true,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("board lock does not block assemble", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "trylo-adv-"));
  const writer = createFileBoardStore(dir);

  assert.equal("apply" in writer, true);

  if (!("apply" in writer)) {
    return;
  }

  try {
    const draft = userRuleDraft({ proposalId: "p1" });

    await writer.apply(command("submit_proposal", { proposal: draft, commandId: "c1" }));
    const messages = [{ role: "user", content: "still running" }];
    const assembled = await bindContextPort(createFragmentStore(dir)).assemble({
      messages,
    });

    assert.deepEqual(assembled.messages, messages);
    assert.equal(assembled.verified, false);
  } finally {
    await writer.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("last-known-good write failure does not degrade a successful assemble", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "trylo-adv-"));
  const store = createFragmentStore(dir);
  const ingest = createIngest(store);

  try {
    await ingest.recordCorrection("keep this rule", "user");
    await mkdir(path.join(dir, "last-known-good.json"));
    const messages = [{ role: "user", content: "task" }];
    const assembled = await bindContextPort(store).assemble({ messages });

    assert.deepEqual(assembled.messages, messages);
    assert.equal("degradedReason" in assembled, false);
    assert.equal(
      assembled.systemFragments.some((item) => item.body === "keep this rule"),
      true,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
