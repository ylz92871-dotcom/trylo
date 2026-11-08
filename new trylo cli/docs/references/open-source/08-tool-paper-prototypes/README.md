# 08-tool-paper-prototypes — 工具维度论文原型区（reference-only）

> 资料导航，不是设计权威。该分类源码实际位于[研究区](../../../../../_workspace/research/new-cli-open/08-tool-paper-prototypes/)；原说明中的 `report/` 路径从[历史报告归档](../../../../../_workspace/archive/tracked/new-cli-reference-reports/)定位。

本目录存放 `../report/tool/00-literature-excerpt-tool-creation-ORIGINAL.md`（T1–T18）
与 `../report/tool/00c-literature-excerpt-autonomous-agent-optimization-ORIGINAL.md`（A1–A6）
两段文献基线中论文的**官方原型代码仓**（`git clone --depth 1` 浅克隆）。
克隆日期 2026-09-11，HEAD 见 `../report/tool/80-tool-frontier-feasibility.md` §0 基线表。

纪律（与 `07-paper-prototypes/` 一致，全部 reference-only）：

1. **本目录不在 PULL-LIST 内**：论文作者实验原型，不是 trylo 评估过的成熟依赖；
   复制/fork/引入必须走 PULL-LIST 流程 + 许可证审计 + ADR，默认拒绝进入产品。
2. **只读**：只做机制精读（核心理论代码定位到文件/符号），不执行仓库脚本。
3. **许可逐仓记录**：见总报告 §0；无 LICENSE 的仓按 all-rights-reserved 只读处理。
4. **拉取状态诚实记录**：
   - `AlphaEvolve`（Novikov et al., 2025）：DeepMind **未发布官方代码**（`google-deepmind/alphaevolve` 不存在，2026-09-11 探测）。
     以社区重构 `codelion/openevolve` 作**非官方**替代精读，报告中显式标注"非官方"。
   - `ATLASS`（Haque et al., 2025）：GitHub 检索未找到官方代码仓
     （`just-ketan/ATLASS` 为 2026 年无关同名项目，已排除）。

## 仓库清单

| 论文（文献编号） | 仓库 | 语言 |
|---|---|---|
| Voyager (T2) | `MineDojo/Voyager` | Python |
| Live-SWE-Agent (T5) | `OpenAutoCoder/live-swe-agent` | Python |
| CREATOR (T6) | `qiancheng0/CREATOR` | Python |
| SkillWeaver (T7) | `OSU-NLP-Group/SkillWeaver` | Python |
| CRAFT (T8) | `lifan-yuan/CRAFT` | Python |
| RL-GPT (T9) | `JIA-Lab-research/RL-GPT` | Python |
| LearnAct (T11) | `zhao-ht/LearnAct` | Python |
| From Exploration to Mastery (T12) | `quchangle1/DRAFT` | Python |
| AgentSquare (A1) | `tsinghua-fib-lab/AgentSquare` | Python |
| Darwin Gödel Machine (A2) | `jennyzzt/dgm` | Python |
| AlphaEvolve (A3, 非官方) | `codelion/openevolve` | Python |
| Gödel Agent (A4) | `Arvid-pku/Godel_Agent` | Python |
| MemEvolve (A5) | `bingreeky/MemEvolve` | Python |
| Alita (T4) | `CharlesQ9/Alita` | Python |
| ATLASS (T3) | **未找到官方代码**（总报告 §0 记录检索过程） | — |
