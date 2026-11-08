import assert from "node:assert/strict";
import test from "node:test";
import { collectEntries, mergePublic } from "./merge.js";
import { sealDocument } from "./document.js";
import { statusRowFor } from "./resolve.js";
import { emptyDocument } from "./document.js";
import type { CredentialRecord, CredentialStatusRow } from "../ports/credentials.js";

/**
 * The merged public view (WP §2.3 `exportPublic`).
 *
 * `exportPublic` is the shape a `doctor` line or a `--json` flag would render, so
 * these tests pin three things: the view carries only the public fields, the
 * ordering is stable (two exports of the same ledger are byte-identical), and
 * `list`'s `isCurrent` agrees with the scope's own pointer.
 */

const RECORD_A: CredentialRecord = {
  formatVersion: 1,
  accountId: "acct-a",
  providerId: "openai-compatible",
  label: "work",
  secret: "sk-a",
  createdAt: "2026-09-15T00:00:00.000Z",
  updatedAt: "2026-09-15T00:00:00.000Z",
};

const RECORD_B: CredentialRecord = {
  formatVersion: 1,
  accountId: "acct-b",
  providerId: "openai-compatible",
  secret: "sk-b",
  createdAt: "2026-09-15T00:00:00.000Z",
  updatedAt: "2026-09-15T00:00:00.000Z",
};

const STATUS: ReadonlyArray<CredentialStatusRow> = [
  { providerId: "openai-compatible", layer: "user", accountId: "acct-a", label: "work", loggedIn: true },
  { providerId: "fixture", layer: "none", accountId: "", loggedIn: false },
];

test("exportPublic carries no secret field anywhere", () => {
  const user = sealDocument({
    formatVersion: 1,
    current: { "openai-compatible": "acct-a" },
    records: [RECORD_A],
  });
  const view = mergePublic({ status: STATUS, ...collectEntries(user, undefined) });
  const rendered = JSON.stringify(view);

  assert.equal(rendered.includes("sk-a"), false);
  assert.equal(rendered.includes("secret"), false);
});

test("the merged view orders providers by the port's table, then account id", () => {
  const user = sealDocument({
    formatVersion: 1,
    current: { "openai-compatible": "acct-b" },
    records: [RECORD_B, RECORD_A],
  });
  const view = mergePublic({ status: STATUS, ...collectEntries(user, undefined) });

  assert.deepEqual(
    view.entries.map((entry) => entry.accountId),
    ["acct-a", "acct-b"],
  );
});

test("isCurrent agrees with the scope's own pointer", () => {
  const user = sealDocument({
    formatVersion: 1,
    current: { "openai-compatible": "acct-b" },
    records: [RECORD_A, RECORD_B],
  });
  const entries = collectEntries(user, undefined).userEntries;

  assert.deepEqual(
    entries.filter((entry) => entry.isCurrent).map((entry) => entry.accountId),
    ["acct-b"],
  );
});

test("project entries are excluded when there is no project document", () => {
  const collected = collectEntries(emptyDocument(), undefined);
  assert.deepEqual(collected.projectEntries, []);
  assert.deepEqual(collected.userEntries, []);
});

test("a status row is derived from resolution and never carries a secret", () => {
  const row = statusRowFor({
    providerId: "openai-compatible",
    env: { TRYLO_API_KEY: "sk-env" },
    project: emptyDocument(),
    hasProject: false,
    user: emptyDocument(),
  });

  assert.equal(row.layer, "env");
  assert.equal(row.loggedIn, true);
  assert.equal(JSON.stringify(row).includes("sk-env"), false);
});
