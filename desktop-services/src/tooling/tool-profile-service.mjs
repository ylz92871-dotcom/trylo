// Trylo Desktop Services — Tool Profile Service.
//
// Spec TRYLO-CORE-AGENT-TOOL-EXTENSION-TECHNICAL-SPEC §3.1 / §4.
//
// The COMBINER. It is the only place that decides which MCP servers a run
// sees, and it writes them to content-addressed, stable paths so the
// renderer's RuntimeFingerprint (§9) can identify a runtime without
// comparing argv strings.
//
// Explicitly NOT a Hermes adapter. `mcp-args-service.mjs` stays the Hermes
// Adapter and keeps owning what a Hermes profile MEANS; this module asks it
// for its server definitions and merges them with Trylo's own packages
// (§3.1: 「不把新功能继续塞进 mcp-args-service.mjs」).
//
// §4.3: composition is EXPLICIT. A Profile lists its package ids; nothing
// is inherited from the project directory and no unknown MCP can enter a
// Work surface. §4.4: a missing package degrades to a reported unavailable
// capability — never to a silent, tool-less run.
//
// Failure policy: `resolve` never throws. A failure yields `ok:false` with
// reason codes the renderer can show verbatim.

import fs from 'node:fs';
import { desktopControlForPlatform } from './computer-control/platform.mjs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { browserRuntimeEnv } from './browser/browser-runtime-env.mjs';

import { resolvePinnedWgcHelper } from './tool-package-manager.mjs';
import { toolRuntimeIdentity } from './tool-runtime-identity.mjs';
import { CORE_TOOL_RUNTIME_REVISION } from './tool-catalog.mjs';
import { MODEL_PREVIEW_NAMES, MODEL_PREVIEW_VERSION } from './model-preview-contract.mjs';
import { SOFTWARE_NAMES, SOFTWARE_VERSION } from './software-workspace-contract.mjs';

/** Placeholder expanded per-run in a manifest's argv (spec §10.2). */
const RUNTIME_DIR_TOKEN = '{runtimeDir}';

/** CAD/EDA: placeholder expanded to a package's install directory — how a
 *  source-run pinned-pypi-env manifest points its venv python at the pinned
 *  source entry script (TRYLO-CAD-EDA-TOOL-ADAPTER §6.2). */
const INSTALL_DIR_TOKEN = '{installDir}';

/** Desktop-control package (windows-mcp → MCP server `trylo-windows`). Excluded
 *  from a resolved Work Profile when `computerUse === false` (the 电脑控制
 *  switch), so a Work agent cannot see/use desktop tools at all in that case. */
const WINDOWS_MCP_PACKAGE_ID = 'windows-mcp';

// Capability layers. Every Profile below is materialised from these layers
// instead of hand-copying a complete package list. This makes the invariant
// executable: specialist Work modes may replace the browser implementation
// or add CAD/EDA adapters, but can never accidentally drop the shared base.
const CODE_BASE_PACKAGES = Object.freeze(['officecli', 'playwright', WINDOWS_MCP_PACKAGE_ID]);
const WORK_BASE_PACKAGES = Object.freeze(['officecli', 'playwright', WINDOWS_MCP_PACKAGE_ID]);
const WORK_DEBUG_BASE_PACKAGES = Object.freeze(['officecli', 'chrome-devtools', WINDOWS_MCP_PACKAGE_ID]);
const CAD_EDA_PACKAGES = Object.freeze([
  'solidworks-mcp',
  'autocad-mcp',
  'kicad-mcp',
  'jlceda-mcp',
  'freecad-mcp',
  'blender-mcp',
]);

function withCadEda(base) {
  return Object.freeze([...base, ...CAD_EDA_PACKAGES]);
}

/**
 * The stable Profiles (§4.1). `revision` changes whenever the
 * composition changes, so a stale warm runtime can never be reused.
 */
export const TOOL_PROFILES = Object.freeze({
  'code.core.v1': Object.freeze({
    id: 'code.core.v1',
    revision: '3',
    surface: 'code',
    hermesProfile: 'normal',
    // Office, browser and desktop control are the shared default tools.
    // Code still overlays the user's MCP configuration; action approvals
    // remain independent of mounting these capabilities.
    packageIds: CODE_BASE_PACKAGES,
    // §4.3: Code keeps reading the user's own MCP servers today; Work does
    // not. The two surfaces therefore do not share one argv.
    strictMcpConfig: false,
  }),

  // 办公基底 (2026-09-06, rev 2): office + browser + desktop control in
  // ONE default. CAD-era workflows end in reports/decks that may need a
  // live window, so splitting desktop control into a separate exclusive
  // Profile (`work.computer.v1`, removed) forced toggle-shuffling mid-task.
  // The per-action gates stay intact (§6.6 leases + bypass-immune
  // approvals) — this merge only mounts the tools, it never auto-allows
  // their sensitive actions.
  'work.core.v1': Object.freeze({
    id: 'work.core.v1',
    revision: '2',
    surface: 'work',
    hermesProfile: 'normal',
    packageIds: WORK_BASE_PACKAGES,
    strictMcpConfig: true,
  }),

  'work.browser-debug.v1': Object.freeze({
    id: 'work.browser-debug.v1',
    revision: '2',
    surface: 'work',
    hermesProfile: 'normal',
    // §4.1: Playwright is REPLACED by Chrome DevTools MCP here — never
    // both at once. Enabling this profile with chrome-devtools missing
    // (not installed) degrades to a reported unavailable capability.
    packageIds: WORK_DEBUG_BASE_PACKAGES,
    strictMcpConfig: true,
  }),

  // CAD/EDA adapter profile (TRYLO-CAD-EDA-TOOL-ADAPTER spec §4). Every
  // package automates a host application the USER must have installed —
  // health gating degrades the missing ones to reported unavailable
  // capabilities (§4.4), so ONE profile carries all six adapters and the
  // machine only ever sees the servers it can actually reach. Never a
  // default Profile: entering it requires the workCad capability toggle.
  //
  // 2026-09-06: windows-mcp joins this Profile. CAD acceptance REQUIRES
  // live-window visual checks (bearing-housing report #20: MCP renders are
  // archive-only, never acceptance) — a CAD run without desktop control
  // loses its own acceptance gate. The 办公基底 already carries
  // windows-mcp, so CAD + office + desktop control compose with a single
  // toggle and no profile shadowing.
  //
  // 2026-09-06 (rev 3): officecli joins this Profile. CAD work ends in
  // acceptance reports / slide decks, and a CAD session without Office
  // forces the user to shuttle files between surfaces. One session must
  // see every tool it needs (§4.1 composition), so the CAD run keeps its
  // documentation capability alongside the six adapters + desktop control.
  'work.cad.v1': Object.freeze({
    id: 'work.cad.v1',
    revision: '4',
    surface: 'work',
    hermesProfile: 'normal',
    packageIds: withCadEda(WORK_BASE_PACKAGES),
    strictMcpConfig: true,
  }),

  // Both Work toggles can be active together. Chrome DevTools replaces
  // Playwright while Office, desktop control, Hermes and every CAD/EDA
  // adapter remain present. Without this explicit composition the renderer's
  // old first-match routing silently discarded the CAD layer.
  'work.cad-browser-debug.v1': Object.freeze({
    id: 'work.cad-browser-debug.v1',
    revision: '1',
    surface: 'work',
    hermesProfile: 'normal',
    packageIds: withCadEda(WORK_DEBUG_BASE_PACKAGES),
    strictMcpConfig: true,
  }),
});

export const DEFAULT_PROFILE_BY_SURFACE = Object.freeze({
  code: 'code.core.v1',
  work: 'work.core.v1',
});

function sha256(input) {
  return crypto.createHash('sha256').update(input).digest('hex');
}

function stableStringify(value) {
  // Key-sorted serialization so two logically identical configs always
  // produce the same hash — without this, insertion order would mint new
  // content hashes and destroy warm-runtime reuse (§9).
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(',')}}`;
}

function runtimeDirFor(projectRoot, dirName, conversationId) {
  return path.join(projectRoot, '.trylo', 'runtime', dirName, conversationId);
}

/** Expand `{runtimeDir}` and `{installDir}` and return the args plus any
 *  dirs the host must create. */
function expandArgs(args, runtimeDir, installDir) {
  const dirs = [];
  const expanded = args.map((arg) => {
    let out = arg;
    if (out.includes(RUNTIME_DIR_TOKEN)) {
      dirs.push(runtimeDir);
      out = out.split(RUNTIME_DIR_TOKEN).join(runtimeDir);
    }
    if (installDir && out.includes(INSTALL_DIR_TOKEN)) {
      out = out.split(INSTALL_DIR_TOKEN).join(installDir);
    }
    return out;
  });
  return { expanded, dirs };
}

export function createToolProfileService(options = {}) {
  const catalog = options.catalog;
  const desktopControl = desktopControlForPlatform(options.platform ?? process.platform);
  const packages = options.packages;
  const health = options.health;
  const hermes = options.hermes ?? null; // { mcpArgs({profile}) } — Hermes Adapter
  const storageRoot = options.storageRoot ?? '';
  const now = options.now ?? (() => Date.now());
  const browserObserver = options.browserObserver;
  const nativeBrowser = options.nativeBrowser;
  const modelPreview = options.modelPreview;
  const softwareWorkspace = options.softwareWorkspace;
  // An embedded caller's argv[1] is its launcher, which need not implement
  // --native-browser-mcp. The service host supplies its own path when bundled.
  const hostEntrypoint = options.hostEntrypoint ?? fileURLToPath(new URL('../host.mjs', import.meta.url));

  const profilesRoot = options.profilesRoot
    ?? (storageRoot ? path.join(storageRoot, 'tool-profiles') : '');

  /**
   * Read the Hermes server definitions for a profile (§3.1). The adapter
   * may answer with a config path or with inline JSON in its argv; both are
   * accepted, and neither is re-derived here.
   */
  async function hermesServers(profile) {
    if (!hermes) {
      return { servers: {}, unavailable: [], warning: null };
    }
    let result;
    try {
      result = hermes.mcpArgs({ profile: profile.hermesProfile });
    } catch (error) {
      return { servers: {}, unavailable: [], warning: `hermes adapter failed: ${error?.message ?? error}` };
    }
    if (!result?.ok) {
      return { servers: {}, unavailable: [], warning: result?.warning ?? 'hermes unavailable' };
    }

    // Prefer the on-disk config path; fall back to inline JSON in the argv.
    if (result.configPath && fs.existsSync(result.configPath)) {
      try {
        const parsed = JSON.parse(fs.readFileSync(result.configPath, 'utf8'));
        const servers = parsed?.mcpServers ?? {};
        return { servers, unavailable: [], warning: null };
      } catch (error) {
        return {
          servers: {},
          unavailable: [],
          warning: `hermes config unreadable: ${error?.message ?? error}`,
        };
      }
    }
    const inline = Array.isArray(result.arg) ? result.arg[1] : null;
    if (typeof inline === 'string' && inline.trim().startsWith('{')) {
      try {
        const servers = JSON.parse(inline)?.mcpServers ?? {};
        return { servers, unavailable: [], warning: null };
      } catch {
        return { servers: {}, unavailable: [], warning: 'hermes inline config unparseable' };
      }
    }
    return { servers: {}, unavailable: [], warning: 'hermes produced no usable config' };
  }

  /** Write `contents` to a content-addressed path, skipping a rewrite when
   *  an identical file is already present (§9: stable identity). */
  async function writeContentAddressed(dir, filename, contents) {
    const hash = sha256(contents);
    const short = hash.slice(0, 16);
    const target = path.join(dir, short, filename);
    const targetDir = path.dirname(target);
    await fsp.mkdir(targetDir, { recursive: true });
    let exists = false;
    try {
      exists = (await fsp.readFile(target, 'utf8')) === contents;
    } catch {
      exists = false;
    }
    if (!exists) {
      // Temp-then-rename so a crashed write can never leave a half config
      // that a later run would happily adopt.
      // Separate resolves (including separate service instances) may publish
      // identical content concurrently; each writer needs its own temp file.
      const tmp = `${target}.${process.pid}.${crypto.randomUUID()}.tmp`;
      try {
        await fsp.writeFile(tmp, contents, 'utf8');
        try {
          await fsp.rename(tmp, target);
        } catch (err) {
          // Windows can reject replacement when another resolver has just
          // published this content-addressed file. Only adopt exact contents;
          // permission failures and mismatched files remain real failures.
          if (!['EEXIST', 'EPERM', 'EACCES'].includes(err?.code)) throw err;
          let published;
          try { published = await fsp.readFile(target, 'utf8'); }
          catch { throw err; }
          if (published !== contents) throw err;
        }
      } finally {
        await fsp.rm(tmp, { force: true });
      }
    }
    return { path: target, hash };
  }

  /**
   * Compose one Profile into a ResolvedToolRuntime.
   *
   * @param {{ surface?: 'code'|'work', requestedProfileId?: string,
   *           computerUse?: boolean, projectKey?: string, projectRoot?: string,
   *           conversationId?: string }} params
   */
  async function resolve(params = {}) {
    const surface = params.surface === 'work' ? 'work' : 'code';
    const requested = String(params.requestedProfileId ?? '').trim();
    const profileId = requested || DEFAULT_PROFILE_BY_SURFACE[surface];
    const profile = TOOL_PROFILES[profileId];
    // User-facing defaults always include desktop control. Internal callers
    // may still explicitly isolate a noninteractive/background operation.
    const computerUse = params.computerUse !== false;

    if (!profile) {
      return {
        ok: false,
        reasonCode: 'unknown_profile',
        error: `unknown tool profile '${profileId}'`,
        knownProfiles: Object.keys(TOOL_PROFILES),
      };
    }
    if (profile.surface !== surface) {
      return {
        ok: false,
        reasonCode: 'profile_surface_mismatch',
        error: `profile '${profileId}' belongs to surface '${profile.surface}', not '${surface}'`,
      };
    }
    if (!profilesRoot) {
      return { ok: false, reasonCode: 'no_storage_root', error: 'tool profile storage is not configured' };
    }

    const projectRoot = params.projectRoot ?? '';
    const conversationId = params.conversationId ?? '';

    // 1. Hermes contribution (existing behaviour, unchanged ownership).
    const hermesPart = await hermesServers(profile);

    // 2. Trylo package contributions — explicit, health-gated.
    const mcpServers = { ...hermesPart.servers };
    const preparedPackages = new Set();
    const packageHealth = [];
    const unavailableCapabilities = [];

    function markPackageUnavailable(id, manifest, reasonCode, detail, userMessage) {
      const priorIndex = packageHealth.findIndex(record => record.id === id);
      const record = {
        ...(priorIndex < 0 ? {} : packageHealth[priorIndex]),
        id,
        displayName: manifest?.displayName ?? id,
        version: manifest?.version ?? '',
        serverName: manifest?.mcp.serverName,
        expectedTools: [...(manifest?.mcp.expectedTools ?? [])],
        state: 'condition-missing',
        available: false,
        reasonCode,
        detail,
        protocol: 'not-checked',
        checkedAt: now(),
      };
      if (priorIndex < 0) packageHealth.push(record);
      else packageHealth[priorIndex] = record;
      unavailableCapabilities.push({ id, type: 'package', displayName: record.displayName,
        version: record.version, reasonCode, detail, userMessage });
    }

    for (const packageId of profile.packageIds) {
      const id = packageId === WINDOWS_MCP_PACKAGE_ID ? desktopControl?.packageId : packageId;
      // 电脑控制开关: when explicitly disabled, the desktop-control package is
      // dropped from the Profile. Not an "unavailable capability" (the user
      // turned it off, not a missing dependency) — the tools are simply absent.
      if (packageId === WINDOWS_MCP_PACKAGE_ID && !computerUse) continue;
      if (!id) {
        unavailableCapabilities.push({ id: packageId, type: 'package', reasonCode: 'unsupported_platform',
          userMessage: '当前系统尚未接入电脑控制工具' });
        continue;
      }
      let manifest;
      try {
        manifest = catalog.get(id);
        if (!manifest) {
          unavailableCapabilities.push({
            id,
            type: 'package',
            reasonCode: 'not_in_catalog',
            userMessage: `工具包 ${id} 尚未纳入 Trylo 工具目录`,
          });
          continue;
        }

        const record = await health.check(manifest);
        packageHealth.push(record);

        if (!record.available) {
          unavailableCapabilities.push({
            id,
            type: 'package',
            displayName: manifest.displayName,
            version: manifest.version,
            reasonCode: record.reasonCode ?? (record.state === 'version-mismatch' ? 'version_mismatch' : 'not_installed'),
            detail: record.detail,
            userMessage: `${manifest.displayName}（${manifest.version}）不可用：${record.detail}`,
          });
          continue;
        }

        const installed = await packages.resolve(manifest);
        const runtimeIdentity = toolRuntimeIdentity(manifest,installed);
        if (record.runtimeIdentity && record.runtimeIdentity !== runtimeIdentity) {
          markPackageUnavailable(id, manifest, 'runtime_changed', 'runtime changed after health check',
            `${manifest.displayName} 的运行环境在检查后发生变化，请重新发送以重新检查。`);
          continue;
        }
        // Broker reuse must also retire an older host relay implementation.
        const identityEnv = { TRYLO_TOOL_RUNTIME_ID: runtimeIdentity,
          TRYLO_CORE_TOOL_RUNTIME_REVISION: String(CORE_TOOL_RUNTIME_REVISION) };
        // §8.2 outputDir contract: a manifest may rename its per-run runtime
        // dir (playwright → `browser/<conversationId>`). Default: package id.
        const dirName = manifest.runtimeDirName ?? manifest.id;
        const runtimeDir = runtimeDirFor(projectRoot, dirName, conversationId);
        // §8.2 origin configuration: forwarded verbatim as the server's own
        // request filter. Semicolon-joined per the pinned server's --help.
        const originArgs = [];
        if (Array.isArray(manifest.mcp.allowedOrigins) && manifest.mcp.allowedOrigins.length > 0) {
          originArgs.push('--allowed-origins', manifest.mcp.allowedOrigins.join(';'));
        }
        if (Array.isArray(manifest.mcp.blockedOrigins) && manifest.mcp.blockedOrigins.length > 0) {
          originArgs.push('--blocked-origins', manifest.mcp.blockedOrigins.join(';'));
        }
        const nativePackage = nativeBrowser && ['playwright', 'chrome-devtools'].includes(id);
        const { expanded, dirs } = expandArgs([...manifest.mcp.args].filter(arg => !nativePackage || arg !== '--isolated'), runtimeDir, installed.installDir);
        for (const dir of dirs) await fsp.mkdir(dir, { recursive: true });
        let nativeConnection;
        if (nativePackage) {
          try { nativeConnection = await nativeBrowser.configure({ packageId: id, projectRoot, conversationId }); expanded.push(...nativeConnection.args); }
          catch (error) {
            const detail = String(error?.message ?? error);
            markPackageUnavailable(id, manifest, 'native_browser_unavailable', detail,
              `原生浏览器连接失败：${detail}`);
            continue;
          }
        } else if (browserObserver && ['playwright', 'chrome-devtools'].includes(id)) {
          expanded.push(...await browserObserver.configure({ packageId: id, projectRoot, conversationId }));
        }

        // WCC-P2-05 wiring (spec §19.8): a manifest may pin a native helper the
        // sidecar needs at runtime (windows-mcp's .NET WGC capture helper). The
        // fork's WgcProvider resolves it via WINDOWS_MCP_WGC_HELPER first (wgc.py
        // `default_helper_path`), so the host injects its digest-verified
        // resolution here — the packaged sidecar's only other candidate is a
        // repo-relative dev path that does not exist in an installed tree. A
        // failed resolution (not staged / digest drift) injects NOTHING: the
        // child's own lookup then comes up empty and the capture path degrades
        // to the honest legacy status (§13.1); we never point the child at
        // unverified native code.
        let helperEnv = null;
        if (id === WINDOWS_MCP_PACKAGE_ID) {
          helperEnv = { WINDOWS_MCP_SCREENSHOT_NATIVE: '1', WINDOWS_MCP_PREVIEW_CACHE: path.join(path.dirname(storageRoot), 'tool-cache') };
        }
        if (manifest.helper) {
          try {
            const helper = await resolvePinnedWgcHelper(manifest);
            if (helper.ok && helper.path) {
              helperEnv = { ...helperEnv, WINDOWS_MCP_WGC_HELPER: helper.path };
            }
          } catch {
            // Keep preview quality even if the optional native helper is unavailable.
          }
        }

        const browserEnv = id === 'playwright' ? browserRuntimeEnv(runtimeDir) : {};

        // Never let two manifests claim one server name — the catalog
        // guarantees uniqueness, but a late collision must not silently
        // overwrite Hermes or another package.
        if (mcpServers[manifest.mcp.serverName]) {
          markPackageUnavailable(id, manifest, 'server_name_collision', 'MCP server name already occupied',
            `${manifest.displayName} 的 MCP server 名冲突，已跳过`);
          continue;
        }

        // §8.2: a `runner: 'node'` package's entry is a .js script — the
        // command is the Node runtime the Service Host itself runs under,
        // and the entry path is the first argv (never `npx`).
        if (manifest.artifact.runner === 'node') {
          mcpServers[manifest.mcp.serverName] = {
            command: process.execPath,
            args: nativeConnection
              ? [hostEntrypoint, '--native-browser-mcp', nativeConnection.gate, installed.executable, ...expanded, ...originArgs]
              : [installed.executable, ...expanded, ...originArgs],
            env: { ...manifest.mcp.env, ...helperEnv, ...browserEnv, ...identityEnv },
          };
        } else {
          mcpServers[manifest.mcp.serverName] = {
            command: installed.executable,
            args: [...(installed.argsPrefix ?? []), ...expanded, ...originArgs],
            env: { ...manifest.mcp.env, ...helperEnv, ...identityEnv },
          };
        }
        preparedPackages.add(id);
      } catch (error) {
        // One optional package must not discard the other servers in this run.
        const detail = String(error?.message ?? error);
        markPackageUnavailable(id, manifest, 'package_resolution_failed', detail,
          `${manifest?.displayName ?? id} 准备失败，其他工具仍可继续使用。`);
      }
    }

    // Placement transport preserves each existing CAD tool and approval rule.
    // Only packages already admitted by this profile can enter the workspace.
    if (softwareWorkspace && computerUse && projectRoot && conversationId) {
      try {
        const connection = await softwareWorkspace.configure({ projectRoot, conversationId });
        for (const id of ['solidworks-mcp', 'autocad-mcp']) {
          const name = catalog.get(id)?.mcp.serverName;
          const server = mcpServers[name];
          if (!server || !preparedPackages.has(id)) continue;
          await softwareWorkspace.configure({ projectRoot, conversationId, packageId: id, server });
          mcpServers[name] = { command: process.execPath,
            args: [hostEntrypoint, '--software-workspace-mcp', connection.gate, id], env: server.env };
        }
        if (mcpServers['trylo-software']) throw new Error('software_workspace_server_name_collision');
        mcpServers['trylo-software'] = { command: process.execPath,
          args: [hostEntrypoint, '--software-workspace-mcp', connection.gate], env: {} };
        packageHealth.push({ id: 'software-workspace', classifierId: 'software-workspace', displayName: '软件工作区',
          version: SOFTWARE_VERSION, adoption: 'stable', serverName: 'trylo-software', state: 'installed',
          available: true, active: true, builtIn: true, runtimeIdentity: `software-workspace@${SOFTWARE_VERSION}`,
          detail: 'Conversation-owned background software', expectedTools: [...SOFTWARE_NAMES], protocol: 'not-checked', checkedAt: now() });
      } catch (error) {
        // No foreground fallback after a placement failure.
        for (const id of ['solidworks-mcp', 'autocad-mcp']) if (preparedPackages.has(id)) delete mcpServers[catalog.get(id)?.mcp.serverName];
        unavailableCapabilities.push({ id: 'software-workspace', type: 'adapter', reasonCode: 'software_workspace_unavailable',
          detail: String(error.message ?? error), userMessage: '软件工作区连接失败，请检查工具服务后重试。' });
      }
    }

    // The host-owned preview has no package installation lifecycle.
    if (modelPreview && projectRoot && conversationId) {
      try {
        if (mcpServers['trylo-preview']) throw new Error('model_preview_server_name_collision');
        const connection = await modelPreview.configure({ projectRoot, conversationId });
        mcpServers['trylo-preview'] = { command: process.execPath,
          args: [hostEntrypoint, '--model-preview-mcp', connection.gate], env: {} };
        packageHealth.push({ id: 'model-preview', classifierId: 'model-preview', displayName: '3D 模型预览',
          version: MODEL_PREVIEW_VERSION, adoption: 'stable', serverName: 'trylo-preview', state: 'installed',
          available: true, active: true, builtIn: true, runtimeIdentity: `model-preview@${MODEL_PREVIEW_VERSION}`,
          detail: 'Built into the Service Host', autoUpdate: false, expectedTools: [...MODEL_PREVIEW_NAMES],
          protocol: 'not-checked', checkedAt: now(), reportedVersion: MODEL_PREVIEW_VERSION, versionMatches: true });
      } catch (error) {
        unavailableCapabilities.push({ id: 'model-preview', type: 'adapter', reasonCode: 'model_preview_unavailable',
          detail: String(error.message ?? error), userMessage: '3D 预览暂时无法连接，其他工具仍可继续使用。' });
      }
    }

    // 3. Materialise the two config files (content-addressed, stable).
    const mcpConfig = { mcpServers };
    const mcpContents = `${stableStringify(mcpConfig)}\n`;

    // §6.1: every audited external server is `ask` — even the ones not in
    // this Profile, so a future composition bug still lands on the host
    // classifier instead of running unseen. `ask` fires before
    // bypassPermissions in the CLI (verified: permissions.ts step 1b
    // precedes step 2a), so this is bypass-immune.
    const askRules = catalog.list().map((m) => `mcp__${m.mcp.serverName}__*`);
    if (modelPreview) askRules.push('mcp__trylo-preview__*');
    if (softwareWorkspace && computerUse) askRules.push('mcp__trylo-software__*');
    const settingsContents = `${stableStringify({
      permissions: { ask: askRules, deny: [] },
    })}\n`;

    let mcpConfigPath = null;
    let mcpConfigHash = '';
    let permissionSettingsPath = null;
    let permissionSettingsHash = '';
    let nativeRegistryPath = null;

    try {
      const writtenMcp = await writeContentAddressed(profilesRoot, 'mcp.json', mcpContents);
      const writtenSettings = await writeContentAddressed(profilesRoot, 'settings.json', settingsContents);
      const servers = Object.entries(mcpServers).map(([name, server]) => {
        const transport = server.type ?? (server.url ? 'http' : 'stdio');
        if (!['stdio', 'http', 'sse'].includes(transport)) throw new Error(`unsupported MCP transport for ${name}`);
        return transport === 'stdio' ? { name, transport, command: server.command, args: server.args ?? [], env: server.env ?? {}, enabled: true }
          : { name, transport, url: server.url,
            ...(Object.keys(server.headers ?? {}).length ? { headers: server.headers } : {}), enabled: true };
      });
      const checksum = crypto.createHash('sha256').update(stableStringify(servers)).digest('hex');
      const registry = await writeContentAddressed(profilesRoot, 'mcp-registry.json', `${stableStringify({ formatVersion: 1, checksum, servers })}\n`);
      nativeRegistryPath = registry.path;
      mcpConfigPath = writtenMcp.path;
      mcpConfigHash = writtenMcp.hash;
      permissionSettingsPath = writtenSettings.path;
      permissionSettingsHash = writtenSettings.hash;
    } catch (error) {
      return {
        ok: false,
        reasonCode: 'config_write_failed',
        error: `could not materialise the tool profile config: ${error?.message ?? error}`,
      };
    }

    // 4. CLI argv. Empty when the Profile carries no server, so a plain run
    //    keeps today's argv exactly (§12.3: no gratuitous CLI surface).
    const hasServers = Object.keys(mcpServers).length > 0;
    const cliArgs = hasServers
      ? [
          '--mcp-config',
          mcpConfigPath,
          '--settings',
          permissionSettingsPath,
          ...(profile.strictMcpConfig ? ['--strict-mcp-config'] : []),
        ]
      : [];

    if (hermesPart.warning) {
      unavailableCapabilities.push({
        id: 'hermes',
        type: 'adapter',
        reasonCode: 'hermes_unavailable',
        detail: hermesPart.warning,
        userMessage: 'Hermes 学习能力不可用（不影响对话）',
      });
    }

    return {
      ok: true,
      profileId: profile.id,
      profileRevision: profile.revision,
      surface,
      mcpConfigPath,
      mcpConfigHash,
      permissionSettingsPath,
      permissionSettingsHash,
      cliArgs,
      spawnEnv: Object.freeze({ TRYLO_TEAM_SURFACE: surface, TRYLO_MCP_RUNTIME_REGISTRY: nativeRegistryPath,
        TRYLO_MCP_RUNTIME_MODE: profile.strictMcpConfig ? 'exclusive' : 'overlay' }),
      serverNames: Object.keys(mcpServers),
      packageHealth,
      unavailableCapabilities,
      strictMcpConfig: profile.strictMcpConfig,
      resolvedAt: now(),
    };
  }

  return {
    resolve,
    profiles: TOOL_PROFILES,
    profilesRoot,
    // Exported for tests + diagnostics; the renderer never needs it.
    stableStringify,
  };
}

export default createToolProfileService;
