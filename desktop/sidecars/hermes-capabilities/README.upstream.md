# hermes-capabilities — upstream provenance

This directory is a **thin adapter**. It does **not** contain a re-implemented
learning/memory/skill/FTS engine. All capability logic is reused directly from
the official Hermes Agent package by importing it at runtime.

## Upstream source

- **Project:** Hermes Agent — NousResearch
- **Repository:** https://github.com/NousResearch/hermes-agent
- **PyPI:** https://pypi.org/project/hermes-agent/
- **License:** MIT (any vendored source must preserve the LICENSE and this notice)
- **Pinned version:** `hermes-agent[mcp]==0.19.0` (see `requirements.lock`)
- **Audited release commit:** `3ef6bbd201263d354fd83ec55b3c306ded2eb72a`

The pinned package is **not** vendored into this repository. It is expected to
be installed in a Python environment that the adapter launches (currently the
`uv` tool environment `hermes-agent`; see `hermes-capability-manager.js`). If it
is absent, the adapter fails to start and Trylo's original agent continues
without these capabilities — no data is lost and no second runtime is created.

## Reused upstream symbols

Imported in `upstream.py`, called directly from `server.py` / `session_adapter.py`
/ `admin.py`. None of these are re-implemented.

| Symbol | Upstream module | Used for |
| --- | --- | --- |
| `MemoryStore` | `tools.memory_tool` | load + frozen snapshot for prompt injection |
| `memory_tool` | `tools.memory_tool` | staged memory proposals (write-approval gate) |
| `apply_memory_pending` | `tools.memory_tool` | replay an approved pending memory write |
| `scan_for_threats`, `first_threat_message` | `tools.threat_patterns` | injection/exfil scan of memory + context |
| `scan_skill`, `should_allow_install`, `full_content_hash` | `tools.skills_guard` | skill structure/security scan |
| `skills_list`, `skill_view` | `tools.skills_tool` | skill discovery + read |
| `skill_manage`, `apply_skill_pending` | `tools.skill_manager_tool` | staged skill proposals + replay |
| `session_search` | `tools.session_search_tool` | FTS5/CJK session recall |
| `write_approval` (`stage_write`, `list_pending`, `get_pending`, `discard_pending`) | `tools.write_approval` | pending store + approval semantics |
| `SessionDB` | `hermes_state` | SQLite session store, FTS5, CJK, schema, locks |
| `build_learn_prompt` | `agent.learn_prompt` | official `/learn` authoring standard |
| `build_learning_graph` | `agent.learning_graph` | Journey graph and safe Skill metadata |
| `load_usage`, `usage_report`, `provenance`, `set_pinned` | `tools.skill_usage` | Skill usage/lineage signals |
| `snapshot_skills`, `list_backups`, `rollback` | `agent.curator_backup` | Skill backup and rollback |

`hermes_state.py` is ~7,000 lines. Reusing it via import is exactly why this
adapter exists instead of a JavaScript port.

## Data directory

All Hermes-owned files live under a Trylo-managed directory pointed to by the
`HERMES_HOME` environment variable (set by `hermes-capability-manager.js` to
`<Tauri app_data_dir>/Trylo/hermes-capabilities/v1`). The old VS Code location
is only an import source; Desktop never runs against it in place. Trylo never parses or
modifies these files directly; their format is owned entirely by Hermes.

```
hermes-capabilities/v1/
├── config.yaml          # write_approval flags (Trylo writes, Hermes reads)
├── state.db             # SessionDB (SQLite + FTS5) — rebuilt from Trylo JSON
├── memories/            # MEMORY.md, USER.md
├── skills/              # one dir per skill, each with SKILL.md
└── pending/             # staged memory/skill writes awaiting approval
    ├── memory/<id>.json
    └── skills/<id>.json
```

## Files in this directory

| File | Role |
| --- | --- |
| `upstream.py` | Unified import, version check, JSON error helpers. The only place that knows the Hermes API surface. |
| `server.py` | FastMCP server; registers thin MCP tools. No business logic. |
| `session_adapter.py` | Trylo session -> Hermes `SessionDB` field mapping (Phase 3). |
| `skills_adapter.py` | Thin skills list/view adapter over upstream tools. |
| `admin.py` | Memory/Skill pending list/detail/apply/discard for the Trylo approval UI (Phase 3B). |

## Desktop runtime boundaries

- Normal Code runs may degrade when Hermes is unavailable.
- Learning/history runs fail closed when their Hermes MCP profile is unavailable.
- Learning runs start in a disposable temporary working directory, never the user's project directory.
- Memory and Skill writes remain staged; apply requires the reviewed subsystem, pending id, and expected content hash.
