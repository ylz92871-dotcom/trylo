import type { ProviderEvent, ProviderMessage, ProviderPort, ProviderForkOptions, ProviderRequest, ProviderToolSpec } from "../../ports/provider.js";
import { parseToolInput } from "../provider/invalid-tool-input.js";
import { object } from "./broker-contract.js";

export const MCP_SEARCH = "mcp_search_tools";
export const MCP_INVOKE = "mcp_call_tool";
export const INVOKE_SPEC: ProviderToolSpec = { name: MCP_INVOKE,
    description: "Call an external MCP tool after mcp_search_tools returned its full definition. Use exactly that tool name and arguments. Existing tool permissions still apply.",
    parameters: { type: "object", properties: { name: { type: "string" }, arguments: { type: "object" } }, required: ["name", "arguments"], additionalProperties: false } };

function external(name: string): boolean { return name.startsWith("mcp__"); }

function messageForWire(message: ProviderMessage): ProviderMessage {
    if (!message.toolCalls)
        return message;
    return { ...message, toolCalls: message.toolCalls.map(call => external(call.name)
            ? { toolCallId: call.toolCallId, name: MCP_INVOKE, arguments: { name: call.name, arguments: call.arguments } } : call) };
}

function presentedTools(tools: readonly ProviderToolSpec[]): readonly ProviderToolSpec[] {
    const ordinary = tools.filter(tool => !external(tool.name) && tool.name !== MCP_INVOKE);
    return ordinary.some(tool => tool.name === MCP_SEARCH) ? [...ordinary, INVOKE_SPEC] : ordinary;
}

/** The same pure presentation is used during preparation and by legacy direct
 * stream callers. Applying it again to a prepared request is value-identical. */
function presentedRequest(request: ProviderRequest, specs: readonly ProviderToolSpec[]): ProviderRequest {
    const enabled = specs.some(tool => tool.name === MCP_SEARCH);
    return { ...request, tools: specs, messages: request.messages.map(message => {
        const translated = messageForWire(message);

        if (message.role !== "system" || !message.content.startsWith("Available tools this run: ")
            || !message.content.endsWith("an unapproved call fails the turn.")) return translated;

        const instruction = enabled
            ? `External capabilities use ${MCP_SEARCH} then ${MCP_INVOKE}. Loading a schema never grants permission.`
            : "Tool availability is not permission; an unapproved call fails the turn.";

        return { ...translated, content: `Available tools this run: ${specs.map(tool => tool.name).join(", ")}. ${instruction}` };
    }) };
}

/** Stable model surface, canonical execution names. The bridge never executes a
 * tool: original names/arguments reach the existing loop's permission gate. */
export function discoveryProvider(provider: ProviderPort, authorize: (name: string) => boolean): ProviderPort {
    return {
        ...(provider.inputBindingDigest === undefined ? {} : { inputBindingDigest: (request: ProviderRequest) => provider.inputBindingDigest!(presentedRequest(request, presentedTools(request.tools))) }),
        ...(provider.responseFormats ? { responseFormats: provider.responseFormats } : {}),
        async prepareRequest(request, signal) {
            const specs = presentedTools(request.tools);
            const inner = await provider.prepareRequest?.(presentedRequest(request, specs), signal);
            return { apply: base => {
                const presented = presentedRequest(base, specs);
                return inner?.apply(presented) ?? presented;
            } };
        },
        ...(provider.fork ? {
            fork: (messages?: readonly ProviderMessage[], options?: ProviderForkOptions) =>
                discoveryProvider(provider.fork!(messages?.map(messageForWire), options), authorize),
        } : {}),
        ...(provider.continuation ? { continuation: { ...provider.continuation,
                ...(provider.continuation.bindCanonicalResponse ? { bindCanonicalResponse: (input: Parameters<NonNullable<typeof provider.continuation.bindCanonicalResponse>>[0]) => provider.continuation!.bindCanonicalResponse!({ ...input, message: messageForWire(input.message) }) } : {}),
                ...(provider.continuation.estimateOverheadTokens ? { estimateOverheadTokens: (messages: readonly ProviderMessage[]) => provider.continuation!.estimateOverheadTokens!(messages.map(messageForWire)) } : {}),
                restore(input) {
                    provider.continuation!.restore({ ...input, records: input.records.map(record => {
                            const payload = record.payload;
                            return record.type === "transcript_item" && payload.kind === "tool_call" && typeof payload.name === "string" && external(payload.name) && object(payload.arguments)
                                ? { ...record, payload: { ...payload, name: MCP_INVOKE, arguments: { name: payload.name, arguments: payload.arguments } } } : record;
                        }) });
                },
            } } : {}),
        async *stream(request, signal) {
            const specs = presentedTools(request.tools);
            const enabled = specs.some(tool => tool.name === MCP_SEARCH);
            const hiddenInputs = new Map<string, string>();
            const settled = new Set<string>();

            for await (const incoming of provider.stream(presentedRequest(request, specs), signal)) {
                let event: ProviderEvent = incoming;
                if (event.type === "tool_input_start" && event.name === MCP_INVOKE) {
                    hiddenInputs.set(event.toolCallId, "");
                    continue;
                }

                if (event.type === "tool_input_delta" && hiddenInputs.has(event.toolCallId)) {
                    if (settled.has(event.toolCallId))
                        continue;

                    const text = hiddenInputs.get(event.toolCallId) ?? "";
                    if (text.length + event.argumentsText.length <= (1 << 20))
                        hiddenInputs.set(event.toolCallId, text + event.argumentsText);
                    else {
                        settled.add(event.toolCallId);
                        yield { type: "tool_call_invalid", toolCallId: event.toolCallId, name: MCP_INVOKE, rawArguments: "", message: "MCP invocation exceeds the argument limit." };
                    }

                    continue;
                }

                if (event.type === "tool_input_end" && hiddenInputs.has(event.toolCallId)) {
                    const parsed = parseToolInput(hiddenInputs.get(event.toolCallId) ?? "");
                    if (settled.has(event.toolCallId))
                        continue;
                    event = parsed.ok ? { type: "tool_call", toolCallId: event.toolCallId, name: MCP_INVOKE, arguments: parsed.arguments }
                        : { type: "tool_call_invalid", toolCallId: event.toolCallId, name: MCP_INVOKE, rawArguments: "", message: parsed.message };
                }

                if ((event.type === "tool_call" || event.type === "tool_call_invalid") && event.name === MCP_INVOKE) {
                    if (settled.has(event.toolCallId))
                        continue;
                    settled.add(event.toolCallId);
                }

                if (event.type === "tool_call" && event.name === MCP_INVOKE) {
                    const name = event.arguments.name, args = event.arguments.arguments;
                    if (enabled && typeof name === "string" && external(name) && object(args) && authorize(name)) {
                        yield { ...event, name, arguments: args };
                    }
                    else {
                        // A malformed/undiscovered invocation is a normal failed tool call.
                        // Never guess a target or execute against the generic bridge name.
                        yield { ...event, arguments: {} };
                    }
                }
                else
                    yield event;
            }
        },
    };
}
