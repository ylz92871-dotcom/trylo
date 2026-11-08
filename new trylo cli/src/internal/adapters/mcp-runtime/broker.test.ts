import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createConnection } from "node:net";
import { test } from "node:test";
import { brokerRequest, connectBroker } from "./broker-client.js";
import { isAddress, snapshotRegistry, type BrokerAddress } from "./broker-contract.js";
import { serveBroker } from "./broker-host.js";
import { callResult, listResult, readResult } from "./broker-results.js";
import { openProgressiveMcpRuntime } from "./progressive.js";
import { testScratchPath } from "../../testing/scratch.js";

test("optional broker startup failure preserves nonblocking turn-owned discovery", async () => {
    const root = await mkdtemp(join(tmpdir(), "trylo-mcp-fallback-"));
    const blocked = join(root, "blocked");

    await writeFile(blocked, "not a directory");
    const registry = snapshotRegistry([{ name: "echo", command: process.execPath, args: [], env: {}, transport: "stdio", enabled: true }]);
    const runtime = await openProgressiveMcpRuntime({ registry, cwd: process.cwd() }, { root: blocked, scope: "fallback", policy: "ask" });

    try {
        assert.ok(runtime.warnings.some(warning => warning.startsWith("mcp_background_host_unavailable")));
        const status = await runtime.tools.execute({ name: "mcp_search_tools", toolCallId: "status", arguments: {} }, new AbortController().signal);
        assert.equal(status.outcome, "result");
        assert.equal(runtime.toolNames.has("mcp__echo__echo"), false);
    }
    finally {
        await runtime.close();
        await rm(root, { recursive: true, force: true });
    }
});

test("broker reuses a live connection across turn clients and separates policy identities", async () => {
    const root = await mkdtemp(join(tmpdir(), "trylo-mcp-broker-"));
    const addresses: BrokerAddress[] = [];
    const registry = snapshotRegistry([{ name: "echo", command: process.execPath,
            args: [join(process.cwd(), "testdata/mcp/fake-server.mjs"), "ok"], env: {}, transport: "stdio", enabled: true }]);
    const input = { registry, cwd: process.cwd(), root, scope: "same-chat", policy: "ask" };

    try {
        const [first, second] = await Promise.all([connectBroker(input), connectBroker(input)]);

        assert.equal(first.key, second.key);

        for (const file of await readdir(root)) {
            const raw: unknown = JSON.parse(await readFile(join(root, file), "utf8"));
            assert.ok(isAddress(raw));
            addresses.push(raw);
        }

        assert.equal(addresses.length, 1);
        const loaded = await first.request({ method: "load", server: "echo" });

        assert.ok(Array.isArray(loaded));
        assert.equal(loaded[0]?.state, "ready");
        await first.close();
        const status = await second.request({ method: "status" });

        assert.ok(Array.isArray(status));
        assert.equal(status[0]?.state, "ready");
        assert.deepEqual(status[0]?.tools, [], "status must not retransmit full tool schemas");
        const changed = await connectBroker({ ...input, policy: "denied" });

        assert.notEqual(changed.key, first.key);
        const file = join(root, `${changed.key}.json`);
        const raw: unknown = JSON.parse(await readFile(file, "utf8"));

        assert.ok(isAddress(raw));
        addresses.push(raw);
        assert.equal((await readdir(root)).length, 2);
    }
    finally {
        await Promise.all(addresses.map(address => brokerRequest(address, { method: "shutdown" })));
        await rm(root, { recursive: true, force: true });
    }
});

test("loopback broker refuses unauthenticated and browser-origin requests", async () => {
    const host = await serveBroker({ version: 1, key: "test", cwd: process.cwd(), entries: [] });
    const url = `http://127.0.0.1:${host.address.port}/rpc`;

    try {
        assert.equal((await fetch(url, { method: "POST", body: '{}' })).status, 403);
        assert.equal((await fetch(url, { method: "POST", headers: { Authorization: `Bearer ${host.address.token}`, Origin: "http://example.com" }, body: '{}' })).status, 403);
        assert.deepEqual(await brokerRequest(host.address, { method: "status" }), []);
    }
    finally {
        await host.close();
    }
});

test("broker idle expiry closes its listener", async () => {
    let now = 0;
    const host = await serveBroker({ version: 1, key: "test", cwd: process.cwd(), entries: [] }, { now: () => now, idleMs: 1 });

    try {
        now = 2;
        // One real maintenance tick is a bounded process-lifecycle integration check.
        await new Promise(resolve => setTimeout(resolve, 1100));
        await assert.rejects(brokerRequest(host.address, { method: "status" }));
    }
    finally {
        await host.close();
    }
});

test("an attached turn keeps its broker alive while other work runs, then releases idle cleanup", async () => {
    const root = await mkdtemp(join(testScratchPath(), "mcp-broker-lifetime-"));
    const registry = snapshotRegistry([]);
    const input = { registry, cwd: process.cwd(), root, scope: "long-shell", policy: "ask", heartbeatIntervalMs: 20 };
    const bootstrap = await connectBroker(input);
    const addressFile = join(root, `${bootstrap.key}.json`);
    const original: unknown = JSON.parse(await readFile(addressFile, "utf8"));

    assert.ok(isAddress(original));
    await bootstrap.close();
    await brokerRequest(original, { method: "shutdown" });

    let now = 0, releasedAt: number | undefined;
    const host = await serveBroker({ version: 1, key: bootstrap.key, cwd: process.cwd(), entries: [] },
        { now: () => now + (releasedAt === undefined ? 0 : performance.now() - releasedAt), idleMs: 50 });
    await writeFile(addressFile, JSON.stringify(host.address));
    const client = await connectBroker(input);

    try {
        now = 1000;
        // One host maintenance tick simulates a long shell/model gap; no business
        // operation is sent and a client heartbeat must retain the connection.
        await new Promise(resolve => setTimeout(resolve, 1100));
        assert.deepEqual(await client.request({ method: "status" }), []);

        await client.close();
        now = 2000;
        // Cancellation can finish locally before the host's finally updates its
        // last activity. Let the clock keep advancing after release and observe
        // the listener without issuing HTTP requests that would refresh it.
        releasedAt = performance.now();
        const deadline = releasedAt + 5000;

        while (await new Promise<boolean>((resolve, reject) => {
            const socket = createConnection({ host: "127.0.0.1", port: host.address.port });

            socket.once("connect", () => { socket.destroy(); resolve(true); });
            socket.once("error", (error: NodeJS.ErrnoException) => {
                socket.destroy();
                if (error.code === "ECONNREFUSED") resolve(false);
                else reject(error);
            });
        })) {
            assert.ok(performance.now() < deadline, "the released broker listener must become idle and close");
            await new Promise(resolve => setTimeout(resolve, 25));
        }

        await assert.rejects(brokerRequest(host.address, { method: "status" }));
    }
    finally {
        await client.close();
        await host.close();
        await rm(root, { recursive: true, force: true });
    }
});

test("tool cancellation crosses the broker process boundary", async () => {
    const root = await mkdtemp(join(tmpdir(), "trylo-mcp-cancel-"));
    const registry = snapshotRegistry([{ name: "slow", command: process.execPath, args: [join(process.cwd(), "testdata/mcp/fake-server.mjs"), "timeout"], env: {}, transport: "stdio", enabled: true }]);
    const input = { registry, cwd: process.cwd(), root, scope: "cancel-test", policy: "ask" };
    const client = await connectBroker(input);
    const raw: unknown = JSON.parse(await readFile(join(root, `${client.key}.json`), "utf8"));

    assert.ok(isAddress(raw));
    const runtime = await openProgressiveMcpRuntime({ registry, cwd: process.cwd() }, input);
    const signal = new AbortController().signal;

    try {
        const found = await runtime.tools.execute({ toolCallId: "load", name: "mcp_search_tools", arguments: { server: "slow", query: "echo" } }, signal);
        assert.equal(found.outcome, "result");
        const call = runtime.tools.execute({ toolCallId: "cancel", name: "mcp__slow__echo", arguments: { text: "never responds" } }, signal);
        await new Promise(resolve => setTimeout(resolve, 30));
        await runtime.tools.cancel("cancel");
        assert.equal((await call).outcome, "cancelled");
    }
    finally {
        await runtime.close();
        await brokerRequest(raw, { method: "shutdown" });
        await rm(root, { recursive: true, force: true });
    }
});

test("broker results reject malformed tool, image and resource payloads", () => {
    assert.throws(() => callResult({ ok: true, outcome: { outcome: "result", value: {}, output: 4 } }));
    assert.throws(() => callResult({ ok: true, outcome: { outcome: "result", value: {}, output: "", truncated: false, inlineImages: [{}] } }));
    assert.throws(() => listResult({ ok: true, value: { resources: [{ uri: "file:///x" }] } }));
    assert.throws(() => readResult({ ok: true, value: { contents: [{ kind: "binary", uri: "x", byteLength: -1 }] } }));
    assert.deepEqual(callResult({ ok: true, outcome: { outcome: "cancelled" } }), { ok: true, outcome: { outcome: "cancelled" } });
});
