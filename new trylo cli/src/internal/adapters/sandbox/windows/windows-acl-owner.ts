import { closeSync, mkdirSync, openSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";

/** The vendor revokes every grant held by one PID, so overlapping owners refuse. */
export function acquireAclOwner(directory = join(homedir(), ".trylo-sandbox-owners"), holderPid = process.pid, birth = performance.timeOrigin): () => void {
  mkdirSync(directory, { recursive: true });
  // A crashed process cannot block a later process reusing its numeric PID.
  const file = join(directory, `${holderPid}-${birth}.lock`);
  let fd: number;

  try { fd = openSync(file, "wx", 0o600); }
  catch (error) { throw new Error("isolation_owner_busy: this process already owns an ACL lease", { cause: error }); }

  return () => {
    closeSync(fd);
    unlinkSync(file);
  };
}
