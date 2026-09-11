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
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';

/** Placeholder expanded per-run in a manifest's argv (spec §10.2). */
const RUNTIME_DIR_TOKEN = '{runtimeDir}';

/** CAD/EDA: placeholder expanded to a package's install directory — how a
 *  source-run pinned-pypi-env manifest points its venv python at the pinned
 *  source entry script (TRYLO-CAD-EDA-TOOL-ADAPTER §6.2). */
const INSTALL_DIR_TOKEN = '{installDir}';

/**
 * The stable Profiles (§4.1). `revision` changes whenever the
 * composition changes, so a stale warm runtime can never be reused.
 */
export const TOOL_PROFILES = Object.freeze({
  'code.core.v1': Object.freeze({
    id: 'code.core.v1',
    revision: '1',
    surface: 'code',
    hermesProfile: 'normal',
    packageIds: Object.freeze([]),
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
    packageIds: Object.freeze(['officecli', 'playwright', 'windows-mcp']),
    strictMcpConfig: true,
  }),

  'work.browser-debug.v1': Object.freeze({
    id: 'work.browser-debug.v1',
    revision: '1',
    surface: 'work',
    hermesProfile: 'normal',
    // §4.1: Playwright is REPLACED by Chrome DevTools MCP here — never
    // both at once. Enabling this profile with chrome-devtools missing
    // (not installed) degrades to a reported unavailable capability.
    packageIds: Object.freeze(['officecli', 'chrome-devtools']),
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
    revision: '3',
    surface: 'work',
    hermesProfile: 'normal',
    packageIds: Object.freeze([
      'solidworks-mcp',
      'autocad-mcp',
      'kicad-mcp',
      'jlceda-mcp',
      'freecad-mcp',
      'blender-mcp',
      'windows-mcp',
      'officecli',
    ]),
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
  const packages = options.packages;
  const health = options.health;
  const hermes = options.hermes ?? null; // { mcpArgs({profile}) } — Hermes Adapter
  const storageRoot = options.storageRoot ?? '';
  const now = options.now ?? (() => Date.now());

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
      const tmp = `${target}.${process.pid}.tmp`;
      await fsp.writeFile(tmp, contents, 'utf8');
      await fsp.rename(tmp, target);
    }
    return { path: target, hash };
  }

  /**
   * Compose one Profile into a ResolvedToolRuntime.
   *
   * @param {{ surface?: 'code'|'work', requestedProfileId?: string,
   *           projectKey?: string, projectRoot?: string,
   *           conversationId?: string }} params
   */
  async function resolve(params = {}) {
    const surface = params.surface === 'work' ? 'work' : 'code';
    const requested = String(params.requestedProfileId ?? '').trim();
    const profileId = requested || DEFAULT_PROFILE_BY_SURFACE[surface];
    const profile = TOOL_PROFILES[profileId];

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
    const packageHealth = [];
    const unavailableCapabilities = [];
    const runtimeDirs = [];

    for (const id of profile.packageIds) {
      const manifest = catalog.get(id);
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
          reasonCode: record.state === 'version-mismatch' ? 'version_mismatch' : 'not_installed',
          detail: record.detail,
          userMessage: `${manifest.displayName}（${manifest.version}）不可用：${record.detail}`,
        });
        continue;
      }

      const installed = await packages.resolve(manifest);
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
      const { expanded, dirs } = expandArgs([...manifest.mcp.args], runtimeDir, installed.installDir);
      runtimeDirs.push(...dirs);

      // Never let two manifests claim one server name — the catalog
      // guarantees uniqueness, but a late collision must not silently
      // overwrite Hermes or another package.
      if (mcpServers[manifest.mcp.serverName]) {
        unavailableCapabilities.push({
          id,
          type: 'package',
          reasonCode: 'server_name_collision',
          userMessage: `${manifest.displayName} 的 MCP server 名冲突，已跳过`,
        });
        continue;
      }

      // §8.2: a `runner: 'node'` package's entry is a .js script — the
      // command is the Node runtime the Service Host itself runs under,
      // and the entry path is the first argv (never `npx`).
      if (manifest.artifact.runner === 'node') {
        mcpServers[manifest.mcp.serverName] = {
          command: process.execPath,
          args: [installed.executable, ...expanded, ...originArgs],
          env: { ...manifest.mcp.env },
        };
      } else {
        mcpServers[manifest.mcp.serverName] = {
          command: installed.executable,
          args: [...expanded, ...originArgs],
          env: { ...manifest.mcp.env },
        };
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
    const settingsContents = `${stableStringify({
      permissions: { ask: askRules, deny: [] },
    })}\n`;

    let mcpConfigPath = null;
    let mcpConfigHash = '';
    let permissionSettingsPath = null;
    let permissionSettingsHash = '';

    try {
      for (const dir of runtimeDirs) {
        await fsp.mkdir(dir, { recursive: true });
      }
      const writtenMcp = await writeContentAddressed(profilesRoot, 'mcp.json', mcpContents);
      const writtenSettings = await writeContentAddressed(profilesRoot, 'settings.json', settingsContents);
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
      spawnEnv: Object.freeze({ TRYLO_TEAM_SURFACE: surface }),
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
