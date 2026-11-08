import assert from "node:assert/strict";
import test from "node:test";
import { validateFreezeCandidate, type FreezeCandidate } from "./freeze-record.js";

const SCOPE = [
  { id: "C01", scope: "in_scope" as const, primaryWorkPackage: "WP23" },
  { id: "C80", scope: "excluded_by_user" as const, primaryWorkPackage: "WP26" },
  { id: "A05", scope: "excluded_by_user" as const, primaryWorkPackage: "WP26" },
];

test("WP27.3: 四眼 + 证据齐备才可冻结", () => {
  const verdict = validateFreezeCandidate(
    {
      packageId: "WP23",
      sourceHash: "db1e428",
      reviewedHash: "db1e428",
      artifactPath: "dist/cmd/trylo/main.js",
      evidenceLink: "evidence/2026-10-06-WP23/",
      implementer: "zcode-agent",
      reviewer: "independent-reviewer",
      maturityClaim: "locally_verified",
    },
    SCOPE,
  );
  assert.equal(verdict.kind, "freezable");
});

test("WP27.3 红例：实现人冒充复核人不得冻结", () => {
  const verdict = validateFreezeCandidate(
    {
      packageId: "WP23",
      sourceHash: "db1e428",
      reviewedHash: "db1e428",
      artifactPath: "dist/cmd/trylo/main.js",
      evidenceLink: "evidence/2026-10-06-WP23/",
      implementer: "same-person",
      reviewer: "same-person",
      maturityClaim: "locally_verified",
    },
    SCOPE,
  );

  assert.equal(verdict.kind, "not_freezable");

  if (verdict.kind === "not_freezable") {
    assert.ok(verdict.failures.some((failure) => failure.code === "same_reviewer"));
  }
});

test("WP27.3 红例：缺 hash/制品/证据分别显式失败", () => {
  const verdict = validateFreezeCandidate(
    {
      packageId: "WP23",
      sourceHash: "  ",
      reviewedHash: "  ",
      artifactPath: "",
      evidenceLink: "",
      implementer: "builder",
      reviewer: "reviewer",
      maturityClaim: "interface_ready",
    },
    SCOPE,
  );

  assert.equal(verdict.kind, "not_freezable");

  if (verdict.kind === "not_freezable") {
    const codes = verdict.failures.map((failure) => failure.code);
    assert.ok(codes.includes("missing_hash"));
    assert.ok(codes.includes("missing_artifact"));
    assert.ok(codes.includes("missing_evidence"));
  }
});

test("WP27.3 红例：不拥有任何能力的包不得通过四眼冻结", () => {
  const unknownPackage = validateFreezeCandidate(
    {
      packageId: "WP99",
      sourceHash: "db1e428",
      reviewedHash: "db1e428",
      artifactPath: "dist/cmd/trylo/main.js",
      evidenceLink: "evidence/2026-10-06-WP23/",
      implementer: "builder",
      reviewer: "reviewer",
      maturityClaim: "locally_verified",
    },
    SCOPE,
  );

  assert.equal(unknownPackage.kind, "not_freezable");

  if (unknownPackage.kind === "not_freezable") {
    assert.ok(unknownPackage.failures.some((failure) => failure.code === "no_owned_capability"));
  }

  const emptyPackage = validateFreezeCandidate(
    {
      packageId: "",
      sourceHash: "db1e428",
      reviewedHash: "db1e428",
      artifactPath: "dist/cmd/trylo/main.js",
      evidenceLink: "evidence/2026-10-06-WP23/",
      implementer: "builder",
      reviewer: "reviewer",
      maturityClaim: "locally_verified",
    },
    SCOPE,
  );

  assert.equal(emptyPackage.kind, "not_freezable");
});

test("WP27.3 红例：排除包携 PASS 不得冻结", () => {
  const verdict = validateFreezeCandidate(
    {
      packageId: "WP26",
      sourceHash: "db1e428",
      reviewedHash: "db1e428",
      artifactPath: "dist/cmd/trylo/main.js",
      evidenceLink: "evidence/2026-10-07-WP26/",
      implementer: "builder",
      reviewer: "reviewer",
      maturityClaim: "release_accepted",
    },
    SCOPE,
  );

  assert.equal(verdict.kind, "not_freezable");

  if (verdict.kind === "not_freezable") {
    assert.ok(verdict.failures.some((failure) => failure.code === "excluded_claimed_pass"));
  }
});

test("WP27.3 红例：大小写不同的同一人视为同一复核人", () => {
  const verdict = validateFreezeCandidate(
    {
      packageId: "WP23",
      sourceHash: "db1e428",
      reviewedHash: "db1e428",
      artifactPath: "dist/cmd/trylo/main.js",
      evidenceLink: "evidence/2026-10-06-WP23/",
      implementer: "Alice",
      reviewer: "alice",
      maturityClaim: "locally_verified",
    },
    SCOPE,
  );

  assert.equal(verdict.kind, "not_freezable");

  if (verdict.kind === "not_freezable") {
    assert.ok(verdict.failures.some((failure) => failure.code === "same_reviewer"));
  }
});

test("WP27.3 红例：复核的不是将被冻结的那一版不得冻结", () => {
  const staleReview = validateFreezeCandidate(
    {
      packageId: "WP23",
      sourceHash: "newbuild1",
      reviewedHash: "oldbuild0",
      artifactPath: "dist/cmd/trylo/main.js",
      evidenceLink: "evidence/2026-10-06-WP23/",
      implementer: "builder",
      reviewer: "reviewer",
      maturityClaim: "locally_verified",
    },
    SCOPE,
  );

  assert.equal(staleReview.kind, "not_freezable");

  if (staleReview.kind === "not_freezable") {
    assert.ok(staleReview.failures.some((failure) => failure.code === "review_covers_other_revision"));
  }

  const noReviewedHash = validateFreezeCandidate(
    {
      packageId: "WP23",
      sourceHash: "newbuild1",
      reviewedHash: "",
      artifactPath: "dist/cmd/trylo/main.js",
      evidenceLink: "evidence/2026-10-06-WP23/",
      implementer: "builder",
      reviewer: "reviewer",
      maturityClaim: "locally_verified",
    },
    SCOPE,
  );

  assert.equal(noReviewedHash.kind, "not_freezable");
});

test("WP27.3 红例：成熟度断言必须是四档之一", () => {
  const verdict = validateFreezeCandidate(
    {
      packageId: "WP23",
      sourceHash: "db1e428",
      reviewedHash: "db1e428",
      artifactPath: "dist/cmd/trylo/main.js",
      evidenceLink: "evidence/2026-10-06-WP23/",
      implementer: "builder",
      reviewer: "reviewer",
      maturityClaim: "totally_verified" as FreezeCandidate["maturityClaim"],
    },
    SCOPE,
  );

  assert.equal(verdict.kind, "not_freezable");

  if (verdict.kind === "not_freezable") {
    assert.ok(verdict.failures.some((failure) => failure.code === "invalid_maturity"));
  }
});
