# Trylo CLI 核心与学习融入方案（过程记录，已过期）

> 状态：已替代；仅保存过程记录。旧“两接点/环外资产”产品解释与 `TRYLO-LEARNING-AGENT-顶层架构与目标.md` 冲突，不得作为新施工依据。  
> 阶段：P00 开工依据 + L01 默认答案  
> 日期：2026-09-12  
> 依据：P00 规格、学习边界讨论稿、旧 CLI `LOOP_EVENTS`/`EVENT_VOCABULARY`、`open/report` 七维（memory/temporal/workflow/tool/prompt/reward/multi-agent）及各 `80-*-frontier` trylo 段  
> 本文件替代「先调研再讨论」的空转。D1–D7 在此给出**默认方案**，不是再列选项。
> 仍有效：自有 Protocol、单 Execution Loop、权限独立、两个接点、next-boundary 生效；当前权威学习架构见 `../00-总领/TRYLO-CLI-双循环学习控制面架构.md`。

## 0. 一句话

新 CLI 核心是 **自有 Protocol + 单 Loop + 唯一 Permission**；学习是 **环外文件资产**，只通过 **两个空接点** 碰 Loop：turn 开始时可选地提供已生效上下文，turn 结束时非阻塞地收到运行事实投影。不把 v0.3、memdir、OpenCode、四端口搬进核心。

## 1. 对原 P00 工作包的判定

P00 规格目标/非目标/门禁 **保留**。§9 的 P00-00…08 **不能当第一包**——太大、语言未选、没有把学习槽位说死。

本方案把「第一步」收成今晚四包（§7）。P00-03/04/06/07/08 仍按原规格，排在这四包之后。

## 2. 核心长什么样

### 2.1 语言与进程（冻结建议）

| 项 | 决定 | 理由 |
| --- | --- | --- |
| 主语言 | TypeScript + `tsc`（C 级工具） | 旧 CLI、Desktop、MCP 生态、人才栈一致；Go/Rust 收益不够覆盖 Windows PTY/TUI/SDK 边界成本 |
| 进程 | 单进程 CLI；Desktop 只经版本化 Protocol | 开源共识：CLI 与 UI 共享 runtime 或共享事件，UI 不当事实源 |
| 不选 | OpenCode 当 core；LangGraph 当领域；bun 当发行运行时（开发可用） | 类型主权；图框架会反向定义 Loop |

ADR-0001 按此写草案。推翻需要工程反证，不是口味。

### 2.2 模块与依赖（逻辑冻结，物理树随 TS）

```text
cmd/trylo/                 进程、参数、stdio
internal/protocol/         Envelope、kind、ID、兼容策略
internal/domain/           attempt/action/terminal 纯转换
internal/loop/             状态机；只依赖下面四个端口
internal/ports/
    provider.ts            流 → canonical
    tools.ts               调用/结果
    permission.ts          唯一审批地板
    context.ts             组装本轮模型可见输入（学习将来挂这里）
internal/journal/          唯一 sequencer；observation 投影从这里出
internal/knowledge/        片段库（pending/active）；Loop 禁止 import 本目录
internal/adapters/         provider/sdk、desktop、fs；禁止被 loop import
```

依赖只许向下。核心不得 import Desktop 事件、React、provider SDK、数据库。

### 2.3 Loop（学开源的是形状，不是代码）

旧 trylo / OpenCode / Codex / Goose / mini-swe 共识：

- 一个 `while` 主循环，子代理是再入，不是第二引擎
- 星型委派，子→父只有摘要
- 阶段靠 permission mode + 清单，不靠可搜索拓扑
- 取消 / 拒权 / 超时 / unknown 与 `completed` 分开

新 Loop 状态（判别联合，禁止布尔堆）：

```text
Idle → Turning → Streaming → Tooling → (Turning | Terminal)
Terminal.reason = completed | failed | cancelled | unknown
```

`completed` **不等于** 经过验证。验证是另一事实（artifact check），默认不拦住 terminal。这是 D5 的实现位置，P00 只把两个事实分开。

Continue 只允许：retry、compact、token budget、permission block、**bounded_recheck**（预留，P00 实现为 no-op 枚举值）。禁止再占位 `loopRunner`。

### 2.4 P00 事件种类（从旧词汇归一，学习中性）

Envelope 用 P00 规格 §5。`kind` 首批只这些：

| kind | 来源 | P00 必须 |
| --- | --- | --- |
| `session_start` / `session_end` | EVENT_VOCABULARY | 是 |
| `loop_start` / `loop_end` | 同上 | 是 |
| `turn_start` / `turn_end` | 同上 | 是 |
| `api_call` / `api_retry` / `model_fallback` | 同上 | 是 |
| `text` / `thinking` | 同上 | thinking payload 可空 |
| `tool_use` / `tool_result` / `permission_denied` | 同上 | 是 |
| `subagent_spawn` / `subagent_end` | `subagent` 拆开 | 是 |
| `compact` | 同上 | 是 |
| `user_cancel` / `user_reject` | 用户终止 | 是 |
| `terminal` | 终态；reason 见上 | 是 |
| `file_write` | 旧 `memory_updated` 改名 | 是：路径/操作/大小 |
| `user_correction` | 用户明确纠正或确认 | **P00 要做**：D3 信号，正文+why |
| `check_result` | 外部检查 PASS/FAIL/PARTIAL | **P00 要做**：D4/D5 信号，不是权限 |

环外 worker 自己的 dream/extract 日志仍不进 Protocol。P00 **要做** 的是：把纠正和检查变成 canonical 事件，并让 ContextPort 能读已生效片段。

每条事件有 `eventId`、`attemptSequence`、`correlationId`。学习以后只读 journal 的 **隐私过滤投影**，不另造第二日志偷采集。

## 3. 学习怎么融进核心

### 3.1 默认方案（D1–D7 在此拍板为建议默认）

对应讨论稿候选 **B（薄控制面）+ A 的故障降级**。不选 C。

| D | 默认 | 报告依据 | 核心落点 |
| --- | --- | --- | --- |
| D2 | 已生效知识可改变「建议步骤 / 已批准检查」；**不能**改权限、工具集、Loop 拓扑 | 旧 CLI 只改 markdown/SKILL.md；开源产品同构 | `ports/context.ts` 输出文本+检查清单，不输出 allow 规则 |
| D5 | 已批准检查可触发 **有界** `bounded_recheck`；默认 **不** 阻断 `completed` | verificationAgent 的 VERDICT 存在但未消费；inspect-ai 才有分→续轮 | Loop 认得 recheck 枚举；P00 实现恒为 Pass |
| D3 | 用户明确纠正 → 写入候选，**下次任务**装载即生效；可关采集。推断只候选 | feedback 类型；skillImprovement 有人审；gemini inbox | 环外 store；Loop 只看见已 active 快照 |
| D4 | Agent 经验：自动候选；**验证准入**后才试用；禁止自动晋升 | Voyager 成功才入库；ReasoningBank 假成功更毒；旧 extract 无监督是要修的债 | P05 治理；P00 不管 |
| D6 | 同轮不更新长期资产；写入后 **下次 turn 的 context 组装** 才可见 | TT1：四条写入通道当轮不回注 | Context 每 turn 重取；不做热替换 |
| D1 | 结构化头（type/scope/version/active）+ 自然语言正文；检索用规则/LLM 元数据，**向量不当事实源** | 旧 memdir；Mem0 向量不是产品差异 | 环外文件；Context 只收已筛选片段 |
| D7 | 关键决策事件 + 因果 ID；学习读投影。不全量存执行日志 | loopEvents 已够；问卷不回流（reward 05） | journal 投影；collect=false 则投影为空 |

证伪：P03 若证明行为差 = 多塞 prompt，整份退回候选 A（Context 仍在，只是永远空快照）。

### 3.2 两个接点（不是八个，不是四端口旧名）

Loop 只认这两个端口。P00 **必须做出可测的纵切，不是永远 no-op**：

- 文件库 `internal/knowledge/`：片段 = `{ id, type: user|feedback|project|reference|method, scope, version, state: pending|active|withdrawn, body, why? }`
- `recordCorrection(text, why)` → 写 `active` 片段 + 发 `user_correction`
- `appendCandidate(body)` → 只写 `pending`，下次 assemble **看不见**
- `assemble()` 读全部 `active` 进 `systemFragments`；`pending`/`withdrawn` 不进
- `project({ collect: false })` 必须空

旧总领「L01 前不准动学习」**作废**。本方案授权 P00 实现上述纵切。不搬 v0.3 类型名，不搬 memdir 目录结构，但 **机制必须开工**。

```text
ContextPort.assemble(turnInput) ->
  { messages, systemFragments, requiredChecks: [] }
  失败/超时 -> 与空 fragments 等价，Loop 继续

Journal.project(filter) ->
  只读事件投影 | Empty   // collect=false => Empty
  Loop 从不 await 学习 worker
```

对照旧 CLI（机制保留，模块不搬）：

| 旧符号 | 新位置 |
| --- | --- |
| `claudemd` + `context.getUserContext` | 将来的 ContextPort 实现（P02/P05） |
| `stopHooks` → extract/autoDream | 环外 worker 订阅 `Journal.project`（P05） |
| `runForkedAgent` | P05 实现细节，P00 禁止出现 |
| `verificationAgent` VERDICT | 将来可写入 `tool_result`/`file_write` 旁的普通字段；P03 再接到 `requiredChecks` |
| `skillImprovement` | P05 + 人审；改的是 skill 文件，不是 Loop |
| desktop `user-learning/types.ts`、v0.3 Episode | **不迁**；语义能对上 D3/D4 的留下，类型扔掉 |

权限：`PermissionPort` 不读 ContextPort。学习失败不得扩大权限。

### 3.3 环外学习（P05，今晚不建）

数据流照旧 CLI 五段，换成订阅 journal：

```text
turn_end / terminal
  → 环外 worker（非阻塞）
  → 候选文件（pending）
  → 人审或验证准入 → active
  → 下一次 ContextPort.assemble 读到
```

治理抄 W3，仍是 P05：ExpeL counter、ReasoningBank 成败双源、Voyager 成功才入库。P00 不预埋 store。

v0.3 的 Episode/补丁/实验留在 Desktop/Host 实验库，新 CLI 不 import。

## 4. 开源贡献清单（只这些进方案）

**进核心形状**

- 旧 CLI `query.ts`：单循环 + Terminal reason 枚举
- OpenCode `runLoop`：固定顺序、step 熔断（学形状）
- Codex：任务类型静态、hooks 在采样循环内、权限地板
- Goose recipe：工作流是人写资产，不是搜索对象
- mini-swe：证明静态循环够用；新 CLI 不比它更「智能结构」

**进环外学习（P05）**

- AWM：markdown 归纳、全文注入、不要代码化 workflow
- ExpeL：规则池 counter
- 旧 CLI extract/autoDream 两段式 + feedback 记纠正与成功
- Codex citation / gemini inbox：人审与归因
- SkillWeaver/Voyager：verified-only、版本化（技能面，P03/P05）

**不进**

- OpenCode 类型、LangGraph 图、MARL 训练、Gödel 热替换、DGM 自改源码、DSPy、向量库当事实源、v0.3 schema、loopRunner 死壳

## 5. 不做

- 复制旧 CLI / memdir / v0.3 schema 进新树
- 从 `open/` import
- 问卷/frustration/advisor 当学习信号
- 用 `completed` 冒充验证通过
- 学习授予权限或改 Loop 拓扑
- pending 片段自动晋升为 active

## 6. 文档优先级

**本方案 > 今晚提示词/WP > AGENTS.md 与 00-总领里「L01 前不得学习」的旧句。** 许可 A–E、质量第一门禁、不抄 open/ 仍有效。P00 **要做** §3.2 纵切，不是只留空端口。

## 7. 今晚四包（同时开工，每包是整块子系统）

共享合同已落在 `src/internal/contract/`（只读，四包禁止改）。`package.json`/`tsconfig.json` 禁止改。互不等待。

| ID | 子系统 | 工作量（必须做完，不是空壳） |
| --- | --- | --- |
| N1 | Protocol + 8 类合成 trace + ADR | parse/seq/脱敏/兼容 + 8 条 jsonl + ADR 草案 |
| N2 | Loop reducer | 旧 CLI 终态/continue 全覆盖测试；cmd 可跑一轮假循环 |
| N3 | 用户学习 | 纠正+确认+撤回+assemble；读旧 memoryTypes.feedback 行为 |
| N4 | Agent 学习 + journal | pending 候选、check_result 才晋升、投影、对照 extract/autoDream |

文件所有权：

| 包 | 只许写 |
| --- | --- |
| N1 | `src/internal/protocol/`、`testdata/protocol/`、`testdata/parity/`、P00 产出里 ADR-0001 / RELEASE-TOPOLOGY / LICENSE-REMEDIATION / N1-STATE / N1-RUN |
| N2 | `src/cmd/`、`src/internal/domain/`、`src/internal/loop/`、`ports/provider.ts|tools.ts|permission.ts`、`testdata/loop/`、N2-STATE/RUN |
| N3 | `src/internal/knowledge/store.ts`、`user.ts`、`src/internal/ports/context.ts`、`testdata/knowledge/user/`、N3-STATE/RUN（L01 目录） |
| N4 | `src/internal/knowledge/agent.ts`、`promote.ts`、`src/internal/journal/`、`testdata/knowledge/agent/`、OLD-CLI-TO-PORTS.md、N4-STATE/RUN |

执行清单与提示词：`docs/02-分期工程产出/P00-工程地基与质量门禁/2026-09-12-FOUR-PROMPTS.md`。WP 不得再发明架构。
