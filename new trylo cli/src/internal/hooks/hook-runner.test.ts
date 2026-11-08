import assert from "node:assert/strict";
import test from "node:test";
import type { HookConfig, HookStore } from "./hook-config.js";
import type {
  HookAgentPort,
  HookCommandExecutor,
  HookHttpPort,
  HookPromptPort,
  HookPermissionGate,
  HookRunnerDeps,
  HookTrigger,
} from "./hook-ports.js";
import { runHooksForEvent } from "./hook-runner.js";
import type { TimerScheduler } from "../subagent/scheduler.js";

/**
 * WP17.2 / WP17.3：命令、HTTP、prompt、agent 四执行器的显式合同。
 *
 * 全部端口由测试注入，生产接线分别走 Process/Isolation（WP05/WP04）、
 * 注入式网络端口、provider 端口与子代理端口——本文件只证明 runner 的
 * 仲裁语义：授权先行、失败终局、递归有界、聚合保序。
 */

function commandHook(id: string, overrides?: Partial<Extract<HookConfig, { kind: "command" }>>): HookConfig {
  return {
    id,
    event: "PreToolUse",
    source: "project",
    kind: "command",
    command: ["hook", id],
    timeoutMs: 1000,
    ...overrides,
  };
}

function triggerOf(store: HookStore, overrides?: Partial<HookTrigger>): { store: HookStore; trigger: HookTrigger } {
  return {
    store,
    trigger: {
      event: "PreToolUse",
      matchValue: "Write",
      data: { tool: "Write" },
      depth: 0,
      signal: new AbortController().signal,
      ...overrides,
    },
  };
}

function depsOf(overrides?: Partial<HookRunnerDeps>): HookRunnerDeps & {
  executed: Array<readonly string[]>;
  httpCalls: Array<string>;
} {
  const executed: Array<readonly string[]> = [];
  const httpCalls: Array<string> = [];
  const command: HookCommandExecutor = {
    run: (argv) => {
      executed.push(argv);
      return Promise.resolve({ exitCode: 0, stdout: "{}", stderr: "", timedOut: false });
    },
  };
  const gate: HookPermissionGate = {
    authorizeHookCommand: () => Promise.resolve({ verdict: "approved" }),
  };
  const http: HookHttpPort = {
    post: (url) => {
      httpCalls.push(url);
      return Promise.resolve({ statusCode: 200, body: "{}" });
    },
  };
  const prompt: HookPromptPort = {
    ask: () => Promise.resolve({ ok: true, reason: "fine" }),
  };
  const agent: HookAgentPort = {
    run: () => Promise.resolve({ ok: true, reason: "fine", turnsUsed: 1 }),
  };

  return { command, gate, http, prompt, agent, executed, httpCalls, ...overrides };
}

test("exit 0 with a block decision blocks the task", async () => {
  const deps = depsOf({
    command: {
      run: () => Promise.resolve({ exitCode: 0, stdout: '{"decision":"block","reason":"no writes"}', stderr: "", timedOut: false }),
    },
  });
  const { store, trigger } = triggerOf({ hooks: [commandHook("guard")] });
  const result = await runHooksForEvent(store, trigger, deps);

  assert.equal(result.verdict, "block");
  assert.deepEqual(result.reasons, ["no writes"]);
  assert.deepEqual(result.executedIds, ["guard"]);
});

test("exit 0 with plain text observes and injects the text as context", async () => {
  const deps = depsOf({
    command: {
      run: () => Promise.resolve({ exitCode: 0, stdout: "remember the schema", stderr: "", timedOut: false }),
    },
  });
  const { store, trigger } = triggerOf({ hooks: [commandHook("note")] });
  const result = await runHooksForEvent(store, trigger, deps);

  assert.equal(result.verdict, "allow");
  assert.deepEqual(result.additionalContexts, ["remember the schema"]);
});

test("exit 2 blocks; any other non-zero exit is a recorded non-blocking error", async () => {
  const denied = depsOf({
    command: {
      run: () => Promise.resolve({ exitCode: 2, stdout: "", stderr: "blocked by policy", timedOut: false }),
    },
  });
  const failed = depsOf({
    command: {
      run: () => Promise.resolve({ exitCode: 1, stdout: "", stderr: "boom", timedOut: false }),
    },
  });
  const fixture: HookStore = { hooks: [commandHook("h")] };
  const blocked = await runHooksForEvent(fixture, triggerOf(fixture).trigger, denied);

  assert.equal(blocked.verdict, "block");
  assert.deepEqual(blocked.reasons, ["blocked by policy"]);
  const errored = await runHooksForEvent(fixture, triggerOf(fixture).trigger, failed);

  assert.equal(errored.verdict, "allow");
  assert.equal(errored.hookErrors.length, 1);
});

test("a denied hook command never reaches the executor", async () => {
  const deps = depsOf({
    gate: {
      authorizeHookCommand: () => Promise.resolve({ verdict: "denied", reason: "hook not approved" }),
    },
  });
  const { store, trigger } = triggerOf({ hooks: [commandHook("side-effect")] });
  const result = await runHooksForEvent(store, trigger, deps);

  assert.equal(result.verdict, "block");
  assert.deepEqual(result.reasons, ["hook not approved"]);
  assert.deepEqual(deps.executed, []);
});

test("an aborted trigger cancels without running anything", async () => {
  const deps = depsOf();
  const controller = new AbortController();

  controller.abort();
  const { store, trigger } = triggerOf({ hooks: [commandHook("late")] }, { signal: controller.signal });
  const result = await runHooksForEvent(store, trigger, deps);

  assert.equal(result.verdict, "cancelled");
  assert.deepEqual(deps.executed, []);
});

test("a hook that never finishes is cancelled when the scheduler fires", async () => {
  let fire: (() => void) | undefined;
  const manual: TimerScheduler = (delayMs, onFire) => {
    assert.equal(delayMs, 25);
    fire = onFire;
    return { cancel: () => {} };
  };
  const deps = depsOf({
    command: {
      // Never settles on its own: only the manual scheduler may end this hook.
      run: () => new Promise<never>(() => {}),
    },
  });
  const hook: HookConfig = commandHook("hang", { timeoutMs: 25 });
  const { store, trigger } = triggerOf({ hooks: [hook] });
  const pending = runHooksForEvent(store, trigger, deps, manual);

  // The runner reaches the scheduler through async seams (gate, executor
  // call); yield one macrotask so the manual timer is armed before firing.
  await new Promise((resolve) => setTimeout(resolve, 0));
  fire?.();
  const result = await pending;

  assert.equal(result.verdict, "cancelled");
});

test("an http hook to a non-allowlisted url never leaves the process", async () => {
  const deps = depsOf();
  const hook: HookConfig = {
    id: "webhook",
    event: "PreToolUse",
    source: "project",
    kind: "http",
    url: "https://evil.example/hook",
    allowedUrlPatterns: ["https://hooks.example/*"],
    timeoutMs: 1000,
  };
  const { store, trigger } = triggerOf({ hooks: [hook] });
  const result = await runHooksForEvent(store, trigger, deps);

  assert.equal(result.verdict, "allow");
  assert.equal(result.hookErrors.length, 1);
  assert.deepEqual(deps.httpCalls, []);
});

test("a throwing http port cancels the aggregation fail-closed", async () => {
  const deps = depsOf({
    http: {
      post: () => Promise.reject(new Error("socket hang up")),
    },
  });
  const hook: HookConfig = {
    id: "webhook",
    event: "PreToolUse",
    source: "project",
    kind: "http",
    url: "https://hooks.example/hook",
    allowedUrlPatterns: ["https://hooks.example/*"],
    timeoutMs: 1000,
  };
  const { store, trigger } = triggerOf({ hooks: [hook] });
  const result = await runHooksForEvent(store, trigger, deps);

  assert.equal(result.verdict, "cancelled");
});

test("a failing prompt port cancels fail-closed", async () => {
  const blocking = depsOf({
    prompt: { ask: () => Promise.resolve({ ok: false, reason: "stop that" }) },
  });
  const hook: HookConfig = { id: "judge", event: "PreToolUse", source: "project", kind: "prompt", prompt: "review", timeoutMs: 1000 };
  const fixture: HookStore = { hooks: [hook] };
  const blocked = await runHooksForEvent(fixture, triggerOf(fixture).trigger, blocking);

  assert.equal(blocked.verdict, "block");
  assert.deepEqual(blocked.reasons, ["stop that"]);

  const garbled = depsOf({
    prompt: {
      ask: () => Promise.reject(new Error("html instead of json")),
    },
  });
  const errored = await runHooksForEvent(fixture, triggerOf(fixture).trigger, garbled);

  assert.equal(errored.verdict, "cancelled");
});

test("an agent hook without a usable answer cancels; ok:false blocks", async () => {
  const blocking = depsOf({
    agent: { run: () => Promise.resolve({ ok: false, reason: "unsafe plan", turnsUsed: 2 }) },
  });
  const hook: HookConfig = { id: "reviewer", event: "PreToolUse", source: "project", kind: "agent", task: "review", timeoutMs: 1000, maxTurns: 5 };
  const fixture: HookStore = { hooks: [hook] };
  const blocked = await runHooksForEvent(fixture, triggerOf(fixture).trigger, blocking);

  assert.equal(blocked.verdict, "block");

  const empty = depsOf({
    agent: { run: () => Promise.reject(new Error("no structured output")) },
  });
  const cancelled = await runHooksForEvent(fixture, triggerOf(fixture).trigger, empty);

  assert.equal(cancelled.verdict, "cancelled");
});

test("a hook cannot widen the caller's recursion ceiling (P0-2)", async () => {
  let promptCalls = 0;
  const deps = depsOf({
    prompt: {
      ask: () => {
        promptCalls += 1;
        return Promise.resolve({ ok: true, reason: "fine" });
      },
    },
  });
  const hook: HookConfig = {
    id: "deep",
    event: "PreToolUse",
    source: "project",
    kind: "prompt",
    prompt: "r",
    timeoutMs: 1000,
    maxDepth: 10,
  };
  const fixture: HookStore = { hooks: [hook] };
  // Caller ceiling is 2, hook claims 10, depth is 5: the tighter bound wins.
  const refused = await runHooksForEvent(fixture, triggerOf(fixture, { depth: 5, maxDepth: 2 }).trigger, deps);

  assert.equal(refused.verdict, "cancelled");
  assert.equal(promptCalls, 0);

  // And tightening still works: hook bound 1 under caller ceiling 5.
  const tightHook: HookConfig = { ...hook, maxDepth: 1 };
  const tightFixture: HookStore = { hooks: [tightHook] };
  const tight = await runHooksForEvent(tightFixture, triggerOf(tightFixture, { depth: 2, maxDepth: 5 }).trigger, deps);

  assert.equal(tight.verdict, "cancelled");
  assert.equal(promptCalls, 0);
});

test("an abort during authorisation never spawns the command (P0-3)", async () => {
  const controller = new AbortController();
  const deps = depsOf({
    gate: {
      authorizeHookCommand: () => {
        controller.abort();
        return Promise.resolve({ verdict: "approved" });
      },
    },
  });
  const { store, trigger } = triggerOf({ hooks: [commandHook("boom")] }, { signal: controller.signal });
  const result = await runHooksForEvent(store, trigger, deps);

  assert.equal(result.verdict, "cancelled");
  assert.deepEqual(deps.executed, []);
});

test("an exit-2 hook prefers a JSON reason over raw output", async () => {
  const deps = depsOf({
    command: {
      run: () => Promise.resolve({ exitCode: 2, stdout: '{"reason":"json-reason"}', stderr: "", timedOut: false }),
    },
  });
  const { store, trigger } = triggerOf({ hooks: [commandHook("blocker")] });
  const result = await runHooksForEvent(store, trigger, deps);

  assert.equal(result.verdict, "block");
  assert.deepEqual(result.reasons, ["json-reason"]);
});

test("an exit-2 hook with plain-text stdout keeps the text as its reason", async () => {
  const deps = depsOf({
    command: {
      run: () => Promise.resolve({ exitCode: 2, stdout: "just text", stderr: "", timedOut: false }),
    },
  });
  const { store, trigger } = triggerOf({ hooks: [commandHook("blocker")] });
  const result = await runHooksForEvent(store, trigger, deps);

  assert.equal(result.verdict, "block");
  assert.deepEqual(result.reasons, ["just text"]);
});

test("an exit-2 hook prefers stderr over stdout text", async () => {
  const deps = depsOf({
    command: {
      run: () => Promise.resolve({ exitCode: 2, stdout: "note", stderr: "from stderr", timedOut: false }),
    },
  });
  const { store, trigger } = triggerOf({ hooks: [commandHook("blocker")] });
  const result = await runHooksForEvent(store, trigger, deps);

  assert.equal(result.verdict, "block");
  assert.deepEqual(result.reasons, ["from stderr"]);
});

test("an exit-2 hook with a reason-less JSON answer falls back to raw output", async () => {
  const deps = depsOf({
    command: {
      run: () => Promise.resolve({ exitCode: 2, stdout: '{"decision":"block"}', stderr: "", timedOut: false }),
    },
  });
  const { store, trigger } = triggerOf({ hooks: [commandHook("blocker")] });
  const result = await runHooksForEvent(store, trigger, deps);

  assert.equal(result.verdict, "block");
  assert.deepEqual(result.reasons, ['{"decision":"block"}']);
});

test("prompt and agent hooks past the recursion bound never reach their ports", async () => {
  let promptCalls = 0;
  let agentCalls = 0;
  const deps = depsOf({
    prompt: {
      ask: () => {
        promptCalls += 1;
        return Promise.resolve({ ok: true, reason: "fine" });
      },
    },
    agent: {
      run: () => {
        agentCalls += 1;
        return Promise.resolve({ ok: true, reason: "fine", turnsUsed: 1 });
      },
    },
  });
  const fixture: HookStore = {
    hooks: [
      { id: "p", event: "PreToolUse", source: "project", kind: "prompt", prompt: "r", timeoutMs: 1000 },
      { id: "a", event: "PreToolUse", source: "project", kind: "agent", task: "r", timeoutMs: 1000, maxTurns: 5 },
    ],
  };
  const result = await runHooksForEvent(fixture, triggerOf(fixture, { depth: 3 }).trigger, deps);

  assert.equal(result.verdict, "cancelled");
  assert.equal(promptCalls, 0);
  assert.equal(agentCalls, 0);
});

test("aggregation keeps execution order and the first block reason wins", async () => {
  const deps = depsOf({
    command: {
      run: (argv) => {
        if (argv[1] === "first") {
          return Promise.resolve({ exitCode: 0, stdout: '{"additionalContext":"ctx-one"}', stderr: "", timedOut: false });
        }
        return Promise.resolve({ exitCode: 0, stdout: '{"decision":"block","reason":"second says no"}', stderr: "", timedOut: false });
      },
    },
  });
  const fixture: HookStore = { hooks: [commandHook("first"), commandHook("second")] };
  const result = await runHooksForEvent(fixture, triggerOf(fixture).trigger, deps);

  assert.equal(result.verdict, "block");
  assert.deepEqual(result.executedIds, ["first", "second"]);
  assert.deepEqual(result.additionalContexts, ["ctx-one"]);
  assert.deepEqual(result.reasons, ["second says no"]);
});

test("a hook may inject context and rewritten input into the next request", async () => {
  const deps = depsOf({
    command: {
      run: () =>
        Promise.resolve({
          exitCode: 0,
          stdout: '{"additionalContext":"use v2 schema","updatedInput":{"prompt":"do it with v2"}}',
          stderr: "",
          timedOut: false,
        }),
    },
  });
  const { store, trigger } = triggerOf({ hooks: [commandHook("injector")] });
  const result = await runHooksForEvent(store, trigger, deps);

  assert.equal(result.verdict, "allow");
  assert.deepEqual(result.additionalContexts, ["use v2 schema"]);
  assert.deepEqual(result.updatedInputs, [{ prompt: "do it with v2" }]);
});

test("no matching hooks is an allow with empty evidence", async () => {
  const deps = depsOf();
  const fixture: HookStore = { hooks: [] };
  const result = await runHooksForEvent(fixture, triggerOf(fixture).trigger, deps);
  assert.equal(result.verdict, "allow");
  assert.deepEqual(result.executedIds, []);
  assert.deepEqual(result.additionalContexts, []);
});
