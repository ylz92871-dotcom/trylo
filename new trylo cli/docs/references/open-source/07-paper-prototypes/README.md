# 07-paper-prototypes — 论文原型区（reference-only）

> 资料导航，不是设计权威。该分类源码实际位于[研究区](../../../../../_workspace/research/new-cli-open/07-paper-prototypes/)；原说明中的 `report/` 路径从[历史报告归档](../../../../../_workspace/archive/tracked/new-cli-reference-reports/)定位。

本目录存放 `report/00-literature-excerpt-memory-evolution-ORIGINAL.md`
文献基线中 12 篇论文的**官方原型代码仓**（`git clone --depth 1` 浅克隆，
HEAD 见 `../report/80-paper-prototype-feasibility.md` §0 基线表）。

纪律（与 trylo《开源依赖与参考代码准入政策》一致）：

1. **本目录不在 PULL-LIST 内**：这里的仓是论文作者发布的实验原型，
   不是 trylo 评估过可引入的成熟开源依赖。任何复制、fork、依赖引入
   都必须走 PULL-LIST 流程 + 许可证闭包审计 + ADR，默认拒绝进入产品。
2. **全部 reference-only，只读**：本次任务只做机制精读（触发-写入-存储-检索
   四要素定位到文件/符号），不复制代码到产品，不执行可疑脚本。
3. **许可逐仓待审**：各仓 LICENSE 状态见总报告 §0。其中
   `memgen/`、`richelieu/` 根目录**无 LICENSE 文件**，分类记为
   `reference-no-license（all-rights-reserved，只读）`，不得复制；
   `meminsight/` 为 CC-BY-NC-ND 4.0（非商业、禁演绎），只读、不得改写复用。
4. 拉取状态诚实记录：`sage/` 未拉到（官方项目页声明的
   `github.com/codepassionor/sage` 返回 404，已清掉不完整目录）；
   `memory-r1/` 仓内当时无实现代码（README "Code coming soon"）；
   `richelieu/` 仓内只有 Diplomacy Gym 环境 + 自博弈权重，
   论文中的 LLM planner/negotiation/memory 模块不在仓内。
   详情见总报告 §0 / §4。
