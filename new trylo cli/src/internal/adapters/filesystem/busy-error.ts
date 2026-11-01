/** Windows scanners and open handles can temporarily deny a filesystem replacement. */
export function isFilesystemBusy(error: unknown): boolean {
  const code = error !== null && typeof error === "object" && "code" in error ? error.code : undefined;
  return ["EPERM", "EACCES", "EBUSY"].includes(String(code));
}
