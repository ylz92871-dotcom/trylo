# 通用协作 Agent 派发失败修复

日期：2026-10-24。范围：旧版 Trylo CLI `Agent → runAgent`，以及 Desktop 开发环境使用的 `trylo cli/cli.js`。状态：本次派发错误修复与定向验证完成，未提交、未推送。

## 原因与修改

用户提供的 `statusline-setup` 英文诗任务在派发后立即返回 `memberId is not defined`。此入口位于 `trylo cli`，上轮 `new trylo cli` 的六项能力验证没有覆盖它。

`runAgent` 的参数类型已有可选 `memberId`，元数据写入也引用该变量，但函数入参解构缺少 `memberId`。因此普通任务即使没传成员身份，也会在进入 child query 之前同步抛出 `ReferenceError`。生产修复是在入参解构中补上这一项，保持可选参数语义，未引入默认成员或扩大权限。

真实进程回归另发现：worker 完成后删除无改动工作树时，`AgentTool` 重写元数据只保留类型与描述，丢失先前写入的成员身份。清理写入现在保留已解析的 `resolvedMemberId`，仍移除已删除的工作树路径。

生产源码增量为两处各一行，位于 `runAgent.ts` 与 `AgentTool.tsx`。新增两个回归测试文件，并重建了实际运行入口。原先已修改的 `cli.js` 完整备份在 `work/subagent-memberid-20261024/cli.before.cjs`，没有覆盖原始失败证据。

## 证据

证据目录：[subagent-memberid-20261024](evidence/subagent-memberid-20261024/verification.json)。

| 验证 | 结果 |
| --- | --- |
| 原始运行文件、真实 SDK 进程 | `red-entry-correct-resolution`：Agent 已广告，主请求 2 次，child 请求 0 次；实际 tool_result 为 `is_error:true, content:"memberId is not defined"`。进程退出 0 仍被回归正确判为失败 |
| 未修复源码、实际 runAgent 函数体 | `source-red.tap`：普通任务、指定成员、后台任务共 3 项均以相同 ReferenceError 失败。仅外部环境与 provider/query 依赖被隔离 |
| 修复后源码 | `source-green.tap`：3/3 通过，检查进入 query、返回文本及元数据中可选身份的精确保留 |
| 工作树清理身份回归 | `accepted-process/worker.result.json`：派发与 child 回复已成功，但身份断言失败；原元数据只有类型和描述。保留身份后再验通过 |
| 最新构建真实 SDK 派发 | `serial-sdk.tap`：3/3 通过。statusline-setup、general-purpose、worker 均实际执行 child query，返回诗句，tool_result 无错误；每项 3 次 provider 请求、1 次 child 请求，退出均为 0。worker 元数据保留 memberId |
| 相邻角色、overlay、权限衰减、团队简报、事件 | `adjacent.tap`：78/78 通过，另有 loop-events 脚本 15/15 事件解析及监听通过 |
| 构建 | Bun 完整构建成功；最终入口 SHA-256 与内联 source map 绑定，见 `build-binding.json`；runAgent 内嵌源码与当前磁盘源码一致 |

真实进程测试使用本地合成 Anthropic provider，不调用付费服务或读取用户凭证；测试返回固定诗句，只验证派发、执行、返回与身份，不能证明真实模型诗歌质量。worker 使用测试专属空 Git 仓库和真实工作树，不操作用户仓库。

复现命令（在 `trylo cli`，先完成构建）：

```powershell
node --test tests/runAgentMemberIdentity.test.mjs
node --test tests/subagentDispatch.test.mjs
bun test src/tools/AgentTool/team-roster tests/loopEvents.test.ts
```

进程回归默认 SDK stream-json，可设 `TRYLO_AGENT_TEST_INPUT_MODE=prompt` 验证单次 prompt 入口；`TRYLO_AGENT_TEST_EVIDENCE` 和 `TRYLO_AGENT_TEST_WORK_ROOT` 可指定证据及临时目录。最终 SDK 回归使用规范的仓库外临时目录及 Desktop 固定 Node v24.14.1，逐项启动 CLI。断言仍要求退出 0、真实 child 请求、无错误 tool_result、正确文本和元数据。

## 实际构建与限制

Desktop 当前运行的是开发版可执行文件，资源目录没有 `cli-legacy`，默认 legacy 解析回退至仓库 `trylo cli/cli.js`；此运行文件已经重建。显式自定义的 CLI 路径或另一个安装包不在本次更新范围。已运行的 CLI 把旧代码加载在内存里，需要结束当前运行并重新发起一轮任务；没有强制结束用户进程或修改其设置。

旧入口与新入口的内联源码比较还显示 `tools.ts`、`ripgrep.ts`、`powershellProvider.ts` 中已有的 Desktop 工具目录、打包路径、PowerShell UTF-8 修复被本次重建纳入。它们来自当前既有源码，不是本次新增修复，未回退或冒领。`build-binding.json` 列出完整差异。

试跑中的真实负例全部保留：仓库内启动曾超时；备份入口移到错误依赖树时出现 React compiler-runtime 解析错误；无 Git 测试目录不能启动默认工作树 worker；部分并行试跑在返回成功之后出现 Windows `UV_HANDLE_CLOSING` 退出断言。最终三项串行 SDK 回归正常退出，但未证明该 Windows 退出异常被产品修复，也未把它记作 memberId 问题的原因。原生 UI、安装包及并发退出稳定性不在本次已通过范围。

可读性自审：仅补齐既有参数绑定，并在既有清理写入保留同一身份；不新增状态所有者、权限路径、依赖或持久化格式。回滚源码可反向应用 `source.patch`；运行文件可从已保存的 `cli.before.cjs` 恢复，实际回滚前应核对并发修改与哈希。本次只做反向检查，不实际回滚。
