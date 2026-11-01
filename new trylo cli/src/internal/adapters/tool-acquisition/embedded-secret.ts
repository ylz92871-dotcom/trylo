/** Narrow package-data heuristic, not a general malware or secret-free verdict. */
export function hasEmbeddedSecret(bytes: Uint8Array): boolean {
  const source = Buffer.from(bytes).toString("utf8");
  if (/AKIA[0-9A-Z]{16}|ghp_[A-Za-z0-9]{36}/.test(source)) return true;
  for (const marker of source.matchAll(/-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY-----/g)) {
    // PEM importers necessarily contain the format label. Reject material following it,
    // including escaped newlines in a source string, rather than rejecting the label itself.
    const following = source.slice(marker.index + marker[0].length, marker.index + marker[0].length + 512);
    if (/^(?:\s|\\r|\\n)*[A-Za-z0-9+/=]{32,}/.test(following)) return true;
  }
  return false;
}
