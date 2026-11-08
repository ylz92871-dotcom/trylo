# P08 Desktop 切换与 Parity 技术规格

> 状态：可执行（待项目评审）  
> 阶段：P08 Desktop 切换与 Parity  
> 负责人：Desktop / CLI 联合施工  
> 最后更新：2026-09-22  
> 依赖决策：P00 Trylo Protocol、CLI stream projection、Desktop 单进程监管与权限分权基线

## 1. 结论与施工目标

新 Trylo CLI 已具备独立运行、流式事件、工具执行、会话创建与恢复能力，工程上可以接入 Desktop。当前 Desktop 仍绑定旧 CLI 的参数、事件和常驻进程语义，因此不能通过修改路径直接切换。

P08 的目标是在保留旧运行时回滚路径的前提下，建立一条明确的新 CLI 适配路径，并按以下顺序交付：

1. 开发态 fixture 最小闭环：发送消息、流式文本、工具卡、终态、失败和取消；
2. 真实 provider 闭环：CLI 自有凭据、endpoint/model、错误呈现；
3. 会话和权限闭环：恢复、审批、拒绝、超时与崩溃；
4. 功能 parity：附件、结果坞、学习、Team、恢复；
5. 发行闭环：打包资源、固定 Node、真机安装、灰度切换和回滚。

本阶段不让 CLI 核心依赖 Desktop 类型。Trylo Protocol 是跨边界事实源，Desktop 只实现协议适配和呈现。

## 2. 已验证基线

2026-09-22 在 Windows、Node `v24.14.1` 上从当前源码执行：

| 验证项 | 命令形态 | 结果 |
| --- | --- | --- |
| TypeScript 构建 | `npm run build` | PASS，退出码 0 |
| 环境诊断 | `trylo doctor --json` | PASS，退出码 0 |
| 文本运行 | `trylo run --provider fixture <message>` | PASS，完整工具循环与 final |
| 流式运行 | `trylo run --provider fixture --format stream-json <message>` | PASS，`run_start` 到唯一 `run_result` |
| stdin 运行 | `... | trylo run --format stream-json -` | PASS，退出码 0 |
| 写工具 | `fixture-write + --allow-tools write_file` | PASS，文件真实落盘并读回 |
| 会话创建 | `--session desktop-probe` | PASS，持久 journal 生成 |
| 会话恢复 | `--resume desktop-probe` | PASS，同 sessionId 继续运行 |
| Hermetic 门禁 | `npm test` | PASS，1916 tests、0 failed、5 skipped |
| Desktop 旧参数直连 | `trylo -p --input-format ...` | FAIL AS EXPECTED，退出码 2，`unknown command: -p` |

原始输出位于 `docs/02-分期工程产出/P08-Desktop切换与Parity/evidence/2026-09-22-standalone-smoke/`。

这组证据证明的是“新 CLI 独立可运行”和“接入具备工程基础”。它不证明 Desktop parity 已完成。

## 3. 当前边界差异

### 3.1 启动合同

Desktop 当前在 `desktop/src/host-adapter/trylo-runner.ts` 使用旧合同：

```text
-p
--input-format stream-json
--output-format stream-json
--permission-prompt-tool stdio
--verbose
--include-partial-messages
--bare
--permission-mode ...
--tools=...
```

新 CLI 的合同是：

```text
trylo run
--format stream-json
--workspace <absolute-path>
[--provider openai-compatible --endpoint <url> --model <id>]
[permission flags]
-
```

提示词应通过 stdin 发送，发送完必须关闭 stdin。不能把用户正文放进 argv：Windows 命令行长度有限，Rust 进程日志会记录 argv，附件和长历史也会放大失败概率。

### 3.2 输出合同

新 CLI 的权威输出定义在 `src/internal/protocol/cli-stream.ts`：

```text
run_start
message_start / message_delta / message_end
reasoning_start / reasoning_delta / reasoning_end
tool_use / tool_result
warning
usage
run_result
```

Desktop 当前翻译器主要识别旧 SDK 的 `system`、`stream_event`、`assistant`、`user`、`result`。`tool_use` 和 `tool_result` 虽然同名，字段也不同；当前 fast path 会把新 CLI 事件误当成 Desktop LoopEvent，导致缺少 `id/tool/input/ok/durationMs` 等字段。

### 3.3 生命周期

旧运行时是常驻 stdin 进程，支持预热、同进程多轮和控制帧。新 CLI 的 `run` 是一轮一个进程，EOF 后执行，终态后退出；持久上下文由 `--session/--resume` 所有。

首个接入版本必须按 one-shot 建模，禁止假装它是旧常驻进程。预热、warm reuse、`sendPromptToProcess` 和 steering 在新运行时路径上必须关闭或明确报告不支持。

### 3.4 凭据和 provider

新 CLI 的真实 provider 当前为 `openai-compatible`，凭据来自 CLI credential ledger，不能假设 Desktop 的 `ANTHROPIC_API_KEY` 环境变量会自动成为新 CLI 的凭据。

开发验收先用 fixture。真实 provider 验收前必须完成：

- Desktop 设置到 `--endpoint/--model` 的映射；
- CLI 登录状态读取和清晰提示；
- 不通过 argv、日志、事件或文档暴露密钥；
- 明确旧 Desktop API key 是否迁移。默认不自动复制，避免产生第二凭据源。

### 3.5 权限

新 CLI 的非交互 stdin 默认 `--ask never`，会失败关闭。Desktop 的 `ask` 等级需要双向审批协议，不能在接入层静默改成自动允许。

在审批协议交付前：

| Desktop 权限级别 | 新 CLI M0 策略 |
| --- | --- |
| `read_only` | `--ask never --deny-tools write_file,edit_file,run_shell` |
| `ask` | 明确报告“新 CLI Desktop 审批尚未接通”，不启动有副作用的运行 |
| `workspace_write` | `--ask never --allow-tools write_file,edit_file` |
| `unrestricted` | `--ask never --allow-tools write_file,edit_file,run_shell` |

学习、模型输出和 Desktop UI 均不能扩大权限。Permission Service 仍是唯一决策所有者。

## 4. 目标架构

```text
Desktop ConversationRunSupervisor
              |
              v
       CliRuntimeRouter
        /            \
legacy-stream-json   trylo-v1
        |              |
 LegacyTryloRunner   TryloV1Runner (one process / turn)
                       |
             Tauri ProcessService
             send(prompt) + closeInput()
             stdout JSONL + stderr + exit
                       |
                 new Trylo CLI
                       |
               Trylo Protocol events
                       |
              TryloV1EventAdapter
                       |
              Desktop LoopEvent / UI
```

### 4.1 唯一扩展点

新增 `CliRuntimeProtocol`：

```ts
type CliRuntimeProtocol = 'legacy-stream-json' | 'trylo-v1';
```

它必须进入以下边界：

- 持久设置及迁移；
- `SettingsForCodeRun` 快照；
- runtime fingerprint；
- runner 路由；
- 设置 UI。

默认保持 `legacy-stream-json`，直到发行 parity 通过。开发人员可显式选择 `trylo-v1`。

### 4.2 进程桥补充

`ProcessService` 需要两个能力：

1. `closeInput(processId)`：只关闭 stdin，保留 stdout、取消句柄和退出归属；重复调用幂等；
2. 独立 stderr 通道或等价的结构化启动失败通道：不得把 stderr 混入 JSONL stdout。

Rust `ProcessEntry.writer` 应成为可取走的所有权槽。关闭 stdin 是 drop writer，不是 kill process。`process_send` 在关闭后返回明确的 broken-pipe 类型错误。

### 4.3 新 CLI runner 状态机

```text
idle
  -> spawning
  -> writing_prompt
  -> input_closed
  -> streaming
  -> terminal(completed | failed | cancelled | unknown)
  -> exited
```

关键不变量：

- 每轮最多一个权威 `run_result`；
- 收到 `run_result` 后 UI 可以结束 busy，但仍等待进程退出做资源回收；
- 未收到 `run_result` 就退出，按 exit code 与 stderr 形成 `unknown/failed/cancelled`，不可伪造 completed；
- `stop` 终止当前进程树，产生 cancelled；
- superseded generation 的事件全部丢弃；
- prompt 成功写入但 closeInput 结果未知时，终态是 unknown，不自动重试有副作用的 turn。

## 5. 事件映射合同

适配器必须运行时校验新 CLI 输入，不能直接类型断言。

| Trylo CLI event | Desktop 目标 | 规则 |
| --- | --- | --- |
| `run_start` | `loop_start` + `turn_start` | 保留 sessionId、turnId、providerId、model；工具列表未知不得伪造 |
| `message_start` | 内部缓冲开始 | 清空本消息缓冲 |
| `message_delta` | `text(partial=true)` | 累加后输出完整预览，或修改 reducer 接受 append delta；二选一且只有一处所有者 |
| `message_end` | `text(partial=false)` | 封口当前消息；空消息不创建气泡 |
| `reasoning_start/delta/end` | `thinking` | 遵守 redacted；未授权推理正文不得投影 |
| `tool_use` | `tool_use` | M0 可显示 id/name；完整 parity 需要 CLI stream 增加脱敏后的 input |
| `tool_result` | `tool_result` | 映射 status、output、truncated；完整 parity 需要 tool name、错误码、duration、富内容 |
| `warning` | `runtime_warning` | 新增可见 notice；禁止丢弃重要 warning 或伪装成 assistant 文本 |
| `usage` | 运行内 usage accumulator | 不要为每个 usage 事件伪造一个 turn_end |
| `run_result` | `turn_end` + `loop_end` | status 决定 isError；usage 使用最终累计值；唯一终态 |

### 5.1 CLI stream 需要补强的字段

当前协议足够完成聊天和简单工具卡，但不足以声称完整 Desktop parity：

- `tool_use` 缺工具输入；
- `tool_result` 缺工具名、canonical error、duration 和结构化/二进制内容；
- `warning` 需要稳定 code 词表；
- pre-run 配置/认证失败需要可机器读取的 terminal failure；
- approval request/decision 还没有 Desktop 双向帧；
- subagent、compaction、checkpoint、learning、Team 的可见事件需要对照映射表逐项验收。

这些字段应从核心 envelope 投影出来，不能由 Desktop 猜测。

## 6. 会话方案

### 6.1 M0：无持久 session

每轮使用 ephemeral session，并把 Desktop 已有文本历史包装进当前 prompt。此阶段只用于 fixture 和短对话开发闭环，不作为最终方案。

优点是没有 create/resume 竞态；限制是长历史、compaction 和崩溃恢复不达标。

### 6.2 M2：CLI 持久 session

Desktop conversation metadata 增加：

```ts
type CliSessionBinding =
  | { state: 'none' }
  | { state: 'creating'; sessionId: string; runId: string }
  | { state: 'established'; sessionId: string }
  | { state: 'unknown'; sessionId: string; reason: string };
```

首轮生成不可预测且合法的 sessionId，使用 `--session`；收到 `run_start` 后转为 established。后续使用 `--resume`。创建过程中崩溃进入 unknown，必须通过结构化 session probe 决定 resume 或创建新 id，不能从“文件可能存在”推断成功。

Desktop history 与 CLI journal 只能有一个模型上下文所有者。进入 established 后不再把完整历史重复塞进 prompt。

## 7. 审批协议

完整 Desktop `ask` 需要 CLI 提供版本化双向控制面。推荐在 P08 增加宿主传输命令，而不是复刻旧 Claude 控制帧：

```text
CLI -> Desktop: approval_requested
  requestId, runId, toolCallId, action, scope, risk, expiresAt

Desktop -> CLI: approval_resolved
  requestId, decision(once|session|deny|deny_tool|cancel)
```

必须验证：重复 decision 幂等、过期拒绝、跨 run/request 重放拒绝、取消与审批竞态、Desktop 断开后失败关闭。学习系统不能生成或消费授权决定。

若 one-shot stdin 已被 EOF 关闭，则审批不能复用同一单向 prompt stdin。需要独立控制通道，或将新 CLI Desktop 表面升级为长驻的版本化 host transport。该决策必须在开始审批代码前冻结 ADR。

## 8. 工作包与依赖顺序

### WP0：协议冻结与红例

交付：

- 本规格获批；
- 保存一条成功、失败、取消、工具、warning 的 golden JSONL；
- Desktop 合同测试先红：现有 translator 无法消费新 CLI trace；
- 记录旧 argv 返回退出码 2 的黑盒证据。

退出标准：测试能稳定证明未接入状态，而不是只检查函数调用。

### WP1：进程桥与 one-shot runner

交付：

- `closeInput`；
- stderr/exit 的结构化捕获；
- `TryloV1Runner`；
- prompt 只走 stdin；
- 取消进程树；
- legacy runner 零行为变化。

退出标准：fixture 文本运行、stdin EOF、无终态退出、取消四类集成测试通过。

### WP2：事件适配

交付：

- 独立 `TryloV1EventAdapter`，不继续膨胀 legacy translator；
- 全部 12 种 CLI stream event 的运行时 guard；
- 成功/失败/取消/unknown 唯一终态；
- warning 可见；
- tool 卡 M0 映射。

退出标准：golden trace 投影、乱序/重复/未知事件、截断 JSONL 和终态测试通过。

### WP3：Desktop 显式切换

交付：

- `CliRuntimeProtocol` 设置和 UI；
- runtime fingerprint 纳入 protocol；
- trylo-v1 禁用预热、warm reuse 和 steering；
- fixture 开发态端到端演示；
- 默认仍为 legacy。

退出标准：两个协议在同一 Desktop 构建中可选择，互不污染；切回 legacy 无数据迁移。

### WP4：真实 provider、session 与审批

交付：

- CLI ledger 登录状态呈现；
- endpoint/model 映射；
- session binding 状态机；
- approval transport ADR 与实现；
- cancel/timeout/crash/recovery 集成测试。

退出标准：真实 provider 多轮、写工具逐次审批、拒绝、恢复均有黑盒证据。

### WP5：功能 parity

逐项完成并留证：

- 聊天与 reasoning；
- 工具输入、结果、错误和富内容；
- 附件；
- 结果坞；
- checkpoint/恢复；
- compaction；
- learning；
- Team/subagent；
- Work 工具 profile。

任何未完成项必须显示为不可用或降级，不得以“进程退出码 0”代替 parity。

### WP6：发行与切换

交付：

- `dist`、固定 Node 与必要资源进入 Tauri bundle；
- runtime path 从 resource resolver 获取，移除开发机绝对路径；
- release inventory、SBOM 和许可证闭包；
- Windows 安装包真机 smoke；
- 灰度开关、遥测和回滚手册；
- parity 通过后再修改默认协议。

## 9. 当日可执行切片

当日只推进开发态 M0，严格控制范围：

1. 冻结成功/失败 golden trace；
2. 先提交 event adapter 红例；
3. 增加 `closeInput` 和 stderr 进程合同；
4. 实现 one-shot `TryloV1Runner`；
5. 增加协议选择但保持 legacy 默认；
6. 用 fixture 在 Tauri dev 中完成一次读工具和一次写工具；
7. 保存截图、stdout trace、进程退出和真实文件变更证据。

当天不做 session、审批、学习、Team 或发行切换。M0 通过后再按 WP4 前进。

## 10. 验收矩阵

| 级别 | 必须证明 | 不通过时 |
| --- | --- | --- |
| M0 开发闭环 | fixture chat、stream、tool、terminal、cancel | 不进入真实 provider |
| M1 真实单轮 | auth、endpoint/model、错误可见、无 secret 泄漏 | 不进入 session |
| M2 多轮恢复 | create/resume、compaction、崩溃与 unknown outcome | 不进入默认试用 |
| M3 权限与工具 | once/session/deny/cancel、重放拒绝、富结果 | 不声称工具 parity |
| M4 产品 parity | 附件、结果坞、learning、Team、Work | 不修改默认协议 |
| M5 发行 | bundle、安装包、固定 runtime、回滚 | 不发布 |

## 11. 验证命令

新 CLI 基线：

```powershell
npm run build
npm test
node .\dist\cmd\trylo\main.js doctor --json
node .\dist\cmd\trylo\main.js run --provider fixture --format stream-json "hello"
"hello" | node .\dist\cmd\trylo\main.js run --provider fixture --format stream-json -
```

Desktop 每个工作包至少执行：

```powershell
pnpm typecheck
pnpm test -- <changed contract and integration tests>
pnpm build
cargo test --manifest-path .\src-tauri\Cargo.toml
```

发行前还必须执行 Tauri dev 真机、安装包 smoke、无开发 checkout 的资源解析测试，以及真实 provider 的脱敏日志检查。

## 12. 风险、回滚与完成定义

主要风险：

- 同名事件字段错配导致 UI 表面成功、数据实为 undefined；
- stdin 未关闭导致运行永远不开始；
- pre-run 错误只在 stderr，UI 卡在 busy；
- one-shot 被 controller 当作 warm process 重用；
- Desktop key 与 CLI ledger 形成双凭据源；
- 缺 tool input/富结果却提前宣称 parity；
- 打包仍依赖开发机绝对路径。

回滚方法：把 `CliRuntimeProtocol` 切回 `legacy-stream-json`。新 CLI session、credential ledger 和 Desktop conversation 数据互不删除。任何迁移都必须是 additive，禁止在 P08 灰度期清理旧 runner。

P08 只有在以下证据全部存在时才能宣告完成：能力矩阵、合同测试、黑盒 trace、Windows 真机、安装包运行、权限攻击测试、恢复测试、发行库存和回滚演练。代码完成或退出码 0 都不是阶段完成证据。
