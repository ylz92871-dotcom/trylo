import type { JsonObject } from "../../protocol/envelope.js";
import type { ToolBinding, ToolCallRequest, ToolOutcome, ToolPort } from "../../ports/tools.js";
import { demandModel, type ModelCatalog } from "../provider/model-catalog.js";
import { checkImageBytes, describeImageForLog } from "./image-guard.js";

export const GENERATE_IMAGE_TOOL = "generate_image";

/**
 * Image generation gate (WP19.3: C59).
 *
 * Reuse: Codex `ext/image-generation` — availability decided up front (there:
 * OpenAI-backed provider + capability + modality; here: an injected backend +
 * the model card's `image_generation` tool kind), generation behind a service
 * adapter, artifacts validated before they travel further.
 *
 * What this gate does not do is deliberate: it never invents a backend, and
 * an unadvertised tool is not a broken promise — with no backend the tool is
 * absent from the catalog entirely, so a model can neither call it nor be
 * refused for trying. Artifact persistence (save root, atomic write, file
 * facts) stays with the run layer that owns `atomic-write`, named in the
 *施工记录 as the remaining seam rather than smuggled in here.
 */

export type GeneratedArtifact = {
  readonly bytes: Uint8Array;
  readonly width?: number;
  readonly height?: number;
};

export type ImageGenerationBackend = {
  generate(
    input: { readonly prompt: string },
    signal: AbortSignal,
  ): Promise<
    | { readonly ok: true; readonly artifact: GeneratedArtifact }
    | { readonly ok: false; readonly code: string; readonly message: string }
  >;
};

export type ImageGenerationConfig = {
  readonly backend?: ImageGenerationBackend;
  /**
   * Declared catalog and run model for the `image_generation` tool-kind demand.
   * Both absent means the run layer did not declare: the gate then checks the
   * backend only and invents no refusal, the same rule `demandModel` applies
   * to undeclared models.
   */
  readonly catalog?: ModelCatalog;
  readonly modelId?: string;
};

const GENERATE_IMAGE_BINDING: ToolBinding = {
  name: GENERATE_IMAGE_TOOL,
  description:
    "Generate an image from a text prompt via the configured image service. Only offered when a backend is configured; otherwise the tool is absent, not failing. The text result is a redacted summary and the bytes travel in the structured result.",
  sideEffect: "external",
  parameters: {
    type: "object",
    properties: {
      prompt: { type: "string", description: "What to depict. A concrete visual description, not a file path." },
    },
    required: ["prompt"],
  },
  needsApproval: true,
  timeoutMs: 120_000,
  outputLimits: { maxBytes: 1024, maxLines: 20 },
};

function readPrompt(args: JsonObject): string | undefined {
  const value = args.prompt;
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

export function createImageGenerationTools(config: ImageGenerationConfig): ToolPort {
  return {
    snapshot() {
      return config.backend === undefined ? [] : [GENERATE_IMAGE_BINDING];
    },
    async execute(call: ToolCallRequest, signal: AbortSignal): Promise<ToolOutcome> {
      if (call.name !== GENERATE_IMAGE_TOOL) {
        return { outcome: "error", code: "unknown_tool", message: `unknown_tool:${call.name}` };
      }

      const prompt = readPrompt(call.arguments);
      if (prompt === undefined) {
        return { outcome: "error", code: "invalid_arguments", message: "generate_image requires prompt" };
      }

      if (signal.aborted) {
        return { outcome: "cancelled" };
      }

      if (config.backend === undefined) {
        return {
          outcome: "error",
          code: "image_generation_unavailable",
          message: "image_generation_unavailable: no image backend configured (externally_blocked)",
        };
      }

      if (config.catalog !== undefined && config.modelId !== undefined) {
        const demand = demandModel(config.catalog, config.modelId, { kind: "toolKind", toolKind: "image_generation" });
        if (!demand.ok) {
          return {
            outcome: "error",
            code: "model_unsupported",
            message: `model_unsupported: ${config.modelId} does not declare the image_generation tool kind`,
          };
        }
      }

      let generated: Awaited<ReturnType<ImageGenerationBackend["generate"]>>;

      try {
        generated = await config.backend.generate({ prompt }, signal);
      } catch (error) {
        if (signal.aborted) {
          return { outcome: "cancelled" };
        }
        const message = error instanceof Error ? error.message : "backend threw";
        return { outcome: "error", code: "image_backend_threw", message: `image_backend_threw:${message}` };
      }

      if (signal.aborted) {
        return { outcome: "cancelled" };
      }

      if (!generated.ok) {
        return { outcome: "error", code: generated.code, message: generated.message };
      }

      // The service is not trusted on format: its bytes face the same guard as
      // a local file before they may travel further.
      const validation = checkImageBytes({ bytes: generated.artifact.bytes });
      if (!validation.ok) {
        return {
          outcome: "error",
          code: "image_generation_failed",
          message: `image_generation_failed: service returned ${validation.code}`,
        };
      }

      const attachment = { ...validation.attachment, detail: "high" as const };
      const summary = describeImageForLog(attachment);
      const value: JsonObject = {
        mediaType: attachment.mediaType,
        bytes: attachment.bytes,
        ...(attachment.width === undefined ? {} : { width: attachment.width }),
        ...(attachment.height === undefined ? {} : { height: attachment.height }),
        dataUrl: `data:${attachment.mediaType};base64,${attachment.dataBase64}`,
      };

      return { outcome: "result", value, output: `${summary} prompt=${JSON.stringify(prompt)}`, truncated: false };
    },
    async cancel(): Promise<void> {
      return;
    },
  };
}
