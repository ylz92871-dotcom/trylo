import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { canonicalJson, sha256Hex } from "../../learning/control/hash.js";
import type { ToolEvolutionCandidate, ToolEvolutionRequest } from "../../learning/domains/tool/evolution/contracts.js";
import type { IsolationOutcome, IsolationPort, IsolationRequest } from "../../ports/isolation.js";
import { createToolEvolutionVerifier } from "./process-verifier.js";

const BASE = path.resolve("Temp/tool-evolution-worker-20261028/verifier-tests");
const SIGNAL = new AbortController().signal;
const CANDIDATE: ToolEvolutionCandidate = {
  identity: "double", description: "Double a numeric input.", inputSchema: { type: "object" },
  source: 'module.exports = input => { if(typeof input.n !== "number") throw Object.assign(new Error("number required"), {code:"invalid_input"}); return input.n * 2; };',
  mastery: { whenToUse: ["Double numeric JSON input."], preconditions: ["n is a number."], pitfalls: ["Reject strings."] },
};
const REQUEST: ToolEvolutionRequest = {
  schemaVersion: 1, requestId: "double-request", scope: "test", capability: "double", operation: "create",
  evidence: [
    { sampleId: "source", role: "source", input: { n: 2 }, expected: { kind: "value", value: 4 } },
    { sampleId: "variation", role: "variation", input: { n: 7 }, expected: { kind: "value", value: 14 } },
    { sampleId: "counterexample", role: "counterexample", input: { n: "no" }, expected: { kind: "error", code: "invalid_input" } },
  ],
};

/** TEST ONLY. Exercises real child processes, not OS isolation or WFP enforcement. */
function hostProcessTestPort(observe?: (request: IsolationRequest) => void): IsolationPort {
  return {
    probe: async () => ({ state: "ready", backend: "windows-srt", evidence: "TEST ONLY: unconfined host-process contract seam" }),
    run: async request => {
      observe?.(request);
      return runHostProcess(request);
    },
  };
}

/** Known test fixtures cannot spawn descendants; kill only this owned child. */
function runHostProcess(request: IsolationRequest): Promise<IsolationOutcome> {
  return new Promise(resolve => {
    const child = spawn(request.argv[0] as string, request.argv.slice(1), {
      cwd: request.cwd, env: {}, windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "", stderr = "", timedOut = false;
    child.stdout?.setEncoding("utf8"); child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (text: string) => { stdout = (stdout + text).slice(0, 65_537); });
    child.stderr?.on("data", (text: string) => { stderr = (stderr + text).slice(0, 65_537); });
    const abort = (): void => { child.kill(); };
    const timer = setTimeout(() => { timedOut = true; child.kill(); }, request.timeoutMs);
    const cleanup = (): void => { clearTimeout(timer); request.signal.removeEventListener("abort", abort); };
    request.signal.addEventListener("abort", abort, { once: true });
    if (request.signal.aborted) abort();
    child.on("error", error => { cleanup(); resolve({ outcome: "isolation_failed", code: "isolation_start_failed", message: error.message }); });
    child.on("close", code => {
      cleanup();
      resolve(request.signal.aborted ? { outcome: "cancelled" } : {
        outcome: "completed", backend: "windows-srt", stdout, stderr, exitCode: code ?? -1, timedOut,
      });
    });
  });
}

async function scratch(): Promise<string> {
  const { mkdir } = await import("node:fs/promises");
  await mkdir(BASE, { recursive: true });
  return mkdtemp(path.join(BASE, "case-"));
}

async function verifySource(source: string, request = REQUEST) {
  const root = await scratch();
  try {
    return await createToolEvolutionVerifier({ isolation: hostProcessTestPort(), scratchRoot: root,
      nodeExecutable: process.execPath, timeoutMs: 500 }).verify({ ...CANDIDATE, source }, request, SIGNAL);
  } finally { await rm(root, { recursive: true, force: true }); }
}

test("JSON prototype-named output keys cannot disappear and satisfy an empty-object expectation", async () => {
  const request: ToolEvolutionRequest = { ...REQUEST, evidence: REQUEST.evidence.map(sample => sample.expected.kind === "value"
    ? { ...sample, expected: { kind: "value", value: {} } } : sample) };
  const report = await verifySource('module.exports = input => { if(typeof input.n !== "number") throw Object.assign(new Error("invalid"), {code:"invalid_input"}); return JSON.parse(\'{"__proto__":1}\'); };', request);
  assert.equal(report.verdict, "fail");
  assert.equal(report.checks.filter(check => check.outcome === "wrong_result").length, 2);
});

test("process verifier executes caller-owned source, variation, and counterexample samples in fresh processes", async () => {
  const requests: IsolationRequest[] = [];
  const root = await scratch();
  try {
    const result = await createToolEvolutionVerifier({ isolation: hostProcessTestPort(request => requests.push(request)),
      scratchRoot: root, nodeExecutable: process.execPath }).verify(CANDIDATE, REQUEST, SIGNAL);
    assert.equal(result.verdict, "pass", JSON.stringify(result));
    assert.deepEqual(result.checks.map(check => [check.sampleId, check.role, check.outcome]),
      REQUEST.evidence.map(sample => [sample.sampleId, sample.role, "passed"]));
    assert.equal(result.candidateHash, sha256Hex(canonicalJson(CANDIDATE)));
    assert.equal(result.samplesHash, sha256Hex(canonicalJson(REQUEST.evidence)));
    assert.equal(requests.length, 3);
    for (const request of requests) {
      assert.deepEqual(request.env, {});
      assert.deepEqual(request.network.allowedDomains, []);
      assert.equal(request.argv.some(arg => arg.includes("expected")), false);
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("process verifier cannot accept a candidate that prints a forged result and exits before exporting work", async () => {
  const request = { ...REQUEST, evidence: REQUEST.evidence.map(sample => ({ ...sample, expected: { kind: "value" as const, value: 1 } })) };
  const result = await verifySource('console.log("TRYLO_TOOL_RESULT:" + JSON.stringify({kind:"value",value:1})); process.exit(0);', request);
  assert.equal(result.verdict, "fail", "a forged stdout frame is not execution evidence");
});

test("process verifier refuses duplicate or polluted protocol markers even if the function result matches", async () => {
  const result = await verifySource('console.log("TRYLO_TOOL_RESULT:" + JSON.stringify({kind:"value",value:4})); ' + CANDIDATE.source);
  assert.equal(result.verdict, "fail");
});

test("process verifier refuses lossy JSON values instead of converting them into matching expectations", async () => {
  const request = { ...REQUEST, evidence: REQUEST.evidence.map(sample => ({ ...sample, expected: { kind: "value" as const, value: {} } })) };
  const result = await verifySource('module.exports = () => ({missing:undefined});', request);
  assert.equal(result.verdict, "fail");
});

test("process verifier does not let candidate prototype hooks rewrite its trusted result envelope", async () => {
  const request = { ...REQUEST, evidence: REQUEST.evidence.map(sample => ({ ...sample, expected: { kind: "value" as const, value: 1 } })) };
  const result = await verifySource('Object.prototype.toJSON = () => ({kind:"value",value:1}); module.exports = () => 0;', request);
  assert.equal(result.verdict, "fail");
});

test("process verifier separates module-load errors from errors raised by an invoked tool", async () => {
  const request = { ...REQUEST, evidence: REQUEST.evidence.map(sample => ({ ...sample, expected: { kind: "error" as const, code: "tool_error" } })) };
  const result = await verifySource('throw new Error("module did not load");', request);
  assert.equal(result.verdict, "fail");
});

test("process verifier refuses wrong results, nonzero exits, and invalid JSON returns", async () => {
  for (const source of ['module.exports=()=>999;', 'process.exit(9);', 'module.exports=()=>1n;', 'module.exports=()=>undefined;']) {
    const result = await verifySource(source);
    assert.equal(result.verdict, "fail");
    assert.ok(result.checks.every(check => check.outcome !== "passed"));
  }
});

test("process verifier classifies genuine execution timeout", async () => {
  const result = await verifySource('module.exports=()=>{while(true){}};');
  assert.equal(result.verdict, "fail");
  assert.ok(result.checks.every(check => check.outcome === "timeout"));
});

test("process verifier rejects empty or duplicate case identifiers before execution", async () => {
  let runs = 0;
  const port = hostProcessTestPort(() => { runs += 1; });
  const root = await scratch();
  try {
    const verifier = createToolEvolutionVerifier({ isolation: port, scratchRoot: root, nodeExecutable: process.execPath });
    assert.equal((await verifier.verify(CANDIDATE, { ...REQUEST, evidence: [] }, SIGNAL)).verdict, "fail");
    const evidence = REQUEST.evidence.map(sample => ({ ...sample, sampleId: "same-id" }));
    assert.equal((await verifier.verify(CANDIDATE, { ...REQUEST, evidence }, SIGNAL)).verdict, "fail");
    assert.equal(runs, 0);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("process verifier never runs or falls back after an unavailable isolation probe", async () => {
  let runs = 0;
  const root = await scratch();
  const isolation: IsolationPort = {
    probe: async () => ({ state: "unavailable", reason: "no OS isolation" }),
    run: async () => { runs += 1; throw new Error("must not run"); },
  };
  try {
    const result = await createToolEvolutionVerifier({ isolation, scratchRoot: root, nodeExecutable: process.execPath })
      .verify(CANDIDATE, REQUEST, SIGNAL);
    assert.equal(result.verdict, "unavailable");
    assert.equal(runs, 0);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("process verifier classifies cancellation, backend errors, and failed cleanup without pass", async () => {
  const outcomes: readonly IsolationOutcome[] = [
    { outcome: "cancelled" },
    { outcome: "isolation_failed", code: "isolation_start_failed", message: "refused" },
    { outcome: "completed", backend: "windows-srt", stdout: "", stderr: "", exitCode: 0, timedOut: false,
      cleanupFailure: { code: "isolation_cleanup_failed", message: "cleanup did not finish" } },
  ];
  for (const outcome of outcomes) {
    const root = await scratch();
    try {
      const isolation: IsolationPort = { probe: hostProcessTestPort().probe, run: async () => outcome };
      const result = await createToolEvolutionVerifier({ isolation, scratchRoot: root, nodeExecutable: process.execPath })
        .verify(CANDIDATE, REQUEST, SIGNAL);
      assert.equal(result.verdict, outcome.outcome === "cancelled" ? "cancelled" : "unavailable");
    } finally { await rm(root, { recursive: true, force: true }); }
  }
});

test("process verifier setup errors remain typed and cancellation before setup creates no process", async () => {
  const root = await scratch();
  const file = path.join(root, "not-a-directory");
  await writeFile(file, "occupied");
  try {
    const verifier = createToolEvolutionVerifier({ isolation: hostProcessTestPort(), scratchRoot: file, nodeExecutable: process.execPath });
    assert.equal((await verifier.verify(CANDIDATE, REQUEST, SIGNAL)).verdict, "unavailable");
    const controller = new AbortController(); controller.abort();
    assert.equal((await verifier.verify(CANDIDATE, REQUEST, controller.signal)).verdict, "cancelled");
  } finally { await rm(root, { recursive: true, force: true }); }
});
