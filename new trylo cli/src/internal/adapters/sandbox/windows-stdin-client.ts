import { spawn } from "node:child_process";
import { connect } from "node:net";
import { bridgeArgv, HANDSHAKE_TIMEOUT_MS, STDIN_ACK, STDIN_PIPE, STDIN_TOKEN, takeStdinHeader } from "./windows-stdin-protocol.js";

// Runs inside the existing SRT Job/account. Only its authenticated socket becomes
// target stdin; broker stdin remains SRT control traffic.
const argv = bridgeArgv(process.argv[2]);
const pipe = process.env[STDIN_PIPE], token = process.env[STDIN_TOKEN];
delete process.env[STDIN_PIPE]; delete process.env[STDIN_TOKEN];
if (pipe === undefined || !/^\\\\\.\\pipe\\trylo-stdin-[a-f0-9]{32}$/.test(pipe) || token === undefined || !/^[a-f0-9]{64}$/.test(token)) {
  throw new Error("stdin_bridge_missing_capability");
}
const socket = connect({ path: pipe, allowHalfOpen: true });
let child: ReturnType<typeof spawn> | undefined;
let header = Buffer.alloc(0);
const timeout = setTimeout(() => fail("stdin_bridge_handshake_timeout"), HANDSHAKE_TIMEOUT_MS);
function fail(message: string): void {
  clearTimeout(timeout);
  process.stderr.write(`${message}\n`);
  socket.destroy();
  // Closing this trusted SRT entry closes the existing Job and its descendants.
  process.exit(1);
}
socket.on("error", () => fail("stdin_bridge_connection_failed"));
socket.on("connect", () => socket.write(`${token}\n`));
socket.on("end", () => { if (child === undefined) fail("stdin_bridge_closed_before_ack"); });
const acknowledge = (chunk: Buffer): void => {
  header = Buffer.concat([header, chunk]);
  let frame: ReturnType<typeof takeStdinHeader>;
  try { frame = takeStdinHeader(header); }
  catch { fail("stdin_bridge_invalid_ack"); return; }
  if (frame === undefined) return;
  if (frame.header.toString("ascii") + "\n" !== STDIN_ACK) { fail("stdin_bridge_invalid_ack"); return; }
  clearTimeout(timeout);
  socket.pause(); socket.removeListener("data", acknowledge);
  if (frame.rest.length > 0) socket.unshift(frame.rest);
  child = spawn(argv[0], argv.slice(1), { env: process.env, stdio: ["pipe", "inherit", "inherit"], windowsHide: true });
  const input = child.stdin;
  if (input === null) { fail("stdin_bridge_target_stdin_missing"); return; }
  // EPIPE means the target deliberately stopped reading; its real exit is authoritative.
  input.on("error", error => { if ("code" in error && error.code === "EPIPE") socket.unpipe(input); else fail("stdin_bridge_target_stdin_failed"); });
  child.on("error", () => fail("stdin_bridge_target_start_failed"));
  child.on("close", code => { socket.destroy(); process.exit(code ?? 1); });
  socket.pipe(input);
};
socket.on("data", acknowledge);
