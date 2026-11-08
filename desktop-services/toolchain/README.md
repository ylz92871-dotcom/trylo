# Desktop Services toolchain

The local tool registry and maintained tool inputs belong to Desktop Services.

The user-approved 2026-11-08 built-in delivery contract supersedes the relocation-only boundary below for the four core tools. See `../../docs/development/2026-11-08-builtin-tools-and-attachment-send.md`. OfficeCLI is compiled from this maintained source with `TRYLO_BUNDLED`; its previously produced `_dist-trylo` executable is not a release input.

- `tool-sources.json` declares paths relative to this directory. Entries must stay inside it; moving the registry does not relax that boundary.
- `office/OfficeCLI/`, `browser/playwright-mcp/` and `browser/chrome-devtools-mcp/` supply the existing repository-local entries.
- `computer-control/Windows-MCP/` supplies the maintained fork, pinned WGC helper build, provenance and license inputs. Its `managed-local` registry policy keeps the product's managed Python environment separate from this checkout's `.venv`.
- Tool checkouts retain their original repositories, local modifications and installed environments. They remain local inputs under the existing ignore policy; relocation does not authorize new public source or binary distribution.
- The linked `OfficeCLI-pptx` worktree and research-only tool references live under `_workspace/research/tool-references/`. OfficeCLI's Git worktree metadata points to that location.

The 2026-11-07 relocation changed ownership and path resolution only. It did not update, rebuild, download or install tools. Source snapshots and migration verification are recorded in `_workspace/tasks/workspace-layout-20261107/` at the repository root. The preserved checkout `.venv` is not claimed to be generally relocatable; existing synthetic-test readers use its new Python executable location, while production keeps its managed environment.
