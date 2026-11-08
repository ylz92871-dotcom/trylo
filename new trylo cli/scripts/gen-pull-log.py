import json
from pathlib import Path

base = Path(__file__).resolve().parents[1] / "docs/references/open-source"
log_path = base / "PULL-LOG.json"
log = json.loads(log_path.read_text(encoding="utf-8"))

lines = []
lines.append("| 目标 | 状态 | commit | 许可证复核 | 拉取时间 |")
lines.append("| --- | --- | --- | --- | --- |")
for e in log:
    short = e["commit"][:7]
    date = e["commit_date"][:10]
    lines.append(f"| {e['target']} | pulled | {short} ({date}) | {e['license_at_commit']} | {e['pulled_at'][:10]} |")

md = f"""# PULL-LOG — P0 首次拉取台账

> 生成时间: {log[0]['pulled_at']}
> 核验基准: 2026-09-09 commit 级浅克隆 (--depth 1 --single-branch, core.longpaths=true)
> 分类: reference (not-evaluated)
> 路径说明: 表格和命令保留 2026-09-09 历史目标；现 checkout 位于仓库根 `_workspace/research/new-cli-open/`。本台账是资料导航，不是设计权威。

## 概览

- 成功: 25/25 P0
- 失败/待重试: 0 (pydantic-ai 采用 --no-checkout 后成功)
- 隔离区 Q 未拉取 (需专项审计后决定)
- openai-evals LFS 部分对象因网络限速过滤较慢，但 HEAD 与主要源码已就绪

## 明细

{chr(10).join(lines)}

## 许可证复核要点

- **mcp-spec** 与 **mcp-typescript-sdk**: 处于 MIT→Apache-2.0 迁移期，LICENSE 明确新代码 Apache-2.0，文档 CC-BY-4.0，不能笼统记 MIT。已按 commit 复核。
- **codex**: Apache-2.0，含 NOTICE 与 third_party/wezterm MIT。
- **gemini-cli**: Apache-2.0，含 third_party/get-ripgrep MIT 与 NOTICES.txt。
- **vercel/ai**: Apache-2.0，harness 等子包亦 Apache-2.0。
- **e2b**: 根 Apache-2.0，子包 js-sdk 等 MIT。
- **mem0**: 根 Apache-2.0，但 mem0-ts/src/oss 与 n8n-nodes-mem0 为 MIT。
- **ag-ui**: MIT 全仓一致，子包亦 MIT (除 mastra 集成 Apache-2.0)。
- 其余均与 PULL-LIST 首轮一致，无 enterprise/commercial 混入。

## 可复现命令

```powershell
# 已执行的 25 条 (--depth 1 --single-branch, core.longpaths=true)
{chr(10).join([f"git clone --depth 1 --single-branch https://github.com/{e['repository']}.git {e['target']}" for e in log])}
```

## 后续

- `_workspace/research/new-cli-open/` 已隔离，禁止 import/build/package；历史 `open/` 目标不作为新的写入位置。
- 如需历史研究: git -C <target> fetch --unshallow
"""

(base / "PULL-LOG.md").write_text(md, encoding="utf-8")
print(f"written {base / 'PULL-LOG.md'}")
