# 协作对话 V3 接线记录

用户先评审 `prototype/agent-collaboration-v3`，随后明确允许接线。本次接入 Code / Work 的共享对话界面，保留现有应用导航与其他并行修改。

## 实际行为

- 每个用户轮次只保留一处协作入口。总人数由去重后的真实子智能体数量加一名主控计算，标明主控与协作构成。默认收起，事件更新不会自动展开。
- 成员列表只显示名称与状态，点击后打开完整任务与分轮答复。窄窗口一次显示一个会话区域；Escape / 返回按钮关闭成员会话。
- 新 CLI 的 spawn / 轮次进展 / 等待追问 / 完成 / 失败 / 取消进入 Desktop 的协议校验、事件适配、消息归并与生产组件。普通 V1 worker 不再被误判为旧版 Team 席位。
- Desktop 的 V1 启动参数启用 `--subagent`；命令行直接运行时仍须原有显式开关。子智能体继续继承父任务的工具边界，未增加独立授权通道。
- 成员补充要求经当前进程的定向输入通道进入同一个智能体。CLI 发送匹配的接收确认后才清空草稿；拒绝、超时、进程退出会保留草稿。跨进程确认和未确认期间的重复提交均不算送达。
- 主控结束时，先收口子智能体生命周期，再输出最终结果。缺失子智能体终态会显示失败且将总体结果降为未知，不伪造完成。
- 成功的协作调度回执由简洁成员入口替代；失败与中断仍然可见。持久化消息不被裁剪。
- 主会话沿用已有滚动控制。成员会话上滑、拖动滚动条或键盘翻阅会暂停跟随，收到新答复保持阅读位置，点击“回到最新”恢复。

## 验证与原始记录

所有日志在仓库根目录 `work/collaboration-wiring-20261022/`，保留初始失败和后续复核。

- `desktop-tests-verified.txt`：12 个测试文件，164 项通过；覆盖共享消息列表、真实 Virtuoso、事件归并、运行器、协议适配与 Team 隔离。
- `lifecycle-tests-complete.txt`：追加生命周期真实性检查与真实 CLI 子进程联调，35 项通过。后续更强的席位隔离断言见 `lifecycle-guard-verified.txt`。
- `final-scope-tests.txt` 保留滚动条回归首次失败；修正为每次读取独立几何快照，避免保存可变 DOM 引用。复核见 `final-scope-verified.txt`：成员滚动、接收确认、同一智能体追问和生命周期补充检查，14 项通过。
- `desktop-typecheck-complete.txt` / `eslint-complete.txt`：Desktop 类型与相关源码检查通过。
- `desktop-production-build-final.txt`：10 月 23 日完整生产构建通过，耗时 1 分 36 秒；产物在 `work/collaboration-wiring-20261022/desktop-production-final/`。早先的临时文件删除和 Monaco 路径访问失败分别保留在 `desktop-production-build.txt` / `desktop-production-build-retry.txt`，未覆盖。
- `live-verified/summary.json`、`live-verified/wire.json`：React 生产组件 → Desktop 运行器 → 实际 Node CLI 进程 → 本机测试 HTTP 服务 → 三个真实子智能体。成员输入使原智能体返回第二轮答复；其他成员结果保留，终态一份，剩余子进程为零。
- `cli-input-tests.txt`：CLI 共享标准输入与事件投影的 22 项检查通过。前一轮关联的运行时、控制工具和协议映射 75 项检查也通过。
- `cli-verify-final.txt`：全量 CLI 门禁没有全绿。10 个阶段通过，单元阶段发现三项环境干扰：共享 dist 构建读取冲突，以及临时目录位于仓库内使 `/diff` 用例识别到项目。不能将该记录写成全量通过。
- `cli-failed-tests-rechecked.txt`：将编译产物复制到独立位置，使用仓库外的临时目录，原失败所在的两个文件共 7 项通过。快照位于 `D:/CC/trylo-collaboration-check-20261022/`。

## 视觉检查与边界

- `prototype/collaboration-integrated` 使用生产 React 组件和协议适配器，示例事件仅用于视觉检查。真实输入闭环证据是上述本机 CLI 联调记录。
- 浏览器检查默认收起、展开成员、完整答复、关闭回主对话，以及 1440 / 768 / 390 宽度。效果图为 `work/collaboration-wiring-20261022/production-child.png`。
- 视觉检查器在短对话的固定高度视窗中报告留白：768 宽度一项失败，其他宽度两项警告。该处按用户批准的简洁对话布局保留：消息靠上、输入框固定在底部，中间供后续消息增长。未添加占位内容来掩盖指标。
- 没有调用真实付费模型，没有修改全局模型选择或密钥，没有重启用户正在使用的 Desktop。原生窗口、安装包更新和真实模型多智能体体验不属于本次已完成的验收证据。

## 修改边界

生产 UI：`CollaborationGroup`、`SubagentConversation`、共享 `AgentConversationSurface` / `MessageList` / `ChatPanel` 与 App 回调。

运行链路：V1 子智能体协议、事件适配、消息归并、定向标准输入确认、运行器启动，以及新 CLI 的轮次事件、流投影和结束顺序。

另修正一处现有测试查询中不被类型定义支持的 `exact` 参数，改为等价的完整名称正则。没有重置工作区或提交其他任务的改动。
