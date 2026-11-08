import assert from "node:assert/strict";
import { test } from "node:test";
import { setImmediate } from "node:timers/promises";
import type { McpStdioClient, McpToolSpec } from "../../ports/mcp-client.js";
import type { McpServerEntry } from "../../ports/mcp-registry.js";
import type { ProviderEvent, ProviderPort, ProviderRequest } from "../../ports/provider.js";
import { runTurn } from "../../loop/runner.js";
import { wirePorts } from "../../surface/cli/wiring.js";
import { createAllowToolsPermission } from "../../surface/cli/permission.js";
import { createBrokerEngine } from "./broker-engine.js";
import { digest, snapshotRegistry } from "./broker-contract.js";
import { openProgressiveMcpRuntime } from "./progressive.js";
import { openMcpRuntime } from "./index.js";
import { discoveryProvider, INVOKE_SPEC, MCP_SEARCH } from "./discovery-provider.js";

const entry: McpServerEntry = { name: "alpha", transport: "stdio", command: "node", args: [], env: {}, enabled: true };
const spec: McpToolSpec = { serverId: "alpha", serverToolName: "echo", qualifiedName: "mcp__alpha__echo",
    description: "Echo the supplied text", inputSchema: { type: "object", properties: { text: { type: "string" } } },
    annotations: { readOnlyHint: true }, annotationsTrust: "untrusted", needsApproval: true };

function fixture() {
    const state = { opened: 0, closed: 0, calls: 0, crash: false, fail: false, wait: Promise.resolve() };
    const client: McpStdioClient = {
        async connect() {
            state.opened++;
            await state.wait;
            return state.fail ? { ok: false, code: "handshake_timeout", detail: "fixture" }
                : { ok: true, value: { name: "fixture", version: "1", protocolVersion: "2025-03-26", capabilities: {} } };
        },
        async listTools() { return { ok: true, value: [spec] }; },
        async callTool(request) {
            state.calls++;

            if (state.crash)
                return { ok: false, code: "child_crashed", detail: "fixture crash" };

            if (request.arguments.wait === true) {
                await new Promise<void>(resolve => {
                    if (request.signal?.aborted)
                        resolve();
                    else
                        request.signal?.addEventListener("abort", () => resolve(), { once: true });
                });
                return { ok: true, outcome: { outcome: "cancelled" } };
            }

            return { ok: true, outcome: { outcome: "result", value: {}, output: "echo-ok", truncated: false } };
        },
        async listResources() { return { ok: true, value: { resources: [] } }; },
        async listResourceTemplates() { return { ok: true, value: { templates: [] } }; },
        async readResource() { return { ok: true, value: { contents: [] } }; },
        async close() { state.closed++; }, isConnected: () => true,
        stderrDiagnostics: () => ({ bytes: 0, truncated: false }),
    };

    return { state, client, clientFor: () => ({ ok: true as const, client }) };
}

const scope = { root: "unused-custom-client", scope: "s1", policy: "deny" };

test("deferred MCP calls preserve omitted and explicit deadlines", async () => {
    const f = fixture();
    const deadlines: (number | undefined)[] = [];
    const original = f.client.callTool;
    f.client.callTool = async request => {
        deadlines.push(request.timeoutMs);
        return original(request);
    };
    const runtime = await openProgressiveMcpRuntime({ registry: snapshotRegistry([entry]), cwd: process.cwd(), clientFor: f.clientFor }, scope);
    const signal = new AbortController().signal;

    try {
        assert.equal((await runtime.tools.execute({ name: MCP_SEARCH, toolCallId: "load-deadline", arguments: { server: "alpha" } }, signal)).outcome, "result");
        assert.equal(runtime.tools.snapshot().find(item => item.name === spec.qualifiedName)?.timeoutMs, undefined);
        for (const timeoutMs of [undefined, 120000]) {
            const result = await runtime.tools.execute({ name: spec.qualifiedName, toolCallId: `deadline-${String(timeoutMs)}`,
                arguments: timeoutMs === undefined ? {} : { timeoutMs } }, signal);
            assert.equal(result.outcome, "result");
        }
        assert.deepEqual(deadlines, [undefined, 120000]);
    }
    finally {
        await runtime.close();
    }
});

test("fragment-only generic calls settle once and malformed arguments never become an executable target", async () => {
    for (const raw of [JSON.stringify({ name: spec.qualifiedName, arguments: { text: "hi" } }), "{"]) {
        const provider: ProviderPort = { async *stream() {
                yield { type: "tool_input_start", toolCallId: "c1", name: INVOKE_SPEC.name };
                yield { type: "tool_input_delta", toolCallId: "c1", argumentsText: raw };
                yield { type: "tool_input_end", toolCallId: "c1" };
                if (raw !== "{")
                    yield { type: "tool_call", toolCallId: "c1", name: INVOKE_SPEC.name, arguments: { name: spec.qualifiedName, arguments: { text: "hi" } } };
            } };
        const wrapped = discoveryProvider(provider, () => true);
        const events: ProviderEvent[] = [];

        for await (const event of wrapped.stream({ attemptId: "a1", model: "local", messages: [], tools: [{ name: MCP_SEARCH, description: "search", parameters: {} }] }, new AbortController().signal))
            events.push(event);

        assert.equal(events.length, 1);

        if (raw === "{")
            assert.equal(events[0]?.type, "tool_call_invalid");
        else
            assert.ok(events[0]?.type === "tool_call" && events[0].name === spec.qualifiedName);
    }
});

test("first provider request does not wait for an unrelated MCP handshake", async () => {
    const f = fixture();
    let release = () => { };

    f.state.wait = new Promise<void>(resolve => { release = resolve; });
    const input = { registry: snapshotRegistry([entry]), cwd: process.cwd(), clientFor: f.clientFor };
    // Run this same contract against the former eager runtime to retain red evidence.
    const opening = process.env.TRYLO_TEST_EAGER_BASELINE === "1" ? openMcpRuntime(input) : openProgressiveMcpRuntime(input, scope);
    const early = await Promise.race([opening.then(() => true), setImmediate().then(() => false)]);

    release();
    const runtime = await opening;

    try {
        assert.equal(early, true, "first request is blocked by optional tool startup");
    }
    finally {
        await runtime.close();
    }
});

test("connections are single-flight; a crash is not replayed and failed starts back off", async () => {
    const f = fixture();
    let now = 0;
    const engine = createBrokerEngine({ entries: [entry], cwd: process.cwd(), clientFor: f.clientFor, now: () => now });

    try {
        await Promise.all([engine.ensure("alpha"), engine.ensure("alpha")]);
        assert.equal(f.state.opened, 1);
        const signal = new AbortController().signal;

        assert.equal((await engine.call("alpha", "echo", "stale", {}, 100, signal)).ok, false);
        assert.equal(f.state.calls, 0);
        f.state.crash = true;
        assert.equal((await engine.call("alpha", "echo", digest(spec), {}, 100, signal)).ok, false);
        assert.equal(f.state.calls, 1);
        await engine.ensure("alpha");
        assert.equal(f.state.opened, 1);
        now = 30001;
        f.state.fail = true;
        await engine.ensure("alpha");
        await engine.ensure("alpha");
        assert.equal(f.state.opened, 2);
        assert.equal(engine.snapshot()[0]?.state, "failed");
    }
    finally {
        await engine.close();
    }
});

test("live schema loading admits exact tools; cancellation reaches the active call", async () => {
    const f = fixture();
    const runtime = await openProgressiveMcpRuntime({ registry: snapshotRegistry([entry]), cwd: process.cwd(), clientFor: f.clientFor }, scope);
    const signal = new AbortController().signal;

    try {
        const denied = await runtime.tools.execute({ name: spec.qualifiedName, toolCallId: "early", arguments: {} }, signal);

        assert.equal(denied.outcome, "error");
        assert.equal(f.state.calls, 0);
        const found = await runtime.tools.execute({ name: MCP_SEARCH, toolCallId: "search", arguments: { server: "alpha", query: "echo" } }, signal);

        assert.equal(found.outcome, "result");
        assert.equal(runtime.toolNames.has(spec.qualifiedName), true);
        assert.equal((await runtime.tools.execute({ name: "mcp_list_resources", toolCallId: "resources", arguments: { server: "alpha" } }, signal)).outcome, "result");
        const pending = runtime.tools.execute({ name: spec.qualifiedName, toolCallId: "call", arguments: { wait: true } }, signal);

        await setImmediate();
        await runtime.tools.cancel("call");
        assert.equal((await pending).outcome, "cancelled");
        assert.equal(f.state.opened, 1);
    }
    finally {
        await runtime.close();
    }
});

test("discovery keeps provider schemas stable and restores canonical history on the wire", async () => {
    const requests: ProviderRequest[] = [];
    const provider: ProviderPort = { async *stream(request) {
            requests.push(request);
            yield { type: "tool_call", toolCallId: "c1", name: INVOKE_SPEC.name, arguments: { name: spec.qualifiedName, arguments: { text: "hi" } } };
        } };
    const wrapped = discoveryProvider(provider, name => name === spec.qualifiedName);
    const base: ProviderRequest = { attemptId: "a1", model: "local", messages: [], tools: [INVOKE_SPEC, { name: MCP_SEARCH, description: "search", parameters: {} }] };
    const events: ProviderEvent[] = [];

    for await (const event of wrapped.stream(base, new AbortController().signal))
        events.push(event);

    assert.ok(events.some(event => event.type === "tool_call" && event.name === spec.qualifiedName));

    for await (const _event of wrapped.stream({ ...base, tools: [...base.tools, { name: spec.qualifiedName, description: spec.description, parameters: spec.inputSchema }],
        messages: [{ role: "assistant", content: "", toolCalls: [{ toolCallId: "old", name: spec.qualifiedName, arguments: { text: "old" } }] }] }, new AbortController().signal)) { /* Drain. */ }

    assert.deepEqual(requests[0]?.tools, requests[1]?.tools);
    assert.equal(requests[1]?.messages[0]?.toolCalls?.[0]?.name, INVOKE_SPEC.name);
});

test("generic MCP invocation still asks permission for the original tool", async () => {
    for (const allow of [false, true]) {
        const f = fixture();
        const runtime = await openProgressiveMcpRuntime({ registry: snapshotRegistry([entry]), cwd: process.cwd(), clientFor: f.clientFor }, scope);
        const permission = createAllowToolsPermission(new Set(allow ? [spec.qualifiedName] : [INVOKE_SPEC.name]));
        const wiring = wirePorts({ providerId: "fixture", model: "local", endpoint: "", apiKey: undefined, workspaceRoot: process.cwd(), permission,
            mcp: { tools: runtime.tools, toolNames: runtime.toolNames } });

        assert.ok(!("code" in wiring));

        if ("code" in wiring)
            throw new Error("wiring failed");

        const provider: ProviderPort = { async *stream(request) {
                const count = request.messages.filter(message => message.role === "tool").length;
                yield { type: "stream_start", providerId: "local", model: "local", warnings: [] };
                if (count < 2)
                    yield { type: "tool_call", toolCallId: `c${count}`, name: count === 0 ? MCP_SEARCH : INVOKE_SPEC.name,
                        arguments: count === 0 ? { server: "alpha", query: "echo" } : { name: spec.qualifiedName, arguments: { text: "hi" } } };
                yield { type: "finish", reason: count < 2 ? "tool_calls" : "stop", rawReason: "stop", requiresFollowUp: count < 2 };
            } };

        try {
            const result = await runTurn({ ...wiring.ports, provider: runtime.wrapProvider!(provider) }, { sessionId: "s1", turnId: "t1", correlationId: "c1", text: "echo" });
            assert.equal(f.state.calls, allow ? 1 : 0);
            assert.equal(result.state.terminalReason, "completed");
            const settled = result.transcript.filter(item => item.kind === "tool_result" && item.toolCallId === "c1");
            assert.equal(settled.length, 1);
            assert.ok(settled[0]?.kind === "tool_result");
            assert.equal(settled[0].outcome, allow ? "succeeded" : "failed");
            if (!allow) assert.match(settled[0].output, /permission_denied/);
            assert.ok(result.transcript.some(item => item.kind === "tool_call" && item.name === spec.qualifiedName));
        }
        finally {
            await runtime.close();
        }
    }
});
