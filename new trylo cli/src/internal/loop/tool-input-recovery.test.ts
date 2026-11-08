import assert from "node:assert/strict";
import { test } from "node:test";
import type { ProviderEvent, ProviderMessage, ProviderRequest } from "../ports/provider.js";
import type { ToolPort } from "../ports/tools.js";
import { createFakePermission, emptyProfileLoader } from "./fakes.js";
import { runTurn } from "./runner.js";

/** Chat, Responses and Anthropic require every tool result to answer a call. */
function assertPaired(messages: readonly ProviderMessage[]): void {
  const pending = new Set<string>();

  for (const message of messages) {
    if (pending.size > 0) assert.equal(message.role, "tool", "an assistant call must receive all its results before other messages");
    if (message.role === "tool") {
      assert.ok(pending.delete(message.toolCallId ?? ""), "orphan tool result must not be sent to a provider");
    }
    for (const call of message.toolCalls ?? []) pending.add(call.toolCallId);
  }

  assert.equal(pending.size, 0);
}

async function recover(events: readonly ProviderEvent[]) {
  const requests: ProviderRequest[] = [];
  const executed: string[] = [];
  const tools: ToolPort = {
    snapshot: () => [{name:"read_file",description:"read",parameters:{type:"object",properties:{}},sideEffect:"read_only",needsApproval:false,timeoutMs:1000,outputLimits:{maxBytes:1000,maxLines:10}}],
    async execute(call) {
      executed.push(call.toolCallId);
      return {outcome:"result",value:{},output:"read succeeded",truncated:false};
    },
    async cancel() { return; },
  };
  const result = await runTurn({ profile:emptyProfileLoader(),permission:createFakePermission("approved"),tools,
    provider:{async *stream(request) {
      requests.push(request);
      for(const event of requests.length===1?events:[{type:"finish",reason:"stop",rawReason:"stop",requiresFollowUp:false} as const]) yield event;
    }},
  },{sessionId:"s",turnId:"t",correlationId:"c",text:"do the work"});

  assert.equal(result.state.terminalReason,"completed");
  assert.equal(requests.length,2);
  assertPaired(requests[1]!.messages);
  assert.ok(requests[1]!.messages.some(message=>message.content.includes("invalid_arguments")));
  assert.equal(result.envelopes.some(event=>event.kind==="approval_request"),false);

  return {result,requests,executed};
}

const BAD: ProviderEvent = {type:"tool_call_invalid",toolCallId:"bad",name:"write_file",rawArguments:"secret malformed payload",message:"invalid_arguments: malformed JSON"};
const FINISH: ProviderEvent = {type:"finish",reason:"tool_calls",rawReason:"tool_calls",requiresFollowUp:true};

test("custom provider error wording retains the canonical invalid-argument failure and paired feedback",async()=>{
  const {executed}=await recover([{...BAD,message:"fixture could not parse JSON"},FINISH]);
  assert.deepEqual(executed,[]);
});

test("invalid adapter calls retain paired, explicitly redacted history without executing any replacement arguments",async()=>{
  const {result,requests,executed}=await recover([BAD,FINISH]);

  assert.deepEqual(executed,[]);
  assert.equal(result.transcript.filter(item=>item.kind==="tool_result").length,1);
  const notice=requests[1]!.messages.find(message=>message.toolCalls?.some(call=>call.toolCallId==="bad"));

  assert.deepEqual(notice?.toolCalls?.find(call=>call.toolCallId==="bad")?.arguments,{});
  assert.match(notice?.content??"",/redacted history placeholder only/);
  assert.equal(JSON.stringify(requests).includes("secret malformed payload"),false);
});

test("a mixed valid and invalid response sends contiguous paired results and a non-executing failure notice",async()=>{
  const {executed}=await recover([BAD,{type:"tool_call",toolCallId:"good",name:"read_file",arguments:{}},FINISH]);
  assert.deepEqual(executed,["good"]);
});

test("a malformed fragment call followed by the adapter's invalid event settles once",async()=>{
  const {result,executed}=await recover([{type:"tool_input_start",toolCallId:"bad",name:"write_file"},{type:"tool_input_delta",toolCallId:"bad",argumentsText:"{not json"},{type:"tool_input_end",toolCallId:"bad"},BAD,FINISH]);
  assert.deepEqual(executed,[]);
  assert.equal(result.transcript.filter(item=>item.kind==="tool_result"&&item.toolCallId==="bad").length,1);
  assert.equal(result.envelopes.filter(event=>event.kind==="tool_result"&&event.payload.toolCallId==="bad").length,1);
});

test("valid fragments retain a replayable call even when a parsed adapter event follows",async()=>{
  const requests: ProviderRequest[]=[];
  const result=await runTurn({profile:emptyProfileLoader(),permission:createFakePermission("approved"),
    tools:{snapshot:()=>[],execute:async()=>{throw new Error("unknown tool must not execute");},cancel:async()=>undefined},
    provider:{async *stream(request){
      requests.push(request);
      if(requests.length===1){
      yield {type:"tool_input_start",toolCallId:"valid",name:"unavailable"};
      yield {type:"tool_input_delta",toolCallId:"valid",argumentsText:"{}"};
      yield {type:"tool_input_end",toolCallId:"valid"};
      yield {type:"tool_call",toolCallId:"valid",name:"unavailable",arguments:{}};
      yield FINISH;
    }else yield {type:"finish",reason:"stop",rawReason:"stop",requiresFollowUp:false};
    }},
  },{sessionId:"s",turnId:"t",correlationId:"c",text:"do the work"});

  assertPaired(requests[1]!.messages);
  assert.equal(result.transcript.filter(item=>item.kind==="tool_call"&&item.toolCallId==="valid").length,1);
  assert.equal(result.transcript.filter(item=>item.kind==="tool_result"&&item.toolCallId==="valid").length,1);
});
