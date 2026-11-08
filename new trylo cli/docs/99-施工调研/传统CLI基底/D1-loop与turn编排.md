# D1 Loop 与 Turn 编排机制（传统 Agent 基底）

> 调研根 OPEN = `D:\CC\trylo\new trylo cli\open\01-agent-cli-runtimes`。所有 `路径:符号` 均经 grep/Read 验证。所有权基线：`docs/00-总领/TRYLO-CLI-双循环学习控制面架构.md` §4.1——provider 流、tool call、取消、重试、terminal 归 Execution Loop 唯一所有者。

## 0. 一页结论

1. 七家全部是"双层循环"形态：外层 turn/step 迭代决定是否再问模型，内层消费 provider 流；差别在外层是 while、递归 generator 还是"操作列表 step 重入"。
2. "一轮结束"没有一家只看 finish reason：全部取交集 = finish ∩（无未决 tool 请求）∩（无 pending 输入 / 语义继续判定 / 终止契约工具）。opencode 甚至把 `tool-calls`/`unknown` 列为"不许退出"的黑名单。
3. 预算分两派：硬终止派（aider num_reflections=3、mini step/cost/wall 闸、cline maxIterations、goose 1000 默认但弹"要不要继续"）与软收敛派（opencode/codex 到 max-steps 后注入"禁用工具只做总结"提示、gemini 靠 checkNextSpeaker 递归深度）。
4. 历史重读两派：数据库权威（opencode V1 `filterCompactedEffect`、V2 `SessionHistory.entriesForRunner`、codex `clone_history().for_prompt`）vs 内存累积（cline、aider、gemini、mini、goose legacy）。
5. 插话能力光谱：aider 无（只有 ^C）→ gemini 排队+随下次请求夹带 hint → cline 每次模型请求前消费一条 pending → codex/opencode-V2/goose 真 steer（活动 turn 内注入下一个安全边界）。
6. provider 再请求一律发生在"工具结果全部回填历史之后"；并行工具（codex FuturesOrdered、cline parallel、opencode FiberSet）都在本轮 step 结束前 await 全部结果，无一允许半回填开新请求。
7. mini-swe-agent 用 130 行给出最小完备形态：终止即 exit 消息、每步 finally 落盘、异常类型即控制流分支——三条都是 Trylo 解释器模型可直接吸收的不变量。
8. Trylo runTurn+reduce 与七家 while 等价（tool 结果→openStream→新 provider 流），但迭代由事件推送链驱动而非循环拉取；PhaseName 缺多 tool 并行、provider 轮次预算、compaction、pending 输入四个循环维度。

## 1. 循环拓扑

结论（每家一行）：

- **opencode**：V1 单层 `while(true)` 外循环 + processor 内层流消费（`OPEN/opencode/packages/opencode/src/session/prompt.ts:runLoop`）；V2 双层 while：外层 queue 提升、内层 step 续跑（`packages/core/src/session/runner/llm.ts:run`），且 step 函数 `runTurnAttempt` 可重入（compaction 通过 `TurnTransitionError` die/catch 重进）。
- **codex**：三层。`submission_loop` 永久消费提交队列（事件驱动，非模型循环）→ `RegularTask::run` 的 `loop{run_turn}`（pending 输入续 turn）→ `run_turn` 内 `loop{run_sampling_request}`（模型/工具迭代）。
- **goose**：双轨并存。legacy `reply_internal` 外层 `loop` + 内层流 `loop`（`crates/goose/src/agents/agent.rs`）；新 `StateMachine::run` = `loop{load→step→apply}`，step 按操作列表顺序扫描、首个 Applied 即返回——step 函数天然可重入（`crates/goose-agent/src/machine.rs:step/run`）。
- **gemini-cli**：非交互是单层 `while(true)`（`packages/cli/src/nonInteractiveCli.ts:runNonInteractive`）+ 内层 for-await；交互核心 `sendMessageStream` 是**递归 generator** 而非循环（续工具/续 speak 都 `yield*` 自身）。
- **cline**：`execute` 单层 `while (iteration < maxIterations)` 内联全部流消费（`sdk/packages/agents/src/agent-runtime.ts:execute`）；外层 orchestrator 只保证单 run 所有权（`activeRunPromise`），不再循环。
- **aider**：四层嵌套：`run`（交互 while True 读输入）→ `run_one`（reflection while）→ `send_message`（retry while True）→ `send`（一次请求流）。没有 tool 循环（见 §6）。
- **mini-swe-agent**：教科书单层 `while True { step(); 查 exit 消息 }`（`src/minisweagent/agents/default.py:run/step/query/execute_actions`）。

证据清单：`prompt.ts:1081,1088`；`llm.ts:390,400-412`；`session/handlers.rs:529`；`tasks/regular.rs:78`；`session/turn.rs:335`；`agent.rs:2559,2699`；`machine.rs:158-173`；`nonInteractiveCli.ts:316`；`client.ts:910,896`；`agent-runtime.ts:727`；`base_coder.py:882,932,1457`；`default.py:96`。

## 2. 「一轮结束」的精确判定

- **opencode V1**：退出表达式（`prompt.ts:runLoop`）= `lastAssistant.finish` 存在 **且** `!["tool-calls","unknown"].includes(finish)`（黑名单）**且** `!hasToolCalls`（最后 assistant parts 中无未回填 tool part，排除 `providerExecuted` 与孤儿中断件 `isOrphanedInterruptedTool`，1106-1109）**且** `lastAssistant.parentID === lastUser.id`（1111-1116）。附加 break：structured 输出达成（1288-1292）、`content-filter` finish 转错误（1301）、compaction 返回 "stop"（1157）。
- **opencode V2**：`needsContinuation` 仅在流中出现非 providerExecuted 的 `tool-call` 事件时置 true（`llm.ts:250-255`），流结束后 `!publisher.hasProviderError() && needsContinuation` 决定内层是否再转（352）；即使 false，若仍有 pending steer 也强制续（408）。
- **codex**：`needs_follow_up = model_needs_follow_up || has_pending_input`（`turn.rs:475`）。前者由 `run_sampling_request` 内工具处理置位（2509）或流尾 `end_turn == Some(false)`（2689-2690）；后者查 `InputQueue::has_pending_input`（`input_queue.rs:329`）。`!needs_follow_up` 后还要过 `run_turn_stop_hooks`（554）：`should_block` 注 prompt 再续（587）、`should_stop` 才 break（598/611）。
- **goose legacy**：`no_tools_called && !exit_chat` 进入分支梯子（`agent.rs:3361`）：final_output 契约工具未调用→注入续跑消息；已调用→`exit_chat=true`；有 pending steer→本轮让位；goal/grind 未完成→注入 nudge 继续；recipe retry→重开；空响应→`MAX_EMPTY_TURN_RETRIES` 有界重试后 `EMPTY_TURN_MESSAGE` 退出（3438-3460）；全不命中→`exit_chat = true`（3471）。
- **gemini**：两层判定。Turn 层只在 `resp.candidates[0].finishReason` 存在时 yield Finished（`turn.ts:run` 394-410，"有 finishReason 才算完"）；请求层在 `!turn.pendingToolCalls.length && !aborted` 时跑 `checkNextSpeaker`，模型说 `next_speaker === 'model'` 就"Please continue."递归再来一轮（`client.ts:875-906`）；非交互外层则 `toolCallRequests.length > 0` → 回填再循环，否则 return（`nonInteractiveCli.ts:482/589-590`）。
- **cline**：`toolCalls.length === 0` 先过 `getCompletionReminderMessages()`（终端完成工具未调用则注入提醒 continue，791-805）；无提醒才 `finishRun("completed")`；有工具则执行后查 `findCompletingToolMessage`（`lifecycle.completesRun` 工具成功返回即完成，850-867）。
- **aider**：一次 send_message 回复应用完 edits 即算完（`apply_updates` 1585）；"结束"与否交给外层 reflection——`reflected_message` 为空即 break（`run_one:936`）。
- **mini**：`self.messages[-1]["role"] == "exit"`（`run:122`）。终止是一种消息，不是循环谓词。

## 3. 循环预算与防失控

- **opencode**：`agent.steps ?? Infinity`（V1 `prompt.ts:1178`；V2 `agent.info?.steps`，`llm.ts:202`）。超限不是 kill：末步注入 `MAX_STEPS_PROMPT`（禁用工具、只要总结，`runner/max-steps.ts`）+ V2 直接 materialize 空工具表、`toolChoice:"none"`（203/220）。新输入 promote 重置预算（195）。
- **codex**：**无轮数预算**（搜索关键词 `max_turns`/`iteration` 于 `core/src/config` 无果）。防失控 = 上下文档位：`context_window_token_status` + `should_roll_over` → `run_auto_compact(CompactionReason::ContextLimit, MidTurn)` 滚窗续跑（`turn.rs:510-550`）+ stop hooks 有界（`stop_hook_active` 只防 hook 死循环，一次 `build_hook_prompt_message` 续）。
- **goose**：`max_turns` 默认 `DEFAULT_MAX_TURNS = 1000`（`agent.rs:90`，`GOOSE_MAX_TURNS` 覆盖）；超限发 `MAX_TURNS_MESSAGE`"I've reached the maximum number of actions… Would you like me to continue?" 再 break——**终止但询问**（2646-2649；状态机侧 `ops_maxturns.rs:MaxTurnsOperation` 同语义，且过半时注入 `<turn-budget>n/m used</turn-budget>` moim 提醒）。stop hook 拒绝另有 `GOOSE_STOP_HOOK_BLOCK_CAP` 计数封顶（2613-2624）。
- **gemini**：核心 `MAX_TURNS = 100`（`client.ts:79`），每次递归 `boundedTurns - 1`，`min(turns, MAX_TURNS)` 夹紧（960）；非交互外层 `getMaxSessionTurns()` 默认 **-1 = 无限**（`core/config/config.ts:1243`），≥0 且超限才 `handleMaxTurnsExceededError` 终止（`nonInteractiveCli.ts:318-322`）。另有 `LoopDetected` 事件（client 的 loopDetector）熔断重复模式。
- **cline**：`maxIterations === undefined` 时**无限**（`agent-runtime.ts:727-729`，SDK 无默认值，由 agent 配置注入）；超限 throw `exceeded maxIterations`（870）——硬终止进 failed。
- **aider**：`num_reflections = 0; max_reflections = 3`（`base_coder.py:100-101`）；`run_one:939-941` 达到即 warning 停止（**终止不再问**）。`init_before_message` 每条用户消息复位（864-867）。输出 token 打满走 `FinishReasonLength`→assistant prefix 继续（1492-1505），窗口打满走 exhausted 报错（1464）。
- **mini**：`step_limit: int = 0`（0=无限制）、`cost_limit: float = 3.0`、`wall_time_limit_seconds: int = 0`、`max_consecutive_format_errors: int = 3`（`AgentConfig:26-33`）；全部是 `query()` **前置闸门**，触发即 raise `LimitsExceeded`/`TimeExceeded`（`default.py:132-147`）。

## 4. 每轮重读历史 vs 内存累积

- **opencode**：两版都**每迭代从 DB 重读**。V1 `MessageV2.filterCompactedEffect(sessionID)`（`prompt.ts:1092`）；V2 `SessionHistory.entriesForRunner(db, session.id, baselineSeq)`（`llm.ts:200`），且每 step 重建 system/context epoch（183/198）。
- **codex**：**每次采样请求从 session 权威历史重建**：`sess.clone_history().await.for_prompt(...)`（`turn.rs:422-428`）；step_context 重捕获（368-404）。工具/用户输入先 `record_*` 进历史再重读。
- **goose**：legacy 内存 `conversation` 增量 + 每条消息 `persist_and_push_message_with_id` 落盘；状态机每 step `runtime.load(session_id)` 重新加载（`machine.rs:163`），effect 可 `ReplaceConversation` 整段换血（`goose-agent/src/operation.rs:ConversationEffect`）。
- **gemini**：内存累积。`GeminiChat` 持有 contents，交互 `recordCompletedToolCalls/addHistory`（`nonInteractiveCli.ts:537`；`useGeminiStream.ts` quota 分支），循环间只传**增量** parts。
- **cline**：内存 `this.state.messages`（execute push），每次请求 `cloneMessages(this.state.messages)` 全量重发（`agent-runtime.ts:1041`）；orchestrator 侧 `prepareMessagesForModelRequest` 每请求加工（`session-runtime-orchestrator.ts:1105`）。
- **aider**：内存 `cur_messages`/`done_messages`（`base_coder.py:395-403`）；`send_message` 每次 `format_messages()` 从内存组包（1429）；`move_back_cur_messages`（1036）与 summarizer（1003-1034）做降级。
- **mini**：内存 `self.messages`，`model.query(self.messages)` 全量重发（`default.py:149`）。

## 5. 运行中插话（steer / queue）

- **codex**：最完整。全部输入走 `Op` 枚举 submission 队列（`protocol.rs:596`）；`TurnInputMode::StartOrSteer | StartIfIdle | Steer{expected_turn_id}`（`protocol/src/turn_input.rs:133`）决定 idle 起新 turn 还是 steer 活动 turn（`turn_input.rs:steer:472→Session::steer_input:576`）→ 落入 `InputQueue`（`input_queue.rs:81`，`extend_pending_input_for_turn_state:272`）；`run_turn` 在下一次采样前 `get_pending_input` 排空（`turn.rs:339`），且**pending 输入并入 needs_follow_up**（475）——有插话就不许收轮；外层 `RegularTask::run` 靠 `has_pending_input` 续跑整个 run_turn（`regular.rs:94`）；空闲时 mailbox `trigger_turn` 由 `maybe_start_turn_for_pending_work`（`tasks/mod.rs:427/441`）拉新 turn。
- **opencode**：V2 一等公民。durable `session_input` 表 admit（`core/src/session/input.ts:admit:41`，幂等、带 `admitted_seq`）；delivery 二值 `"steer"|"queue"`；`promoteSteers`（245，cutoff=当前事件序列，安全边界提升）/`promoteNextQueued`（268，一次只提一条）/`hasPending`（170）。唤醒路径：`SessionExecution.wake`（`execution.ts:16`）→ `SessionRunCoordinator.wake` 合并 pendingWake、活动 run 结束即 successor 续跑（`run-coordinator.ts:81-92/51-65`）。AGENTS.md「V2 Session Core」（`opencode/AGENTS.md:151` 起）明文：steer 下个安全边界提升并重置步数预算，queue 在"本该空闲"时提升一条再重估。V1 无 steer（搜索 `steer|queue` 于 `packages/opencode/src/session` 无输入实现）。
- **cline**：每轮迭代级。`consumePendingUserMessage`（config 注入的回调）在 `iteration > 1` 的每次模型请求前消费**一条**并追加到本请求（`agent-runtime.ts:1058-1068/1589`）；所有权由 orchestrator 单 run 保证（`session-runtime-orchestrator.ts:activeRunPromise:356`，`executeRun` 726-738 设置/清除，`run` 重置 vs `continue` 续写 675-701）。
- **goose**：两边都有。`SteerQueue = Arc<Mutex<VecDeque<Message>>>`（legacy `agent.rs:steer_queues`，`drain_pending_steers:592`，仅在 `can_drain_pending_steers=true`——上轮工具处理完——时排空，2564/3322）；状态机 `SteerOperation`（`ops_steer.rs`）排第一，`ends_turn || last role == Tool` 才 Applied。
- **gemini**：交互无真 steer。流式中输入进 `useMessageQueue`（`ui/hooks/useMessageQueue.ts:popAllMessages`），streaming 完成后作为新 query 提交；运行中 steering hint 刻意**不消费**，夹带进下一次工具回填消息（`useGeminiStream.ts:2162-2181`，`buildUserSteeringHintPrompt` unshift 到 responsesToSend）。非交互无插话。搜索词记录：`steer|queue|pending_user|follow_up`。
- **aider**：**无**。只有 ^C KeyboardInterrupt → 在 cur_messages 写 `^C` 对（`base_coder.py:1489/1575-1583`）。搜索 `queue|pending_user` 无运行中输入实现。
- **mini**：**无**。单发任务循环（搜索词 `interrupt|steer|queue`）。

## 6. Provider 请求构造时机与工具并行

共识：工具结果**全部**回填历史/消息数组后才构造下一次请求；无一允许部分回填抢跑。

- **codex**：流式解析中每个可执行工具立即 spawn 进 `in_flight: FuturesOrdered`（`turn.rs:2326/2504`），流结束后 `drain_in_flight` 等全部完成（2229/2861）→ 输出记入历史 → 外层 loop 重建 `sampling_request_input`（422）再发。并行发起、整轮等待。
- **opencode**：V2 每个 `tool-call` 事件 `FiberSet.run(toolFibers)` 并发 settle（`llm.ts:278`），step 收口 `awaitToolFibers`（141/303）后才 publish `Step.Ended`、返回 needsContinuation；结果即 durable 事件，下一请求由重读历史组成。V1 每个外层迭代重新 `SessionTools.resolve` + `handle.process`（`prompt.ts:1226/1272`）。
- **cline**：`executeToolCalls`——`toolExecution:"sequential"`（默认，528）逐个 await；`"parallel"` 则 `Promise.all` 等全部（1639-1643）；结果 push 进 messages，下一 while 迭代 `generateAssistantMessage` 全量重发。
- **gemini**：非交互收集整批 `toolCallRequests` → `scheduler.schedule` 一次拿 `completedToolCalls`（`nonInteractiveCli.ts:324/484`）→ 拼 `toolResponseParts` 作为下一轮 `currentMessages`（589）。交互则 `submitQuery(responsesToSend)` 触发下一轮 `sendMessageStream`。
- **goose**：legacy 在流内遇 ToolRequest 排队、本轮内联执行回填 `messages_to_add`；状态机 `ToolExecutionOperation` 用 `pending_tool_requests`（`ops_toolcalling.rs:622/652` "未 answered 的 id 集合"）统一消化。未见并行证据，语义按序。
- **aider**：模型不回工具——edit block 由 `apply_updates` 本地解析写盘（1585）；shell 命令 `run_shell_commands` 的输出以 user/assistant 对子注入 `cur_messages`（1609-1614），影响的是**下一次 send_message**（reflection 级），不是同消息内。
- **mini**：`execute_actions` 顺序 `[env.execute(a) for a in actions]`，observation 消息全量回填后 while 下一圈 `model.query(self.messages)`（`default.py:154-157`）。

## 7. mini-swe-agent 最小 loop 逐行拆解

伪代码（`default.py:DefaultAgent`，不复制原文）：

1. `run(task)`：清空 `messages`；压入两条模板渲染消息——role=system、role=user(instance_template 注入 task)。
2. 进入 `while True`：
3. 尝试 `step()` = `execute_actions(query())`；成功则清零连续格式错误计数。
4. 若抛 `FormatError`（模型输出不合协议）：把已被计费的成本累进 cost（解析失败前已产生 token 费）；连续错误计数 +1；达到 `max_consecutive_format_errors(3)` 则**追加一条 role=exit、exit_status=RepeatedFormatError 的消息**；否则只把错误提示消息追加回去让模型自纠。
5. 若抛 `InterruptAgentFlow`（业务型中断，如工具要求换流程）：追加其自带消息，继续循环。
6. 其他异常：`handle_uncaught_exception` 先追加 role=exit（带 traceback 与异常类名）落盘保轨迹，然后 re-raise。
7. `finally`：**每次迭代**都 `save(output_path)`——整条 trajectory + 模型/环境统计 + exit 状态序列化重写盘。
8. 循环出口唯一判定：`messages[-1].role == "exit"` → break，返回最后一条消息的 extra（exit_status/submission）。
9. `step()` 本体三步：`query()` → 模型消息 → `execute_actions()` 提取 `extra.actions` 逐个 `env.execute` → 结果格式化成 observation 消息追加。
10. `query()` 前置闸门：`step_limit ≤ n_calls` 或 `cost_limit ≤ cost` → raise `LimitsExceeded`；`wall_time_limit ≤ 已耗时` → raise `TimeExceeded`——都以 exit 消息形态终结；全过则 `n_calls += 1`，`model.query(self.messages)` 全量历史重发，计费累加，回复追加。

Trylo 值得学的三个不变量：
- **终止即消息**：exit 是历史中的一等消息（含异常/预算/成功全路径），终态可被重放和投影——与 Trylo `Envelope(kind="terminal")` + Journal 事实流同构，但 mini 把"为什么终止"（exit_status 枚举）也放进消息本身。
- **每步落盘**：finally-save 让崩溃恢复 = 读最后一个轨迹文件，与 §4.1 的"向 Journal 写执行事实"一致，且落盘点在错误路径也覆盖。
- **异常分类即控制流**：FormatError（可恢复、留在环内）、InterruptAgentFlow（可恢复、注入消息）、LimitsExceeded/TimeExceeded（终态化）、未知异常（终态化+上抛）四类各接一条边——Trylo 的 `transport_fail/unknown` 与 `tool_failed/unknown` 已具雏形，缺的是"分类 → 循环走向"的显式表。

## 8. Trylo 对照与缺口

先读锚点确认的现状：`src/internal/loop/runner.ts:runTurn`(68) = 组装 context → `dispatch(start_turn)` → `reduce`(reduce.ts:29) 产 state+EffectCommand → `interpret`(168) 逐命令执行；`runProvider`(215) for-await 拉流、每个事件回灌 `handleProviderEvent`(268)→dispatch；`reduce.ts:applyToolOutcome`(318) 在 tool 终态后 phase→turning、streamIndex+1、重新 `openStream` → 解释器再执行 `stream_provider`。

**等价性**：dispatch→commands→interpret 的链式重入就是七家的"回填后再发一次请求"：`tool_succeeded` 输入 = codex 的 needs_follow_up=true = opencode V2 的 needsContinuation=true。事件链自然停止（provider 发 `finish`）= `reduceStreaming:129` terminate completed。幂等键/seenEventIds/reorder buffer 是七家都没有的严谨超集。

**差异（谁驱动迭代）**：七家是**循环拉取**——外层 while 每次迭代主动决定"要不要再问模型、从哪份权威历史问"；Trylo 是**事件推送链**——没有外层 while，迭代是"结果事件触发下一条 effect command"的被动传染。后果：(a) Trylo 无法在"再问模型之前"插入预算检查/steer 排空/compaction 判定这些**迭代间隙钩子**（七家全在钩子里做，见 §2/§3/§5）；(b) 历史由 runTurn 入参 `engine.messages` 固定，`applyToolOutcome` 开新流时**不重读任何权威历史**，等价于"内存累积派"，但连内存累积都只存在于调用方。

**PhaseName 缺少的循环维度**（只列缺口，`state.ts:10-16`）：
1. **多 tool 并行**：`activeToolCallId` 单值 + `tooling` 单相位，无法表达 codex in_flight / cline parallel / opencode FiberSet 的"一批工具在途、全部落定才开下一请求"。
2. **provider 轮次预算**：无"本 turn 已做第几轮模型调用"的状态维度（streamIndex 是流序号非轮次；MAX_ATTEMPTS=3 只管传输重试），七家全有 §3 的闸门与超限策略。
3. **无工具结果续问 vs 终止判定分离**：`finish` 即无条件 completed，缺 opencode "finish 但仍有未决 tool part 不许退"、cline "finish 但完成工具未调用要 nudge"、gemini checkNextSpeaker 这类**迭代末判定**相位。
4. **pending/steer 输入**：`ReduceInput` 无"运行中新用户输入"类型（搜 input.ts：仅 start_turn/cancel/retry/check_result），缺 §5 的 queue/steer 语义与提升边界。
5. **compaction/context-overflow**：无溢出探测、无"压缩后续跑同一逻辑轮"的相位（opencode TurnTransition、codex MidTask MidTurn compact 的对应物）。
6. **等待再输入态**：terminalReason 无"预算耗尽待用户批准继续"（goose MAX_TURNS_MESSAGE 的 would-you-continue）这类半终态。

## 附：证据符号索引

| 仓库 | 路径:符号 | 一句话作用 |
|---|---|---|
| opencode | packages/opencode/src/session/prompt.ts:runLoop | V1 单层 while 外循环、退出黑名单判定 |
| opencode | prompt.ts:filterCompactedEffect 调用(1092) | 每迭代从 DB 重读压缩后历史 |
| opencode | prompt.ts:handleSubtask / compaction.process | subtask 分派与压缩分支 |
| opencode | packages/core/src/session/runner/llm.ts:run/runTurnAttempt | V2 双层 while 与可重入 step |
| opencode | runner/llm.ts:needsContinuation(255/352/408) | tool-call 事件与 pending steer 驱动续跑 |
| opencode | runner/max-steps.ts:MAX_STEPS_PROMPT | 末步禁工具软收敛 |
| opencode | packages/core/src/session/input.ts:admit/promoteSteers/promoteNextQueued/hasPending | durable steer/queue 收件箱 |
| opencode | packages/core/src/session/execution.ts:SessionExecution.wake | 新输入唤醒执行（advisory） |
| opencode | packages/core/src/session/run-coordinator.ts:make/settle | 每 session 串行、wake 合并、successor 续跑 |
| codex | codex-rs/core/src/session/handlers.rs:submission_loop | 永久提交分发循环（Op 全家族入口） |
| codex | codex-rs/protocol/src/protocol.rs:Op | 输入/审批/控制枚举全集 |
| codex | protocol/src/turn_input.rs:TurnInputMode | StartOrSteer/StartIfIdle/Steer 路由 |
| codex | core/src/tasks/regular.rs:RegularTask::run | loop{run_turn}，pending 输入续整轮 |
| codex | core/src/session/turn.rs:run_turn | 内层采样 loop 与 needs_follow_up 判定 |
| codex | turn.rs:clone_history().for_prompt | 每请求重建模型输入 |
| codex | turn.rs:drain_in_flight/in_flight | 工具并行发起、整轮等待 |
| codex | turn.rs:run_auto_compact(MidTurn) | 滚窗压缩代替轮数预算 |
| codex | session/turn_input.rs:steer/steer_input；input_queue.rs | 活动 turn 插话通道 |
| codex | tasks/mod.rs:maybe_start_turn_for_pending_work | 空闲时 mailbox 拉新 turn |
| goose | crates/goose/src/agents/agent.rs:reply_internal | legacy 外 loop+内流 loop 双轨之一 |
| goose | agent.rs:no_tools_called 分支梯子(3361+) | 终止判定的契约工具/goal/retry 梯子 |
| goose | agent.rs:DEFAULT_MAX_TURNS/MAX_TURNS_MESSAGE | 1000 轮默认，超限转询问 |
| goose | agents/state_machine/ops_steer.rs、ops_maxturns.rs、ops_toolcalling.rs:pending_tool_requests | 状态机侧 steer/预算/工具消化 |
| goose | crates/goose-agent/src/machine.rs:step/run | 操作列表扫描、每 step reload |
| gemini-cli | packages/cli/src/nonInteractiveCli.ts:runNonInteractive | 单层 while+tool 回填 currentMessages |
| gemini-cli | packages/core/src/core/client.ts:sendMessageStream/checkNextSpeaker | "Please continue." 递归、MAX_TURNS=100 |
| gemini-cli | packages/core/src/core/turn.ts:Turn.run | finishReason 存在才 yield Finished |
| gemini-cli | packages/cli/src/ui/hooks/useMessageQueue.ts；useGeminiStream.ts:consumeUserHint | 交互排队与 steering hint 夹带 |
| cline | sdk/packages/agents/src/agent-runtime.ts:execute | maxIterations while+完成工具契约 |
| cline | agent-runtime.ts:consumePendingUserMessage(1058/1589) | 每轮模型请求前消费一条插话 |
| cline | agent-runtime.ts:executeToolCalls | sequential 默认 / parallel Promise.all |
| cline | sdk/packages/core/src/runtime/orchestration/session-runtime-orchestrator.ts:executeRun/activeRunPromise | 单 run 所有权与 continue 续写 |
| aider | aider/coders/base_coder.py:run/run_one/send_message/send | 四层嵌套；reflection 循环 |
| aider | base_coder.py:init_before_message/num_reflections/max_reflections=3 | 每消息复位反思预算 |
| aider | base_coder.py:apply_updates/run_shell_commands | 本地应用编辑、shell 输出注入历史 |
| mini-swe-agent | src/minisweagent/agents/default.py:run/step/query/execute_actions | 最小 while True + 前置 limits 闸门 |
| mini-swe-agent | default.py:handle_uncaught_exception/AgentConfig | 异常转 exit 消息；预算默认值 |
| Trylo | src/internal/loop/runner.ts:runTurn/dispatch/interpret/runProvider | 解释器骨架与流拉取 |
| Trylo | src/internal/domain/reduce.ts:applyToolOutcome/reduceStreaming | 工具回填→新流；finish→终止 |
| Trylo | src/internal/domain/state.ts:PhaseName；input.ts:ReduceInput | 循环维度缺口清单的对照基准 |
