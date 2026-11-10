import path from "node:path";
import { randomUUID } from "node:crypto";
import { realpath } from "node:fs/promises";
import type { ToolBinding, ToolCallRequest, ToolOutcome, ToolPort } from "../../ports/tools.js";
import { GENERATED_MEDIA_SCHEMA, type GeneratedMediaArtifact } from "../../protocol/generated-media.js";
import { MediaArtifacts, artifactDigest, connectionIdentity } from "./artifacts.js";
import { MediaFailure, type MediaHttp } from "./http.js";
import { generateImages } from "./images.js";
import { createVideo, getVideo } from "./videos.js";
import type { MediaConfiguration } from "./config.js";

const IMAGE_PARAMETERS = { type: "object", properties: {
  prompt: { type: "string", description: "The requested image or video content." },
  path: { type: "string", description: "Optional new workspace-relative output file. Defaults to .trylo/out/media; existing files are not overwritten." },
  size: { type: "string", description: "Optional exact size/resolution supported by this configured provider/model; omit to use its default." },
}, required: ["prompt"], additionalProperties: false };
const CREATE_PARAMETERS = { ...IMAGE_PARAMETERS, properties: { ...IMAGE_PARAMETERS.properties,
  seconds: { type: "number", description: "Optional video duration supported by this provider/model." },
} };

function receipt(artifacts: readonly GeneratedMediaArtifact[], workspace: string, disposition: "created" | "retained" = "created"): ToolOutcome {
  const relative = artifacts.map(artifact => path.relative(workspace, artifact.path).replaceAll("\\", "/"));
  return { outcome: "result", value: {
    generatedMedia: { schema: GENERATED_MEDIA_SCHEMA, artifacts: artifacts.map(artifact => ({ ...artifact })) },
    ...(disposition === "created" ? { fileWrites: artifacts.map((artifact, index) => ({ kind: "file_write", path: relative[index]!, bytes: artifact.size, mode: "created" })) } : {}),
  }, output: JSON.stringify({ status: "succeeded", files: artifacts.map((artifact, index) => ({
    path: relative[index]!, mimeType: artifact.mimeType, size: artifact.size, sha256: artifact.sha256,
  })) }), truncated: false };
}

export function createMediaGenerationTools(input: {
  readonly configuration: MediaConfiguration; readonly workspaceRoot: string;
  readonly fetch?: typeof globalThis.fetch; readonly id?: () => string;
}): ToolPort {
  const { configuration, workspaceRoot } = input;
  const http: MediaHttp = { fetch: input.fetch ?? globalThis.fetch };
  const id = input.id ?? randomUUID;
  const bindings: ToolBinding[] = [];
  const binding = (name: string, description: string, parameters: ToolBinding["parameters"] = CREATE_PARAMETERS): ToolBinding => ({ name, description,
    parameters, sideEffect: "external", needsApproval: true, outputLimits: { maxBytes: 32_768, maxLines: 200 } });
  if (configuration.image?.enabled) bindings.push(binding("image_generate",
    `Generate an image with the user's configured ${configuration.image.protocol} / ${configuration.image.model} connection and save the actual image. Do not resubmit a call with unknown outcome.`, IMAGE_PARAMETERS));
  if (configuration.video?.enabled) {
    bindings.push(binding("video_generate", `Create one video task with ${configuration.video.protocol} / ${configuration.video.model}. Returns job_id immediately; use video_get_result to resume it. Do not recreate a pending task.`));
    bindings.push({ ...binding("video_get_result", "Check an existing video job and save its finished video. Pending means continue independent work and check later, never create it again."),
      parameters: { type: "object", properties: { job_id: { type: "string" } }, required: ["job_id"] } });
  }

  return {
    snapshot: () => bindings,
    async execute(call: ToolCallRequest, signal: AbortSignal): Promise<ToolOutcome> {
      if (!bindings.some(item => item.name === call.name)) return { outcome: "error", code: "unknown_tool", message: "No matching media connection is configured." };
      if (signal.aborted) return { outcome: "cancelled" };
      let effect: "none" | "create-submitted" | "artifact-written" = "none";
      try {
        const physicalRoot = await realpath(workspaceRoot);
        const artifacts = new MediaArtifacts(physicalRoot, id);
        if (call.name === "video_get_result") {
          const jobId = call.arguments.job_id;
          if (typeof jobId !== "string" || !jobId) throw new MediaFailure("invalid_media_job_id");
          const job = await artifacts.job(jobId), connection = configuration.video!;
          if (job.connection !== connectionIdentity(connection)) throw new MediaFailure("media_job_connection_changed");
          if (job.artifact) {
            if (await artifactDigest(job.artifact.path) !== job.artifact.sha256) throw new MediaFailure("media_artifact_changed");
            return receipt([job.artifact], physicalRoot, "retained");
          }
          const progress = await getVideo(http, connection, job.taskId, signal);
          if (progress.status === "failed" || progress.status === "cancelled") return {
            outcome: "error", code: `media_generation_${progress.status}`,
            message: `The provider reports this video job ${progress.status}. Its receipt was retained; no replacement task was created.`,
          };
          if (progress.status !== "succeeded") return { outcome: "result", value: { job_id: jobId, status: progress.status },
            output: JSON.stringify({ job_id: jobId, status: progress.status, next: "Check this job later; do not recreate it." }), truncated: false };
          const target = await artifacts.target(job.outputPath, "video");
          const artifact = await artifacts.video(http, progress.url!, target, signal);
          effect = "artifact-written";
          await artifacts.completeJob(jobId, job, artifact);
          return receipt([artifact], physicalRoot);
        }
        const prompt = call.arguments.prompt, requested = call.arguments.path, size = call.arguments.size, seconds = call.arguments.seconds;
        if (typeof prompt !== "string" || !prompt.trim() || requested !== undefined && typeof requested !== "string"
          || size !== undefined && typeof size !== "string" || seconds !== undefined && (typeof seconds !== "number" || !Number.isFinite(seconds) || seconds <= 0)) {
          throw new MediaFailure("invalid_media_arguments");
        }
        if (call.name === "image_generate" && seconds !== undefined) throw new MediaFailure("image_generation_has_no_duration");
        if (call.name === "image_generate" && configuration.image!.protocol === "gemini-images" && size !== undefined
          && !["1K", "2K", "4K"].includes(size)) throw new MediaFailure("gemini_image_size_requires_1K_2K_or_4K");
        const target = await artifacts.target(requested, call.name === "image_generate" ? "image" : "video");
        const options = { prompt, ...(size === undefined ? {} : { size }), ...(seconds === undefined ? {} : { seconds }) };
        effect = "create-submitted";
        if (call.name === "image_generate") {
          const images = await generateImages(http, configuration.image!, options, signal);
          const saved: GeneratedMediaArtifact[] = [];
          for (const [index, image] of images.entries()) {
            const imageTarget = index === 0 ? target : await artifacts.target(undefined, "image");
            saved.push(await artifacts.image(http, image, imageTarget, signal));
            effect = "artifact-written";
          }
          return receipt(saved, physicalRoot);
        }
        const taskId = await createVideo(http, configuration.video!, options, signal);
        const jobId = id();
        await artifacts.putJob(jobId, { version: 1, taskId, connection: connectionIdentity(configuration.video!),
          outputPath: path.relative(physicalRoot, target) });
        return { outcome: "result", value: { job_id: jobId, status: "pending" },
          output: JSON.stringify({ job_id: jobId, status: "pending", next: "Use video_get_result for this job; do not recreate it." }), truncated: false };
      } catch (error) {
        if (signal.aborted && effect === "none") return { outcome: "cancelled" };
        if (error instanceof MediaFailure && (effect === "none" || effect === "create-submitted"
          && /^media_http_4\d\d$/.test(error.code) && error.code !== "media_http_408")) {
          return { outcome: "error", code: error.code, message: error.code + ": inspect the configured media connection or retained job; no retry was issued." };
        }
        // Unknown POST/receipt failures may have charged or created work.
        // Never turn missing acknowledgement into an automatic second create.
        if (effect === "artifact-written") return { outcome: "unknown", code: "media_delivery_outcome_unknown",
          message: "A media file was saved but its delivery receipt is incomplete. Inspect the retained job and output files before retrying." };
        return effect === "create-submitted" ? { outcome: "unknown", code: "media_create_outcome_unknown", message: "The media create receipt is unknown. Inspect the provider account before creating again." }
          : { outcome: "error", code: "media_operation_failed", message: "The media operation failed; the existing job and files were preserved." };
      }
    },
    async cancel() { /* Fetch and file IO use the executor's abort signal; remote jobs retain their receipt. */ },
  };
}
