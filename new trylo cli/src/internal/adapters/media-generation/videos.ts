import { mediaApiUrl, type MediaConnection } from "./config.js";
import { imageUrl, list, mediaJson, record, text, MediaFailure, type MediaHttp } from "./http.js";

export type VideoProgress = { readonly status: "pending" | "running" | "succeeded" | "failed" | "cancelled";
  readonly taskId: string; readonly url?: string };

export async function createVideo(http: MediaHttp, connection: MediaConnection,
  input: { readonly prompt: string; readonly size?: string; readonly seconds?: number }, signal: AbortSignal): Promise<string> {
  const size = input.size ? { size: input.size } : {}, duration = input.seconds === undefined ? {} : { duration: input.seconds };
  let data: Record<string, unknown>;
  if (connection.protocol === "ark-video") {
    data = await mediaJson(http, mediaApiUrl(connection, "contents/generations/tasks"), connection, signal,
      { model: connection.model, content: [{ type: "text", text: input.prompt }], ...duration,
        ...(input.size ? { resolution: input.size } : {}) });
  } else if (connection.protocol === "dashscope-video") {
    data = await mediaJson(http, mediaApiUrl(connection, "services/aigc/video-generation/video-synthesis"), connection, signal,
      { model: connection.model, input: { prompt: input.prompt }, parameters: { ...size, ...duration } }, { "X-DashScope-Async": "enable" });
  } else if (connection.protocol === "replicate-video") {
    if (!/^[\w.-]+\/[\w.-]+$/.test(connection.model)) throw new MediaFailure("replicate_model_requires_owner_and_name");
    data = await mediaJson(http, mediaApiUrl(connection, `models/${connection.model}/predictions`), connection, signal,
      { input: { prompt: input.prompt, ...duration, ...size } });
  } else throw new MediaFailure("unsupported_video_protocol");
  const id = text(data.id) ?? text(record(data.output).task_id);
  if (!id) throw new MediaFailure("media_task_receipt_missing");
  return id;
}

export async function getVideo(http: MediaHttp, connection: MediaConnection, taskId: string, signal: AbortSignal): Promise<VideoProgress> {
  const suffix = connection.protocol === "ark-video" ? "contents/generations/tasks/" : connection.protocol === "dashscope-video" ? "tasks/" : "predictions/";
  const data = await mediaJson(http, mediaApiUrl(connection, suffix + encodeURIComponent(taskId)), connection, signal);
  const output = record(data.output);
  const raw = (text(data.status) ?? text(output.task_status) ?? "").toLowerCase();
  const status = ["succeeded", "completed"].includes(raw) ? "succeeded" : raw === "failed" ? "failed"
    : ["cancelled", "canceled"].includes(raw) ? "cancelled" : ["pending", "queued", "starting"].includes(raw) ? "pending"
      : ["running", "processing", "in_progress"].includes(raw) ? "running" : undefined;
  if (!status) throw new MediaFailure("unknown_media_task_status");
  const url = text(record(data.content).video_url) ?? text(output.video_url) ?? text(data.output) ?? text(list(data.output)[0]);
  if (status === "succeeded" && !url) throw new MediaFailure("media_result_missing_video");
  const source = url ? imageUrl(url) : undefined;
  if (source?.kind === "bytes") throw new MediaFailure("invalid_media_video_url");
  return { status, taskId, ...(source?.kind === "url" ? { url: source.url } : {}) };
}
