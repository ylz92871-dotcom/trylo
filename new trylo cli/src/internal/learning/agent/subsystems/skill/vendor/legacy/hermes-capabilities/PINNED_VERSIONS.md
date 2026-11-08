# PINNED_VERSIONS — 依赖固定

> 文档角色：L7-A (依 `L7_EXECUTION_TASK.md` §4.1)。生产环境使用的上游版本/路径**单一来源**。启动校验、迁移、升级探针都引用本文件。
> 校验：L7 启动期 `smoke-upstream-contract.js` 必须读这份文件并对比 `UPSTREAM_SYMBOLS.json`。
> 修改纪律：版本变更必须先建新分支 → 临时 venv 安装 → 跑全量探针 → 全绿才能切。

---

## 1. Hermes Python 包

| 字段 | 值 | 校验 |
| --- | --- | --- |
| hermes_version | `0.19.0` (严格匹配) | `upstream.require_version()` 必须返回 `success=true` 且 `version=0.19.0` |
| install_method | `uv tool install hermes-agent` | `hermes --version` 输出 `Hermes Agent v0.19.0` |
| 安装方式 | `uv tool install hermes-agent` | `hermes --version` 输出 `Hermes Agent v0.19.0` |
| 安装目录 | `%APPDATA%\uv\tools\hermes-agent` (Windows) / `~/.local/share/uv/tools/hermes-agent` (Linux/macOS) | `hermes-agent` 包路径存在 |
| Python | 3.11.x (3.11.15 已验) | `python --version` 必须 ≥ 3.11 |

## 2. Hermes JS / TS 包

| 项 | 值 | 校验 |
| --- | --- | --- |
| `ws` | `8.21.0` (override 锁) | `package.json.overrides.ws` |
| `pptxgenjs` | `^0.10.0` | package.json |
| `exceljs` | `^4.4.0` | package.json |
| `docx` | `^9.7.1` | package.json |
| `qrcode` | `^1.5.4` | package.json |
| `edge-tts` | `^1.0.1` | package.json |
| `jszip` | `^3.10.1` | package.json |

> 上表为 transitive risk（`ws` 的漏洞 CVE-2024-37890 等已知会触发；其余是稳定大版本）。运行时实际依赖路径在 `package.json`。

## 3. VS Code 引擎

| 项 | 值 | 校验 |
| --- | --- | --- |
| VS Code engine | `^1.85.0` | `engines.vscode` |
| Node | ≥ 18.x | Node 实际运行版本 |

## 4. 启动期符号校验

启动期 `smoke-upstream-contract.js` 必须验证（不验证 = 启动失败）：

| 符号 | 模块 | 校验 |
| --- | --- | --- |
| `MemoryStore` | `upstream` | `upstream.MemoryStore` 是 class |
| `ok` | `upstream` | callable |
| `err` | `upstream` | callable |
| `require_version` | `upstream` | callable 且返回 dict with `success` |
| `load_on_disk_store` | `upstream` | callable |
| `format_for_system_prompt` | `MemoryStore` | method, returns str |
| `get_session` | `SessionDB` | method, returns dict with `cwd` |
| `set_session_title` | `SessionDB` | method |
| `search_sessions` | `history_adapter` | callable, returns list |
| `build_summary` | `curation_adapter` | callable, returns dict with `safe_nodes` |
| `safe_nodes` 形状 | `curation_adapter` 内部 | array of `{id, label, kind}` |
| `scan_skill` | `curation_adapter` | callable |
| `usage_report` | `curation_adapter` | callable, returns dict |

## 5. 升级流程（依 L7 §4.2）

```text
1. 切到新分支 + 临时 venv 安装候选 Hermes
   uv tool install --with hermes-agent==<新版本>  # 不动生产 uv env
2. 修改 PINNED_VERSIONS.md 第 1 节版本号（草稿）
3. python tools/collect-upstream-symbols.js --target <venv-python>
   → 输出 UPSTREAM_SYMBOLS.json 草稿
4. 跑 smoke-upstream-contract.js：
   - 草稿 PINNED 还不切；用 --expected=<新版本> 参数让探针跑在新版本上
   - 全绿：进入 5
   - 任一红：保留旧版本，上报 Codex
5. 出差异报告（被改名的符号 / DTO 字段变化）
6. 改 adapter 薄适配
7. 全量回归：l3i / l3c / l4 / l5 / l6 / l0-v3 / upstream-contract / install-recovery
8. 全绿后：把 PINNED_VERSIONS.md 草稿提交，触发旧 env 保留一个版本周期
9. 旧 env 清理：uv tool uninstall hermes-agent@<旧版本>  # N 版本保留策略
```

## 6. 私有符号风险登记（须 Codex 批准替代方案）

| 私有符号 | 风险 | 替代方案 (Codex 决策) |
| --- | --- | --- |
| `_SKILL_REVIEW_PROMPT` (Hermes 内部) | 升级时改名/删字段 | TBD: 走官方 prompt builder 公开 API；或 vendor 此 prompt |
| `agent.background_review` 内部结构 | 升级时字段名变化 | TBD: 走 L0 自己的 trigger-policy (已有) |

> 任何 §4.2 升级流程走到第 5 步发现此处变更，**必须停手等 Codex**。

## 7. Trylo L0 接线补丁登记（vendor 刷新时按 patch 块回填）

升级上游时**禁止直接覆盖**这些 Trylo 改动；改动都用 `TRYLO-L0-PATCH(...)` 注释块包裹，升级后照此回填：

| 被改文件 | 上游版本 | Trylo patch 摘要 | 备注 |
| --- | --- | --- | --- |
| `vendor/legacy/learning-loop/evidence-builder.js` | 0.19.0 学习栈 | `EVENT_CATEGORY_ALLOWLIST` 增 `office`/`browser`/`desktop`（spec §2.5） | 存量，git 跟踪，走正常 PR |
| `sidecars/hermes-capabilities/learning_prompt_adapter.py` | 0.19.0 | `TRYLO_L0_CONTRACT_TAIL` 追加 tail 7–9（class-level Skill / templates/ 指针 / 不 dump 到MEMORY）；不改 `_SKILL_REVIEW_PROMPT` 正文 | tail 只追加，promptHash 仍可回放 |
| `vendor/legacy/learning-loop/trigger-policy.js` | 0.19.0 学习栈 | `checkExplicitLearn` 允许 `office`（PR-5） | 见 PR-5 |
| `vendor/legacy/learning-loop/orchestrator.js` | 0.19.0 学习栈 | `runExplicitLearn` 把 Desktop `mode` 交给闸门，删写死 `'agent'`（PR-5） | 见 PR-5 |

> 上游 provenance 见 `README.upstream.md`；只追加、不重写更前言的原则保证 `prompt = _SKILL_REVIEW_PROMPT + TRYLO_L0_CONTRACT_TAIL` 可回放。
