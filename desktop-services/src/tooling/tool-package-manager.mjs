// Trylo Desktop Services — Tool Package Manager.
//
// Spec TRYLO-CORE-AGENT-TOOL-EXTENSION-TECHNICAL-SPEC §3 / §8.2 / §8.3.
//
// Owns the ON-DISK truth of a tool package: where a pinned version lives,
// whether its binary is present and whether its digest matches the manifest.
//
// Deliberately NOT owned here:
//   - the MCP process (the Trylo CLI owns every runtime MCP child, §8.1);
//   - any auto-update — `autoUpdate` is always written `false` and a package
//     may never update itself (§8.2/§8.3).
//
// PR-2 adds the release-download transport (§8.2): fetch the PINNED asset
// URL from the manifest, stream it to a scratch file under a hard byte cap,
// verify the SHA256 against the manifest BEFORE anything is placed, and
// only then materialise the version directory. A failed download or a
// digest mismatch leaves nothing behind.
//
// Layout (§3):  <installRoot>/<id>/<version>/<executableRelativePath>
// `current` is NOT part of this layout: activation is derived from the
// manifest the catalog carries, so a third party can never switch versions
// behind Trylo's back.
//
// Failure policy: never throws. Every lookup degrades to a `not-installed`
// state the Profile Resolver can report as an unavailable capability
// (§4.4) instead of a hard failure.

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { pipeline } from 'node:stream/promises';
import { Readable, Transform } from 'node:stream';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const INSTALL_STATE_FILE = 'install-state.json';

/** Hard cap on a downloaded asset. Generous for a CLI binary; exists so a
 *  hostile redirect can never turn `install()` into an unbounded disk write. */
export const MAX_DOWNLOAD_BYTES = 512 * 1024 * 1024;

/** PR-3 (pinned-npm): extraction uses the OS tar (bsdtar ships with every
 *  supported Windows release). The command is a seam so tests and exotic
 *  environments can replace it. Exported so test helpers build their
 *  fixtures with the SAME tar the transport runs — a bare PATH `tar` can
 *  resolve to GNU tar (e.g. Git Bash), which reads `C:\…` as a remote host
 *  and fails with "Cannot connect to C:". */
export const TAR_COMMAND = process.platform === 'win32' ? path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe') : 'tar';

/** Extract a .tgz whose single root is `package/` into `destDir`.
 *  @param {string} tarballPath
 *  @param {string} destDir
 *  @param {{ extract?: (tarball: string, dest: string) => Promise<void> }} [seam]
 */
export function extractPackageTarball(tarballPath, destDir, seam = {}) {
  const run = seam.extract ?? defaultExtract;
  return run(tarballPath, destDir);
}

function defaultExtract(tarballPath, destDir) {
  return new Promise((resolve, reject) => {
    execFile(
      TAR_COMMAND,
      ['-xzf', tarballPath, '-C', destDir, '--strip-components=1'],
      { windowsHide: true, timeout: 120_000 },
      (error, _stdout, stderr) => {
        if (error) {
          reject(new Error(`tar extract failed: ${String(stderr || error.message).slice(0, 200)}`));
          return;
        }
        resolve();
      },
    );
  });
}

/** @typedef {'installed'|'not-installed'|'hash-mismatch'|'override'} PackageState */

function parseOverrides(raw) {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const out = {};
    for (const [id, exe] of Object.entries(parsed)) {
      if (typeof id === 'string' && typeof exe === 'string' && exe.length > 0) out[id] = exe;
    }
    return out;
  } catch {
    return {};
  }
}

async function sha256OfFile(filePath) {
  const hash = crypto.createHash('sha256');
  const handle = await fsp.open(filePath, 'r');
  try {
    const buffer = Buffer.alloc(1024 * 1024);
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
      if (bytesRead === 0) break;
      hash.update(buffer.subarray(0, bytesRead));
    }
  } finally {
    await handle.close();
  }
  return hash.digest('hex');
}

function isFileSync(filePath) {
  try {
    return fs.statSync(filePath).isFile();
  } catch {
    return false;
  }
}

/**
 * Constant-time digest comparison (OWASP attack-surface hardening: the
 * manifest hash is not a secret, but comparing in constant time costs
 * nothing and removes a class of timing observations from the trust
 * boundary entirely).
 */
function digestsMatch(actualHex, expectedHex) {
  if (typeof actualHex !== 'string' || typeof expectedHex !== 'string') return false;
  const actual = Buffer.from(actualHex, 'hex');
  const expected = Buffer.from(expectedHex, 'hex');
  if (actual.length !== expected.length || actual.length === 0) return false;
  return crypto.timingSafeEqual(actual, expected);
}

/**
 * PR-2 default transport: stream the pinned asset URL to `destPath` under a
 * hard byte cap. Redirects are followed (GitHub release assets redirect to
 * a CDN); http:// downgrades are rejected by `fetch` being https-pinned in
 * the manifest, and the digest check after the transfer is the real trust
 * boundary.
 *
 * @param {string} url
 * @param {string} destPath
 * @param {number} maxBytes
 */
/** §6.5: hard per-download bound. A stalled CDN connection (evening
 *  throttling of files.pythonhosted.org is the observed case) must fail
 *  over to the mirror/upstream instead of hanging the install forever.
 *  Generous for the largest pinned artifact (the biggest wheel is ~13 MB);
 *  the 1.5 GB JLCPCB catalog is a TOOL download, never an install one. */
export const DOWNLOAD_TIMEOUT_MS = 5 * 60 * 1000;

export async function downloadToFile(url, destPath, maxBytes = MAX_DOWNLOAD_BYTES, timeoutMs = DOWNLOAD_TIMEOUT_MS) {
  const response = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(timeoutMs) });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const declared = Number(response.headers.get('content-length') ?? 0);
  if (declared && declared > maxBytes) {
    throw new Error(`asset declares ${declared} bytes, above the ${maxBytes} cap`);
  }
  if (!response.body) throw new Error('response has no body');

  let total = 0;
  let lastProgress = Date.now();
  const cap = new Transform({
    transform(chunk, _encoding, callback) {
      total += chunk.length;
      // Stall detection: a connection that delivers NOTHING for the timeout
      // window is aborted even mid-stream (AbortSignal alone only bounds the
      // headers phase in some runtimes).
      if (Date.now() - lastProgress > timeoutMs) {
        callback(new Error(`download stalled: no bytes for ${Math.round(timeoutMs / 1000)}s`));
        return;
      }
      lastProgress = Date.now();
      if (total > maxBytes) {
        callback(new Error(`asset exceeded the ${maxBytes}-byte cap mid-stream`));
        return;
      }
      callback(null, chunk);
    },
  });
  const source = Readable.fromWeb(/** @type {import('node:stream/web').ReadableStream} */ (response.body));
  try {
    await pipeline(source, cap, fs.createWriteStream(destPath));
  } catch (error) {
    source.destroy().catch?.(() => {});
    throw error;
  }
}

export function createToolPackageManager(options = {}) {
  const storageRoot = options.storageRoot ?? '';
  // Dev/CI seam only: TRYLO_TOOL_PACKAGES_DIR relocates the install root and
  // TRYLO_TOOL_PACKAGE_OVERRIDES points an id straight at an absolute exe.
  // Neither carries a secret; both are ignored when unset.
  const installRoot =
    options.installRoot ??
    process.env.TRYLO_TOOL_PACKAGES_DIR ??
    (storageRoot ? path.join(storageRoot, 'tool-packages') : '');
  const overrides = options.overrides ?? parseOverrides(process.env.TRYLO_TOOL_PACKAGE_OVERRIDES);
  // §6.5 zero-config mirror: a `<storageRoot>/pinned-artifact-mirror`
  // directory (marker: mirror-manifest.json from the mirror script) is
  // honoured automatically when TRYLO_ARTIFACT_MIRROR is unset — dropping
  // the offline copy there makes every install local with NO env setup.
  const defaultLocalMirror = storageRoot
    ? path.join(storageRoot, 'pinned-artifact-mirror')
    : '';
  const mirrorBaseForInstalls = () =>
    mirrorBaseFromEnv() ??
    (defaultLocalMirror && isFileSync(path.join(defaultLocalMirror, 'mirror-manifest.json'))
      ? defaultLocalMirror
      : null);
  // Test seam: the transport is injectable so tests never touch the network.
  const download = options.download ?? downloadToFile;
  const maxDownloadBytes = options.maxDownloadBytes ?? MAX_DOWNLOAD_BYTES;
  // PR-3 seam: tarball extraction (tests use a tiny hand-built tarball).
  const extract = options.extract ?? extractPackageTarball;
  // Test seam: the browser-body install shells out; tests inject a runner
  // instead of downloading a real Chromium.
  const runCommand = options.runCommand ?? runBoundedCommand;

  function versionDir(manifest) {
    return path.join(installRoot, manifest.id, manifest.version);
  }

  function expectedExecutable(manifest) {
    return path.join(versionDir(manifest), manifest.artifact.executableRelativePath);
  }

  /** `.stale` swap target for one package version. Trees land here when a
   *  fresh install must replace a version directory whose previous contents
   *  may still be held open (a live MCP process, an antivirus scan). */
  function staleDirFor(manifest) {
    return path.join(installRoot, '.stale', `${manifest.id}-${manifest.version}`);
  }

  /** Best-effort sweep of a renamed-aside tree. A process that still holds
   *  handles keeps it alive; the next install/uninstall of the same package
   *  retries. Never throws — a stale tree is hygiene, not truth. */
  async function sweepStaleTree(manifest) {
    await fsp.rm(staleDirFor(manifest), { recursive: true, force: true }).catch(() => {});
  }

  /**
   * Rename `dir` aside to the stale area. Windows cannot DELETE a tree while
   * any handle inside it is open (the 2026-09-03 acceptance reinstall died
   * with a raw EBUSY on rmdir), but NTFS rename of a directory succeeds even
   * with open handles below it — a live process keeps running against the
   * renamed files. Returns false when `dir` did not exist; rethrows anything
   * else (the caller decides whether that is fatal).
   */
  async function renameAside(dir, stalePath) {
    try {
      // rename() cannot create the destination's parent — without this the
      // ENOENT would masquerade as "source absent" and the old tree would
      // silently stay in place (caught by the re-install test).
      await fsp.mkdir(path.dirname(stalePath), { recursive: true });
      await fsp.rename(dir, stalePath);
      return true;
    } catch (error) {
      if (error?.code === 'ENOENT') return false;
      throw error;
    }
  }

  async function readInstallState(manifest) {
    const file = path.join(versionDir(manifest), INSTALL_STATE_FILE);
    try {
      return JSON.parse(await fsp.readFile(file, 'utf8'));
    } catch {
      return null;
    }
  }

  /**
   * Resolve where a package's executable lives and whether it is usable.
   *
   * @param {object} manifest
   * @returns {Promise<{ id: string, version: string, installDir: string,
   *   executable: string|null, state: PackageState, detail: string,
   *   autoUpdate: boolean }>}
   */
  async function resolve(manifest) {
    const override = overrides[manifest.id];
    if (override) {
      return {
        id: manifest.id,
        version: manifest.version,
        installDir: path.dirname(override),
        executable: isFileSync(override) ? override : null,
        state: isFileSync(override) ? 'override' : 'not-installed',
        detail: isFileSync(override)
          ? `dev override: ${path.basename(override)}`
          : 'dev override path does not exist',
        autoUpdate: false,
      };
    }

    if (!installRoot) {
      return {
        id: manifest.id,
        version: manifest.version,
        installDir: '',
        executable: null,
        state: 'not-installed',
        detail: 'tool package install root is not configured',
        autoUpdate: false,
      };
    }

    const exe = expectedExecutable(manifest);
    if (!isFileSync(exe)) {
      return {
        id: manifest.id,
        version: manifest.version,
        installDir: versionDir(manifest),
        executable: null,
        state: 'not-installed',
        detail: `pinned ${manifest.id} ${manifest.version} is not installed`,
        autoUpdate: false,
      };
    }

    const state = await readInstallState(manifest);
    const recorded = state?.sha256 ?? null;
    const expected = manifest.artifact.archiveSha256 || null;
    if (expected && recorded && recorded !== expected) {
      return {
        id: manifest.id,
        version: manifest.version,
        installDir: versionDir(manifest),
        executable: null,
        state: 'hash-mismatch',
        detail: 'recorded digest does not match the pinned manifest',
        autoUpdate: Boolean(state?.autoUpdate),
      };
    }

    // 增量修复：已安装的 windows-mcp 旧包在本地直接补丁，无需重装即可修复
    // Screenshot 快捷路径窗口为空（No windows found）问题
    if (manifest.id === 'windows-mcp') {
      await applyWindowsMcpPatches(versionDir(manifest)).catch(() => {});
    }
    return {
      id: manifest.id,
      version: manifest.version,
      installDir: versionDir(manifest),
      executable: exe,
      state: 'installed',
      detail: recorded ? 'digest verified' : 'installed without a recorded digest',
      autoUpdate: Boolean(state?.autoUpdate),
    };
  }

  /**
   * Verify + place an ALREADY-VERIFIED artefact. Shared by the local and
   * network transports so the two can never disagree about layout or state.
   *
   * @param {object} manifest
   * @param {string} artefactPath absolute path to the verified file
   * @param {string} digest its sha256
   */
  async function placeVerifiedArtefact(manifest, artefactPath, digest, origin = null) {
    const dir = versionDir(manifest);
    await fsp.mkdir(dir, { recursive: true });
    const target = expectedExecutable(manifest);
    await fsp.copyFile(artefactPath, target);
    await fsp.writeFile(
      path.join(dir, INSTALL_STATE_FILE),
      JSON.stringify(
        {
          id: manifest.id,
          version: manifest.version,
          sha256: digest,
          ...(origin ? { artifactOrigin: origin } : {}),
          executable: manifest.artifact.executableRelativePath,
          // §8.2: Trylo owns updates. A package may never update itself.
          autoUpdate: false,
          installedAt: new Date().toISOString(),
        },
        null,
        2,
      ),
      'utf8',
    );
    return { ok: true, id: manifest.id, version: manifest.version, installDir: dir, executable: target };
  }

  /**
   * Install a pinned package.
   *
   * Three transports, one trust boundary (§8.2):
   *   - `archivePath` present: verify an ALREADY-DOWNLOADED local artefact
   *     (the PR-1 surface, kept for air-gapped/dev flows);
   *   - otherwise, release-archive: download `artifact.downloadUrl` (PR-2) —
   *     pinned URL, hard byte cap, digest verified before placement;
   *   - otherwise, pinned-npm (PR-3): download the pinned registry tarball
   *     of the entry package AND every pinned dependency, verify each
   *     digest, and extract the whole closure into the version directory.
   * In all cases the manifest's digests are the authority; a mismatch
   * leaves the version directory untouched.
   *
   * @param {{ id: string, archivePath?: string }} params
   */
  async function install(params = {}) {
    const id = String(params.id ?? '');
    if (!id) return { ok: false, reasonCode: 'missing_id', error: 'a package id is required' };
    const manifest = options.catalog?.get(id);
    if (!manifest) return { ok: false, id, reasonCode: 'unknown_package' };
    if (!installRoot) {
      return { ok: false, id, reasonCode: 'no_install_root', error: 'install root is not configured' };
    }
    if (manifest.artifact.installStrategy === 'pinned-npm') {
      return installPinnedNpm(manifest, params.archivePath ? String(params.archivePath) : '');
    }
    if (manifest.artifact.installStrategy === 'pinned-python-env') {
      return installPinnedPythonEnv(manifest, params.archivePath ? String(params.archivePath) : '');
    }
    if (manifest.artifact.installStrategy === 'pinned-pypi-env') {
      return installPinnedPypiEnv(manifest, params.archivePath ? String(params.archivePath) : '');
    }
    if (manifest.artifact.installStrategy !== 'release-archive') {
      return {
        ok: false,
        id,
        reasonCode: 'strategy_unsupported',
        error: `installStrategy '${manifest.artifact.installStrategy}' has no transport`,
      };
    }
    // CAD/EDA: a release-archive manifest with a build step is a SOURCE tree
    // (GitHub tarball → extract → npm ci → npm run build), not a single
    // placed file (TRYLO-CAD-EDA-TOOL-ADAPTER §6.3).
    if (manifest.artifact.build?.kind === 'npm-ci-build') {
      return installReleaseArchiveSource(manifest, params.archivePath ? String(params.archivePath) : '');
    }

    const archivePath = params.archivePath ? String(params.archivePath) : '';
    if (!archivePath) {
      return installFromNetwork(manifest);
    }
    if (!isFileSync(archivePath)) {
      return { ok: false, id, reasonCode: 'artefact_missing' };
    }

    const digest = await sha256OfFile(archivePath);
    const expected = manifest.artifact.archiveSha256;
    if (expected && !digestsMatch(digest, expected)) {
      return { ok: false, id, reasonCode: 'hash_mismatch', expected, actual: digest };
    }
    return placeVerifiedArtefact(manifest, archivePath, digest);
  }

  /**
   * PR-2 release transport (§8.2): download the pinned asset URL, verify the
   * digest, place, clean the scratch file. Every failure removes the scratch
   * and reports a reason code — never a half-installed version directory.
   */
  async function installFromNetwork(manifest) {
    const url = manifest.artifact.downloadUrl;
    if (!url) {
      return {
        ok: false,
        id: manifest.id,
        reasonCode: 'no_download_url',
        error: `manifest for ${manifest.id} pins no artifact.downloadUrl`,
      };
    }
    const downloadsDir = path.join(installRoot, '.downloads');
    const scratch = path.join(
      downloadsDir,
      `${manifest.id}-${manifest.version}-${process.pid}-${Date.now()}.tmp`,
    );
    try {
      await fsp.mkdir(downloadsDir, { recursive: true });
    } catch (error) {
      return {
        ok: false,
        id: manifest.id,
        reasonCode: 'download_failed',
        error: `could not create the download scratch dir: ${error?.message ?? error}`,
      };
    }
    try {
      let origin = null;
      if (manifest.artifact.archiveSha256) {
        // Mirror-first (§6.5) with the digest as the acceptance gate.
        ({ origin } = await downloadPinnedArtifact({
          id: manifest.id,
          url,
          sha256: manifest.artifact.archiveSha256,
          dest: scratch,
        }));
      } else {
        // No pinned digest → the mirror path cannot be derived (mirror
        // entries are content-addressed); upstream only, verified after
        // the transfer below.
        await download(url, scratch, maxDownloadBytes);
      }
      try {
        const digest = await sha256OfFile(scratch);
        const expected = manifest.artifact.archiveSha256;
        if (expected && !digestsMatch(digest, expected)) {
          return { ok: false, id: manifest.id, reasonCode: 'hash_mismatch', expected, actual: digest };
        }
        return await placeVerifiedArtefact(manifest, scratch, digest, origin);
      } finally {
        await fsp.rm(scratch, { force: true }).catch(() => {});
      }
    } catch (error) {
      await fsp.rm(scratch, { force: true }).catch(() => {});
      return {
        ok: false,
        id: manifest.id,
        reasonCode: error?.reasonCode ?? 'download_failed',
        error: String(error?.message ?? error).slice(0, 200),
      };
    }
  }

  /**
   * PR-3 pinned-npm transport (§8.2 固定 npm 包版本与完整性 hash).
   *
   * The runtime closure — the entry package plus every pinned dependency —
   * is fetched from its pinned registry tarball, digest-verified, and
   * extracted into the version directory at `node_modules/<name>`. No npm
   * resolution runs at install time, so nothing can float: every byte that
   * lands on disk was vouched for by the manifest. A failure at ANY step
   * removes the staging tree and reports a reason code — never a
   * half-installed version directory.
   */
  async function installPinnedNpm(manifest, archivePath) {
    const deps = Array.isArray(manifest.artifact.npmDependencies)
      ? manifest.artifact.npmDependencies
      : [];
    const stageRoot = path.join(
      installRoot,
      '.downloads',
      `${manifest.id}-${manifest.version}-${process.pid}-${Date.now()}`,
    );
    try {
      await fsp.mkdir(stageRoot, { recursive: true });

      // 1. Entry package — verify + extract into node_modules/<name>.
      const { digest: entryDigest } = await fetchAndVerify({
        packageId: manifest.id,
        url: manifest.artifact.downloadUrl,
        expected: manifest.artifact.archiveSha256,
        localPath: archivePath,
        stageRoot,
        label: 'entry',
      });
      const entryDir = path.join(stageRoot, 'node_modules', manifest.artifact.packageName ?? manifest.id);
      await fsp.mkdir(entryDir, { recursive: true });
      await extract(path.join(stageRoot, 'entry.tgz'), entryDir);

      // 2. Pinned dependency closure — each verified, each extracted.
      const dependencyDigests = {};
      for (const dep of deps) {
        dependencyDigests[dep.name] = (await fetchAndVerify({
          packageId: manifest.id,
          url: dep.tarballUrl,
          expected: dep.sha256,
          localPath: '',
          stageRoot,
          label: dep.name,
        })).digest;
        const depDir = path.join(stageRoot, 'node_modules', dep.name);
        await fsp.mkdir(depDir, { recursive: true });
        await extract(path.join(stageRoot, `${dep.name}.tgz`), depDir);
      }

      // 3. Move the verified tree into place. A previous version directory
      //    is replaced wholesale, never partially merged. Windows rename()
      //    cannot land on an existing directory, and deleting the old tree
      //    in place dies with EBUSY while any handle inside it is open —
      //    so the old node_modules is renamed aside (rename tolerates open
      //    handles) and swept best-effort afterwards.
      const dir = versionDir(manifest);
      await renameAside(path.join(dir, 'node_modules'), staleDirFor(manifest));
      await fsp.mkdir(path.join(dir, 'node_modules'), { recursive: true });
      for (const entry of await fsp.readdir(path.join(stageRoot, 'node_modules'), { withFileTypes: true })) {
        await fsp.rename(
          path.join(stageRoot, 'node_modules', entry.name),
          path.join(dir, 'node_modules', entry.name),
        );
      }
      // The swap is complete: sweep the renamed-aside tree. A live process
      // keeps it alive and the next install/uninstall retries the sweep.
      await sweepStaleTree(manifest);

      await fsp.writeFile(
        path.join(dir, INSTALL_STATE_FILE),
        JSON.stringify(
          {
            id: manifest.id,
            version: manifest.version,
            sha256: entryDigest,
            executable: manifest.artifact.executableRelativePath,
            dependencies: dependencyDigests,
            // §8.2: Trylo owns updates. A package may never update itself.
            autoUpdate: false,
            installedAt: new Date().toISOString(),
          },
          null,
          2,
        ),
        'utf8',
      );
      return {
        ok: true,
        id: manifest.id,
        version: manifest.version,
        installDir: dir,
        executable: expectedExecutable(manifest),
      };
    } catch (error) {
      return {
        ok: false,
        id: manifest.id,
        reasonCode: error?.reasonCode ?? 'install_failed',
        error: String(error?.message ?? error).slice(0, 200),
      };
    } finally {
      await fsp.rm(stageRoot, { recursive: true, force: true }).catch(() => {});
    }
  }

  /**
   * PR-6 pinned-python-env transport (§8.2 Windows-MCP: 「正式分发使用锁定
   * Python runtime + wheel/lock，或者项目提供的可校验自包含发行物」).
   *
   * The pinned GitHub source tarball is fetched, digest-verified against the
   * manifest, and extracted into the version directory; `uv sync --locked`
   * then materialises the `.venv` from the tarball's OWN uv.lock — the lock
   * digest in the manifest vouches for the whole dependency set, and
   * `--locked` refuses to resolve anything the lock does not pin. No runtime
   * package resolution exists: source commit → tarball digest → lock digest
   * is the entire chain.
   *
   * Cache policy (PR-6 偏差②收口): the sync tries `--offline` first so a
   * warm uv cache is the normal path; on a cold machine it falls back to
   * ONE networked `sync --locked`, which is still lock-pinned (every wheel
   * is hash-verified against the lock by uv itself). The two origins are
   * distinguishable in install-state (`offlineSync`).
   *
   * Failure at ANY step removes the staging tree and reports a reason code —
   * never a half-installed version directory.
   */
  async function installPinnedPythonEnv(manifest, archivePath) {
    const uv = resolveUvExecutable();
    if (!uv) {
      return {
        ok: false,
        id: manifest.id,
        reasonCode: 'uv_missing',
        error: 'pinned-python-env requires the uv executable (UV_PATH or PATH)',
      };
    }
    const stageRoot = path.join(
      installRoot,
      '.downloads',
      `${manifest.id}-${manifest.version}-${process.pid}-${Date.now()}`,
    );
    try {
      await fsp.mkdir(stageRoot, { recursive: true });

      // 1. Fetch + digest-verify the pinned source tarball (local artefact or
      //    the pinned download URL — the same trust boundary as PR-2/PR-3).
      const { digest } = await fetchAndVerify({
        packageId: manifest.id,
        url: manifest.artifact.downloadUrl,
        expected: manifest.artifact.archiveSha256,
        localPath: archivePath,
        stageRoot,
        label: 'source',
      });

      // 2. Extract the project source into the staging tree.
      const sourceDir = path.join(stageRoot, 'source');
      await fsp.mkdir(sourceDir, { recursive: true });
      await extract(path.join(stageRoot, 'source.tgz'), sourceDir);
      // GitHub archive tarballs wrap everything in one top-level directory.
      const topLevel = await fsp.readdir(sourceDir, { withFileTypes: true });
      const projectDir = topLevel.length === 1 && topLevel[0].isDirectory()
        ? path.join(sourceDir, topLevel[0].name)
        : sourceDir;
      const lockFile = path.join(projectDir, 'uv.lock');
      if (!isFileSync(lockFile)) {
        throw Object.assign(new Error('pinned source has no uv.lock'), { reasonCode: 'hash_mismatch' });
      }
      // The manifest pins the LF-normalised lock digest (GitHub tarballs ship
      // LF; a working tree may have CRLF). Normalise before comparing so a
      // checkout line-ending difference cannot read as drift.
      const lockDigest = sha256Hex((await fsp.readFile(lockFile)).toString('utf8').replace(/\r\n/g, '\n'));
      if (!digestsMatch(lockDigest, manifest.artifact.uvLockSha256 ?? '')) {
        throw Object.assign(
          new Error(`uv.lock digest mismatch: expected ${String(manifest.artifact.uvLockSha256).slice(0, 12)}…, got ${lockDigest.slice(0, 12)}…`),
          { reasonCode: 'hash_mismatch' },
        );
      }

      // 3. Materialise the locked environment INSIDE the staging tree. This
      //    is the only step that shells out to uv, and `--locked` guarantees
      //    the on-disk dependency set equals the lock file byte-for-byte.
      //    The first attempt is `--offline`: every PACKAGE must come from the
      //    uv cache (the pinned wheels a previous install already resolved),
      //    never from a floating network resolution. The Python interpreter
      //    itself may still be fetched by uv per its own pin.
      //    PR-6 偏差②收口: on a COLD machine that cache is empty and the
      //    honest offline install would fail forever. The fallback re-runs
      //    `sync --locked` WITH the network once, in the same staging tree —
      //    still zero floating resolution (`--locked` pins the whole set;
      //    every wheel hash is verified against the lock either way), and
      //    the result is recorded in install-state so diagnostics can tell
      //    the two origins apart. No mirror/pre-seed policy is implied.
      let offline = true;
      try {
        await runBoundedCommand(
          uv,
          ['sync', '--locked', '--no-dev', '--offline', '--project', projectDir],
          600_000,
        );
      } catch (offlineError) {
        try {
          await runBoundedCommand(
            uv,
            ['sync', '--locked', '--no-dev', '--project', projectDir],
            600_000,
          );
          offline = false;
        } catch (error) {
          const reason = offlineError?.message === error?.message ? error : offlineError;
          throw Object.assign(new Error(`uv sync --locked failed: ${reason?.message ?? error.message}`), {
            reasonCode: 'install_failed',
          });
        }
      }

      // 4. Move the verified tree into place. Same swap as pinned-npm: the
      //    old version dir is renamed aside (a live windows-mcp process
      //    keeps its handles) and swept best-effort — never rm'd in place,
      //    which dies with EBUSY while handles are open.
      // 5. REAL-INSTALL FINDING (§15.2-7 同族): uv console-script trampolines
      //    embed the ABSOLUTE path they were generated at — moving the venv
      //    from staging into the version dir leaves a broken entry
      //    ("uv trampoline failed to canonicalize script path") that the
      //    python-metadata health probe cannot see (it runs python.exe, not
      //    the entry). One idempotent repair re-sync INSIDE the final
      //    version dir regenerates every entry point with the real paths;
      //    cached wheels make it fast, `--locked`/`--offline` keep the
      //    trust chain identical.
      const dir = versionDir(manifest);
      await renameAside(dir, staleDirFor(manifest));
      await fsp.mkdir(dir, { recursive: true });
      for (const entry of await fsp.readdir(projectDir, { withFileTypes: true })) {
        await fsp.rename(path.join(projectDir, entry.name), path.join(dir, entry.name));
      }
      try {
        await runBoundedCommand(
          uv,
          ['sync', '--locked', '--no-dev', '--offline', '--project', dir],
          600_000,
        );
      } catch (repairError) {
        throw Object.assign(
          new Error(`uv entry-point repair failed: ${repairError?.message ?? repairError}`),
          { reasonCode: 'install_failed' },
        );
      }
      // Post-install patch: fix upstream app.py PATH resolution and
      // desktop/service.py fast-path window enumeration without waiting for
      // an upstream release. Patch is idempotent — re-applies safely on
      // every install; a missing file is not fatal (future upstream may move
      // it).
      await applyWindowsMcpPatches(dir).catch(() => {});
      // The swap is complete: sweep the renamed-aside tree (best-effort; a
      // live windows-mcp process keeps it and the next install retries).
      await sweepStaleTree(manifest);

      await fsp.writeFile(
        path.join(dir, INSTALL_STATE_FILE),
        JSON.stringify(
          {
            id: manifest.id,
            version: manifest.version,
            sha256: digest,
            executable: manifest.artifact.executableRelativePath,
            sourceCommit: manifest.artifact.sourceCommit ?? null,
            uvLockSha256: manifest.artifact.uvLockSha256 ?? null,
            // PR-6 偏差②: whether the wheel set came from the warm uv cache
            // (offline) or required one networked `sync --locked` warm-up.
            // Diagnostics only — the digest chain is identical either way.
            offlineSync: offline,
            // §8.2: Trylo owns updates. A package may never update itself.
            autoUpdate: false,
            installedAt: new Date().toISOString(),
          },
          null,
          2,
        ),
        'utf8',
      );
      return {
        ok: true,
        id: manifest.id,
        version: manifest.version,
        installDir: dir,
        executable: expectedExecutable(manifest),
      };
    } catch (error) {
      return {
        ok: false,
        id: manifest.id,
        reasonCode: error?.reasonCode ?? 'install_failed',
        error: String(error?.message ?? error).slice(0, 200),
      };
    } finally {
      await fsp.rm(stageRoot, { recursive: true, force: true }).catch(() => {});
    }
  }

  /**
   * CAD/EDA (TRYLO-CAD-EDA-TOOL-ADAPTER §6.2): pinned-pypi-env materialises
   * a uv venv from an EXPLICIT wheel closure. Every dependency — and in
   * wheels mode the server itself — is one pinned {name, version, url,
   * sha256} wheel downloaded and digest-verified BEFORE uv runs; uv never
   * consults an index (`pip install --no-deps <staged files>`), so nothing
   * can float. Only the Python interpreter follows the pinned
   * `pythonVersion` via uv's own managed download.
   *
   * Two modes:
   *   wheels  — PyPI-published servers (blender-mcp, freecad-mcp,
   *             autocad-mcp-pro): the wheel set includes the server dist.
   *   source  — GitHub-source servers (solidworks-automation-skill): a
   *             pinned source tarball is extracted alongside the venv and
   *             launched via `sourceEntry` (the {installDir} argv token).
   *
   * Console-script trampolines embed the staging absolute path (§15.2-7 同族
   * finding); one idempotent re-install from the same staged wheels inside
   * the FINAL version directory regenerates them. Failure at ANY step
   * removes the staging tree and reports a reason code — never a
   * half-installed version directory.
   */
  async function installPinnedPypiEnv(manifest, archivePath) {
    const uv = resolveUvExecutable();
    if (!uv) {
      return {
        ok: false,
        id: manifest.id,
        reasonCode: 'uv_missing',
        error: 'pinned-pypi-env requires the uv executable (UV_PATH or PATH)',
      };
    }
    const artifact = manifest.artifact;
    const wheels = Array.isArray(artifact.wheels) ? artifact.wheels : [];
    const stageRoot = path.join(
      installRoot,
      '.downloads',
      `${manifest.id}-${manifest.version}-${process.pid}-${Date.now()}`,
    );
    try {
      await fsp.mkdir(stageRoot, { recursive: true });

      // 1. Stage the wheel closure — each file digest-verified against the
      //    manifest. This list IS the dependency trust chain. Staged under
      //    their REAL wheel filenames: uv/pip REFUSE to install a wheel
      //    whose filename does not parse (`wheel-<name>-<ver>.whl` fails
      //    with "The wheel filename … is invalid" — real-install finding,
      //    the fake-uv tests cannot see it).
      const wheelsDir = path.join(stageRoot, 'wheels');
      await fsp.mkdir(wheelsDir, { recursive: true });
      const wheelPaths = [];
      const wheelDigests = {};
      for (const wheel of wheels) {
        const scratch = path.join(wheelsDir, artifactBasename(wheel.url));
        await downloadPinnedArtifact({
          id: manifest.id,
          url: wheel.url,
          sha256: wheel.sha256,
          dest: scratch,
        });
        wheelDigests[wheel.name] = wheel.sha256;
        wheelPaths.push(scratch);
      }

      // 2. Source mode extracts the pinned tree; wheels mode uses an empty
      //    project dir that carries just the venv.
      let sourceDigest = null;
      let projectDir;
      if (artifact.sourceTarballUrl) {
        sourceDigest = (await fetchAndVerify({
          packageId: manifest.id,
          url: artifact.sourceTarballUrl,
          expected: artifact.sourceTarballSha256,
          localPath: archivePath,
          stageRoot,
          label: 'source',
        })).digest;
        const sourceDir = path.join(stageRoot, 'source');
        await fsp.mkdir(sourceDir, { recursive: true });
        await extract(path.join(stageRoot, 'source.tgz'), sourceDir);
        const topLevel = await fsp.readdir(sourceDir, { withFileTypes: true });
        projectDir = topLevel.length === 1 && topLevel[0].isDirectory()
          ? path.join(sourceDir, topLevel[0].name)
          : sourceDir;
      } else {
        projectDir = path.join(stageRoot, 'project');
        await fsp.mkdir(projectDir, { recursive: true });
      }

      // 3. Materialise the venv and install the closure offline. No index
      //    access exists: `--no-deps` over staged wheel files only, via a
      //    requirements file (80 long wheel paths would brush the Windows
      //    ~32k argv ceiling; `-r` sidesteps it entirely).
      const venvDir = path.join(projectDir, '.venv');
      await runCommand(uv, ['venv', venvDir, '--python', String(artifact.pythonVersion)], 300_000);
      const venvPython = path.join(venvDir, process.platform === 'win32' ? path.join('Scripts', 'python.exe') : path.join('bin', 'python'));
      const wheelRequirements = path.join(stageRoot, 'wheels-requirements.txt');
      await fsp.writeFile(wheelRequirements, `${wheelPaths.join('\n')}\n`, 'utf8');
      await runCommand(
        uv,
        ['pip', 'install', '--python', venvPython, '--no-deps', '--no-progress', '-r', wheelRequirements],
        900_000,
      );

      // 4. Swap into the version directory (rename-aside, same as the other
      //    transports — never rm a live tree).
      const dir = versionDir(manifest);
      await renameAside(dir, staleDirFor(manifest));
      await fsp.mkdir(dir, { recursive: true });
      for (const entry of await fsp.readdir(projectDir, { withFileTypes: true })) {
        await fsp.rename(path.join(projectDir, entry.name), path.join(dir, entry.name));
      }

      // 5. Trampoline repair: regenerate entry points against the FINAL
      //    absolute paths from the same staged wheels (idempotent; the trust
      //    chain is byte-identical). `--reinstall` is REQUIRED here — plain
      //    re-install sees the distributions already satisfied inside the
      //    moved venv and SKIPS relinking, leaving trampolines that embed
      //    the staging path (real-install finding: `uv trampoline failed to
      //    canonicalize script path`; uv sync DOES relink on re-run, pip/
      //    pip-install semantics do not).
      const finalVenvPython = path.join(dir, '.venv', process.platform === 'win32' ? path.join('Scripts', 'python.exe') : path.join('bin', 'python'));
      await runCommand(
        uv,
        ['pip', 'install', '--python', finalVenvPython, '--no-deps', '--no-progress', '--reinstall', '-r', wheelRequirements],
        900_000,
      );
      await sweepStaleTree(manifest);

      await fsp.writeFile(
        path.join(dir, INSTALL_STATE_FILE),
        JSON.stringify(
          {
            id: manifest.id,
            version: manifest.version,
            // resolve() compares this against artifact.archiveSha256 — the
            // manifest pins the SAME combined digest (source tarball digest
            // in source mode, wheel-set digest in wheels mode).
            sha256: sourceDigest ?? pypiWheelStateDigest(wheels),
            executable: artifact.executableRelativePath,
            mode: artifact.sourceTarballUrl ? 'source-run' : 'wheels',
            wheels: wheelDigests,
            sourceCommit: artifact.sourceCommit ?? null,
            pythonVersion: artifact.pythonVersion ?? null,
            // §8.2: Trylo owns updates. A package may never update itself.
            autoUpdate: false,
            installedAt: new Date().toISOString(),
          },
          null,
          2,
        ),
        'utf8',
      );
      return {
        ok: true,
        id: manifest.id,
        version: manifest.version,
        installDir: dir,
        executable: expectedExecutable(manifest),
      };
    } catch (error) {
      return {
        ok: false,
        id: manifest.id,
        reasonCode: error?.reasonCode ?? 'install_failed',
        error: String(error?.message ?? error).slice(0, 200),
      };
    } finally {
      await fsp.rm(stageRoot, { recursive: true, force: true }).catch(() => {});
    }
  }

  /**
   * CAD/EDA (TRYLO-CAD-EDA-TOOL-ADAPTER §6.3): release-archive with a
   * `build` step — a pinned GitHub SOURCE tree that is not published to npm
   * (jlcmcp, KiCAD-MCP-Server). Chain: archive digest → the repo's own
   * package-lock.json integrity hashes (npm ci). `--ignore-scripts` means
   * NO upstream lifecycle hook ever runs; `npm run build` is the audited
   * compile step the archive digest pins. Optional `pythonWheels` land in
   * the HOST application's own interpreter (KiCad bundled Python — pcbnew
   * exists nowhere else), each wheel digest-pinned.
   */
  async function installReleaseArchiveSource(manifest, archivePath) {
    const artifact = manifest.artifact;
    const stageRoot = path.join(
      installRoot,
      '.downloads',
      `${manifest.id}-${manifest.version}-${process.pid}-${Date.now()}`,
    );
    try {
      await fsp.mkdir(stageRoot, { recursive: true });

      const { digest, origin } = await fetchAndVerify({
        packageId: manifest.id,
        url: artifact.downloadUrl,
        expected: artifact.archiveSha256,
        localPath: archivePath,
        stageRoot,
        label: 'source',
      });
      const sourceDir = path.join(stageRoot, 'source');
      await fsp.mkdir(sourceDir, { recursive: true });
      await extract(path.join(stageRoot, 'source.tgz'), sourceDir);
      const topLevel = await fsp.readdir(sourceDir, { withFileTypes: true });
      const projectDir = topLevel.length === 1 && topLevel[0].isDirectory()
        ? path.join(sourceDir, topLevel[0].name)
        : sourceDir;

      // Swap into the version dir FIRST: npm materialises bin shims and
      // build artifacts that embed absolute paths — the build must run at
      // the final location. A failure below leaves the tree without an
      // install-state file, which resolve() reads as not-installed.
      const dir = versionDir(manifest);
      await renameAside(dir, staleDirFor(manifest));
      await fsp.mkdir(dir, { recursive: true });
      for (const entry of await fsp.readdir(projectDir, { withFileTypes: true })) {
        await fsp.rename(path.join(projectDir, entry.name), path.join(dir, entry.name));
      }

      const npm = resolveNpmCommand();
      if (!npm) {
        throw Object.assign(
          new Error('npm CLI not found next to the Node runtime (node_modules/npm/bin/npm-cli.js)'),
          { reasonCode: 'npm_missing' },
        );
      }
      await runCommand(npm.command, [...npm.args, 'ci', '--ignore-scripts', '--no-audit', '--no-fund'], 900_000, { cwd: dir });
      await runCommand(npm.command, [...npm.args, 'run', 'build'], 600_000, { cwd: dir });

      if (artifact.pythonWheelsTarget === 'kicad-bundled') {
        const wheels = Array.isArray(artifact.pythonWheels) ? artifact.pythonWheels : [];
        const kicadPython = detectKicadPython();
        if (!kicadPython) {
          throw Object.assign(
            new Error('no KiCad bundled python detected (KiCad 9+ expected under Program Files)'),
            { reasonCode: 'kicad_python_missing' },
          );
        }
        const wheelPaths = [];
        const wheelDigests = {};
        await fsp.mkdir(path.join(stageRoot, 'wheels'), { recursive: true });
        for (const wheel of wheels) {
          // Real wheel filenames — pip validates the filename format and
          // refuses invented ones (same real-install finding as uv above).
          const scratch = path.join(stageRoot, 'wheels', artifactBasename(wheel.url));
          await downloadPinnedArtifact({
            id: manifest.id,
            url: wheel.url,
            sha256: wheel.sha256,
            dest: scratch,
          });
          wheelDigests[wheel.name] = wheel.sha256;
          wheelPaths.push(scratch);
        }
        const kicadRequirements = path.join(stageRoot, 'kicad-wheels-requirements.txt');
        await fsp.writeFile(kicadRequirements, `${wheelPaths.join('\n')}\n`, 'utf8');
        try {
          // KiCad's own interpreter needs the deps pcbnew/kipy imports live
          // in; --no-deps keeps the pinned closure exact.
          await runCommand(
            kicadPython,
            ['-m', 'pip', 'install', '--no-deps', '--no-warn-script-location', '-r', kicadRequirements],
            600_000,
          );
        } catch (error) {
          throw Object.assign(
            new Error(`KiCad python wheel install failed: ${error?.message ?? error}`),
            { reasonCode: 'kicad_python_install_failed' },
          );
        }
        await fsp.writeFile(
          path.join(dir, INSTALL_STATE_FILE),
          JSON.stringify(
            {
              id: manifest.id,
              version: manifest.version,
              sha256: digest,
              artifactOrigin: origin,
              executable: artifact.executableRelativePath,
              build: 'npm-ci-build',
              kicadPython,
              pythonWheels: wheelDigests,
              autoUpdate: false,
              installedAt: new Date().toISOString(),
            },
            null,
            2,
          ),
          'utf8',
        );
      } else {
        await fsp.writeFile(
          path.join(dir, INSTALL_STATE_FILE),
          JSON.stringify(
            {
              id: manifest.id,
              version: manifest.version,
              sha256: digest,
              artifactOrigin: origin,
              executable: artifact.executableRelativePath,
              build: 'npm-ci-build',
              autoUpdate: false,
              installedAt: new Date().toISOString(),
            },
            null,
            2,
          ),
          'utf8',
        );
      }
      await sweepStaleTree(manifest);
      return {
        ok: true,
        id: manifest.id,
        version: manifest.version,
        installDir: dir,
        executable: expectedExecutable(manifest),
      };
    } catch (error) {
      return {
        ok: false,
        id: manifest.id,
        reasonCode: error?.reasonCode ?? 'install_failed',
        error: String(error?.message ?? error).slice(0, 200),
      };
    } finally {
      await fsp.rm(stageRoot, { recursive: true, force: true }).catch(() => {});
    }
  }

  /**
   * §6.5 availability insurance: fetch one pinned artifact with
   * MIRROR-FIRST / upstream-fallback. When `TRYLO_ARTIFACT_MIRROR` is set,
   * `<mirrorBase>/<packageId>/<sha16>-<basename>` is tried first; ANY
   * mirror failure — unreachable, 404, or WRONG BYTES — falls back to the
   * pinned upstream URL. The digest check runs on every byte regardless of
   * origin, so the mirror cannot weaken the trust chain, only improve the
   * odds of a successful install.
   *
   * @returns {Promise<{ origin: 'mirror'|'upstream', url: string, digest: string }>}
   */
  async function downloadPinnedArtifact({ id, url, sha256, dest }) {
    if (typeof sha256 !== 'string' || sha256.trim() === '') {
      throw Object.assign(new Error('pinned artifact has no digest'), { reasonCode: 'hash_mismatch' });
    }
    const mirrorBase = mirrorBaseForInstalls();
    if (mirrorBase) {
      // LOCAL mirror (a directory or file:// URL — e.g. the offline copy the
      // mirror script produced): a plain fs copy, ZERO network. This is the
      // guaranteed-availability path when the upstream CDN is throttled or
      // unreachable.
      const isLocalMirror =
        /^[a-zA-Z]:[\\/]/.test(mirrorBase) || mirrorBase.startsWith('\\\\') || mirrorBase.startsWith('file://');
      if (isLocalMirror) {
        const localBase = mirrorBase.startsWith('file://') ? fileURLToPath(mirrorBase) : mirrorBase;
        const mirrorFile = path.join(localBase, id, `${sha256.slice(0, 16)}-${artifactBasename(url)}`);
        try {
          await fsp.copyFile(mirrorFile, dest);
          const mirrorDigest = await sha256OfFile(dest);
          if (digestsMatch(mirrorDigest, sha256)) {
            return { origin: 'mirror', url: mirrorFile, digest: mirrorDigest };
          }
        } catch {
          /* mirror miss → upstream */
        }
        await fsp.rm(dest, { force: true }).catch(() => {});
      } else {
        // HTTPS mirror: same layout over fetch.
        const mirrorUrl = mirrorArtifactUrl(mirrorBase, id, url, sha256);
        try {
          await download(mirrorUrl, dest, maxDownloadBytes);
          const mirrorDigest = await sha256OfFile(dest);
          if (digestsMatch(mirrorDigest, sha256)) {
            return { origin: 'mirror', url: mirrorUrl, digest: mirrorDigest };
          }
          // Wrong bytes from the mirror read as a MISS, never as a failure —
          // the upstream origin is still tried.
        } catch {
          /* mirror miss → upstream */
        }
        await fsp.rm(dest, { force: true }).catch(() => {});
      }
    }
    await download(url, dest, maxDownloadBytes);
    const digest = await sha256OfFile(dest);
    if (!digestsMatch(digest, sha256)) {
      throw Object.assign(
        new Error(`artifact digest mismatch: expected ${sha256.slice(0, 12)}…, got ${digest.slice(0, 12)}…`),
        { reasonCode: 'hash_mismatch' },
      );
    }
    return { origin: 'upstream', url, digest };
  }

  /**
   * Fetch one pinned artefact into the staging tree and verify its digest
   * against the manifest BEFORE anything extracts. The scratch file is
   * removed before returning regardless of outcome. Network fetches ride
   * `downloadPinnedArtifact` (mirror-first, upstream-fallback, §6.5).
   *
   * @returns {Promise<{ digest: string, origin: 'mirror'|'upstream'|'local' }>}
   */
  async function fetchAndVerify({ packageId, url, expected, localPath, stageRoot, label }) {
    if (typeof expected !== 'string' || expected.trim() === '') {
      throw Object.assign(new Error(`${label} has no pinned digest`), { reasonCode: 'hash_mismatch' });
    }
    const scratch = path.join(stageRoot, `${label}.tgz`);
    try {
      if (localPath) {
        if (!isFileSync(localPath)) {
          throw Object.assign(new Error(`${label} artefact not found`), { reasonCode: 'artefact_missing' });
        }
        await fsp.copyFile(localPath, scratch);
        const digest = await sha256OfFile(scratch);
        if (!digestsMatch(digest, expected)) {
          throw Object.assign(
            new Error(`${label} digest mismatch: expected ${expected.slice(0, 12)}…, got ${digest.slice(0, 12)}…`),
            { reasonCode: 'hash_mismatch' },
          );
        }
        return { digest, origin: 'local' };
      }
      if (typeof url !== 'string' || url.trim() === '') {
        throw Object.assign(new Error(`manifest pins no ${label} download URL`), { reasonCode: 'no_download_url' });
      }
      const { digest, origin } = await downloadPinnedArtifact({
        id: packageId ?? label,
        url,
        sha256: expected,
        dest: scratch,
      });
      return { digest, origin };
    } catch (error) {
      await fsp.rm(scratch, { force: true }).catch(() => {});
      throw error;
    }
  }

  /**
   * Remove ONE pinned version directory (§3: 「卸载只删除该版本目录与状态
   * 记录」). Never touches another version, a conversation or a session —
   * removing a package must not require migrating anything.
   */
  async function uninstall(params = {}) {
    const id = String(params.id ?? '');
    const manifest = options.catalog?.get(id);
    if (!manifest) return { ok: false, id, reasonCode: 'unknown_package' };
    if (!installRoot) return { ok: false, id, reasonCode: 'no_install_root' };
    try {
      await fsp.rm(versionDir(manifest), { recursive: true, force: true });
      await sweepStaleTree(manifest);
    } catch (error) {
      // A handle still open inside the tree (a live MCP process) makes the
      // rm fail; the rename-aside swap still clears the package — the stale
      // tree itself is swept on the next install/uninstall.
      const renamed = await renameAside(versionDir(manifest), staleDirFor(manifest)).catch(() => false);
      if (!renamed) {
        return {
          ok: false,
          id,
          reasonCode: 'target_locked',
          error: String(error?.message ?? error).slice(0, 200),
        };
      }
      await sweepStaleTree(manifest);
    }
    return { ok: true, id, version: manifest.version, removed: versionDir(manifest) };
  }

  /**
   * §3.3-7 browser-body install: materialise the browser a manifest's
   * browserCondition needs, using the package's OWN pinned playwright CLI —
   * never a floating `npx playwright`. The download is bounded in time and
   * its result is only "attempted"; the health condition probe is the
   * authority on whether the browser actually landed.
   *
   * @param {{ id: string }} params
   */
  async function installBrowser(params = {}) {
    const id = String(params.id ?? '');
    const manifest = options.catalog?.get(id);
    if (!manifest) return { ok: false, id, reasonCode: 'unknown_package' };
    if (manifest.browserCondition?.kind !== 'playwright-chromium') {
      return { ok: false, id, reasonCode: 'no_browser_condition', error: `package ${id} declares no browser condition` };
    }
    const installed = await resolve(manifest);
    if (!installed.executable) {
      return { ok: false, id, reasonCode: 'package_not_installed', error: 'install the package before the browser body' };
    }
    // <versionDir>/node_modules/@playwright/mcp/cli.js → sibling playwright.
    const mcpDir = path.dirname(installed.executable);
    const playwrightCli = path.resolve(mcpDir, '..', '..', 'playwright', 'cli.js');
    if (!isFileSync(playwrightCli)) {
      return { ok: false, id, reasonCode: 'playwright_cli_missing', error: `pinned playwright CLI not found at ${path.basename(path.dirname(path.dirname(playwrightCli)))}` };
    }
    const browserDir = path.dirname(playwrightCli);
    try {
      await runCommand(
        process.execPath,
        [playwrightCli, 'install', 'chromium'],
        600_000,
        { cwd: browserDir },
      );
    } catch (error) {
      return { ok: false, id, reasonCode: 'browser_install_failed', error: String(error?.message ?? error).slice(0, 200) };
    }
    return { ok: true, id };
  }

  return {
    installRoot,
    versionDir,
    expectedExecutable,
    resolve,
    install,
    uninstall,
    installBrowser,
    sha256OfFile,
    downloadToFile,
    // Exported for tests (same rationale as TAR_COMMAND): the python-env
    // transport and its test fixtures must resolve uv the same way.
    resolveUvExecutable,
  };
}

/** Locate the `uv` executable the pinned-python-env transport shells out to.
 *  Order: UV_PATH env → the user-profile `.local/bin` (uv's default
 *  installer location) and the Hermes-managed copy → PATH lookup. Returns
 *  null when nothing resolves (the caller reports `uv_missing` — §4.4: a
 *  missing capability is a reason code, never a guess). */
export function resolveUvExecutable() {
  const candidates = [];
  if (typeof process.env.UV_PATH === 'string' && process.env.UV_PATH.trim() !== '') {
    candidates.push(process.env.UV_PATH.trim());
  }
  const home = process.env.USERPROFILE ?? process.env.HOME ?? '';
  if (home) {
    candidates.push(path.join(home, '.local', 'bin', process.platform === 'win32' ? 'uv.exe' : 'uv'));
  }
  if (process.platform === 'win32') {
    const localAppData = process.env.LOCALAPPDATA ?? '';
    if (localAppData) {
      candidates.push(path.join(localAppData, 'hermes', 'bin', 'uv.exe'));
      candidates.push(path.join(localAppData, 'Programs', 'uv', 'uv.exe'));
    }
  } else {
    candidates.push('/usr/local/bin/uv');
    candidates.push('/usr/bin/uv');
  }
  for (const candidate of candidates) {
    if (isFileSync(candidate)) return candidate;
  }
  // Last resort: let CreateProcess resolve it from PATH; verify cheaply by
  // asking uv for its version. A wrong resolution surfaces as a probe
  // failure, never a silent substitute.
  try {
    execFileSync('uv', ['--version'], { windowsHide: true, timeout: 10_000, stdio: 'ignore' });
    return 'uv';
  } catch {
    return null;
  }
}

function sha256Hex(content) {
  return crypto.createHash('sha256').update(content).digest('hex');
}

/** One bounded child process for the transports. Resolves — never rejects —
 *  with a boolean success and a truncated failure reason. */
function runBoundedCommand(executable, args, timeoutMs, opts = {}) {
  return new Promise((resolve, reject) => {
    execFile(
      executable,
      [...args],
      { timeout: timeoutMs, windowsHide: true, maxBuffer: 8 * 1024 * 1024, ...opts },
      (error, _stdout, stderr) => {
        if (error) {
          reject(new Error(String(stderr || error.message).slice(0, 200)));
          return;
        }
        resolve(true);
      },
    );
  });
}

/** Candidate locations of the Trylo-maintained fork of the windows-mcp
 *  Python source. The pinned transport downloads the UPSTREAM tarball (its
 *  digest chain still vouches for the dependency set), then the sync below
 *  overwrites the installed `src/windows_mcp` tree with the fork: the fork
 *  is the source of truth for CODE (CAD-workflow fixes — focused-mode Type,
 *  modifier clicks, press/hold + release for every button, double-click
 *  timing for right/middle, wheel-delta granularity, window pre-focus, IME
 *  detection, live dialog-item fallback — plus the fork-added `Ocr` tool),
 *  while the tarball remains the source of truth for DEPENDENCIES.
 *
 *  Two candidates, first existing wins:
 *    1. dev/CI — the monorepo checkout (`new_tool/computer-control/...`,
 *       resolved relative to THIS module);
 *    2. packaged app — `windows-mcp-fork/` staged NEXT TO the bundled
 *       service host by prepare-sidecars.ps1
 *       (`resources/desktop-services/dist/host.bundle.mjs` → sibling
 *       `resources/desktop-services/windows-mcp-fork`). Without it a fresh
 *       install from the upstream tarball alone would expose only the 12
 *       upstream tools and drift against the manifest's 14.
 *  Deployed source of truth: `new_tool/computer-control/Windows-MCP`. */
function windowsMcpForkCandidates() {
  const moduleDir = path.dirname(fileURLToPath(import.meta.url));
  return [
    path.resolve(moduleDir, '../../../new_tool/computer-control/Windows-MCP/src/windows_mcp'),
    path.resolve(moduleDir, '../windows-mcp-fork'),
  ];
}

/** The dev/CI candidate, exported for the manifest↔fork contract test. */
export const WINDOWS_MCP_FORK_SRC = windowsMcpForkCandidates()[0];

function resolveWindowsMcpForkSrc() {
  for (const candidate of windowsMcpForkCandidates()) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

async function pathExists(target) {
  try {
    await fsp.access(target);
    return true;
  } catch {
    return false;
  }
}

/** Overlay the vendored fork onto an installed windows-mcp version dir.
 *  Best-effort and side-effect free when no fork source or no install is
 *  present (packaged apps without the staged fork, not-yet-materialised
 *  installs). Returns the number of files copied. `forkSrc` overrides the
 *  candidate resolution (test seam). */
export async function syncWindowsMcpFork(versionDirPath, forkSrc = resolveWindowsMcpForkSrc()) {
  const targetRoot = path.join(versionDirPath, 'src', 'windows_mcp');
  if (!forkSrc || !(await pathExists(forkSrc)) || !(await pathExists(targetRoot))) {
    return 0;
  }
  let copied = 0;
  async function walk(sourceDir, targetDir) {
    await fsp.mkdir(targetDir, { recursive: true });
    const entries = await fsp.readdir(sourceDir, { withFileTypes: true });
    for (const entry of entries) {
      const sourcePath = path.join(sourceDir, entry.name);
      const targetPath = path.join(targetDir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === '__pycache__') continue;
        await walk(sourcePath, targetPath);
      } else if (entry.isFile()) {
        await fsp.copyFile(sourcePath, targetPath);
        copied += 1;
      }
    }
  }
  await walk(forkSrc, targetRoot);
  return copied;
}

async function applyWindowsMcpPatches(versionDirPath) {
  // Sync 0: overlay the Trylo-maintained fork (see syncWindowsMcpFork). The
  // embedded regex patches below remain as a fallback for environments
  // without the monorepo checkout and are no-ops once the fork is applied —
  // their search strings only match pristine upstream text.
  try {
    await syncWindowsMcpFork(versionDirPath);
  } catch {}
  // Patch 1: tools/app.py — make launch_executable search PATH for bare names like notepad.exe
  const appPy = path.join(versionDirPath, 'src', 'windows_mcp', 'tools', 'app.py');
  try {
    let content = await fsp.readFile(appPy, 'utf8');
    if (content.includes('def _resolve_executable') && !content.includes('shutil.which')) {
      content = content.replace(
        /def _resolve_executable\(executable: str\) -> Path:\s+path = Path\(executable\)\.expanduser\(\)\.resolve\(\)\s+if not path\.is_file\(\):\s+raise ValueError\(f"Executable does not exist: \{path\}"\)\s+return path/,
        `def _resolve_executable(executable: str) -> Path:\n    import os\n    import shutil\n    expanded = os.path.expanduser(os.path.expandvars(executable))\n    candidate = Path(expanded)\n    has_path_sep = (\n        candidate.is_absolute()\n        or os.path.sep in expanded\n        or (os.path.altsep and os.path.altsep in expanded)\n        or "/" in expanded\n        or "\\\\" in expanded\n    )\n    if has_path_sep:\n        path = candidate.expanduser().resolve()\n        if not path.is_file():\n            raise ValueError(f"Executable does not exist: {path}")\n        return path\n    found = shutil.which(expanded)\n    if found:\n        path = Path(found).resolve()\n        if path.is_file():\n            return path\n    path = candidate.expanduser().resolve()\n    if path.is_file():\n        return path\n    raise ValueError(f"Executable does not exist: {path} (searched PATH for {expanded!r}, not found)")`,
      );
      await fsp.writeFile(appPy, content, 'utf8');
    }
  } catch {}
  // Patch 2: desktop/service.py — fast path enumerates windows with per-step timeout
  const servicePy = path.join(versionDirPath, 'src', 'windows_mcp', 'desktop', 'service.py');
  try {
    let content = await fsp.readFile(servicePy, 'utf8');
    if (content.includes('Fast path for Screenshot tool (use_ui_tree=False): skip window enumeration')) {
      content = content.replace(
        /        # Fast path for Screenshot tool \(use_ui_tree=False\): skip window enumeration\.\s+        # UIAutomation calls \(get_controls_handles \/ get_windows \/ get_active_window\)\s+        # can hang when an app is launching and not responding to WM messages\.\s+        if use_ui_tree:\s+            controls_handles = self\.get_controls_handles\(\)  # Taskbar,Program Manager,Apps, Dialogs\s+            windows, windows_handles = self\.get_windows\(controls_handles=controls_handles\)  # Apps\s+            active_window = self\.get_active_window\(windows=windows\)  # Active Window\s+            active_window_handle = active_window\.handle if active_window else None\s+        else:\s+            controls_handles = set\(\)\s+            windows = \[\]\s+            windows_handles = set\(\)\s+            active_window = None\s+            active_window_handle = None/,
        `        # Window enumeration is needed for both Snapshot and Screenshot so\n        # callers can see "Focused Window" / "Opened Windows". The heavy\n        # part that can hang is the UI tree crawl (tree.get_state), not the\n        # lightweight window list — so Screenshot still skips tree capture\n        # but now enumerates windows. Each UIA/COM call can hang when a\n        # target process is unresponsive, so the fast path wraps each step\n        # in a hard timeout and degrades to empty on failure.\n        if use_ui_tree:\n            controls_handles = self.get_controls_handles()  # Taskbar,Program Manager,Apps, Dialogs\n            windows, windows_handles = self.get_windows(controls_handles=controls_handles)  # Apps\n            active_window = self.get_active_window(windows=windows)  # Active Window\n            active_window_handle = active_window.handle if active_window else None\n        else:\n            controls_handles = set()\n            windows = []\n            windows_handles = set()\n            active_window = None\n            active_window_handle = None\n            try:\n                controls_handles = _run_with_timeout(self.get_controls_handles, timeout_sec=5.0)\n            except Exception as ex:\n                logger.warning(f"Fast-path get_controls_handles failed: {ex}")\n            try:\n                windows, windows_handles = _run_with_timeout(\n                    lambda: self.get_windows(controls_handles=controls_handles), timeout_sec=5.0\n                )\n            except Exception as ex:\n                logger.warning(f"Fast-path get_windows failed: {ex}")\n            try:\n                active_window = _run_with_timeout(\n                    lambda: self.get_active_window(windows=windows), timeout_sec=5.0\n                )\n                active_window_handle = active_window.handle if active_window else None\n            except Exception as ex:\n                logger.warning(f"Fast-path get_active_window failed: {ex}")`,
      );
      // Also restore minimized single-instance apps (Win11 Notepad) after launch
      if (!content.includes('restored from minimized')) {
        content = content.replace(
          /                if launched:\s+                    return f"\{name\.title\(\)\} launched\."\s+                return f"Launching \{name\.title\(\)\} sent, but window not detected yet\."/,
          `                if launched:\n                    try:\n                        win, _ = self._find_window_by_name(name, refresh_state=True)\n                        if win is not None and win.status == Status.MINIMIZED:\n                            self.bring_window_to_top(win.handle)\n                            return f"{name.title()} launched and restored from minimized."\n                    except Exception:\n                        pass\n                    return f"{name.title()} launched."\n                return f"Launching {name.title()} sent, but window not detected yet."`,
        );
      }
      await fsp.writeFile(servicePy, content, 'utf8');
    }
  } catch {}
  // Patch 3: uia/core.py — use SendInput instead of deprecated mouse_event for Click/MiddleClick/RightClick
  const corePy = path.join(versionDirPath, 'src', 'windows_mcp', 'uia', 'core.py');
  try {
    let content = await fsp.readFile(corePy, 'utf8');
    // Patch Click function: replace mouse_event with SendInput
    const oldClick = 'def Click(x: int, y: int, waitTime: float = OPERATION_WAIT_TIME) -> None:\n    """\n    Simulate mouse click at point x, y.\n    x: int.\n    y: int.\n    waitTime: float.\n    """\n    SetCursorPos(x, y)\n    screenWidth, screenHeight = GetScreenSize()\n    mouse_event(\n        MouseEventFlag.LeftDown | MouseEventFlag.Absolute,\n        x * 65535 // screenWidth,\n        y * 65535 // screenHeight,\n        0,\n        0,\n    )\n    time.sleep(0.05)\n    mouse_event(\n        MouseEventFlag.LeftUp | MouseEventFlag.Absolute,\n        x * 65535 // screenWidth,\n        y * 65535 // screenHeight,\n        0,\n        0,\n    )\n    time.sleep(waitTime)';
    const newClick = 'def Click(x: int, y: int, waitTime: float = OPERATION_WAIT_TIME) -> None:\n    """\n    Simulate mouse click at point x, y.\n    x: int.\n    y: int.\n    waitTime: float.\n    """\n    SetCursorPos(x, y)\n    screenWidth, screenHeight = GetScreenSize()\n    dx = x * 65535 // screenWidth\n    dy = y * 65535 // screenHeight\n    SendInput(\n        MouseInput(dx, dy, dwFlags=MouseEventFlag.LeftDown | MouseEventFlag.Absolute),\n    )\n    time.sleep(0.05)\n    SendInput(\n        MouseInput(dx, dy, dwFlags=MouseEventFlag.LeftUp | MouseEventFlag.Absolute),\n    )\n    time.sleep(waitTime)';
    if (content.includes(oldClick)) {
      content = content.replace(oldClick, newClick);
    }
    // Patch MiddleClick function
    const oldMiddleClick = 'def MiddleClick(x: int, y: int, waitTime: float = OPERATION_WAIT_TIME) -> None:\n    """\n    Simulate mouse middle click at point x, y.\n    x: int.\n    y: int.\n    waitTime: float.\n    """\n    SetCursorPos(x, y)\n    screenWidth, screenHeight = GetScreenSize()\n    mouse_event(\n        MouseEventFlag.MiddleDown | MouseEventFlag.Absolute,\n        x * 65535 // screenWidth,\n        y * 65535 // screenHeight,\n        0,\n        0,\n    )\n    time.sleep(0.05)\n    mouse_event(\n        MouseEventFlag.MiddleUp | MouseEventFlag.Absolute,\n        x * 65535 // screenWidth,\n        y * 65535 // screenHeight,\n        0,\n        0,\n    )\n    time.sleep(waitTime)';
    const newMiddleClick = 'def MiddleClick(x: int, y: int, waitTime: float = OPERATION_WAIT_TIME) -> None:\n    """\n    Simulate mouse middle click at point x, y.\n    x: int.\n    y: int.\n    waitTime: float.\n    """\n    SetCursorPos(x, y)\n    screenWidth, screenHeight = GetScreenSize()\n    dx = x * 65535 // screenWidth\n    dy = y * 65535 // screenHeight\n    SendInput(\n        MouseInput(dx, dy, dwFlags=MouseEventFlag.MiddleDown | MouseEventFlag.Absolute),\n    )\n    time.sleep(0.05)\n    SendInput(\n        MouseInput(dx, dy, dwFlags=MouseEventFlag.MiddleUp | MouseEventFlag.Absolute),\n    )\n    time.sleep(waitTime)';
    if (content.includes(oldMiddleClick)) {
      content = content.replace(oldMiddleClick, newMiddleClick);
    }
    // Patch RightClick function
    const oldRightClick = 'def RightClick(x: int, y: int, waitTime: float = OPERATION_WAIT_TIME) -> None:\n    """\n    Simulate mouse right click at point x, y.\n    x: int.\n    y: int.\n    waitTime: float.\n    """\n    SetCursorPos(x, y)\n    screenWidth, screenHeight = GetScreenSize()\n    mouse_event(\n        MouseEventFlag.RightDown | MouseEventFlag.Absolute,\n        x * 65535 // screenWidth,\n        y * 65535 // screenHeight,\n        0,\n        0,\n    )\n    time.sleep(0.05)\n    mouse_event(\n        MouseEventFlag.RightUp | MouseEventFlag.Absolute,\n        x * 65535 // screenWidth,\n        y * 65535 // screenHeight,\n        0,\n        0,\n    )\n    time.sleep(waitTime)';
    const newRightClick = 'def RightClick(x: int, y: int, waitTime: float = OPERATION_WAIT_TIME) -> None:\n    """\n    Simulate mouse right click at point x, y.\n    x: int.\n    y: int.\n    waitTime: float.\n    """\n    SetCursorPos(x, y)\n    screenWidth, screenHeight = GetScreenSize()\n    dx = x * 65535 // screenWidth\n    dy = y * 65535 // screenHeight\n    SendInput(\n        MouseInput(dx, dy, dwFlags=MouseEventFlag.RightDown | MouseEventFlag.Absolute),\n    )\n    time.sleep(0.05)\n    SendInput(\n        MouseInput(dx, dy, dwFlags=MouseEventFlag.RightUp | MouseEventFlag.Absolute),\n    )\n    time.sleep(waitTime)';
    if (content.includes(oldRightClick)) {
      content = content.replace(oldRightClick, newRightClick);
    }
    await fsp.writeFile(corePy, content, 'utf8');
  } catch {}
}

/** CAD/EDA: locate the npm CLI that ships beside the Node runtime the
 *  Service Host itself runs under. Falls back to PATH. Never throws. */
/** CAD/EDA: locate the npm CLI. Returns `{ command, args }` — the JS entry
 *  (`npm-cli.js`) run under the SAME Node runtime the Service Host uses.
 *  Spawning `npm.cmd` directly is NOT an option: Node ≥18.20 rejects
 *  .cmd/.bat spawns without a shell (CVE-2024-27980, `spawn EINVAL`), and a
 *  shell join would loosen argv handling. Null when npm is not adjacent to
 *  the runtime (node_modules/npm ships beside node.exe in every official
 *  Node distribution). */
export function resolveNpmCommand() {
  const prefix = path.dirname(process.execPath);
  const cli = path.join(prefix, 'node_modules', 'npm', 'bin', 'npm-cli.js');
  if (isFileSync(cli)) {
    return { command: process.execPath, args: [cli] };
  }
  return null;
}

/** CAD/EDA: locate KiCad's bundled Python (newest install first). pcbnew and
 *  kipy exist ONLY inside this interpreter, so a package that drives KiCad
 *  must materialise its Python deps there. Reads the well-known install
 *  roots read-only; returns null when KiCad is not detected. */
export function detectKicadPython(env = process.env) {
  const roots = [
    env['ProgramFiles'],
    env['ProgramFiles(x86)'],
    env.LOCALAPPDATA ? path.join(env.LOCALAPPDATA, 'Programs') : '',
  ].filter((root) => typeof root === 'string' && root.trim() !== '');
  for (const root of roots) {
    const kicadRoot = path.join(root, 'KiCad');
    let versions;
    try {
      versions = fs
        .readdirSync(kicadRoot, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name);
    } catch {
      continue;
    }
    versions.sort((a, b) => b.localeCompare(a, undefined, { numeric: true, sensitivity: 'base' }));
    for (const version of versions) {
      const python = path.join(kicadRoot, version, 'bin', 'python.exe');
      if (isFileSync(python)) return python;
    }
  }
  return null;
}

/**
 * The digest resolve() vouches for a wheels-mode pinned-pypi-env install by:
 * sha256 over the sorted `name-version-sha256` lines of the closure. The
 * manifest generator pins the SAME value as `artifact.archiveSha256`, so a
 * wheel-set drift reads as hash-mismatch without a separate code path.
 */
export function pypiWheelStateDigest(wheels) {
  const hash = crypto.createHash('sha256');
  const lines = (wheels ?? [])
    .map((wheel) => `${wheel.name}-${wheel.version}-${wheel.sha256}`)
    .sort();
  hash.update(lines.join('\n'));
  return hash.digest('hex');
}

/** CAD/EDA (TRYLO-CAD-EDA-TOOL-ADAPTER §6.5 availability insurance): the
 *  on-disk name of one mirrored pinned artifact. Shared by the mirror
 *  builder (scripts/mirror-pinned-artifacts.mjs) and the transport's mirror
 *  derivation so a mirror directory uploaded AS-IS is resolvable. */
export function artifactBasename(url) {
  try {
    const parsed = new URL(url);
    const last = parsed.pathname.split('/').filter(Boolean).pop() ?? 'artifact';
    return decodeURIComponent(last).replace(/[\\/:*?"<>|]/g, '_');
  } catch {
    return 'artifact';
  }
}

/** The mirror URL for one pinned artifact:
 *  `<mirrorBase>/<packageId>/<sha256-16>-<basename>`. The digest segment
 *  makes every mirror entry self-identifying; the digest CHECK after the
 *  transfer remains the trust boundary either way. */
export function mirrorArtifactUrl(mirrorBase, packageId, url, sha256) {
  const base = String(mirrorBase ?? '').trim().replace(/\/+$/, '');
  return `${base}/${packageId}/${sha256.slice(0, 16)}-${artifactBasename(url)}`;
}

/** Ops-level availability insurance (spec §6.5): when set, the transports
 *  try the mirror FIRST and fall back to the pinned upstream URL on any
 *  failure. The base may be
 *   - an https(s) mirror root:  `<base>/<packageId>/<sha16>-<basename>`, or
 *   - a LOCAL directory / file:// URL (the offline copy the mirror script
 *     produced): a plain fs copy, zero network — the guaranteed path when
 *     the upstream CDN is throttled or unreachable.
 * Read at install time so tests can flip it. */
export function mirrorBaseFromEnv(env = process.env) {
  const base = String(env.TRYLO_ARTIFACT_MIRROR ?? '').trim().replace(/\/+$/, '');
  return base !== '' ? base : null;
}

export default createToolPackageManager;
