import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { IsolationPort } from "../../../../../ports/isolation.js";

const execute = promisify(execFile);
/** TEST ONLY real Node permissions/process boundary. This deliberately makes no OS isolation claim. */
export const localNodeContract: IsolationPort = {
  probe: async () => ({ state: "ready", backend: "windows-srt", evidence: "TEST ONLY local Node child contract, not native isolation acceptance" }),
  run: async request => {
    const [file, ...args] = request.argv;
    if (file === undefined) throw new Error("TEST ONLY missing executable");
    const result = await execute(file, args, { cwd: request.cwd, env: {}, windowsHide: true, timeout: request.timeoutMs,
      signal: request.signal, maxBuffer: 131_072 });
    return { outcome: "completed", stdout: result.stdout, stderr: result.stderr, exitCode: 0, timedOut: false, backend: "windows-srt" };
  },
};
