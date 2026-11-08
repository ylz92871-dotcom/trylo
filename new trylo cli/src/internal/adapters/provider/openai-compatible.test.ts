import assert from "node:assert/strict";
import { test } from "node:test";
import { createOpenAiCompatibleProvider } from "./openai-compatible.js";
import type { ProviderEvent, ProviderRequest } from "../../ports/provider.js";

const DUMMY_REQUEST: ProviderRequest = {
  attemptId: "att-test-1",
  model: "gpt-4o-mini",
  messages: [{ role: "user", content: "Hello" }],
  tools: [],
};

test("createOpenAiCompatibleProvider renews token on 401 and retries bounded", async () => {
  let requestCount = 0;
  let refreshed = false;

  const mockFetch: typeof globalThis.fetch = async (_input, init) => {
    requestCount += 1;
    const headers = (init?.headers as Record<string, string>) ?? {};
    const authHeader = headers["authorization"] ?? headers["Authorization"] ?? "";

    if (requestCount === 1) {
      // First attempt with stale token gets 401
      assert.equal(authHeader, "Bearer at-stale-token");
      return new Response(JSON.stringify({ error: { message: "Unauthorized" } }), {
        status: 401,
        headers: { "Content-Type": "application/json" },
      });
    }

    // Second attempt should use refreshed token
    assert.equal(authHeader, "Bearer at-fresh-token");
    const sseBody = [
      'data: {"choices":[{"delta":{"role":"assistant","content":"Hi there!"},"finish_reason":null}]}\n\n',
      'data: {"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":5,"completion_tokens":3,"total_tokens":8}}\n\n',
      "data: [DONE]\n\n",
    ].join("");

    return new Response(sseBody, {
      status: 200,
      headers: { "Content-Type": "text/event-stream" },
    });
  };

  const provider = createOpenAiCompatibleProvider({
    endpoint: "https://api.openai.com/v1/chat/completions",
    model: "gpt-4o-mini",
    apiKey: "at-stale-token",
    fetchImpl: mockFetch,
    tokenManager: {
      handleAuthError: async (status: number) => {
        assert.equal(status, 401);
        refreshed = true;
        return { refreshed: true, token: "at-fresh-token" };
      },
    },
  });

  const events: ProviderEvent[] = [];

  for await (const event of provider.stream(DUMMY_REQUEST, new AbortController().signal)) {
    events.push(event);
  }

  assert.equal(refreshed, true, "tokenManager.handleAuthError should have been called on 401");
  assert.equal(requestCount, 2, "Expected exactly 1 retry after 401 token refresh");

  const texts = events
    .filter((e) => e.type === "text_delta")
    .map((e) => (e as { text: string }).text)
    .join("");

  assert.equal(texts, "Hi there!");
});

test("createOpenAiCompatibleProvider fails closed if 401 refresh fails", async () => {
  let requestCount = 0;
  const mockFetch: typeof globalThis.fetch = async () => {
    requestCount += 1;
    return new Response(JSON.stringify({ error: { message: "Unauthorized" } }), {
      status: 401,
      headers: { "Content-Type": "application/json" },
    });
  };

  const provider = createOpenAiCompatibleProvider({
    endpoint: "https://api.openai.com/v1/chat/completions",
    model: "gpt-4o-mini",
    apiKey: "at-stale-token",
    fetchImpl: mockFetch,
    tokenManager: {
      handleAuthError: async () => {
        return { refreshed: false, reason: "Refresh token expired", hint: "Re-login required" };
      },
    },
  });

  const events: ProviderEvent[] = [];

  for await (const event of provider.stream(DUMMY_REQUEST, new AbortController().signal)) {
    events.push(event);
  }

  assert.equal(requestCount, 1, "Should not retry if refresh failed");
  const errorEvent = events.find((e) => e.type === "error");

  assert.ok(errorEvent !== undefined);
  assert.equal(errorEvent.class, "auth");
  assert.match((errorEvent as { message: string }).message, /token_refresh_failed/);
});

test("D5: maxOutputTokens is sent as max_tokens in the request body", async () => {
  // --max-tokens 进了 ProviderRequest 却从未进请求体：静默忽略。
  // 红例断言请求体本身，不许只断言"不崩"。
  let body: Record<string, unknown> | undefined;
  const mockFetch: typeof globalThis.fetch = async (_input, init) => {
    body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    const sseBody = [
      'data: {"choices":[{"delta":{"role":"assistant","content":"hi"},"finish_reason":null}]}\n\n',
      'data: {"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":5,"completion_tokens":3,"total_tokens":8}}\n\n',
      "data: [DONE]\n\n",
    ].join("");

    return new Response(sseBody, {
      status: 200,
      headers: { "Content-Type": "text/event-stream" },
    });
  };
  const provider = createOpenAiCompatibleProvider({
    endpoint: "https://api.example.com/v1/chat/completions",
    model: "test-model",
    apiKey: "k",
    fetchImpl: mockFetch,
  });
  const request: ProviderRequest = { ...DUMMY_REQUEST, maxOutputTokens: 50 };

  for await (const _event of provider.stream(request, new AbortController().signal)) {
    // drain
  }

  assert.equal(body?.["max_tokens"], 50);
});

test("D5: no max_tokens key is sent when no budget was given", async () => {
  let body: Record<string, unknown> | undefined;
  const mockFetch: typeof globalThis.fetch = async (_input, init) => {
    body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    const sseBody = 'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n';
    return new Response(sseBody, {
      status: 200,
      headers: { "Content-Type": "text/event-stream" },
    });
  };
  const provider = createOpenAiCompatibleProvider({
    endpoint: "https://api.example.com/v1/chat/completions",
    model: "test-model",
    apiKey: "k",
    fetchImpl: mockFetch,
  });

  for await (const _event of provider.stream(DUMMY_REQUEST, new AbortController().signal)) {
    // drain
  }

  assert.equal("max_tokens" in (body ?? {}), false);
});

test("D6: a usage frame trailing the finish frame is ordered before finish", async () => {
  // 部分 OpenAI 兼容端点把 usage 放在 finish 之后的单独帧里；
  // 循环层在 finish 处停读（429 教训，不动），所以 adapter 负责把顺序摆正：
  // finish 暂扣，尾随 usage 先行，真结束才交 finish。其它尾随帧照样丢弃。
  const mockFetch: typeof globalThis.fetch = async () => {
    const sseBody = [
      'data: {"choices":[{"delta":{"role":"assistant","content":"hi"},"finish_reason":null}]}\n\n',
      'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n',
      'data: {"usage":{"prompt_tokens":5,"completion_tokens":3,"total_tokens":8}}\n\n',
      "data: [DONE]\n\n",
    ].join("");
    return new Response(sseBody, {
      status: 200,
      headers: { "Content-Type": "text/event-stream" },
    });
  };
  const provider = createOpenAiCompatibleProvider({
    endpoint: "https://api.example.com/v1/chat/completions",
    model: "test-model",
    apiKey: "k",
    fetchImpl: mockFetch,
  });
  const events: ProviderEvent[] = [];

  for await (const event of provider.stream(DUMMY_REQUEST, new AbortController().signal)) {
    events.push(event);
  }

  const kinds = events.map((event) => event.type);

  assert.ok(kinds.includes("usage"), "trailing usage must survive");
  assert.ok(kinds.indexOf("usage") < kinds.indexOf("finish"), "usage must precede finish");
  const usage = events.find((event) => event.type === "usage");

  assert.equal(usage?.type === "usage" ? usage.usage.totalTokens : -1, 8);
});
