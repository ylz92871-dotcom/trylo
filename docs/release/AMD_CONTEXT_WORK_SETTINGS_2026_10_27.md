# AMD 免费池上下文、思考与 Work 修复

日期：2026-10-27；范围：现有账号免费池、Desktop 模型设置、Code/Work 共同的 CLI 运行边界。没有修改账号授权、双账号分流或每天共享 1000 次的计量规则。

## 查证

两条真实 AMD API 的 `GET /models` 各返回 15 项。按双方共同支持的文本模型核对，正式账号的 `/relay/models` 中 10 项容量与两边完全一致：

| 文本模型 | 服务声明的上下文 tokens |
| --- | ---: |
| DeepSeek-V4.1-Flash、DeepSeek-V4-Flash、MiMo-V2.6-Flash | 1,048,576 |
| Gemma-4-31B-IT、GLM-5.3-Flash、MiniCPM-V-4.7-1B、MiniCPM-V-4.7-35B-A3B、Qwen3.8-27B、Qwen3.8-Flash-Next | 262,144 |
| MiniCPM5-2B | 131,072 |

这是服务声明的容量，不是将任意模型实际压满该长度的压力测试结果。默认工作窗口仍为 200,000，超过模型/服务容量时由 CLI 钳制。

思考档位依据 [Radeon Cloud 模型表](https://amd-aim.github.io/radeon-cloud-docs/models/overview/) 和 [Chat Completions 合同](https://amd-aim.github.io/radeon-cloud-docs/api/chat-completions/)，不是照搬厂商直连接口或根据名字猜测：Qwen3.8-Flash-Next 提供 none/low/medium/xhigh；Qwen3.8-27B 提供 low/medium/xhigh；AMD GLM-5.3-Flash 提供 low/medium/high。DeepSeek 两款和 MiMo 提供全部现有档位；MiMo 的 none 标为最低投入，不宣称关闭思考。

MiniCPM5-2B 是直接回答模型；Gemma 和两款 MiniCPM-V 的独立思考开关没有通过现有强度字段接入，不伪装成可调整的强度档位。其控件说明限制并保留服务商默认；这不是宣称它们完全没有思考能力。

## 缺陷与修复

1. 用户截图的 `unknown option --context-window` 已通过实际进程重现：开发 checkout 的 dist 退出 2，打包资源的 CLI 已支持这两个参数。源码正确不能证明实际入口正确。已从当前源码重新构建开发 CLI，保留 red/green 输出；相同 argv 现在可运行并报告被限制后的窗口。
2. `pnpm tauri:dev` 的默认开发 CLI 增加只读帮助检查；缺少上下文参数时先按现有构建步骤刷新，再复查后启动。不会重写显式的操作员 CLI 覆盖路径。运行前 guard 也根据实际帮助输出检查当前请求用到的参数，自定义旧 CLI 会收到可操作提示，而不会先发送用户任务。
3. Work 原来只依据个人 API Key 显示模型缺失提示并隐藏起始任务。现在选中账号免费池时，Work 使用账号模型路径，菜单与起始任务不会被个人 Key 的空值误挡；真正的登录/授权仍由 Service Host 和服务端检查，未增加付费回退。
4. 模型菜单、上下文预览与设置页的同时目录读取合并为同一个进行中请求。之后的刷新仍查询真实授权与容量，不缓存过期成功结果。
5. 已运行的旧 Service Host 仍能提供有效模型本机凭据时，前端从同一账号的授权目录补齐容量，避免把 MiniCPM5-2B 猜成 200K。更换服务实例后的旧异步响应会被拒绝。

## UI 与保存合同

原模型连接页先展示“模型运行设置”：选择目标模型，下方并排显示上下文窗口与免费模型思考强度；窄窗口自然改为单列。免费池显示 AMD 的精确 token 容量，不展示可手填、可能被误解为扩容的容量输入。最大档显示精确 token 数；各模型的思考选项来自 AMD 专用规则。个人 API 连接仍保留原有思考设置。

新增可选持久化字段 `modelReasoningPreferences`，键复用既有 `contextModelKey`。未设置或显式 default 时免费模型跟随服务商；不会继承另一个个人 API 的 high/max。个人连接和保存的配置仍使用原有 `reasoningEffort`。调整免费池上下文/思考被记为 preferences，不切换连接、不清除 poolModel，不修改 API 密钥。

## 验证

- Desktop 相关 14 个文件、113 项测试通过，包括真实 Work composer、pool 设置保存/恢复、档位差异、目录并发合并、旧 Service Host 容量兼容、CLI guard 及 Work adapter → controller → 真实 CLI 的上下文/推理请求线。
- 开发启动检查 3 项、CLI 上下文合同 6 项、Service Host 模型边界 4 项通过，共 126 项相关测试；不代表全仓库 verify 已执行。
- CLI 完整构建通过，vendor/PTY 摘要核验和 10 个 locked component 的 release inventory 通过。没有新增依赖，没有修改 CLI 核心源码；Desktop 生产构建及 TypeScript 通过。
- 使用 YLZ 原生登录的隔离副本，通过 staged Service Host、正式账号服务、AMD 和当前开发 CLI 完成真实回答及 read_file 两轮调用。选择窗口 400,000、服务容量 262,144、实际 run_start 窗口 262,144，reasoning_effort=low。原用户会话文件前后不变；探针复制的私有会话文件已清除。
- 浏览器实际操作确认 Qwen 保存 262,144/low、切换 DeepSeek 显示 1,048,576 且不继承 Qwen 偏好、切回后恢复；深色 650px 宽视口单列、无横向溢出。仅使用真实容量元数据和内存设置，不写用户真实偏好。临时视口已恢复。
- UI 静态检测无新增发现。实际原生窗口读到了用户的旧参数报错；后续窗口被最小化，没有强制重启用户窗口，也不将浏览器与进程测试当作原生 WebView2 完整验收。

## 归属、回滚与边界

代码沿用 `desktop/src/account/`、`desktop/src/settings/`、`desktop/src/components/app-shell/`、`desktop/src/runtime/`、`desktop/src/host-adapter/`。构建/探针脚本保留在所属包 scripts；证据统一放在 `output/amd-context-work-20261027/`。用户凭据留在仓库外私有目录及原有服务器密文中。

可读性/维护性自审：模型偏好键、AMD 档位、账号会话与额度所有权保持分离；没有引入第二套账号、权限或配额规则。CLI 只接受标准运行参数，领域不依赖 Desktop 类型；没有下载新的供应链依赖。未提交/推送，未覆盖其他并行改动。

回退应以本轮 scope/源文件摘要核对 UI/port/guard 变更，恢复同一版本源码后完整重建。禁止单独把旧 args-run.js 塞回新 dist，制造混合运行时。Service Host 资源旧 bundle 在证据 before 中保留。官网安装包未重打；本轮没有改线上入口或重部署后端。当前源码/开发 CLI/前端 dist/Service Host 资源已更新；百万 token 真实满载、其余每个模型的实际调用和独立思考开关仍没有本轮验收证据。
