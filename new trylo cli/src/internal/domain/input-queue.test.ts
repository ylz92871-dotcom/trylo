import assert from "node:assert/strict";
import { test } from "node:test";
import {
  admit,
  belongsToTurn,
  closeInbox,
  drainInbox,
  MAX_PENDING_INPUT,
  openInbox,
  pendingCount,
  type UserInputInbox,
} from "./input-queue.js";

/**
 * The inbox one turn reads from (WP08.1 / WP08.3).
 *
 * The queue's promotion rules are covered in `loop-gap.test.ts`; what is tested
 * here is the part that decides whether a message is *offered* at all, and what
 * happens to the ones nobody took. Every case below is a question a person
 * actually asks: did you hear me, how many are you holding, and what happened
 * to the ones you never read.
 */

const TURN = "turn-a";

function offer(inbox: UserInputInbox, text: string, turnId = TURN): UserInputInbox {
  const verdict = admit(inbox, { text, mode: "queue", turnId });
  assert.equal(verdict.kind, "accepted", `expected "${text}" to be accepted`);
  return verdict.inbox;
}

function fill(inbox: UserInputInbox): UserInputInbox {
  let current = inbox;
  for (let index = 0; index < MAX_PENDING_INPUT; index += 1) {
    current = offer(current, `message-${index}`);
  }
  return current;
}

test("an inbox starts empty and bound to one turn", () => {
  const inbox = openInbox(TURN);
  assert.equal(inbox.turnId, TURN);
  assert.deepEqual(inbox.items, []);
  assert.equal(inbox.closed, false);
  assert.equal(pendingCount(inbox.items), 0);
});

test("a blank message is refused, and refusing it changes nothing", () => {
  const before = openInbox(TURN);
  for (const text of ["", "   ", "\n\t"]) {
    const verdict = admit(before, { text, mode: "steer", turnId: TURN });
    assert.equal(verdict.kind, "rejected");
    assert.equal(verdict.kind === "rejected" ? verdict.reason : "", "blank");
    assert.deepEqual(verdict.inbox, before);
  }
});

test("a message typed for a different turn is refused, not delivered late", () => {
  const inbox = openInbox(TURN);
  const verdict = admit(inbox, { text: "meant for the previous turn", mode: "steer", turnId: "turn-previous" });
  assert.equal(verdict.kind, "rejected");
  assert.equal(verdict.kind === "rejected" ? verdict.reason : "", "turn_mismatch");
  assert.deepEqual(verdict.inbox.items, []);
});

test("the queue is bounded, and the refusal says it is full", () => {
  let inbox = fill(openInbox(TURN));

  assert.equal(pendingCount(inbox.items), MAX_PENDING_INPUT);

  const verdict = admit(inbox, { text: "one too many", mode: "queue", turnId: TURN });

  assert.equal(verdict.kind, "rejected");
  assert.equal(verdict.kind === "rejected" ? verdict.reason : "", "full");
  inbox = verdict.inbox;
  assert.equal(pendingCount(inbox.items), MAX_PENDING_INPUT);
  // The refused message was never appended, so the ones already waiting keep
  // their order — a refusal is not a reordering.
  assert.equal(inbox.items[0]?.text, "message-0");
});

test("draining hands each message over exactly once", () => {
  let inbox = offer(openInbox(TURN), "first");

  inbox = offer(inbox, "second");

  const first = drainInbox(inbox);

  assert.deepEqual(first.taken.map((item) => item.text), ["first", "second"]);
  assert.deepEqual(first.inbox.items, []);

  const second = drainInbox(first.inbox);

  assert.deepEqual(second.taken, []);
});

test("every accepted message carries the turn it was typed for", () => {
  const inbox = offer(openInbox(TURN), "addressed");
  const { taken } = drainInbox(inbox);
  assert.equal(taken.length, 1);
  assert.equal(taken[0]?.turnId, TURN);
});

test("closing hands back what was never taken, and refuses anything after", () => {
  let inbox = offer(openInbox(TURN), "never read");

  inbox = offer(inbox, "also never read");

  const closed = closeInbox(inbox);

  assert.deepEqual(closed.unconsumed.map((item) => item.text), ["never read", "also never read"]);
  assert.deepEqual(closed.inbox.items, []);
  assert.equal(closed.inbox.closed, true);

  // A cancelled turn must not keep collecting: after the close, every offer is
  // refused with the one reason that explains it.
  const late = admit(closed.inbox, { text: "after the end", mode: "steer", turnId: TURN });

  assert.equal(late.kind, "rejected");
  assert.equal(late.kind === "rejected" ? late.reason : "", "turn_closed");
});

test("a closed inbox is still closed when it is empty", () => {
  const closed = closeInbox(openInbox(TURN));
  assert.deepEqual(closed.unconsumed, []);
  assert.equal(closed.inbox.closed, true);
});

test("belongsToTurn: an addressed message, an unaddressed one, and a foreign one", () => {
  assert.equal(belongsToTurn({ text: "x", mode: "queue", turnId: TURN }, TURN), true);
  assert.equal(belongsToTurn({ text: "x", mode: "queue", turnId: "turn-b" }, TURN), false);
  // Unaddressed input predates identity; there is no turn it contradicts.
  assert.equal(belongsToTurn({ text: "x", mode: "queue" }, TURN), true);
});
