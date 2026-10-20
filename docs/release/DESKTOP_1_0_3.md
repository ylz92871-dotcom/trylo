# Desktop 1.0.3 dual-runtime preview

The Windows core distribution defaults to the bundled legacy compatibility CLI.
Settings can switch to the bundled new `trylo-v1` CLI and back. Both use the fixed
Node 24.14.1 interpreter. CoWork remains a separate experimental dependency and
is excluded from core. Android 1.6.0 remains a separate APK asset.

## Repairs

- Desktop-approved new-CLI shell commands explicitly use the host process
  boundary instead of unconditionally requiring a second Windows SRT account.
  Permission checks still precede dispatch; read-only rejects writes and commands.
  Standalone CLI retains its original sandbox default with no fallback on error.
- Contained absolute shell cwd paths use the same realpath/link containment
  checks as their relative equivalents.
- Legacy read-only retains Read/Glob/Grep. Desktop bare startup retains the
  complete permission-gated catalog instead of silently removing core tools.
- Portable startup prepares every bundled executable, including nested PTY,
  SRT and search helpers, without following links or requesting elevation.
- Legacy search uses a bundled, fixed ripgrep 15.2.0 with upstream notices,
  resolved relative to the actual entry instead of a build-machine path.
- Desktop typechecking no longer emits test JavaScript into production dist.
- Both runners use the same fixed-Node/path formatter, including Windows
  verbatim drive and UNC prefixes returned by native resource resolution.

## Evidence boundaries

CLI verify passed all 11 steps with 4,209 hermetic test names and 38 contract
checks. Desktop mode, registry, runner, settings and protocol checks passed 183
tests; tool classifiers passed 209 and runtime health checks passed 19.
Real subprocess tests verify shell writes, MCP approval/denial effects and five
legacy read/write/search scenarios against local synthetic provider services.
Native input to arbitrary user applications, installer GUI behavior, real-model
reliability and Android device behavior are separate acceptance boundaries.

Immediate EOF after a legacy result can still produce a native libuv shutdown
assertion in the compatibility runtime. The original negative and a current
reproduction are retained; this boundary is not claimed fixed. Desktop keeps
legacy stdin open between turns; its engine-switching lifecycle is separately
verified. The legacy fixture drains terminal output before closing input and
checks process exit separately.

## Build inputs

Production defaults are recorded in desktop/.env.production and distribution.json.
Building the compatibility component requires TRYLO_LEGACY_RUNTIME_DIR pointing
to its inventoried artifact. Old CLI source is excluded from this public repository;
the new CLI source and build pipeline are included. Published metadata records
artifact hashes, component inventories and automated verification boundaries.

The ripgrep official archive SHA-256 is
71b2fef860abe467217a538ff31de02f5258807c0129f771846f87bd029aafc5;
its Windows x64 executable SHA-256 is
14231169855ec5205cf5a1b6f1db358ff4aed4247c86b69ce8aae647c77f6680.
