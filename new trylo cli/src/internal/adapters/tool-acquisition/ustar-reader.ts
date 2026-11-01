import { gunzipSync } from "node:zlib";
import { inspectArchive } from "../../tooling/quarantine/archive-guard.js";
import { safePackagePath } from "./npm-quarantine-plan.js";

export type PackageFile = { readonly path: string; readonly body: Uint8Array };
export class PackageArchiveError extends Error {
  constructor(readonly code: "invalid_archive" | "unsupported_archive_entry" | "unsafe_archive_path" | "archive_limit") { super(code); }
}
const MAX_EXPANDED = 10_000_000;
const BLOCK = 512;

/** Strict ustar only: no extraction utility, links, PAX overrides, devices, or executable hooks. */
export function readNpmTarball(body: Uint8Array, sha256: string, profile: "dependency_free" | "dependency_tree" = "dependency_free"): readonly PackageFile[] {
  let tar: Buffer;
  try { tar = gunzipSync(body, { maxOutputLength: MAX_EXPANDED }); }
  catch { throw new PackageArchiveError("invalid_archive"); }
  if (tar.length % BLOCK !== 0 || tar.length < 2 * BLOCK) throw new PackageArchiveError("invalid_archive");
  const files: PackageFile[] = [], paths = new Set<string>();
  for (let offset = 0; offset < tar.length;) {
    const header = tar.subarray(offset, offset + BLOCK);
    if (header.every(byte => byte === 0)) {
      if (tar.length - offset < 2 * BLOCK || tar.subarray(offset).some(byte => byte !== 0)) throw new PackageArchiveError("invalid_archive");
      const checked = inspectArchive({ name: "package.tgz", expectedHash: sha256, actualHash: sha256, uncompressedBytes: tar.length,
        entries: files.map(file => ({ path: file.path, kind: "file", size: file.body.length })) }, body.length);
      if (!checked.ok) throw new PackageArchiveError("archive_limit");
      return files;
    }
    const checksum = numberAt(header, 148, 8);
    const actual = header.reduce((sum, byte, index) => sum + (index >= 148 && index < 156 ? 32 : byte), 0);
    if (checksum !== actual || textAt(header, 257, 6) !== "ustar" || (textAt(header, 263, 2) !== "00" && textAt(header, 263, 2) !== "")) throw new PackageArchiveError("invalid_archive");
    const kind = header[156], size = numberAt(header, 124, 12), name = textAt(header, 0, 100), prefix = textAt(header, 345, 155);
    const full = `${prefix === "" ? "" : `${prefix}/`}${name}`;
    if (kind !== 0 && kind !== 48 && kind !== 53) throw new PackageArchiveError("unsupported_archive_entry");
    if (full === "package/" && kind !== 53) throw new PackageArchiveError("unsafe_archive_path");
    const path = (kind === 53 ? full.replace(/\/$/, "") : full).replace(/^package\//, "");
    if ((full !== "package/" && !full.startsWith("package/")) || (full !== "package/" && !safePackagePath(path))) throw new PackageArchiveError("unsafe_archive_path");
    if (size > MAX_EXPANDED || offset + BLOCK + size > tar.length || (kind === 53 && size !== 0)) throw new PackageArchiveError("invalid_archive");
    if (full !== "package/") {
      const key = path.toLowerCase();
      if (paths.has(key)) throw new PackageArchiveError("unsafe_archive_path");
      paths.add(key);
      if (paths.size > (profile === "dependency_tree" ? 4096 : 256)) throw new PackageArchiveError("archive_limit");
      if (kind !== 53) files.push({ path, body: Uint8Array.from(tar.subarray(offset + BLOCK, offset + BLOCK + size)) });
    }
    offset += BLOCK + Math.ceil(size / BLOCK) * BLOCK;
  }
  throw new PackageArchiveError("invalid_archive");
}
function textAt(buffer: Uint8Array, start: number, size: number): string {
  const bytes = buffer.subarray(start, start + size), end = bytes.indexOf(0);
  const length = end < 0 ? bytes.length : end;
  if (end >= 0 && bytes.subarray(end).some(byte => byte !== 0)) throw new PackageArchiveError("invalid_archive");
  try { return new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, length)); }
  catch { throw new PackageArchiveError("invalid_archive"); }
}
function numberAt(buffer: Uint8Array, start: number, size: number): number {
  const text = new TextDecoder().decode(buffer.subarray(start, start + size)).replace(/\0.*$/, "").trim();
  if (!/^[0-7]{1,11}$/.test(text)) throw new PackageArchiveError("invalid_archive");
  return parseInt(text, 8);
}
