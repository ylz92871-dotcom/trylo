import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createServer, type Socket } from "node:net";
import { terminateProcessTree } from "../process-session/process-tree.js";
import { bridgeArgv, HANDSHAKE_TIMEOUT_MS, STDIN_ACK, STDIN_PIPE, STDIN_TOKEN, takeStdinHeader, validStdinToken } from "./windows-stdin-protocol.js";

// This entry is copied from captured installed bytes into the protected helper
// cache before execution. Never run a workspace script under caller authority.
const argv = bridgeArgv(process.argv[2]);
const separator = argv.indexOf("--");
if (separator < 1) throw new Error("stdin_bridge_missing_broker_separator");
const token = randomBytes(32).toString("hex");
const pipe = "\\\\.\\pipe\\trylo-stdin-" + randomBytes(16).toString("hex");
const peers = new Set<Socket>();
let authenticated: Socket | undefined;
let broker: ReturnType<typeof spawn> | undefined;
let state: "starting" | "connected" | "closing" = "starting";
const timeout = setTimeout(() => { void fail("stdin_bridge_handshake_timeout"); }, HANDSHAKE_TIMEOUT_MS);
function closeTransport(): void {
  clearTimeout(timeout);
  process.stdin.unpipe(); process.stdin.pause();
  for (const peer of peers) peer.destroy();
  server.close();
}
async function fail(message: string): Promise<void> {
  if (state === "closing") return;
  state = "closing"; closeTransport();
  process.stderr.write(`${message}\n`);
  if (broker !== undefined) {
    const stopped = await terminateProcessTree(broker);
    if (!stopped.ok) process.stderr.write(`${stopped.message}\n`);
  }
  process.exit(1);
}
const server = createServer({ allowHalfOpen: true }, socket => {
  if (authenticated !== undefined || peers.size >= 4) { socket.destroy(); return; }
  peers.add(socket);
  socket.on("close", () => peers.delete(socket));
  socket.on("error", () => { socket.destroy(); }); // failed peer never becomes stdin
  let header = Buffer.alloc(0);
  const authenticate = (chunk: Buffer): void => {
    header = Buffer.concat([header, chunk]);
    let frame: ReturnType<typeof takeStdinHeader>;
    try { frame = takeStdinHeader(header); }
    catch { socket.destroy(); return; }
    if (frame === undefined) return;
    if (!validStdinToken(frame.header, token) || frame.rest.length !== 0) { socket.destroy(); return; }
    authenticated = socket; state = "connected"; clearTimeout(timeout);
    socket.removeListener("data", authenticate);
    for (const other of peers) if (other !== socket) other.destroy();
    server.close();
    socket.write(STDIN_ACK);
    // ACK and input share ordered socket bytes; the client preserves coalesced data.
    process.stdin.pipe(socket);
  };
  socket.on("data", authenticate);
});
server.on("error", () => { void fail("stdin_bridge_listen_failed"); });
process.stdin.on("error", () => { void fail("stdin_bridge_source_failed"); });
server.listen({ path: pipe, readableAll: true, writableAll: true }, () => {
  // Node's default named-pipe ACL excludes SRT's restricted account. The random
  // nonce authenticates that one client before any stdin bytes are consumed.
  const args = [...argv.slice(1, separator), "--env", `${STDIN_PIPE}=${pipe}`, "--env", `${STDIN_TOKEN}=${token}`, ...argv.slice(separator)];
  broker = spawn(argv[0], args, { env: process.env, stdio: ["ignore", "inherit", "inherit"], windowsHide: true });
  broker.on("error", () => { void fail("stdin_bridge_broker_start_failed"); });
  broker.on("close", code => {
    if (state === "closing") return;
    state = "closing"; closeTransport(); process.exit(code ?? 1);
  });
});
