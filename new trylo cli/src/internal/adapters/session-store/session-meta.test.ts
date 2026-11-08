import assert from "node:assert/strict";
import { test } from "node:test";
import {
  defaultSessionMeta,
  normalizeDisplayName,
  parseSessionMeta,
  serializeSessionMeta,
} from "./session-meta.js";

/**
 * WP02 session sidecar contract (red-first).
 *
 * The sidecar (`<id>.meta.json`) carries rename/archive/fork-provenance and
 * migration facts. It is owned by the Session management service, never by
 * the journal writer — so a corrupt sidecar fails its own readers without
 * ever touching the durable journal.
 */

test("an absent sidecar reads as defaults, never as an error", () => {
  const loaded = parseSessionMeta(undefined);
  assert.equal(loaded.ok, true);
  if (!loaded.ok) return;
  assert.equal(loaded.present, false);
  assert.deepEqual(loaded.meta, defaultSessionMeta());
});

test("a corrupt sidecar fails closed with a code, not a guess", () => {
  for (const raw of ["{not json", JSON.stringify({ version: 2 }), JSON.stringify({ version: 1, archived: "yes" })]) {
    const loaded = parseSessionMeta(raw);
    assert.equal(loaded.ok, false, raw);
    if (loaded.ok) continue;
    assert.equal(loaded.code, "meta_corrupt");
  }
});

test("a well-formed sidecar round-trips through serialize", () => {
  const meta = {
    ...defaultSessionMeta(),
    displayName: "demo",
    archived: true,
    forkedFrom: {
      parentSessionId: "p",
      parentLastSequence: 3,
      snapshot: "interrupted" as const,
      at: "2026-10-04T01:00:00.000Z",
      droppedPending: 1,
      droppedPartials: 0,
      copiedRecords: 3,
    },
  };
  const loaded = parseSessionMeta(serializeSessionMeta(meta));

  assert.equal(loaded.ok, true);

  if (!loaded.ok) return;

  assert.deepEqual(loaded.meta, meta);
});

test("display names collapse whitespace and cap at 100 characters", () => {
  assert.equal(normalizeDisplayName("  hello   world  "), "hello world");
  assert.equal(normalizeDisplayName("   "), undefined);
  assert.equal(normalizeDisplayName("x".repeat(200))?.length, 100);
});

test("migrations survive the round-trip when present", () => {
  const meta = {
    ...defaultSessionMeta(),
    migrations: [
      {
        at: "2026-10-04T02:00:00.000Z",
        from: { schemaVersion: "1", providerId: "fixture", model: "old", toolCatalogHash: "h1", workspaceId: "w" },
        to: { schemaVersion: "1", providerId: "fixture", model: "new", toolCatalogHash: "h1", workspaceId: "w" },
        scope: ["model"] as const,
      },
    ],
  };
  const loaded = parseSessionMeta(serializeSessionMeta(meta));

  assert.equal(loaded.ok, true);

  if (!loaded.ok) return;

  assert.equal(loaded.meta.migrations?.length, 1);
});
