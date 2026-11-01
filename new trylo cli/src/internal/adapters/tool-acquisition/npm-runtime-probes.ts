import { connect, createServer } from "node:net";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import path from "node:path";
import { recordOf } from "../../learning/domains/tool/evolution/parse.js";
import { runNpmSnapshot, type NpmSnapshotOptions } from "./npm-snapshot.js";

const INPUT = { argv: [], stdin: "" };
function probe(source: string, timeoutMs = 5000) {
  return { files: [{ path: "node_modules/trusted-probe/index.cjs", body: Buffer.from(source) }], entrypoint: "node_modules/trusted-probe/index.cjs",
    runtime: { profile: "confined_npm_cli_v1" as const, bin: "trusted-probe", entrypoint: "index.cjs" }, schema: {}, timeoutMs };
}

/** Fixed programs use exactly the same child-launch flags, broker and OS fence as installed tools. */
export async function probeNpmPermissionBounds(options: NpmSnapshotOptions, signal: AbortSignal): Promise<boolean> {
  await mkdir(options.scratchRoot, { recursive: true });
  const directory = await mkdtemp(path.join(options.scratchRoot, "npm-boundary-")), outside = path.join(directory, "outside.txt");
  await writeFile(outside, "TRYLO_SYNTHETIC_BOUNDARY_DATA", { flag: "wx" });
  let connections = 0;
  const server = createServer(socket => { connections++; socket.destroy(); });
  try {
    await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
    const address = server.address(); if (address === null || typeof address === "string") return false;
    const accepted = new Promise<void>(resolve => server.once("connection", () => resolve()));
    await new Promise<void>((resolve, reject) => { const socket = connect(address.port, "127.0.0.1"); socket.once("connect", () => { socket.destroy(); resolve(); }); socket.once("error", reject); });
    await accepted; const before = connections;
    const source = `const fs=require('node:fs'), cp=require('node:child_process'), net=require('node:net'), runtime=require('node:process');
const attempt=fn=>{try{fn();return 'allowed'}catch(error){return error.code}};
const result={read:attempt(()=>fs.readFileSync(${JSON.stringify(outside)},'utf8')),
write:attempt(()=>fs.writeFileSync(__dirname+'/unauthorized.txt','forbidden')),
spawn:attempt(()=>cp.spawnSync(runtime.execPath,['-e','0'])),secret:runtime.env.TRYLO_NPM_BOUNDARY_SENTINEL??'absent'};
const socket=net.connect(${address.port},'127.0.0.1');let settled=false;const done=code=>{if(settled)return;settled=true;socket.destroy();result.network=code;console.log(JSON.stringify(result));};
socket.once('connect',()=>done('connected'));socket.once('error',error=>done(error.code));setTimeout(()=>done('no_enforcement_evidence'),1000).unref();`;
    const checked = await runNpmSnapshot(probe(source), INPUT, { ...options, isolation: { probe: () => options.isolation.probe(),
      run: request => options.isolation.run({ ...request, env: { ...request.env, TRYLO_NPM_BOUNDARY_SENTINEL: "TRYLO_SYNTHETIC_SECRET_MUST_NOT_REACH_CHILD" } }) } }, signal);
    if (checked.kind !== "value" || !recordOf(checked.value) || typeof checked.value.stdout !== "string") return false;
    const result: unknown = JSON.parse(checked.value.stdout);
    const denied = (value: unknown) => ["ERR_ACCESS_DENIED", "EACCES", "EPERM"].includes(String(value));
    return recordOf(result) && denied(result.read) && denied(result.write) && denied(result.spawn) && denied(result.network)
      && result.secret === "absent" && connections === before;
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
}

export async function probeNpmLifecycle(options: NpmSnapshotOptions, signal: AbortSignal): Promise<boolean> {
  const crashed = await runNpmSnapshot(probe("require('node:process').exit(23);"), INPUT, options, signal);
  if (signal.aborted || crashed.kind !== "tool_error" || crashed.code !== "cli_exit_23") return false;
  const timedOut = await runNpmSnapshot(probe("while(true){}", 1000), INPUT, options, signal);
  if (signal.aborted || timedOut.kind !== "timeout") return false;
  const cancelled = new AbortController(); let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const result = await runNpmSnapshot(probe("while(true){}", 10_000), INPUT, { ...options, isolation: { probe: () => options.isolation.probe(),
      run: request => { timer = setTimeout(() => cancelled.abort(), 1500); return options.isolation.run(request); } } }, AbortSignal.any([signal, cancelled.signal]));
    return !signal.aborted && result.kind === "cancelled";
  } finally { clearTimeout(timer); }
}
