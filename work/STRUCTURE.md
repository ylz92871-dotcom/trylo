# Structure — what's in here now, what comes next

This file tracks the fork progress so anyone landing in `trylo/work/` knows what's stub vs real.

## Phase 0 (DONE) — stub daemon + Tauri spawn

Goal: prove Tauri can spawn `trylo-workd` and the Tauri renderer can talk to it over HTTP.

| Path | Status | Notes |
|---|---|---|
| `package.json` | real | `@trylo/work`, type module, bin `trylo-workd` |
| `bin/trylo-workd.mjs` | real | Two modes via `TRYLO_WORKD_MODE` env var. `stub` (default) is an in-process HTTP server with 3 endpoints. `real` shells to vendor coworkd-node.js. |
| `src/daemon/`, `src/control-plane/`, `src/renderer/`, `src/shared/`, `src/host-adapter/` | empty | Will hold the Trylo wrapper layer over the vendor |
| `vendor/cowork-os/` | partial | See Phase 1 below |
| `tests/` | empty | vitest specs when there's logic to test |

Verified:
- `node bin/trylo-workd.mjs` → /health returns 200
- Tauri Rust: `cargo check` clean, `workd_spawn` / `workd_stop` / `workd_status` registered

## Phase 1 (DONE, install deferred) — coworker vendor + real-daemon wiring

Goal: replace the stub with the real CoWork-OS `coworkd` so the Control Plane can actually run an agent and generate artifacts.

| Path | Status | Notes |
|---|---|---|
| `vendor/cowork-os/src/` | copied (1498 .ts files, 34MB) | Full CoWork-OS source tree, unmodified. Includes `src/daemon/`, `src/electron/`, `src/cli/`, `src/shared/`. **Excludes** `src/renderer/` (Phase 2) |
| `vendor/cowork-os/bin/` | copied | coworkd.js (Electron entry), coworkd-node.js (Node entry), cowork-cli.js, coworkctl.js, cowork.js |
| `vendor/cowork-os/LICENSE` | copied | MIT, required for redistribution |
| `vendor/cowork-os/tsconfig.{daemon,cli,electron,node}.json` | copied | Original build configs |
| `vendor/cowork-os/package.json` | **fork-patched** | Original 52 deps + 24 devDeps + scripts. **One change**: removed the `libsignal` GitHub tarball override (see "Install notes" below) |
| `vendor/cowork-os/.npmrc` | **fork-added** | `block-exotic-subdeps=false` and registry pinned to `registry.npmmirror.com` (more reliable from this host). See "Install notes". |
| `vendor/cowork-os/node_modules/` | **not installed** | See "Install notes" |
| `bin/trylo-workd.mjs` | real | Now chooses `stub` vs `real` mode; real shells to `vendor/cowork-os/bin/coworkd-node.js` |
| Tauri `workd_spawn` | real | Accepts `mode` parameter (`"stub"` \| `"real"`), defaults to `stub` for safety |

### Install notes (deferred — blocked on network and Visual Studio Build Tools)

**Why the vendor isn't `pnpm install`ed yet** (verified empirically, not from docs):

1. **Network is flaky to both `registry.npmjs.org` and `registry.npmmirror.com`** from this host. Many tarball fetches fail with `UND_ERR_DESTROYED` mid-flight, even after retries. The dep tree is large (Cowork pulls in AWS SDK, Playwright, OpenAI, Anthropic SDK, MS Bot Framework, etc.) so a single retry pass takes 5+ minutes.

2. **Visual Studio Build Tools is not installed.** `better-sqlite3` is a native module that needs `cl.exe` to compile on Windows. Without it, `npm rebuild better-sqlite3` fails. Cowork's own `coworkd-node.js` shim tries to rebuild it automatically and exits with an error if that fails.

3. **Cowork's `package.json` has an `overrides` entry that pins `libsignal` to a GitHub tarball URL** (used by `baileys` for WhatsApp channel support). pnpm 11+ rejects this as an "exotic subdependency" by default. We removed that one override line — `libsignal` now resolves to the deprecated-but-present `libsignal-node@2.0.1` from npm. We don't use WhatsApp channels in Trylo, so this is fine for the runtime.

**How to flip the switch to real mode (one-time, when ready):**

```bash
# 1. Install Visual Studio Build Tools (Windows only):
#    https://visualstudio.microsoft.com/visual-cpp-build-tools/
#    At minimum: "Desktop development with C++"

# 2. From the vendor dir:
cd C:/work/demo-ws/work/vendor/cowork-os
pnpm install --prod --ignore-scripts --no-optional
npm rebuild better-sqlite3

# 3. First real-mode spawn (slow — builds dist/daemon/daemon/main.js):
node bin/coworkd-node.js --headless --enable-control-plane --import-env-settings

# 4. Or, from Trylo's renderer:
await invoke('workd_spawn', { mode: 'real', port: 47821, host: '127.0.0.1' });
```

The first real-mode spawn runs `tsc -p tsconfig.daemon.json` to build `dist/daemon/daemon/main.js` (one-time, ~5 min on this codebase). Subsequent runs are fast.

**What we cut from cowork's runtime (when we cut):**
- `src/electron/main.ts` — Electron main entry (we don't run Electron)
- `src/electron/preload.ts` — Electron preload (we don't run Electron)
- `src/electron/tray/`, `src/electron/updater/` — Electron-specific surfaces
- `src/electron/automation/`, `src/electron/mission-control/`, `src/electron/teams/` — we said these are out (per `../desktop/spike-results/work-mode-handoff/`)
- `src/electron/subconscious/`, `src/electron/awareness/`, `src/electron/chronicle/`, `src/electron/briefing/` — same
- `baileys` (WhatsApp) and its dep chain — implicit via the override removal

These are kept in the vendor for now because the daemon's import graph may reference them. We cut in Phase 1.5 once we know the import closure (we can use `madge` or `tsc --noEmit` with import tracking).

## Phase 2 (next) — renderer port + Trylo token theme

Goal: the Tauri webview can render the Work surface (artifact cards, viewers, follow-up input). Doesn't require real-mode daemon — works against the stub for dev.

1. Copy cowork's `src/renderer/components/{Document,Presentation,Spreadsheet,Web}Artifact*.tsx` into `src/renderer/`
2. Copy `RightPanel.tsx`, slice to keep only the artifact 4-tab branch
3. Write `src/renderer/Theme.tsx` that imports Trylo's `tokens.css` and exposes them as CSS variables to the ported components
4. Replace `ipcRenderer.invoke(...)` calls with `WorkHostAdapter.workInvoke(...)` (Tauri command → fetch → Control Plane)
5. Wire the Work sub-app into Trylo's `TopBar` mode switch (already wired in `AppShell.tsx` — just need to swap the Work panel from `OfficePanel` to `<WorkSubApp />`)
6. Workspace sharing: pass `Workspace.root` from `state/project-state.ts` to coworkd via `--bootstrap-workspace` (env `COWORK_BOOTSTRAP_WORKSPACE_PATH`)

## Phase 3 (later) — Files tab + Browser tab

Tracked for completeness. Phase 0-2 don't touch this.
