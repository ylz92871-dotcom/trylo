import { spawn } from "node:child_process";
import { readFile, writeFile, mkdir, unlink, stat, realpath } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { childEnvironment } from "../mcp-stdio/transport-env.js";
import type { McpRegistryPort } from "../../ports/mcp-registry.js";
import { BROKER_IDLE_MS, digest, isAddress, record, type BrokerAddress, type BrokerConfig } from "./broker-contract.js";
import { brokerRequestError } from "./broker-errors.js";

const STATUS_TIMEOUT_MS = 500;

export type BrokerClient = {
    readonly key: string;
    request(input: unknown, signal?: AbortSignal): Promise<unknown>;
    close(): Promise<void>;
};

async function readAddress(file: string): Promise<BrokerAddress | undefined> {
    try {
        const value: unknown = JSON.parse(await readFile(file, "utf8"));
        return isAddress(value) ? value : undefined;
    }
    catch {
        return undefined; /* An absent/dead locator is recreated under the startup lock. */
    }
}

export async function brokerRequest(address: BrokerAddress, input: unknown, signal?: AbortSignal): Promise<unknown> {
    let response: Response;

    try {
        response = await fetch(`http://127.0.0.1:${address.port}/rpc`, { method: "POST", redirect: "error",
            headers: { Authorization: `Bearer ${address.token}`, "Content-Type": "application/json" }, body: JSON.stringify(input),
            ...(signal === undefined ? {} : { signal }) });
    }
    catch (error) {
        throw brokerRequestError(error);
    }

    if (!response.ok)
        throw new Error(`mcp_broker_http_${response.status}`);
    return response.json();
}

async function liveAddress(file: string, key: string): Promise<BrokerAddress | undefined> {
    const address = await readAddress(file);
    if (!address || address.key !== key)
        return undefined;

    try {
        await brokerRequest(address, { method: "status" }, AbortSignal.timeout(STATUS_TIMEOUT_MS));
        return address;
    }
    catch {
        return undefined; /* Discovery may reconnect; a dispatched tool call never retries. */
    }
}

/** The turn owns this keepalive; a shell/model wait is not an idle connection.
 * Only status is repeated. Business requests are never retried here. */
function retainBroker(address: BrokerAddress, intervalMs: number): () => Promise<void> {
    let state: "active" | "closed" = "active";
    let pulse: { readonly controller: AbortController; readonly pending: Promise<void> } | undefined;
    const timer = setInterval(() => {
        if (state === "closed" || pulse !== undefined)
            return;

        const controller = new AbortController();
        const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(STATUS_TIMEOUT_MS)]);
        const pending = brokerRequest(address, { method: "status" }, signal).then(() => undefined).catch(() => {
            // Maintenance cannot establish a business outcome. The next actual
            // request reports transport failure through its normal error contract.
        }).finally(() => { pulse = undefined; });

        pulse = { controller, pending };
    }, intervalMs);

    timer.unref();

    return async () => {
        state = "closed";
        clearInterval(timer);
        const current = pulse;

        if (current !== undefined) {
            current.controller.abort();
            await current.pending;
        }
    };
}

async function start(config: BrokerConfig): Promise<BrokerAddress> {
    const child = spawn(process.execPath, [fileURLToPath(new URL("./broker-host.js", import.meta.url))], {
        cwd: config.cwd, env: childEnvironment({}), detached: true, windowsHide: true, stdio: ["pipe", "pipe", "ignore"],
    });
    return new Promise((resolve, reject) => {
        let buffer = "", settled = false;
        const timer = setTimeout(() => finish(new Error("mcp_broker_start_timeout")), 5000);
        const finish = (result: BrokerAddress | Error): void => {
            if (settled)
                return;

            settled = true;
            clearTimeout(timer);
            child.stdout.destroy();
            child.stdin.destroy();

            if (result instanceof Error) {
                child.kill();
                reject(result);
            }
            else {
                child.unref();
                resolve(result);
            }
        };

        child.once("error", () => finish(new Error("mcp_broker_spawn_failed")));
        child.stdin.once("error", () => finish(new Error("mcp_broker_config_failed")));
        child.once("exit", () => finish(new Error("mcp_broker_exited")));
        child.stdout.on("data", chunk => {
            buffer += String(chunk);

            if (buffer.length > 4096) {
                finish(new Error("mcp_broker_invalid_receipt"));
                return;
            }

            if (!buffer.includes("\n"))
                return;

            try {
                const value: unknown = JSON.parse(buffer.split("\n")[0] ?? "");
                finish(isAddress(value) && value.key === config.key ? value : new Error("mcp_broker_invalid_receipt"));
            }
            catch {
                finish(new Error("mcp_broker_invalid_receipt"));
            }
        });
        child.stdin.end(`${JSON.stringify(config)}\n`);
    });
}

/** Only the locator (a local capability) is persisted; registry secrets stay on stdin/in memory. */
export async function connectBroker(input: {
    readonly registry: McpRegistryPort;
    readonly cwd: string;
    readonly root: string;
    readonly scope: string;
    readonly policy: string;
    readonly now?: () => number;
    /** Internal maintenance cadence; the default is derived from host idle cleanup. */
    readonly heartbeatIntervalMs?: number;
}): Promise<BrokerClient> {
    const now = input.now ?? Date.now;
    const heartbeatIntervalMs = input.heartbeatIntervalMs ?? Math.floor(BROKER_IDLE_MS / 3);

    if (!Number.isSafeInteger(heartbeatIntervalMs) || heartbeatIntervalMs <= 0 || heartbeatIntervalMs >= BROKER_IDLE_MS)
        throw new Error("mcp_broker_invalid_heartbeat_interval");

    const names = await input.registry.names();
    if (!names.ok)
        throw new Error(`mcp_registry_${names.code}`);

    const entries = await Promise.all(names.value.map(async (name) => {
        const result = await input.registry.resolve(name);
        if (!result.ok)
            throw new Error(`mcp_registry_${result.code}`);
        return result.value.entry;
    }));
    const cwd = await realpath(input.cwd);
    const build = await Promise.all(["broker-host.js", "broker-engine.js", "broker-contract.js", "pool.js", "factory.js",
        "../mcp-stdio/client.js", "../mcp-stdio/transport.js", "../mcp-http/client.js", "../../mcp/roots.js"].map(async (file) => {
        const info = await stat(new URL(file, import.meta.url));
        return [file, info.size, info.mtimeMs];
    }));
    // Reuse requires the same real workspace, policy, configuration and runtime build.
    const key = digest({ version: 1, cwd, scope: input.scope, policy: input.policy, entries, build });

    await mkdir(input.root, { recursive: true, mode: 0o700 });
    const file = path.join(input.root, `${key}.json`), lock = `${file}.lock`;
    let address = await liveAddress(file, key);
    if (!address) {
        let acquired = false;
        const until = now() + 6500;

        while (!acquired && now() < until) {
            try {
                await writeFile(lock, JSON.stringify({ pid: process.pid, at: now() }), { flag: "wx", mode: 0o600 });
                acquired = true;
            }
            catch (error) {
                if (!record(error) || error.code !== "EEXIST")
                    throw error;

                address = await liveAddress(file, key);

                if (address)
                    break;

                try {
                    const info = await stat(lock);
                    if (now() - info.mtimeMs > 15000) {
                        const owner: unknown = JSON.parse(await readFile(lock, "utf8"));
                        if (record(owner) && Number.isSafeInteger(owner.pid)) {
                            try {
                                process.kill(Number(owner.pid), 0);
                            }
                            catch (failure) {
                                if (record(failure) && failure.code === "ESRCH")
                                    await unlink(lock);
                            }
                        }
                    }
                }
                catch { /* A competing owner may have published/released its lock; retry discovery. */ }

                await new Promise(resolve => setTimeout(resolve, 50));
            }
        }

        if (acquired) {
            try {
                address = await liveAddress(file, key);
                if (!address) {
                    address = await start({ version: 1, key, cwd, entries });
                    await writeFile(file, JSON.stringify(address), { mode: 0o600 });
                }
            }
            finally {
                await unlink(lock);
            }
        }

        if (!address)
            throw new Error("mcp_broker_start_busy");
    }

    const owner = address;

    return { key, request: (request, signal) => brokerRequest(owner, request, signal),
        // Release only this client's keepalive; other turns may share the host.
        close: retainBroker(owner, heartbeatIntervalMs) };
}
