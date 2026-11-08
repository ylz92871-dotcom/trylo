import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { loadDiscoveryIndex } from "../acquisition/discovery-index.js";
import {
  mcpConnectionGrantsActivation,
  mcpSchemaIsTrustProof,
  mcpTransportIsPermission,
} from "../../../../../../tooling/catalog/mcp-trust.js";
import { rankTools, selectTools } from "../../../../../../tooling/catalog/keyword-score.js";
import { createRecordingBoardPort, submitBindingDraft } from "../../domain/index.js";
import { pressMyToolsButton } from "../../assets/my-tools/commands.js";
import { projectFromEvents, projectMyTools } from "../../assets/my-tools/projector.js";
import { acquireToQuarantine, isForbiddenQuarantineRoot } from "../quarantine/acquire.js";
import { inspectArchive } from "../../assets/quarantine/archive-guard.js";
import { classifySandboxOutcome, runFakeSandbox } from "../../../../../../tooling/sandbox/fake-executor.js";
import { archive, issuedGrantRef, memoryPermissionStore, pkg, provenance } from "../../../../../../tooling/testing/fixtures.js";
import { manifest } from "../../../../../../tooling/testing/fixtures.js";
import { appendEventFile, loadEventFile } from "./log.js";

test("My Tools rebuilds from canonical events and survives deletion of snapshots", () => {
  const recorded = pkg({ catalogState: "verified" });
  const events = [
    { kind: "package_recorded" as const, sequence: 1, pkg: recorded },
    {
      kind: "validation_recorded" as const,
      sequence: 2,
      record: {
        validationId: "v1",
        packageVersionId: recorded.packageVersionId,
        stages: [],
        verdict: "pass" as const,
        actor: "verifier" as const,
      },
    },
    {
      kind: "effect_recorded" as const,
      sequence: 3,
      packageVersionId: recorded.packageVersionId,
      effect: "improved" as const,
    },
  ];
  const rebuilt = projectFromEvents(events, []);

  assert.equal(rebuilt[0]?.lifecycle, "verified");
  assert.equal(rebuilt[0]?.effect, "improved");
  const again = projectFromEvents(events, [
    {
      packageVersionId: recorded.packageVersionId,
      scope: "docs",
      state: "active",
      boardSequence: 8,
    },
  ]);

  assert.equal(again[0]?.lifecycle, "active");
  assert.equal(projectMyTools({
    packages: [recorded],
    validations: [],
    activations: [],
    contributionByPackage: {},
  })[0]?.lifecycle, "verified");
});

test("corrupt event log fail-closes and does not skip checksums", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "trylo-ev-"));
  const file = path.join(root, "events.jsonl");

  try {
    await appendEventFile(file, {
      kind: "package_recorded",
      sequence: 1,
      pkg: pkg(),
    });
    await writeFile(file, '{"sequence":1,"checksum":"dead","event":{}}\n', "utf8");
    const loaded = await loadEventFile(file);

    assert.equal(loaded.ok, false);

    if (!loaded.ok) {
      assert.equal(loaded.code, "corrupt_log");
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("activation token is required before binding draft", async () => {
  const board = createRecordingBoardPort();
  const draft = {
    draftId: "d1",
    scope: "docs",
    taskFamily: "docs",
    packageVersionId: "pkg:pdf-lint:1.0.0",
    candidateId: "cand-mit",
  };
  const validation = {
    validationId: "v",
    packageVersionId: "pkg:pdf-lint:1.0.0",
    stages: [],
    verdict: "pass" as const,
    actor: "verifier" as const,
  };
  const denied = await submitBindingDraft(board, draft, validation, {
    now: "2026-09-12T00:00:00Z",
  });

  assert.equal(denied.ok, false);
  assert.deepEqual(board.snapshot(), []);
  const store = memoryPermissionStore();
  const acquire = await submitBindingDraft(board, draft, validation, {
    approvalPort: store,
    token: await issuedGrantRef(store, "acquire"),
    now: "2026-09-12T00:00:00Z",
  });

  assert.equal(acquire.ok, false, "an acquire grant cannot authorize activate");
  const okBind = await submitBindingDraft(board, draft, validation, {
    approvalPort: store,
    token: await issuedGrantRef(store, "activate"),
    now: "2026-09-12T00:00:00Z",
  });

  assert.equal(okBind.ok, true);
});

test("binding draft without an injected port is refused", async () => {
  const board = createRecordingBoardPort();
  const result = await submitBindingDraft(
    board,
    {
      draftId: "d-noport",
      scope: "docs",
      taskFamily: "docs",
      packageVersionId: "pkg:pdf-lint:1.0.0",
      candidateId: "cand-mit",
    },
    {
      validationId: "v",
      packageVersionId: "pkg:pdf-lint:1.0.0",
      stages: [],
      verdict: "pass",
      actor: "verifier",
    },
    { token: { grantId: "grant:unused" }, now: "2026-09-12T00:00:00Z" },
  );

  assert.equal(result.ok, false);

  if (!result.ok) {
    assert.equal(result.code, "no_port");
  }

  assert.deepEqual(board.snapshot(), []);
});

test("select: loads named tools without dumping every schema", () => {
  const tools = [
    { name: "pdf_lint", searchHint: "pdf", description: "pdf", shouldDefer: true, alwaysLoad: false },
    { name: "web_fetch", searchHint: "http", description: "http", shouldDefer: true, alwaysLoad: false },
  ];
  const selected = selectTools("select:pdf_lint", tools);

  assert.deepEqual(selected?.map((item) => item.name), ["pdf_lint"]);
  assert.equal(rankTools("select:pdf_lint", tools)[0]?.name, "pdf_lint");
});

test("MCP transport is not trust or permission", () => {
  assert.equal(mcpTransportIsPermission("stdio"), false);
  assert.equal(mcpSchemaIsTrustProof("2024-11-05"), false);
  assert.equal(mcpConnectionGrantsActivation(), false);
});

test("quarantine refuses PATH/core roots and missing SBOM", async () => {
  assert.equal(isForbiddenQuarantineRoot(path.join(process.cwd(), "src", "internal", "loop")), true);
  const root = await mkdtemp(path.join(os.tmpdir(), "trylo-sbom-"));

  try {
    const store = memoryPermissionStore();
    const result = await acquireToQuarantine({
      approvalPort: store,
      token: await issuedGrantRef(store, "acquire"),
      now: "2026-09-12T00:00:00Z",
      candidateId: "cand-mit",
      packageVersionId: "pkg:pdf-lint:1.0.0",
      scope: "docs",
      quarantineRoot: root,
      archive: archive(),
      compressedBytes: 8,
      manifest: manifest(),
      provenance: provenance({ sbom: "" }),
    });

    assert.equal(result.ok, false);

    if (!result.ok) {
      assert.equal(result.code, "missing_sbom");
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("downloader entries cannot bypass archive audit", () => {
  const result = inspectArchive(
    archive({
      entries: [{ path: "fetch.sh", kind: "file", size: 8, content: "curl", downloader: true }],
    }),
    8,
  );

  assert.equal(result.ok, false);

  if (!result.ok) {
    assert.equal(result.code, "downloader_forbidden");
  }
});

test("fake sandbox classifies crash as unknown never success", () => {
  assert.equal(classifySandboxOutcome("crash"), "unknown");
  const crash = runFakeSandbox({
    outcome: "crash",
    permissionDenied: true,
    maliciousInput: true,
    repeatCall: false,
  });

  assert.equal(crash.ok, true);

  if (crash.ok) {
    assert.equal(crash.value.classified, "unknown");
    assert.equal(crash.value.crashClassifiedUnknown, true);
  }
});

test("My Tools buttons emit commands without mutating entries", () => {
  const before = projectMyTools({
    packages: [pkg({ catalogState: "verified" })],
    validations: [],
    activations: [],
    contributionByPackage: {},
  });
  const press = pressMyToolsButton("suspend", "pkg:pdf-lint:1.0.0");

  assert.equal(press.mutated, false);
  assert.equal(press.command.kind, "request_suspend");
  const after = projectMyTools({
    packages: [pkg({ catalogState: "verified" })],
    validations: [],
    activations: [],
    contributionByPackage: {},
  });

  assert.equal(after[0]?.lifecycle, before[0]?.lifecycle);
});

test("permission stores do not share grant state", async () => {
  const left = memoryPermissionStore();
  const right = memoryPermissionStore();
  const grant = await issuedGrantRef(left, "acquire");
  const use = {
    token: grant,
    action: "acquire" as const,
    candidateId: "cand-mit",
    packageVersionId: "pkg:pdf-lint:1.0.0",
    scope: "docs",
    now: "2026-09-12T00:00:00Z",
  };

  assert.equal((await left.consume(use)).ok, true);
  assert.equal((await right.consume(use)).ok, false, "another store cannot verify a grant it did not issue");
  assert.equal((await left.consume(use)).ok, false);
});

test("fake discovery index loads from testdata without network", async () => {
  const indexPath = fileURLToPath(new URL("../../../../../../../../testdata/tool-learning/discovery-index.json", import.meta.url));
  const loaded = await loadDiscoveryIndex(indexPath);
  assert.equal(loaded.ok, true);
  if (loaded.ok) {
    assert.equal(loaded.value.length >= 2, true);
  }
});
