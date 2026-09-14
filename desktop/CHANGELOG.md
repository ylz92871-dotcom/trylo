# Changelog

All notable changes to Trylo Desktop are recorded here. Format:
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
Versions follow [SemVer](https://semver.org/).

## [Unreleased]

### Added — Phase 2 (Trylo Alpha, day 1, 2026-08-18)

- **HostAdapter trylo extension.** New `acquireTryloApi()` surface for the
  legacy 4-mode webview running in an iframe. 10 message types implemented
  (init, createSession, switchSession, deleteSession, getSessions,
  modeChanged, setPermissionMode, testConnection, clearApiKey,
  clearVisionApiKey). See
  `desktop/src/host-adapter/trylo-{api,message-types,context}.ts`.
- **iframe mount + shim.** `<TryloFrame>` React component installs
  `window.acquireTryloApi` on the iframe's window and listens for inbound
  `postMessage` events. The iframe-side `trylo-iframe-shim.ts` provides
  the legacy `acquireVsCodeApi()`-compatible `vscode` global that
  delegates to `acquireTryloApi()`. See
  `desktop/src/components/legacy-4mode/`.
- **Tauri sidecar process bridge.** Four new Rust commands
  (`process_spawn`, `process_send`, `process_stop`, `process_list`) and a
  matching TS `ProcessService` interface. Each spawned process gets a
  Tauri `Channel<String>` for stdout and a writer half for stdin.
  Pattern follows the existing `lsp_*` commands. See
  `desktop/src-tauri/src/commands/process_*.rs` and
  `desktop/src/host-adapter/tauri-process-service.ts`.
- **Trylo Core stub.** A Node.js script at `runtime/trylo-core/index.js`
  that reads line-delimited JSON from stdin and writes line-delimited
  JSON to stdout. Echoes prompts as `agentDelta` + `agentDone`. The
  real CC CLI integration is Phase 3.
- **Project State pub/sub.** New `useProjectState` hook that owns a
  single `WorkspaceWatcher` subscription and exposes a `subscribe`
  function. Components react to file changes via this bus instead of
  holding their own watcher. See
  `desktop/src/state/use-project-state.ts`.
- **App UI.** New "Show Trylo" / "Hide Trylo" button in the header
  opens a right-side drawer (420px) that mounts the iframe.
- **Tests.** 25 new unit tests (15 trylo-message-types + 3 iframe shim
  + 4 process service + 3 project state). 54 total, all passing.
  `cargo check` clean. `vite build` clean.

### Changed

- `App.tsx` now imports `TryloFrame` and `createTryloContext` from the
  host-adapter. The header gains a Trylo toggle button next to Settings.
- `host-adapter/index.ts` exports new types and adds
  `process: tauriProcessService` to the `hostAdapter` object.

### Fixed

- `main.tsx` now imports `./App` (proper case) instead of `./app`. The
  pre-existing case mismatch worked at runtime on Windows but tripped
  the TypeScript include-pattern check. Trivial fix.

### Notes

- The legacy 4-mode webview is NOT yet vendored under
  `desktop/public/legacy-4mode/`. The current `index.html` is a Phase 2
  stub. A build-time `scripts/sync-legacy-4mode.mjs` (future commit)
  will copy the 14,934 lines from the source of truth.
- The 6 message types implemented today are the "simple" first batch
  per arch doc §3 Phase 2 task #8. The complex types
  (sendPrompt, skills, office, fun, review) ship in Phase 2 weeks 2-3.
- Trylo Core is a stub. Real LLM integration via CC CLI is Phase 3.

## [1.0.0] — 2026-08-18 (Phase 1 closeout, baseline)

Phase 1 (Desktop Alpha) was the original milestone. It shipped:

- Tauri 2 + React 18 + Monaco editor
- File tree, tabs, status bar, integrated terminal (xterm + portable-pty)
- Search service (ripgrep) with regex/case toggles
- Diff view (Monaco `createDiffEditor`)
- Git-status changes panel
- LSP Manager with 5 languages (TS, Python, C/C++, Rust, Go)
- Settings UI + theming (auto/light/dark + Monaco theme sync)
- Windows NSIS MSI installer (`Trylo_1.0.0_x64_en-US.msi`, 10.7 MB)
- 29 unit tests, all passing

See `desktop/spike-results/MIGRATION_SUMMARY.md` for the full
post-Phase-1 closeout, and `docs/ARCHITECTURE.md` §3 for the plan
that produced it.
