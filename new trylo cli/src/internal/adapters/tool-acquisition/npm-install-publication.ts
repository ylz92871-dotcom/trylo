import { lstat, rename } from "node:fs/promises";
import path from "node:path";
import { isFilesystemBusy } from "../filesystem/busy-error.js";
import { checkQuarantineAncestors, isMissing, QuarantineFileError } from "./quarantine-files.js";

export class NpmPublicationError extends Error {
  constructor(readonly code: "npm_install_publish_blocked", readonly ioCode?: string) { super(code); }
}
export type NpmPublicationIo = { readonly rename: typeof rename; readonly wait: (milliseconds: number, signal: AbortSignal) => Promise<void> };
const DEFAULT_IO: NpmPublicationIo = { rename, wait: waitForPublication };

/** Bounded publication only: never re-download, execute hooks, unlink a destination or replace prior evidence. */
export async function publishNpmInstall(destination: string, signal: AbortSignal, io: NpmPublicationIo = DEFAULT_IO): Promise<void> {
  const stage = `${destination}.staging`, parent = path.resolve(path.dirname(destination));
  if (path.dirname(path.resolve(stage)) !== parent || !/^npm-install_v1_[a-f0-9]{64}$/.test(path.basename(destination))) throw new NpmPublicationError("npm_install_publish_blocked");
  await checkQuarantineAncestors(parent);
  const stageInfo = await lstat(stage);
  if (!stageInfo.isDirectory() || stageInfo.isSymbolicLink()) throw new QuarantineFileError("quarantine_corrupt");
  const delays = [0, 25, 75, 200, 500, 1000];
  for (let attempt = 0; attempt < delays.length; attempt++) {
    if (signal.aborted) throw new NpmPublicationError("npm_install_publish_blocked");
    await io.wait(delays[attempt]!, signal);
    if (signal.aborted) throw new NpmPublicationError("npm_install_publish_blocked");
    const existing = await lstat(destination).catch(error => { if (isMissing(error)) return undefined; throw error; });
    if (existing !== undefined) throw new QuarantineFileError("quarantine_busy");
    try { await io.rename(stage, destination); return; }
    catch (error) {
      if (!isFilesystemBusy(error) || attempt === delays.length - 1) {
        const code = error !== null && typeof error === "object" && "code" in error ? String(error.code) : undefined;
        throw new NpmPublicationError("npm_install_publish_blocked", code);
      }
    }
  }
}
function waitForPublication(milliseconds: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.reject(new NpmPublicationError("npm_install_publish_blocked"));
  return new Promise((resolve, reject) => {
    const stop = () => { clearTimeout(timer); signal.removeEventListener("abort", stop); reject(new NpmPublicationError("npm_install_publish_blocked")); };
    const timer = setTimeout(() => { signal.removeEventListener("abort", stop); resolve(); }, milliseconds);
    signal.addEventListener("abort", stop, { once: true });
    if (signal.aborted) stop();
  });
}
