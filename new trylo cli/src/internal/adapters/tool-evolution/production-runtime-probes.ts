import { createServer, connect } from "node:net";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import path from "node:path";
import type { ToolEvolutionCandidate } from "../../learning/domains/tool/evolution/contracts.js";
import { createToolCandidateExecutor, type ProcessToolExecutorOptions } from "./process-executor.js";

/** Fixed checker programs, never generated or supplied by the candidate. No external network destinations. */
export async function probeProductionPermissionBounds(options: ProcessToolExecutorOptions, signal: AbortSignal): Promise<boolean> {
  await mkdir(options.scratchRoot, { recursive: true });
  const root = await mkdtemp(path.join(options.scratchRoot, "boundary-"));
  const secret = path.join(root, "outside.txt"); await writeFile(secret, "TRYLO_PRODUCTION_PROBE_NOT_USER_DATA", { flag: "wx" });
  const { profile: _profile, ...base } = options;
  const executor = createToolCandidateExecutor(base);
  const read = await executor.execute(probeCandidate(`module.exports=()=>require('node:fs').readFileSync(${JSON.stringify(secret)},'utf8');`), null, signal);
  if (read.kind !== "tool_error" || !["ERR_ACCESS_DENIED", "EACCES", "EPERM"].includes(read.code)) return false;
  let connections = 0;
  const server = createServer(socket => { connections++; socket.destroy(); });
  try {
    await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
    const address = server.address(); if (address === null || typeof address === "string") return false;
    // Positive control prevents a dead server from being mistaken for an enforced network denial.
    const accepted = new Promise<void>(resolve => server.once("connection", () => resolve()));
    await new Promise<void>((resolve, reject) => { const socket = connect(address.port, "127.0.0.1"); socket.once("connect", () => { socket.destroy(); resolve(); }); socket.once("error", reject); });
    await accepted;
    const before = connections;
    const source = `module.exports=()=>new Promise(resolve=>{const socket=require('node:net').connect(${address.port},'127.0.0.1');socket.once('connect',()=>{socket.destroy();resolve('connected')});socket.once('error',error=>resolve(error.code));setTimeout(()=>{socket.destroy();resolve('probe_timeout')},1000).unref();});`;
    const network = await executor.execute(probeCandidate(source), null, signal);
    const denial = network.kind === "tool_error" ? network.code : network.kind === "value" && typeof network.value === "string" ? network.value : "";
    return ["ERR_ACCESS_DENIED", "EACCES", "EPERM"].includes(denial) && connections === before;
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
}

export async function probeProductionLifecycle(options: ProcessToolExecutorOptions, signal: AbortSignal): Promise<boolean> {
  const { profile: _profile, ...base } = options;
  const executor = createToolCandidateExecutor(base);
  const crash = await executor.execute(probeCandidate("module.exports=()=>require('node:process').exit(23);"), null, signal);
  if (signal.aborted || crash.kind !== "protocol_error") return false;
  const timeout = await createToolCandidateExecutor({ ...base, timeoutMs: 750 }).execute(probeCandidate("module.exports=()=>{while(true){}};"), null, signal);
  if (signal.aborted || timeout.kind !== "timeout") return false;
  const controller = new AbortController(); let timer: ReturnType<typeof setTimeout> | undefined;
  const cancellable = createToolCandidateExecutor({ ...base, isolation: { probe: () => options.isolation.probe(), run: request => {
    timer = setTimeout(() => controller.abort(), 1500); return options.isolation.run(request);
  } } });
  try {
    const cancelled = await cancellable.execute(probeCandidate("module.exports=()=>{while(true){}};"), null, AbortSignal.any([signal, controller.signal]));
    return !signal.aborted && cancelled.kind === "cancelled";
  } finally { clearTimeout(timer); }
}

function probeCandidate(source: string): ToolEvolutionCandidate {
  return { identity: "trusted-runtime-check", description: "Fixed runtime boundary verification program", source, inputSchema: {},
    mastery: { whenToUse: [], preconditions: [], pitfalls: [] } };
}
