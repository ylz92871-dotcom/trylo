# Trylo Desktop

Tauri 2 shell + Trylo React app + monaco-vscode-api. Long-term home for the Trylo agent system.

**The full technical plan lives in `C:/work/demo-ws/docs/ARCHITECTURE.md`.** Read that first. This README only covers the local dev loop.

## Stack

- **Tauri 2** — desktop shell (Rust + system webview)
- **React 18** — UI
- **TypeScript** — strict, see `tsconfig.json`
- **monaco-vscode-api** — VS Code services without the Workbench UI
- **monaco-editor** — the editor itself
- **Vite** — bundler/dev server
- **portable-pty** (Rust) — terminal
- **notify** (Rust) — file watcher

## Prerequisites

- Node.js ≥ 22
- Rust toolchain (install via `rustup` from https://rustup.rs)
- Tauri 2 system dependencies:
  - **Windows**: WebView2 (usually pre-installed on Windows 10/11)
  - **macOS**: Xcode Command Line Tools (`xcode-select --install`)
  - **Linux**: `libwebkit2gtk-4.1-dev`, `libssl-dev`, `libgtk-3-dev`, `librsvg2-dev`

## Local dev

```bash
# 1. Install JS deps
yarn install

# 2. Run the Tauri dev shell (opens the desktop app with hot-reload)
yarn tauri:dev
```

The first build is slow (Rust compiles the Tauri shell). Subsequent rebuilds are fast.

## Build a production binary

```bash
yarn tauri:build
```

Outputs:
- `src-tauri/target/release/trylo-desktop.exe` (Windows)
- `src-tauri/target/release/bundle/dmg/*.dmg` (macOS)
- `src-tauri/target/release/bundle/appimage/*.AppImage` (Linux)
- `src-tauri/target/release/bundle/deb/*.deb` (Linux)

## Project layout

See `docs/ARCHITECTURE.md` §9. One-sentence version:

```
src/         — Trylo React app (UI + HostAdapter + state)
src-tauri/   — Rust shell (commands, channels, PTY, watcher)
spike-results/ — Phase 0 spike output
config/      — shared lint/format/typecheck config
```

## Code quality

See `docs/ARCHITECTURE.md` §10 for the full standards. Quick rules:

- TypeScript strict mode, no `any`
- `cargo clippy -- -D warnings` must pass
- One file per concept, < 300 lines preferred
- Comments explain WHY, not WHAT
- Tests for `host-adapter/` and Rust `commands/`

## Spike

Phase 0 is a 1-week spike (see `docs/ARCHITECTURE.md` §3 Phase 0 and `spike-results/`). Strict GO criteria; we stop if any fail.

## License

Apache-2.0 (TBD — see `docs/ARCHITECTURE.md` §12).
