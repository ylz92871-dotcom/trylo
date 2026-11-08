import type { ProviderEvent, ProviderPort } from "../../ports/provider.js";
import { emptyUsage } from "../../ports/provider.js";
import type { ToolOutcome } from "../../ports/tools.js";
import type { TurnHostInput } from "./host.js";
import type { Wiring, WiringFailure } from "./wiring.js";
import { literalFileCommand } from "./literal-file-command.js";

/** Explicit literal files use the same tools, permissions and turn budget as
 * model tasks. This interpreter never writes or reads the filesystem itself.
 */
export function fileCommandWiring(wiring: Wiring | WiringFailure, input: TurnHostInput): Wiring | WiringFailure {
  if ("code" in wiring) return wiring;

  const command = literalFileCommand(input.text);
  if (command === undefined) return wiring;

  let step = 0, callId: string | undefined, outcome: ToolOutcome | undefined;
  let written = false;
  const provider: ProviderPort = {
    async *stream(request, signal): AsyncIterable<ProviderEvent> {
      if (signal.aborted) {
        yield { type: "cancel_ack" };
        return;
      }

      yield { type: "stream_start", providerId: "trylo-file-command", model: "local", warnings: [] };
      const name = step === 0 && input.maxIterations !== 1 ? "write_file" : step === 1 && written ? "read_file" : undefined;
      if (name !== undefined && request.tools.some((tool) => tool.name === name)) {
        if (step === 0) {
          yield { type: "text_start", blockId: "file-permission" };
          yield { type: "text_delta", blockId: "file-permission", text: "尚未写入，正在核验本次文件操作的权限。" };
          yield { type: "text_end", blockId: "file-permission" };
        }

        callId = `file-command:${input.turnId}:${step++}`;
        yield { type: "tool_call", toolCallId: callId, name, arguments: name === "write_file"
          ? { path: command.path, content: command.content } : { path: command.path } };
        yield { type: "finish", reason: "tool_calls", rawReason: "tool_calls", requiresFollowUp: true };

        return;
      }

      const verified = written && step === 2 && outcome?.outcome === "result" && !outcome.truncated
        && outcome.value["path"] === command.path && outcome.value["content"] === command.content;
      const text = verified ? `已写入项目文件 ${command.path}，并已读回核对字面内容。`
        : written ? `项目文件 ${command.path} 已写入，但尚未通过读回核验，不能确认交付。`
          : `尚未写入项目文件 ${command.path}：写入未获许可、失败或本轮预算不足。`;

      yield { type: "text_start", blockId: "file-receipt" };
      yield { type: "text_delta", blockId: "file-receipt", text };
      yield { type: "text_end", blockId: "file-receipt" };
      yield { type: "usage", usage: emptyUsage() };

      if (verified) yield { type: "finish", reason: "stop", rawReason: "stop", requiresFollowUp: false };
      else yield { type: "error", class: "invalid_request", retryable: false, phase: "after_stream_started", message: "file_delivery_unverified" };
    },
  };
  const tools = wiring.ports.tools;

  return { ...wiring, providerId: "trylo-file-command", model: "local", ports: { ...wiring.ports, provider,
    tools: { ...tools, async execute(call, signal) {
      const result = await tools.execute(call, signal);
      if (call.toolCallId === callId) {
        outcome = result;
        if (call.name === "write_file") written = result.outcome === "result";
      }
      return result;
    } },
  } };
}
