import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server, type ServerResponse } from "node:http";
import os from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  compareArms,
  runFixtureArm,
  runRealProviderArm,
  scrubCredentialEnv,
  type HarnessSample,
} from "./regression-harness.js";
import { createCliCredentialPort } from "../surface/cli/credentials-wiring.js";

/**
 * W2 Black-box Regression Harness Contract (WP 2026-09-17 地基收口 W2):
 *
 *  1. Fixture arm is 100% green without credentials or network access.
 *  2. Real-provider arm gates strictly on credentials:
 *     when missing, records BLOCKED_MISSING_CREDENTIAL, never falsifying green.
 *  3. When credentials exist (or local endpoint provided), real arm lights up.
 *  4. Harness compares both arms across the same sample.
 *  5. Every arm is hermetic by construction: its ambient snapshot is
 *     `hermeticEnv(home)`, so neither the host shell's credential variables nor
 *     the developer's real ledger can move a result (WP-CLI-LIVE L2).
 */

const SAMPLE_QUERY_PACKAGE: HarnessSample = {
  id: "sample-query-package",
  description: "Read workspace package name and report it",
  prompt: "What is the package name of this project?",
  expectedTools: ["read_file"],
  expectedOutputSubstring: "harness-fixture-workspace",
};

/**
 * The ambient snapshot a hermetic arm may see: a synthetic home, and not one
 * credential name.
 *
 * This is the only way an arm in this file is ever configured. Reading the host
 * environment instead is what let a real `~/.trylo` credential decide whether the
 * gate test passed, and — when the default endpoint applied — let the arm leave
 * for the public internet.
 */
function hermeticEnv(homeDir: string): Readonly<Record<string, string | undefined>> {
  return { ...scrubCredentialEnv(process.env), TRYLO_HOME: homeDir };
}

/** A fresh home directory with no ledger under it, so discovery must find nothing. */
function emptyHomeDir(): string {
  return mkdtempSync(join(os.tmpdir(), "harness-empty-home-"));
}

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
}

function sse(res: ServerResponse, frames: readonly unknown[]): void {
  res.writeHead(200, { "content-type": "text/event-stream" });
  for (const frame of frames) {
    res.write(`data: ${JSON.stringify(frame)}\n\n`);
  }
  res.write("data: [DONE]\n\n");
  res.end();
}

const STOP_FRAMES: ReadonlyArray<unknown> = [
  {
    choices: [
      {
        delta: { content: "The package name is harness-real-workspace." },
        finish_reason: "stop",
      },
    ],
    usage: { prompt_tokens: 10, completion_tokens: 8, total_tokens: 18 },
  },
];

function startMockRealEndpoint(): Promise<{ readonly url: string; readonly close: () => Promise<void> }> {
  const server: Server = createServer((req, res) => {
    let body = "";

    req.setEncoding("utf8");
    req.on("data", (chunk: string) => {
      body += chunk;
    });
    req.on("end", () => {
      sse(res, STOP_FRAMES);
    });
  });

  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address !== null ? address.port : 0;

      resolve({
        url: `http://127.0.0.1:${port}/v1/chat/completions`,
        close: () =>
          new Promise<void>((done) => {
            server.close(() => done());
          }),
      });
    });
  });
}

test("W2 Harness Fixture 臂：离线全绿可重复，不需要真网络或凭据", async () => {
  const result = await runFixtureArm(SAMPLE_QUERY_PACKAGE);

  assert.equal(result.status, "PASSED");
  assert.equal(result.exitCode, 0);
  assert.equal(result.arm, "fixture");
  assert.equal(result.sampleId, SAMPLE_QUERY_PACKAGE.id);
  assert.notEqual(result.events, undefined);

  const eventTypes = (result.events ?? []).map((e) => e["type"]);

  assert.equal(eventTypes.includes("run_start"), true);
  assert.equal(eventTypes.includes("tool_use"), true);
  assert.equal(eventTypes.includes("run_result"), true);

  assert.equal(
    result.lastMessage?.includes("harness-fixture-workspace"),
    true,
    `lastMessage should report package name: ${result.lastMessage}`,
  );
});

test("W2 Harness Real-Provider 臂门控：无凭据时如实报告 BLOCKED_MISSING_CREDENTIAL，不冒充通过", async () => {
  const emptyHome = emptyHomeDir();

  try {
    const result = await runRealProviderArm(SAMPLE_QUERY_PACKAGE, {
      homeDir: emptyHome,
      env: hermeticEnv(emptyHome),
    });

    assert.equal(result.status, "BLOCKED_MISSING_CREDENTIAL");
    assert.equal(result.arm, "real-provider");
    assert.equal(result.sampleId, SAMPLE_QUERY_PACKAGE.id);
    assert.equal(result.reason?.includes("No real provider credentials available"), true);

    // Verify comparison correctly identifies real arm as blocked
    const fixtureResult = await runFixtureArm(SAMPLE_QUERY_PACKAGE);
    const comparison = compareArms(fixtureResult, result);

    assert.equal(comparison.comparisonStatus, "BLOCKED_REAL_ARM");
    assert.equal(comparison.notes.includes("Real-provider arm gated by credential"), true);
  } finally {
    rmSync(emptyHome, { recursive: true, force: true });
  }
});

test("W2 Harness 双臂对照：当端点与凭据点亮时，两臂皆绿并产生可比对结果", async () => {
  const mockEndpoint = await startMockRealEndpoint();
  const home = emptyHomeDir();

  try {
    const fixtureResult = await runFixtureArm(SAMPLE_QUERY_PACKAGE);

    assert.equal(fixtureResult.status, "PASSED");

    const realResult = await runRealProviderArm(SAMPLE_QUERY_PACKAGE, {
      apiKey: "sk-real-mock-credential",
      endpoint: mockEndpoint.url,
      model: "mock-real-model",
      homeDir: home,
      env: hermeticEnv(home),
    });

    assert.equal(realResult.status, "PASSED");
    assert.equal(realResult.exitCode, 0);

    const comparison = compareArms(fixtureResult, realResult);

    assert.equal(comparison.comparisonStatus, "COMPARABLE");
    assert.equal(comparison.notes.includes("Both fixture and real-provider arms executed successfully"), true);
  } finally {
    rmSync(home, { recursive: true, force: true });
    await mockEndpoint.close();
  }
});

test("W4 Harness Real-Provider: 从凭据存储自动发现凭据并解锁真实臂", async () => {
  const mockEndpoint = await startMockRealEndpoint();
  const tempHome = mkdtempSync(join(os.tmpdir(), "harness-cred-home-"));

  try {
    const port = createCliCredentialPort({
      homeDir: tempHome,
      cwd: process.cwd(),
      env: { TRYLO_HOME: tempHome },
      now: () => Date.now(),
    });
    const loginRes = port.login({
      providerId: "openai-compatible",
      accountId: "test-account",
      secret: "sk-stored-test-credential",
      authType: "api_key",
    });

    assert.equal(loginRes.ok, true);

    const realResult = await runRealProviderArm(SAMPLE_QUERY_PACKAGE, {
      homeDir: tempHome,
      endpoint: mockEndpoint.url,
      model: "mock-real-model",
      env: hermeticEnv(tempHome),
    });

    assert.equal(realResult.status, "PASSED");
    assert.equal(realResult.exitCode, 0);
  } finally {
    rmSync(tempHome, { recursive: true, force: true });
    await mockEndpoint.close();
  }
});

test("反方/红例：凭据为空字符串时不得假装点亮", async () => {
  const home = emptyHomeDir();
  try {
    const result = await runRealProviderArm(SAMPLE_QUERY_PACKAGE, {
      apiKey: "   ",
      homeDir: home,
      env: hermeticEnv(home),
    });
    assert.equal(result.status, "BLOCKED_MISSING_CREDENTIAL");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("hermetic 隔离：host shell 导出的合成凭据不得越过门控点亮真实臂", async () => {
  const home = emptyHomeDir();
  // 让 host shell 看起来"有凭据"：隔离一旦失效，这条 ambient 值就会被
  // CredentialPort 的 env 层解析成 secret，真实臂随之越过门控。endpoint 指向
  // 必然拒绝连接的本机端口，所以红例只会本机失败，绝不向公网发出请求。
  const previousKey = process.env.TRYLO_API_KEY;
  const previousEndpoint = process.env.TRYLO_REAL_ENDPOINT;

  process.env.TRYLO_API_KEY = "sk-synthetic-ambient-credential";
  process.env.TRYLO_REAL_ENDPOINT = "http://127.0.0.1:1/v1";

  try {
    const result = await runRealProviderArm(SAMPLE_QUERY_PACKAGE, {
      apiKey: "   ",
      homeDir: home,
      env: hermeticEnv(home),
    });

    assert.equal(result.status, "BLOCKED_MISSING_CREDENTIAL");
    assert.equal(result.exitCode, undefined);
  } finally {
    restoreEnv("TRYLO_API_KEY", previousKey);
    restoreEnv("TRYLO_REAL_ENDPOINT", previousEndpoint);
    rmSync(home, { recursive: true, force: true });
  }
});
