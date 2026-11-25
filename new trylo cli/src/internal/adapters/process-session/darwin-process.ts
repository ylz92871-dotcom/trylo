import { execFile } from "node:child_process";
import type { DaemonIdentity } from "../../domain/daemon-identity.js";

export type DarwinProcess = DaemonIdentity & { readonly processGroup: number };

/** BSD ps reports start time in whole seconds; use a fixed locale and time zone. */
export function observeDarwinProcess(pid: number): Promise<DarwinProcess | undefined> {
  if (!Number.isSafeInteger(pid) || pid <= 0) return Promise.reject(new Error("invalid process id"));
  return new Promise((resolve, reject) => {
    execFile("/bin/ps", ["-o", "pgid=", "-o", "lstart=", "-p", String(pid)], {
      encoding: "utf8", timeout: 5000, env: { LC_ALL: "C", TZ: "UTC" },
    }, (error, stdout, stderr) => {
      if (error !== null) {
        if (error.code === 1 && stdout.trim() === "" && stderr.trim() === "") return resolve(undefined);
        return reject(new Error(`ps could not inspect pid ${pid}: ${stderr.trim() || error.message}`));
      }

      const fields = /^(\d+)\s+[A-Z][a-z]{2}\s+([A-Z][a-z]{2})\s+(\d{1,2})\s+(\d{2}:\d{2}:\d{2})\s+(\d{4})$/.exec(stdout.trim());
      if (fields === null) return reject(new Error(`ps returned an unrecognized start time for pid ${pid}`));
      const [, group, month, day, time, year] = fields;
      const processGroup = Number(group);
      const startedAtMs = Date.parse(`${day} ${month} ${year} ${time} UTC`);
      if (!Number.isSafeInteger(processGroup) || processGroup <= 0 || !Number.isFinite(startedAtMs)) {
        return reject(new Error(`ps returned an invalid identity for pid ${pid}`));
      }
      return resolve({ pid, startedAtMs, processGroup });
    });
  });
}
