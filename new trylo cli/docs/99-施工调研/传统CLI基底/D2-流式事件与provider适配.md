# D2 模型流式事件与 Provider 适配层

> 调研根：`open/` = `D:\CC\trylo\new trylo cli\open`。行号以本快照为准。Trylo 锚点：
> `src/internal/ports/provider.ts`（ProviderEvent）、`src/internal/loop/provider-input.ts`、`src/internal/loop/reorder.ts`、`src/internal/loop/runner.ts`。

## 0. 一页结论

1. **翻译层位置收敛**：所有成熟 CLI 都把「模型词汇→内部事件」压到**每协议一个纯函数状态机**（opencode `protocols/*.ts::step`、codex `sse/responses.rs::process_responses_event`、goose `formats/anthropic.rs::response_to_streaming_message`、cline `llms/providers/ai-sdk.ts`、vercel 各 `*-language-model.ts::doStream`），再往内才是 loop 落库/落 UI。事件词汇正在向 AI SDK v3 的 start/delta/end 三段式趋同（opencode LLMEvent 与 vercel StreamPart 几乎同构）。
2. **tool 参数增量**：分片格式三种——Anthropic `partial_json` / OpenAI Chat `delta.tool_calls[].function.arguments` / Responses `function_call_arguments.delta`；全部在适配层字符串拼接，收口统一 JSON parse。**失败处理三派**：报错事件（opencode invalidRequest、cline `invalidToolCalls` 元数据+`inputParseError`、goose tool_request 携带 `Err`）、直接 throw（vercel-ai anthropic exhaustive never）、宽松继续（aider/mini 不校验）。
3. **reasoning**：独立通道是主流（opencode/cline/vercel-ai/codex/anthropic-sdk/gemini-cli Thought）；aider 把 `reasoning_content` 合成 `<think>` 塞回正文；**redacted thinking 仅 goose（一等块类型）与 cline（redacted 标志）显式建模**，anthropic-sdk 只透传块。
4. **usage**：Anthropic 系 mid-stream 两段合并、OpenAI 系末 chunk（`include_usage`）、vercel v3 单一 finish part 带 noCache/cacheRead/cacheWrite+raw、codex 收口于 `response.completed` 再转 `TokenCount`。**cache 维度在 opencode/cline/vercel/goose 全保留，Trylo 现 union 全丢**。
5. **终止与错误**：`[DONE]` 在 opencode/codex/openai-node 都被降级为 framing 噪声；语义终止收敛到 1~2 个内部 finish 事件。error 通道分叉：**三家 SDK=throw；opencode=流内 provider-error part（processor 处才 throw）；vercel-ai=流内 error part 且允许多个；cline=折叠进 finish{error}**。
6. **前向兼容**：主流是 **default 臂静默忽略**（codex 三层 ignore+trace、goose debug、opencode 两路），vercel-ai provider 侧反例 strict-throw 但提供 `raw` part 逃生门。
7. **重试边界共识**：SDK 层只在 **headers 阶段**重试（anthropic `shouldRetry(response)`、openai `!hasStreamingBody`、genai pRetry 状态码表），流开始后的空响应/断流由**上层**吸收（cline buffer-until-proven、opencode retry.ts 5 次、codex 连接级 5s→60s）。

## 1. 翻译层位置表

| 家 | 翻译点（文件::函数） | 入词汇 | 出事件 | 备注 |
|---|---|---|---|---|
| opencode(native) | `open/…/opencode/packages/llm/src/protocols/{anthropic-messages,openai-chat,openai-responses,gemini,bedrock-converse,bedrock-event-stream,openai-compatible-chat}.ts::step` | 各 wire SSE 事件 | LLMEvent 16 tag | 7 协议每一状态机 |
| opencode(兜底) | `packages/opencode/src/session/llm/ai-sdk.ts::toLLMEvents` | AI SDK fullStream part | LLMEvent | 与 native 同一流出口 |
| codex | `codex-rs/codex-api/src/sse/responses.rs::process_responses_event`；UI 层 `core/src/session/turn.rs` match；`core/src/event_mapping.rs::parse_turn_item` | Responses SSE/WS 事件 | ResponseEvent(17) → EventMsg/TurnItem | api crate→core 两级 |
| goose | `crates/goose-provider-types/src/formats/anthropic.rs::response_to_streaming_message` 等 per-format | wire SSE JSON | MessageStream item `(Option<Message>, Option<ProviderUsage>)` | 块级增量非 token 事件 |
| gemini-cli | `packages/core/src/core/turn.ts::Turn.run` parts 分派 | SDK GenerateContentResponse | GeminiEventType(18) | thought/text/functionCalls |
| cline | `sdk/packages/llms/src/providers/ai-sdk.ts` L1420-1560 归一；`sdk/packages/agents/src/agent-runtime.ts` 装配 | AI SDK v4 part | AgentModelEvent(7) → assistant-* runtime 事件 | llms/agents 两级 |
| aider | `aider/coders/base_coder.py::show_send_output_stream` | litellm chunk | 无事件——拼 partial_response_content | 最扁平 |
| mini-swe-agent | `src/minisweagent/models/litellm_model.py::query` | 完整 response | dict message | 非流式 |
| vercel-ai | `packages/anthropic/src/anthropic-language-model.ts::doStream` 等 | wire JSON 事件 | LanguageModelV3StreamPart(18) | 规范即接缝 |
| anthropic-sdk | 不翻译；`src/lib/BetaMessageStream.ts` raw→snapshot 累加 | BetaRawMessageStreamEvent(6) | 同左+helper 回调 | 逃生门=raw 透传 |
| openai-node | `src/lib/ChatCompletionStream.ts::_processChunk` | ChatCompletionChunk | snapshot+emitter 事件 | 见 §2 |
| google-js-genai | `src/models.ts::generateContentStreamInternal`+converters | SSE 整条 mini-response | typed GenerateContentResponse | 每 chunk 即完整小响应 |

证据：
- opencode `LLMEvent` 全集（`schema/events.ts` L209-226）：step-start、text-start/delta/end、reasoning-start/delta/end、tool-input-start/delta/end、tool-call、tool-result、tool-error、step-finish、finish、provider-error；Usage 为「inclusive 总额+non-overlapping breakdown+providerMetadata 挂 raw」三层契约（L7-74）；`LLMResponse.reduce` 把事件折回 Message（L531-618）。
- codex `ResponseEvent` 全集（`codex-api/src/common.rs` L102-153）：Created、SafetyBuffering、OutputItemDone、OutputItemAdded、ServerModel、ModelVerifications、TurnModerationMetadata、ServerReasoningIncluded、Completed{response_id,token_usage,usage_metadata,end_turn}、OutputTextDelta、ToolCallInputDelta、ReasoningSummaryDelta/Done/PartAdded、ReasoningContentDelta、RateLimits、ModelsEtag；`ResponseStream` 是 `mpsc::Receiver<Result<ResponseEvent,ApiError>>`（L416-428）。
- cline `AgentModelEvent` 全集（`sdk/packages/shared/src/agent.ts` L276-327）：text-delta、media、reasoning-delta、tool-call-delta、tool-result、usage、finish。
- gemini-cli `GeminiEventType` 全集（`core/turn.ts` L55-73）：Content、ToolCallRequest/Response/Confirmation、UserCancelled、Error、ChatCompressed、Thought、MaxSessionTurns、Finished、LoopDetected、Citation、Retry、ContextWindowWillOverflow、InvalidStream、ModelInfo、AgentExecutionStopped/Blocked。
- vercel `LanguageModelV3StreamPart` 全集（`packages/provider/src/language-model/v3/language-model-v3-stream-part.ts` L12-106）：text-start/delta/end、reasoning-start/delta/end、tool-input-start/delta/end、tool-approval-request、tool-call、tool-result、file、source、stream-start{warnings}、response-metadata、finish、raw、error。
- opencode 双 runtime：`session/llm.ts` L226-269 在 `flags.experimentalNativeLlm` 下探测 `LLMNativeRuntime.stream`（`llm/native-runtime.ts` L56-68：非 openai/opencode/anthropic 包、OAuth 需 fetch override、缺 key → `unsupported{reason}` 并 logInfo "llm runtime selected"），否则 `streamText` 兜底、fullStream 经 `LLMAISDK.toLLMEvents` 归一（L370-378），两路暴露同一 LLMEvent 流；Copilot 靠 `includeRawChunks`+raw part 救回 `total_nano_aiu` 计费（ai-sdk.ts L31-43）。
- codex `ModelClient`（`core/src/client.rs` 模块注 L12-24、L250-306）：session 级缓存懒开 Responses WebSocket、`x-codex-turn-state` sticky token 同 turn 必须重放、prewarm=v2-only `generate=false`、WS 失败→**session 级** HTTP fallback（`force_http_fallback` L551-568）、beta header `responses_websockets=2026-02-06`（L167）。
- gemini-cli 接缝：`ContentGenerator`(contentGenerator.ts L39)=generateContent/generateContentStream/countTokens；decorator 序 `Logging(ModelMapping(base))`（L298-306）、fake 短路 Logging(fake)（L216-227）、`RecordingContentGenerator` 最外层（L418）。

### 1.1 opencode `processor.ts::handleEvent` 逐分支落库动作（L278-551）

| 事件 | 落库动作 |
|---|---|
| reasoning-start | 建 reasoning part（PartID.ascending、time.start）→ session.updatePart；重复 id 幂等跳过 |
| reasoning-delta | 累 text；**孤儿 delta（无 start）静默丢**；session.updatePartDelta(field:"text") 增量推送 |
| reasoning-end | 合并 metadata → finishReasoning（补 time.end 再 updatePart） |
| tool-input-start/delta/end | ensureToolCall 建/更新 pending tool part；summary 消息期间直接 throw「Tool call not allowed」 |
| tool-call | updateToolCall→state.running+input；随后取最近 parts 做 **DOOM_LOOP_THRESHOLD=3** 判定：末 3 个 part 同 tool 同 input(JSON.stringify 相等)→ permission.ask("doom_loop")（L331-380） |
| tool-result | completeToolCall；error 结果走 failToolCall；图片附件 normalize，resize 失败计数拼进 output 尾注 |
| tool-error | failToolCall(error) |
| provider-error | **throw**（终止本 attempt 流） |
| step-start | snapshot.track() → step-start part（fs 快照锚点） |
| step-finish | finishReasoning 全部收尾；anthropic inputTransformations→logWarning 丢块；Session.getUsage→message.cost/tokens 累加；step-finish part(tokens+cost+snapshot)；updateMessage；snapshot.patch→patch part；fork summarize；isOverflow→needsCompaction |
| text-start/delta/end | text part 生命周期；delta 走 updatePartDelta；end 触发 plugin "experimental.text.complete" 改写后落库 |
| finish | no-op（step-finish 已承担落账） |
| （cleanup L553-580） | 流尾兜底：flush currentText/残留 reasoning parts、patch part |


## 2. tool_call 参数增量：分片格式与收口校验

| 家 | 分片格式 | 流内 key | 收口动作 | parse 失败路径 |
|---|---|---|---|---|
| opencode | `input_json_delta.partial_json`；OpenAI Chat tool_calls delta；Responses args.delta+done 权威 | 数字 index（Chat/Anthropic/Bedrock）或 item_id（Responses） | finish/finishWithInput/finishAll 三策略→`parseToolInput` | 空串当 `{}`；坏 JSON→route 级 invalidRequest 错误 |
| codex | `ToolCallInputDelta{item_id,call_id?,delta}`（只映射 custom_tool_call_input.delta） | item_id/call_id | OutputItemDone 整条 FunctionCall 重解码 | 增量不 parse——只喂 diff consumer |
| goose | `partial_json` 拼接（anthropic.rs L1044-1049） | content block index | content_block_stop→`parse_tool_arguments` | tool_request 携带 `Err(INVALID_PARAMS)`+truncation 提示 |
| gemini-cli | 无增量（functionCalls 整块到达） | — | ToolCallRequestEvent | 不适用 |
| cline | `tool-call-delta{index?,toolCallId?,inputText?}` | toolCallId ?? `tool_{index}` | 流末按 sequence fold 后 `parseToolInput` | `invalidToolCalls.push`+part.metadata.inputParseError+rawInputText 保留 |
| aider | `delta.function_call` 字段级字符串累加 | dict key | 流末下游 extract | 不校验 |
| vercel-ai | `input_json_delta`→`tool-input-delta` part；空 delta 跳过（code-exec 首字符替换） | contentBlocks[index].toolCallId | content_block_stop→tool-input-end+完整 tool-call part(已 parse) | throw（exhaustive never） |
| anthropic-sdk | raw `partial_json` 透传；`JSON_BUF_PROPERTY` 缓冲+`withLazyInput` 懒解析 | content block index | finalMessage()/inputJson 回调(snapshot) | 惰性——snapshot 不强制 parse |
| openai-node | `delta.tool_calls[].function.arguments` 按 index 拼接 | `current_tool_call_index` | finish_reason 或 index 切换→`tool_calls.function.arguments.done` | 宽松照拼，交给调用方 |
| genai | `streamFunctionCallArguments` opt-in 才有增量 | — | AFC 开启时整块收口 | opt-in 与 AFC 冲突→构造期 throw |
| mini-swe | 非流式 | — | query 内 `parse_toolcall_actions` | FormatError(附 cost/response) |

- opencode 协议细节：`protocols/utils/tool-stream.ts` 一文件收编四种 wire 形态——`start`（Anthropic content_block_start/Bedrock contentBlockStart/Responses output_item.added，L100-109）、`appendOrStart`（OpenAI Chat「id/name 只在首 delta」，L111-139）、`finishWithInput`（Responses done 重复完整参数、final wins，L177-193）、`finishAll`（Chat 无 per-tool stop，finish_reason 时全收，L194-216）；`shared.ts::parseToolInput` L150-158 统一报错文案 "Invalid JSON input for <route> tool call <name>"。
- codex 意外发现：`response.function_call_arguments.delta` 在 ignore 名单（`sse/responses.rs` L528），增量参数只服务 EditTool 实时 diff（`turn.rs` L2729-2746：call_id 不匹配 continue），**契约面是整条 FunctionCall，不是增量**。
- vercel-ai：`anthropic-language-model.ts` L2452-2497 翻译 input_json_delta→tool-input-delta（含 provider 工具首字符改写特例），L2294 content_block_stop 收口；完整 ToolCall part 是权威收口事件（tool-input-delta 仅展示用）。
- cline：`agent-runtime.ts` L1199-1258 PendingToolAssembly（inputText 与 inputValue 双轨）、L1319-1354 收口——missing_name 与 parse 失败都进 `messageMetadata.invalidToolCalls`，assistant message 仍保留 tool-call part（坏 input 带 metadata.inputParseError+rawInputText）。

## 3. reasoning / thinking 通道

| 家 | 独立事件通道 | redacted/签名处理 | 词汇 |
|---|---|---|---|
| opencode | 是 | signature 走 providerMetadata.anthropic；无 redacted 建模 | reasoning-start/delta/end；Usage.reasoningTokens |
| codex | 是（summary 与 raw 双轨） | 原文加密在服务端，客户端只见 summary/raw delta | ReasoningSummaryDelta/Done/PartAdded、ReasoningContentDelta → EventMsg::ReasoningContentDelta、ReasoningRawContentDelta、AgentReasoningSectionBreak |
| goose | 是 | **RedactedThinkingContentBlock 一等类型**（conversation/message.rs L238,L327；wire L1021-1029 直通 `[RedactedThinking]`）；Thinking 合并守签名规则（base.rs collect_stream L404-420） | MessageContentBlock::Thinking(text,signature) |
| gemini-cli | 是（摘要） | thoughtSignature 在 SDK parts 里 | part.thought→parseThought→GeminiEventType.Thought（turn.ts L365-370） |
| cline | 是 | **reasoning-delta.redacted?: boolean**（agent.ts L282） | reasoning-delta{text,redacted,metadata} |
| aider | **否——塞正文** | 无 | `delta.reasoning_content`/`.reasoning` 合成 `<REASONING_TAG>` 开闭标签写 partial_response_content（base_coder.py L1928-1952）；入库前 remove_reasoning_content 剥离（L1986-1992） |
| vercel-ai | 是 | 无 redacted 词汇 | reasoning-start/delta/end parts；outputTokens.reasoning |
| anthropic-sdk | 是 | redacted_thinking 块类型有定义（messages.ts L4046-4072，"pass back unchanged"）但 helper 不回调其内容 | thinking_delta/signature_delta→`thinking`/`signature` 回调（BetaMessageStream.ts L26-41） |
| openai-node | `delta.reasoning_content` 类字段透传（LiteLLM 风格，非本 SDK 强类型） | — | — |
| genai | parts.thought 布尔标志 | — | SDK 层无事件，CLI 层 Thought |
| mini-swe | 无（非流式，thinking blocks reorder 工具函数） | _reorder_anthropic_thinking_blocks 保历史块顺序合法 | — |

- codex 双交付模式：`uses_sequential_cutoff_reasoning_summaries` 时 delta 流让位于「整段 done」（turn.rs ReasoningSummaryDone 分支 L2789-2822 与 delta 分支互斥 continue），由请求 `StreamOptions.reasoning_summary_delivery` 决定（common.rs L190-197）。
- goose 双通道：另有文本内 `<think>` 流式过滤器（`thinking.rs::ThinkFilter/FilterOut/split_think_blocks`），给不吐 thinking 块、只在正文打标签的模型用。
- opencode：孤儿 reasoning-delta（无 start）静默丢（processor.ts L294-296 注释 "Match dev"）；provider 丢弃历史 thinking 块经 step-finish 的 inputTransformations 元数据 logWarning 可观测（L438-451）。

## 4. usage 到达时机与 cache 维度

| 家 | 时机 | cache read/write | reasoning tokens | raw 保留 |
|---|---|---|---|---|
| opencode | mid-stream 累积（Anthropic message_start+message_delta merge），发布收敛在 step-finish/finish | 保留（nonCached+cacheRead+cacheWrite=inputTokens 不变式） | 保留（Anthropic 例外=API 限制，文档化） | providerMetadata 按 provider 名挂 raw |
| codex | 收口 `Completed{token_usage,usage_metadata}`；record 后 drain tools 才 `send_token_count_event`→EventMsg::TokenCount | usage_metadata: ResponseUsageMetadata（protocol 层承载） | — | RawResponseCompleted 另存原文 |
| goose | **每个 stream item 第二槽位**可带 ProviderUsage；merge_delta_usage 保 cache_read/cache_write（formats/anthropic.rs L633-664） | 保留 | — | usage_data 原文入 cost |
| gemini-cli | chunk 级 usageMetadata，Turn 在结束附近带出（turn.ts L411） | cachedContentTokenCount（SDK 类型） | thoughtsTokenCount | — |
| cline | **流末** await stream.usage→normalizeUsage→单 usage 事件（ai-sdk.ts L1875-1895） | GatewayNormalizedUsage.cacheRead/cacheWriteTokens（L82-86,L1213-1260）；cost 先减 cache 再按 cache 单价（L1108-1120） | 支持（outputTokenDetails.reasoningTokens 多路兜底） | metadataToUse |
| aider | 只信非流式 completion.usage；缺则 litellm token_count 估算 | cache_hit/cache_write 有则报（base_coder.py L2000-2028） | — | — |
| vercel-ai | 单一 finish part | inputTokens{total,noCache,cacheRead,cacheWrite} 四维 | outputTokens{total,text,reasoning} | `raw?: JSONObject` |
| anthropic-sdk | message_delta 累计 output_tokens，终值在 finalMessage | cache_read_input_tokens/cache_creation_input_tokens 原生 | 不拆（并入 output） | 原始 JSON |
| openai-node | 末 chunk（`stream_options.include_usage`，choices 可为空数组） | prompt_tokens_details.cached_tokens | completion_tokens_details.reasoning_tokens | — |
| genai | 末 chunk usageMetadata | cachedContentTokenCount | thoughtsTokenCount | — |
| mini-swe | 非流式 completion_cost | 经 litellm registry | — | — |

- opencode `Usage` 契约（events.ts L7-74）：inclusive 总额与非重叠 breakdown 并存、mapper 各自补差 `Math.max(0,…)` 防下溢、`visibleOutputTokens` 是全契约唯一减法处。
- opencode AI SDK 路径同样保多维：ai-sdk.ts `usage()` L45-65 读 inputTokenDetails.cacheRead/Write、outputTokenDetails.reasoningTokens；getUsage（session.ts L338-375）把 cacheWrite 兜底翻 providerMetadata 各家居点（含 bedrock），adjustedInput=input−cacheRead−cacheWrite。
- cline 空重试的计费聚合：被丢弃 attempt 的 usage 合并进最终 finish（retry-empty-response.ts L29-33）——重试不吞账单，各家独此一份。

## 5. 终止信号归一与 error 通道

| 家 | 收敛后终止词汇 | `[DONE]`/哨兵 | error 形态 |
|---|---|---|---|
| opencode | step-finish+finish 成对（utils/lifecycle.ts L80-100 closeOpenBlocks 后双发）；finish 对 processor=no-op | framing 层过滤 empty+`[DONE]`（protocols/shared.ts L236-247） | 流内 provider-error part，processor throw（L421-422）；ai-sdk error part→Effect.fail；finish-step rawFinishReason=network_error→ResponseStreamError |
| codex | Completed break 出循环；TERMINAL_TYPES={completed,incomplete,failed}（openai-responses.ts L609-613） | SSE 层 | `Result<…,ApiError>` 流内 Err 通道→retry 环；StreamErrorEvent 另有 EventMsg |
| goose | 无 finish 事件——流自然 None；空流 `(None,None)`→ExecutionError "Stream yielded no message"（base.rs L451-453） | 无 | `Result<_,ProviderError>` |
| gemini-cli | Finished 事件+Turn.finishReason 字段 | 无 | Error/InvalidStream/Retry 均为**事件**不 throw |
| cline | finish 事件唯一收口 | 无 | **折叠进 finish{reason:"error",error,errorClass,errorReported}**（ai-sdk.ts L1898-1904；agent-runtime L1301-1314 分类兜底 classifyProviderError） |
| aider | for-chunk 尽头；`finish_reason=="length"`→raise FinishReasonLength（L1907-1911） | openai 库吞 | 异常 |
| vercel-ai | finish part（unified 6 值+raw 双层，v3-finish-reason.ts） | 无 | **流内 error part，允许多个**（v3-stream-part.ts L102-106 注释）；另有 abort |
| anthropic-sdk | message_stop→finalMessage() 决议（BetaMessageStream L441-443） | 无 | `error` 事件→AnthropicError 回调+reject |
| openai-node | finish_reason 触发 done-flush + `[DONE]` 终结；**`[DONE]` 后事件忽略**（core/streaming.ts L102,L133） | **哨兵定义处** | throw |
| genai | chunk 流尽头；SSE data 里带 error 字段→ApiError throw（_api_client.ts processStreamResponse L710-728） | 无 | throw |
| mini-swe | query 返回即终止 | — | 异常+retry() 环 |

- 各家「几种信号收敛几个事件」：Anthropic wire 3 种（message_delta.stop_reason/message_stop/error）、OpenAI Chat 3 种（finish_reason/[DONE]/usage-chunk）、Responses 3 种（completed/incomplete/failed）——opencode 全收敛为 step-finish+finish(+provider-error) **2+1**；vercel-ai 收敛为 finish+error(可多) **1+1**；cline 收敛为 finish **1**。
- codex `end_turn: Option<bool>`（common.rs L125-127）：部分 provider 不发，`Some(false)`→needs_follow_up=true（turn.rs L2689-2691）——终止信号本身带「模型是否主动收口」的第二语义。
- opencode FinishReason 枚举：stop|length|tool-calls|content-filter|error|unknown（schema/ids.ts L39）；vercel unified：stop|length|content-filter|tool-calls|error|other + raw 原值。

## 6. 未知事件前向兼容（default 臂逐个确认）

| 家 | 未知 wire 事件 | 未知 part/类型 | 策略判定 |
|---|---|---|---|
| opencode(native) | if-chain 尽头→`[state, NO_EVENTS]` **忽略**（anthropic-messages.ts L822） | 协议 Schema decode 失败→route error（decode 是硬门，见下） | 忽略为主 |
| opencode(ai-sdk) | — | `default: never→Effect.succeed([])` **显式忽略**（ai-sdk.ts L283-287）；abort/source/file/tool-output-denied/tool-approval-request 均空数组 | 忽略+编译期穷尽 |
| codex | 显式 ignore 名单 trace、`kind.ends_with(".delta")` 兜底 trace、`_=>debug` **三层忽略**（sse/responses.rs L525-545） | output_item.done 反序列化失败→debug 丢整 item（L362） | 完全忽略（新 .delta 事件名自动吸收） |
| goose | content_block_start `_=>{}`；未知 delta→`debug!("Unknown content_block_delta type")` **忽略**（anthropic.rs L1031,L1061-1063） | collect_stream 合并器 `_=>push` 兜底 | 忽略 |
| gemini-cli | parts 只分派 thought/text/functionCalls，其余 **忽略**（turn.ts L365-411） | GeminiEventType 自家闭集不受 wire 影响 | 忽略 |
| cline | 未识别 AI SDK part 归入 unsupported-output 分类（stream-part-classification.ts，供空重试 taxonomy，retry-empty-response.ts L3-5）——**忽略但记账**（防止误判空响应） | finish.error 折叠见 §5 | 忽略+记账 |
| aider | hasattr/try-AttributeError 全程宽松 | — | 忽略 |
| vercel-ai | provider 侧 delta default 与顶层 default 均 **throw**（anthropic-language-model.ts L2523-2528,L2763-2766 "Unsupported chunk type"） | 消费者侧 `raw` part 逃生门（includeRawChunks，opencode Copilot 即受益者） | 严格+逃生门 |
| anthropic-sdk | helper 累加 switch 各 case 有 guard（如 tracksToolInput），新增块类型不影响主流程；`checkNever` 只用于自家已判别枚举 | Beta 面持续加块（advisor_*/compaction_delta L694+） | 类型宽松+透传 |
| openai-node | assertNever 用于自家 Choice 快照类型；wire 新增字段天然忽略（读已知字段） | — | 结构前向兼容 |
| genai | converters 只读已知字段 | 流内 error 结构识别 | 忽略 |

- 判定汇总：**8 家忽略、1 家记账（cline）、1 家 throw 但有 raw 逃生门（vercel-ai）、SDK 三家透传/宽松**。codex 的 `.delta` 后缀兜底臂是各家唯一「按命名规律吸收未知增量」的设计。

## 7. capability 声明与「不支持时丢 vs 上报」

| 家 | 声明机制 | 参数不支持时 | 判定 |
|---|---|---|---|
| opencode | native 探测 unsupported reason（native-runtime.ts L56-68）；AI SDK v3 `supportedUrls`（copilot 模型实现 L50,L83-84）；ProviderTransform 改写消息/参数 | runtime 级**上报 reason**；参数级静默 transform | 混合 |
| codex | provider 能力位控 WS（client.rs L1012）；header 派生事件：ServerModel（换模型）、ModelVerifications、ServerReasoningIncluded、X_CODEX_TURN_STATE | **事件化上报**（各家最强） | 上报 |
| goose | `ModelInfo{context_limit,supports_cache_control,reasoning,thinking_preservation_format}`（base.rs L350-361）+ canonical bundled registry + `ThinkingEffortSupport` watch 通道（L673-679）；model_supports_temperature()（formats/anthropic.rs L140） | 查表裁剪 | 查表 |
| gemini-cli | `config/defaultModelConfigs.ts` per-model profile；resolveModel 按能力选模型 | profile 裁剪 | 查表 |
| cline | `model-capabilities.ts` + builtins.ts 声明式 spec（ProviderConfigField 密码/URL/下拉字段、GatewayModelToolCapability、stickySession metadata L85-98）；`createClineLikeSpec` 工厂复用 | 注册表声明、UI 消费 | 声明 |
| aider | litellm `main_model.info`（无 input_cost_per_token 则只报 token 不报价，base_coder.py L2031-2033） | **静默降级** | 静默 |
| mini-swe | 无 profile；cost 算不出默认 raise（可 cost_tracking: ignore_errors） | **硬报错** | 报错 |
| vercel-ai | `LanguageModelV3.supportedUrls`（spec L36）；`stream-start{warnings}` part 承载 `{unsupported|compatibility|other}`（shared-v3-warning.ts） | **上报+修正**：anthropic 对 frequencyPenalty/presencePenalty/seed push unsupported；temperature>1/<0 clamp+details；模型级不支持 temperature→"will be ignored" details 再丢（L288-320,380-386） | 上报（各家最完整样板） |
| google-js-genai | **SDK 内无模型能力表**（全库无 ModelProfile/profile 概念）；唯一 capability 契约=streamFunctionCallArguments 与 AFC 互斥 throw（models.ts L287-295） | 能力知识下沉到调用方 | 缺位 |
| anthropic-sdk | 类型即文档（RefusalStopDetails.category/fallback_credit_token 这类服务端建议字段，messages.ts L4077-4152） | 服务端字段透传 | 透传 |
| openai-node | 类型即文档 | — | 透传 |

## 8. provider 层重试边界

| 家 | 边界 | 关键参数/证据 |
|---|---|---|
| anthropic-sdk | **headers 阶段**：`shouldRetry(response)`（client.ts L1420-1457：x-should-retry 头优先，401 token 刷新一次性、408/409/429/5xx）；重试前 CancelReadableStream(response.body)（L1240）；200 后流死不重 | maxRetries 默认 2（L658）；retry-after-ms→retry-after(秒/日期)→指数+抖动（L1468-1503）；错误码带 "Note that the request will only be retried when maxRetries has not been exhausted"（core/error.ts L137） |
| openai-node | `!hasStreamingBody` 门：连接失败分支 L1301-1304、HTTP 错误分支 L1389 同门；置位后终态信息 "streaming body cannot be retried"（L1320-1322；置位 L1189,L1249） | maxRetries 默认 2（L612）；x-should-retry/retry-after 同族 |
| google-js-genai | pRetry 只包 fetch 返回 Response 的阶段（apiCall L791-860）；**每 attempt 新建 createAttemptSignal**（L89,L800-801）使 timeout 限单次而非全程；流正文错误在 pRetry 外 throw | DEFAULT_RETRY_HTTP_STATUS_CODES=[408,429,500,502,503,504]（L141-147）+retryOptions.httpStatusCodes 可覆盖；requestStream L566-604→streamApiCall L655-684 复用 apiCall |
| opencode | loop 层 `session/retry.ts`：RETRY_MAX_RETRIES=5、初值 2000ms×2、jitter .25、无响应头时上限 30s、retry-after-ms/retry-after/HTTP-date 三级解析（L26-77）、RETRYABLE_MESSAGE_PATTERNS 正则名单（L33-41）；SDK `maxRetries: input.retries ?? 0`（llm.ts L323） | provider-error 在 processor=throw，重试在外圈 |
| cline | **两级**：AI SDK 只重试 `doStream()` 发起失败；发起后断体逃逸其错误包装→`withEmptyResponseRetry`（ai-sdk.ts L2005，L2213 统一包每个 V4 vendor 模型）+`middleware/retry-empty-response.ts` V4 middleware：**buffer-until-proven**，首个实质 part 前全缓冲、空 turn 整段丢弃（结构 part/元数据/空块标记不泄漏）、同窗口吸收出字前 UND_ERR_SOCKET/BodyTimeout/ECONNRESET 类断流（文件头 L1-60）；tool-call-only 不算空；已出字后不重试；abort 永不重试 | 厂商可 opt-out/调次数（ProviderFactoryResult.retryEmptyResponses）；ollama vendor 注释指明包裹在模型外圈（vendors/ollama.ts L146） |
| codex | 连接级：`responses_retry.rs` INITIAL_CONNECTION_RETRY_DELAY=5s→MAX=60s（L17-18,L81），`err.retry_delay()` 优先否则 `backoff(retry_count)`（L105）；Sampling 与 RemoteCompactionV2 分账（L22-25）；WS prewarm 视作首连尝试、失败交同 turn fallback（client.rs 注 L15-24） | 与 SDK headers 门互补：codex 的重试在 core 层 stream 循环 |
| gemini-cli | turn 层把重试当事件：GeminiEventType.Retry（turn.ts L68,L301 'retry' 分支）上报 UI | — |
| aider | 无流层重试；空响应只 warn "Empty response received from LLM"（base_coder.py L1974-1975） | — |
| mini-swe | 自研 `retry()` 环+abort_exceptions 名单（ContextWindowExceeded/Auth 等直接弃，litellm_model.py L50-57,L82） | — |

- 三家 SDK 共同证据链：重试判定函数签名收的是 **Response/headers**（`shouldRetry(response)`、pRetry 的 runFetch 返回 Response、`hasStreamingBody` 标志位），正文消费发生在判定之后——「流开始不重试」是三家一致的架构事实，而非约定俗成。

## 9. Trylo 机制对照

| 维度 | Trylo 现状 | 各家对照 |
|---|---|---|
| 事件词汇量 | ProviderEvent 9 变体（ports/provider.ts L13-28） | opencode 16 / vercel 18 / codex 17 / cline 7（但 cline 7 个覆盖 reasoning+media+error 折叠，密度差一倍） |
| tool 契约 | tool_request 一次交齐已 parse 的 JsonObject | 各家 adapter 内部都有 assembly 状态机（opencode ToolStream、cline PendingToolAssembly、anthropic SDK JSON_BUF），Trylo 把该责任完全推给未建的 adapter 层 |
| 装配循环 | provider-input.ts::providerEventToInput 一对一映射；四类失败塌成 transport_fail{message:"unclassified"}（L33-37） | opencode handleEvent 逐分支落库（§1.1）；各家均保留错误细分（cline errorClass、opencode classification on provider-error part、vercel unified+raw reason） |
| 序号 | runner.ts L227-235：**producerSequence 本地自增**后 push 进 reorder buffer——输入恒 0,1,2…，buffer 只可能是直通，MAX_REORDER=16 溢出分支实际不可达 | codex wire 有 `sequence_number`（仅观测/错误归因，sse/responses.rs 测试 L1097+ 可见），无一家做乱序重排；vercel-ai/cline/goose 全部单连接顺序假设 |
| 重试分层 | 未定（transport_error/timeout/process_exit 已分相，但 provider-input 抹平） | 三层共识：SDK=headers 门；CLI 中间层=空响应/断体吸收（cline buffer-until-proven 最完整）；loop=退避+retry-after |

## 10. Trylo 缺口清单（只列缺口，不设计）

1. **reasoning 通道缺失**：无 reasoning-start/delta/end；思考内容只能污染 `text`；也无 cline 式 `redacted` 标志。
2. **tool 参数增量分片缺失**：无 tool-input-start/delta/end 或等价词汇；无「坏参数收口」出口（对照 opencode invalidRequest、cline invalidToolCalls、goose Err-in-tool_request 三派先例）。
3. **finish 无 reason**：各家 finish 带 unified(+raw)；Trylo `finish` 空载，needs_follow_up/end_turn 第二语义无处安放（codex L125-127 先例）。
4. **usage 维度单薄**：仅 input/output 两数；缺 cacheRead/cacheWrite/noCache、reasoningTokens、total 与 raw 逃生（vercel raw、opencode providerMetadata 双先例）；各家 cache 维度均已进成本账。
5. **warning/unsupported 事件缺失**：参数被 provider 丢弃/夹紧不可观测（vercel stream-start{warnings}、codex ServerModel/ModelVerifications 先例）。
6. **raw/unknown 兜底缺失**：`transport_unknown` 语义是**失败**，不是「无法归类的 provider 数据」；opencode 靠 raw part 救回 Copilot 计费是活案例。
7. **error 通道未分相**：三家 SDK throw、opencode 流内事件、vercel 流内可多个、cline 折叠 finish——Trylo 单一 transport_error 且 message 细节在映射层被 "unclassified" 抹掉；重试所需 retryable 标记各家都有（opencode `retryable?: boolean` + classification）。
8. **块 id/多块交错不可表达**：text/tool/usage 无 content-block id；thinking→text→tool→text 交错是常态（各家 start/delta/end 皆带 id）。
9. **usage 到达时机契约未定**：mid-stream（Anthropic 系/goose）vs 末 chunk（OpenAI 系）vs 收口后独立事件（codex TokenCount）——Trylo 只有一个 usage 变体，未声明可多次/仅末次。
10. **reorder 序列来源未接**：wire 级序号（codex sequence_number 类）无进入 producerSequence 的通路，buffer 现为零收益摆设；overflow→transport_fail 的语义各家无对照物。
11. **provider 能力声明无位**：各家 ModelInfo/supportedUrls/warnings 类 capability 面在 Trylo 端无对应概念，adapter 无法告知「此模型 temperature 将被忽略」。

## 附：证据符号索引

| 符号 | 位置 |
|---|---|
| LLMEvent 16 tag / Usage 三层契约 / LLMResponse.reduce | opencode `packages/llm/src/schema/events.ts` L209-226 / L7-74 / L531-618 |
| ToolStream start/appendOrStart/finish/finishWithInput/finishAll | opencode `packages/llm/src/protocols/utils/tool-stream.ts` L100-216 |
| parseToolInput（空→{}、统一报错文案） | opencode `packages/llm/src/protocols/shared.ts` L150-158 |
| handleEvent / DOOM_LOOP_THRESHOLD=3 / getUsage | opencode `packages/opencode/src/session/processor.ts` L278-551, L29；`session.ts` L338-375 |
| native 探测 / toLLMEvents default-never / network_error 升级 | opencode `session/llm.ts` L226-269, L370-378；`session/llm/ai-sdk.ts` L77-289；`llm/native-runtime.ts` L56-68 |
| [DONE] 过滤 / step-finish+finish 双发 | opencode `packages/llm/src/protocols/shared.ts` L236-247；`protocols/utils/lifecycle.ts` L80-100 |
| opencode 退避参数 | `packages/opencode/src/session/retry.ts` L26-77 |
| ResponseEvent 全集 / Completed.end_turn / ResponseStream | codex `codex-rs/codex-api/src/common.rs` L102-153, L416-428 |
| process_responses_event 三层 ignore | codex `codex-rs/codex-api/src/sse/responses.rs` L353-546 |
| turn.rs 事件 match / token_count drain | codex `core/src/session/turn.rs` L2398-2844, L2864-2870 |
| parse_turn_item（ResponseItem→TurnItem，`_=>None`） | codex `core/src/event_mapping.rs` L181-257 |
| EventMsg delta 子集 | codex `protocol/src/protocol.rs` L1360-1551（AgentMessageContentDelta/PlanDelta/ReasoningContentDelta/ReasoningRawContentDelta/TokenCount/StreamError） |
| WS/sticky/prewarm/fallback | codex `core/src/client.rs` L12-24, L167, L250-306, L551-568 |
| 连接重试 5s→60s | codex `core/src/responses_retry.rs` L17-18, L81, L105 |
| MessageStream / collect_stream 合并器 | goose `crates/goose-provider-types/src/base.rs` L324-455 |
| MessageContentBlock（Thinking/RedactedThinking） | goose `conversation/message.rs` L232-330 |
| response_to_streaming_message（partial_json/签名/收口 Err） | goose `formats/anthropic.rs` L893-1130 |
| ThinkFilter（文本内 `<think>` 剥离） | goose `thinking.rs` L10-160 |
| ProviderDef 注册 | goose `crates/goose/src/providers/anthropic_def.rs` L17-36；`providers/base.rs` L31 |
| GeminiEventType / Turn.run parts 分派 | gemini-cli `packages/core/src/core/turn.ts` L55-73, L365-411 |
| ContentGenerator 接缝 / decorator 序 | gemini-cli `core/contentGenerator.ts` L39-52, L216-227, L298-306, L418 |
| AgentModelEvent 全集 | cline `sdk/packages/shared/src/agent.ts` L276-327 |
| AgentModelEvent 消费 / invalidToolCalls | cline `sdk/packages/agents/src/agent-runtime.ts` L1131-1360 |
| normalizeUsage / GatewayNormalizedUsage / withEmptyResponseRetry | cline `sdk/packages/llms/src/providers/ai-sdk.ts` L82-86, L1137-1260, L2005, L2213 |
| buffer-until-proven 语义 | cline `providers/middleware/retry-empty-response.ts` L1-60 |
| builtins 注册形态 | cline `providers/builtins.ts` L65-98, L701+；`factory-registry.ts` |
| show_send_output_stream / `<think>` 合成 / usage 估算 | aider `aider/coders/base_coder.py` L1900-1975, L1928-1952, L2000-2028 |
| 非流式 query / abort_exceptions | mini-swe `src/minisweagent/models/litellm_model.py` L50-57, L64-106 |
| V3 StreamPart 全集 / error 可多个注释 | vercel `packages/provider/src/language-model/v3/language-model-v3-stream-part.ts` L12-106 |
| unified+raw finish / usage 四维+raw / warnings | vercel `v3/language-model-v3-finish-reason.ts` L8-33；`v3-usage.ts` L6-59；`shared/v3/shared-v3-warning.ts` L7-50 |
| supportedUrls / streamRetries / mergeAbortSignals | vercel `v3/language-model-v3.ts` L36；`packages/ai/src/generate-text/stream-text.ts` L371-372, L624-652, L856-858, L1643-1644 |
| v2→v3→v4 升级（Proxy 改 specificationVersion） | vercel `packages/ai/src/model/as-language-model-v4.ts` L11-21 |
| input_json_delta→tool-input-delta / temperature warnings / 顶层 default throw | vercel `packages/anthropic/src/anthropic-language-model.ts` L2452-2497, L288-320+L380-386, L2763-2766 |
| BetaRawMessageStreamEvent(6) / RedactedThinking 定义 | anthropic-sdk `src/resources/beta/messages/messages.ts` L4038-4044, L4046-4072 |
| MessageStreamEvents 回调全集 / withLazyInput | anthropic-sdk `src/lib/BetaMessageStream.ts` L26-52, L649-700 |
| shouldRetry / retry-after-ms / maxRetries=2 | anthropic-sdk `src/client.ts` L658, L1234-1258, L1420-1503 |
| ChatCompletionChunk/Delta | openai-node `src/resources/chat/completions/completions.ts` L810+, L927+ |
| tool_calls index 拼接 / arguments.done 事件 | openai-node `src/lib/ChatCompletionStream.ts` L90-115, L1400-1470 |
| [DONE] 后忽略 | openai-node `src/core/streaming.ts` L102, L133 |
| hasStreamingBody 门 / maxRetries=2 | openai-node `src/client.ts` L612, L1189, L1241-1249, L1301-1322, L1389 |
| generateContentStreamInternal mini-response / streamFunctionCallArguments×AFC throw | genai `src/models.ts` L801-849, L282-295 |
| pRetry / 状态码表 / createAttemptSignal / 流内 error→ApiError | genai `src/_api_client.ts` L7, L89, L141-147, L655-684, L710-728, L791-860 |
| ProviderEvent / providerEventToInput / reorder / runner 自增 | Trylo `src/internal/ports/provider.ts` L13-28；`loop/provider-input.ts` L5-49；`loop/reorder.ts` L1-39；`loop/runner.ts` L227-248 |
