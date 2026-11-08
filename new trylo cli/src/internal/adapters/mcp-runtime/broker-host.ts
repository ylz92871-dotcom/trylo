import http from "node:http";
import { randomBytes } from "node:crypto";
import { createInterface } from "node:readline";
import { createBrokerEngine } from "./broker-engine.js";
import { BROKER_IDLE_MS, isEntry, object, record, type BrokerConfig } from "./broker-contract.js";

/** Private child entrypoint. Configuration/credentials arrive over stdin only. */
export async function serveBroker(config: BrokerConfig, options: {
    readonly idleMs?: number;
    readonly now?: () => number;
} = {}) {
    const now = options.now ?? Date.now;
    const engine = createBrokerEngine(config);
    const token = randomBytes(32).toString("base64url");
    let touched = now(), active = 0, closing: Promise<void> | undefined;
    const controllers = new Set<AbortController>();
    const server = http.createServer(async (request, response) => {
        const reply = (status: number, value: unknown) => {
            if (!response.destroyed) {
                response.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" });
                response.end(JSON.stringify(value));
            }
        };

        if (request.method !== "POST" || request.url !== "/rpc" || request.headers.origin
            || request.headers.authorization !== `Bearer ${token}`) {
            reply(403, { error: "broker_access_denied" });
            return;
        }

        const controller = new AbortController();

        controllers.add(controller);
        active++;
        touched = now();
        response.on("close", () => {
            if (!response.writableEnded)
                controller.abort();
        });

        try {
            let bytes = 0;
            const chunks: Buffer[] = [];

            for await (const chunk of request) {
                bytes += chunk.length;
                if (bytes > 8 * 1024 * 1024) {
                    reply(413, { error: "broker_input_too_large" });
                    return;
                }
                chunks.push(chunk);
            }

            const input: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
            if (!record(input)) {
                reply(400, { error: "broker_invalid_request" });
                return;
            }

            if (input.method === "status")
                reply(200, engine.snapshot().map(row => ({ ...row, tools: [] })));
            else if (input.method === "load" && typeof input.server === "string") {
                await engine.ensure(input.server);
                reply(200, engine.snapshot().filter(row => row.serverId === input.server));
            }
            else if (input.method === "call" && typeof input.server === "string" && typeof input.tool === "string"
                && typeof input.schemaHash === "string" && object(input.arguments)
                && (input.timeoutMs === undefined || typeof input.timeoutMs === "number" && Number.isSafeInteger(input.timeoutMs) && input.timeoutMs > 0)) {
                reply(200, await engine.call(input.server, input.tool, input.schemaHash, input.arguments, input.timeoutMs, controller.signal));
            }
            else if (input.method === "resource" && typeof input.server === "string") {
                reply(200, await engine.resource(input, controller.signal));
            }
            else if (input.method === "shutdown") {
                reply(200, { closed: true });
                void close();
            }
            else
                reply(400, { error: "broker_invalid_operation" });
        }
        catch {
            // No request body, credential or child stderr is echoed through this boundary.
            reply(500, { error: "broker_request_failed" });
        }
        finally {
            active--;
            touched = now();
            controllers.delete(controller);
        }
    });

    server.requestTimeout = 620000;
    server.headersTimeout = 10000;
    const timer = setInterval(() => {
        if (active === 0 && now() - touched >= (options.idleMs ?? BROKER_IDLE_MS))
            void close();
    }, 1000);

    function close(): Promise<void> {
        return closing ??= (async () => {
            clearInterval(timer);
            for (const controller of controllers)
                controller.abort();
            server.closeAllConnections();
            await new Promise<void>(resolve => server.close(() => resolve()));
            await engine.close();
        })();
    }

    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    if (!address || typeof address === "string") {
        await close();
        throw new Error("broker_address_unavailable");
    }

    // Do not await tool initialization: the first model request is independent.
    void engine.warm();

    return { address: { version: 1 as const, key: config.key, port: address.port, token }, close };
}

if (process.argv[1]?.replace(/\\/g, "/").endsWith("/mcp-runtime/broker-host.js")) {
    const lines = createInterface({ input: process.stdin });
    lines.once("line", async (line) => {
        lines.close();
        try {
            const raw: unknown = JSON.parse(line);
            if (!record(raw) || raw.version !== 1 || typeof raw.key !== "string" || typeof raw.cwd !== "string"
                || !Array.isArray(raw.entries) || !raw.entries.every(isEntry))
                throw new Error("invalid_broker_configuration");

            const host = await serveBroker({ version: 1, key: raw.key, cwd: raw.cwd, entries: raw.entries });

            process.stdout.write(`${JSON.stringify(host.address)}\n`);
            const stop = () => { void host.close(); };

            process.once("SIGTERM", stop);
            process.once("SIGINT", stop);
        }
        catch {
            process.stderr.write("MCP broker startup failed\n");
            process.exitCode = 1;
        }
    });
}
