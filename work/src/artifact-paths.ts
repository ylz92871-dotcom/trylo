// Trylo Work — artifact path canonicalization
// (M3 closure spec §9.2, fixing M3-P2-07).
//
// Windows paths arrive from two independent sources —
// daemon events (`payload.path`) and the `.trylo/out`
// scan — with different drive-letter casing, separators
// and trailing slashes. Deduping on raw strings lets
// `D:/repo/out/a.md` and `d:\repo\out\a.md` surface
// twice, and a case-sensitive `startsWith` prefix even
// turns `D:\repo2\x` into a "relative" path of
// `D:\repo`. Both problems are solved here with ONE
// canonical form and a segment-boundary relative
// computation. The module is core (spec §12): renderer
// components import it, never the other way around.

const WINDOWS_DRIVE_RE = /^([a-zA-Z]):(.*)$/;

/** Canonical absolute form used as the dedupe key
 *  (§9.2): drive letter upper-cased, `/` separators,
 *  no trailing slash, empty dot segments removed.
 *  Returns undefined for empty input. `..` segments are
 *  NOT collapsed — containment checks belong to the
 *  security gate (§9.3), not to display canonicalization. */
export function canonicalAbsolutePath(input: string | undefined | null): string | undefined {
  if (typeof input !== "string") return undefined;
  let path = input.trim();
  if (path.length === 0) return undefined;
  path = path.replace(/\\/g, "/");
  const posixAbsolute = path.startsWith("/");
  const driveMatch = WINDOWS_DRIVE_RE.exec(path);
  // Both capture groups always exist when the regex
  // matches; the ?? fallbacks only placate strict
  // noUncheckedIndexedAccess builds (desktop tsconfig).
  const driveLetter =
    driveMatch !== null ? (driveMatch[1] ?? "").toUpperCase() : undefined;
  if (driveMatch !== null) {
    path = `${driveLetter}:${driveMatch[2] ?? ""}`;
  }
  const segments: string[] = [];
  for (const seg of path.split("/")) {
    if (seg.length === 0 || seg === ".") continue;
    // The drive letter arrives as its own "X:" segment
    // after splitting; it is re-attached as a prefix, so
    // keep it out of the body to avoid `D:/D:/…`.
    if (driveMatch !== null && /^[a-zA-Z]:$/.test(seg)) continue;
    segments.push(seg);
  }
  const body = segments.join("/");
  const out = driveLetter !== undefined && driveLetter.length > 0
    ? `${driveLetter}:/${body}`
    : posixAbsolute
      ? `/${body}`
      : body;
  return out.length > 0 ? out : undefined;
}

/** True when the path looks Windows-style (drive letter
 *  or backslashes in the ORIGINAL input). */
export function isWindowsStylePath(input: string): boolean {
  return WINDOWS_DRIVE_RE.test(input) || input.includes("\\");
}

/** Relative path of `target` under `root` computed by
 *  SEGMENT comparison, not string prefix (§9.2). Returns
 *  undefined when target is outside root or either side
 *  is malformed — callers then fall back to the absolute
 *  form. `D:/repo2/a.md` under `D:/repo` is correctly
 *  rejected; `D:/REPO/a.md` under `d:/repo` is correctly
 *  accepted because both sides are canonicalized first. */
export function relativeArtifactPath(
  target: string | undefined,
  root: string | undefined,
): string | undefined {
  if (typeof target !== "string" || typeof root !== "string") return undefined;
  const t = canonicalAbsolutePath(target);
  const r = canonicalAbsolutePath(root);
  if (t === undefined || r === undefined) return undefined;
  // Windows file systems compare case-insensitively, so
  // `D:/REPO/out` is contained in `d:/repo`.
  const ignoreCase = isWindowsStylePath(target) || isWindowsStylePath(root);
  const sameSeg = (a: string, b: string): boolean =>
    ignoreCase ? a.toLowerCase() === b.toLowerCase() : a === b;
  const rootSegs = r.split("/");
  const targetSegs = t.split("/");
  if (targetSegs.length <= rootSegs.length) return undefined;
  for (let i = 0; i < rootSegs.length; i += 1) {
    if (!sameSeg(targetSegs[i] ?? "", rootSegs[i] ?? "")) return undefined;
  }
  return targetSegs.slice(rootSegs.length).join("/");
}

/** Display name: the last path segment of the canonical
 *  form. */
export function artifactDisplayName(input: string | undefined): string {
  const canonical = canonicalAbsolutePath(input);
  if (canonical === undefined) return "";
  const segments = canonical.split("/");
  return segments[segments.length - 1] ?? "";
}

// ── Security gate (M3 closure spec §9.3, M3-P1-11) ────────────────
//
// Artifact paths come from the daemon/agent and are NOT
// trusted. Every open / open-with / show-in-folder action
// must pass this gate BEFORE any host call: canonicalize
// both sides, then prove the target is strictly inside the
// project root on a SEGMENT boundary. The host (Rust)
// side re-validates after fs::canonicalize, which also
// resolves symlinks — this renderer gate is the fast,
// user-visible first line, not the only one.

/** Why an artifact action was denied (§9.3). */
export type ArtifactOpenDenialReason =
  /** No project root available to contain the target —
   *  the gate cannot run, so the action is refused
   *  (spec: disable + explain, never open unchecked). */
  | "missing_root"
  /** Target or root did not canonicalize to an absolute
   *  path. */
  | "malformed"
  /** Target contains `..` segments — canonicalization
   *  keeps them on purpose, so their presence is an
   *  attempted escape. */
  | "traversal"
  /** Device / UNC / reserved-name path (\\.\X, \\?\X,
   *  //server/share, CON, NUL, COM1…). */
  | "device_path"
  /** Target canonicalizes outside (or equal to) the
   *  project root. */
  | "outside_root";

export type ArtifactOpenVerdict =
  | { readonly ok: true; readonly canonical: string }
  | { readonly ok: false; readonly reason: ArtifactOpenDenialReason };

/** Windows reserved device names, with or without an
 *  extension (`CON`, `NUL.txt`…). */
const WINDOWS_RESERVED_RE =
  /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i;

/** True when `input` is an http(s) URL (web artifacts are
 *  opened in the browser, not through the file gate). */
export function isHttpArtifact(input: string | undefined | null): boolean {
  if (typeof input !== "string") return false;
  const trimmed = input.trim();
  if (!/^https?:\/\//i.test(trimmed)) return false;
  // Reject control characters — the value is handed to an
  // OS launcher as a single argument.
  return !/[\u0000-\u001f\u007f]/.test(trimmed);
}

/** §9.3 security gate for artifact file actions. Returns
 *  the canonical target when the action may proceed, or
 *  the denial reason. Note: existence and symlink escapes
 *  are checked by the host after `fs::canonicalize` —
 *  this static gate covers shape, traversal, devices and
 *  root containment. */
export function validateArtifactTarget(
  target: string | undefined,
  allowedRoot: string | undefined,
): ArtifactOpenVerdict {
  if (typeof allowedRoot !== "string" || allowedRoot.trim().length === 0) {
    return { ok: false, reason: "missing_root" };
  }
  const t = canonicalAbsolutePath(target);
  const r = canonicalAbsolutePath(allowedRoot);
  if (t === undefined || r === undefined) {
    return { ok: false, reason: "malformed" };
  }
  // Device / UNC paths: verbatim devices, UNC shares and
  // Windows reserved names must never reach a launcher.
  if (
    t.startsWith("//") ||
    /^\\\\/.test(target ?? "") ||
    WINDOWS_RESERVED_RE.test(t.split("/").pop() ?? "") ||
    WINDOWS_RESERVED_RE.test(t.split("/")[1] ?? "")
  ) {
    return { ok: false, reason: "device_path" };
  }
  if (t.split("/").includes("..")) {
    return { ok: false, reason: "traversal" };
  }
  // Segment-boundary containment, case-insensitive on
  // Windows (same rule as relativeArtifactPath, §9.2).
  const ignoreCase = isWindowsStylePath(target ?? "") || isWindowsStylePath(allowedRoot);
  const sameSeg = (a: string, b: string): boolean =>
    ignoreCase ? a.toLowerCase() === b.toLowerCase() : a === b;
  const rootSegs = r.split("/");
  const targetSegs = t.split("/");
  if (targetSegs.length <= rootSegs.length) {
    return { ok: false, reason: "outside_root" };
  }
  for (let i = 0; i < rootSegs.length; i += 1) {
    if (!sameSeg(targetSegs[i] ?? "", rootSegs[i] ?? "")) {
      return { ok: false, reason: "outside_root" };
    }
  }
  return { ok: true, canonical: t };
}

/** User-facing denial text (§9.3: disabled actions must
 *  explain why). */
export function artifactDenialText(reason: ArtifactOpenDenialReason): string {
  switch (reason) {
    case "missing_root":
      return "缺少项目根目录，无法校验路径安全";
    case "malformed":
      return "路径格式非法，已拒绝打开";
    case "traversal":
      return "路径包含越级段（..），已拒绝打开";
    case "device_path":
      return "设备或网络路径不允许打开";
    case "outside_root":
      return "目标不在当前项目根目录内，已拒绝打开";
  }
}
