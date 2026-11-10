import { createHash, randomUUID } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { link, mkdir, open, readFile, realpath, rename, stat, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { checkImageBytes } from "../media/image-guard.js";
import { generatedMediaArtifacts, GENERATED_MEDIA_SCHEMA, type GeneratedMediaArtifact } from "../../protocol/generated-media.js";
import type { MediaConnection } from "./config.js";
import { MediaFailure, record, type ImageSource, type MediaHttp } from "./http.js";

function inside(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative !== "" && !path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(".." + path.sep);
}
async function exists(target: string): Promise<boolean> {
  try { await stat(target); return true; } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return false;
    throw error;
  }
}

/** Only temporary names created by this operation are eligible for cleanup. */
async function removeTemporary(file: string): Promise<void> {
  try { await unlink(file); } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
  }
}

export class MediaArtifacts {
  constructor(private readonly root: string, private readonly id: () => string = randomUUID) {}

  /** Relative task outputs only; resolve existing parents before any API call. */
  async target(requested: string | undefined, extension: string): Promise<string> {
    const root = await realpath(this.root);
    const relative = requested ?? `.trylo/out/media/${this.id()}.${extension}`;
    if (path.isAbsolute(relative)) throw new MediaFailure("media_output_must_be_workspace_relative");
    const target = path.resolve(root, relative);
    if (!inside(root, target)) throw new MediaFailure("media_output_outside_workspace");
    let parent = path.dirname(target);
    while (!(await exists(parent))) parent = path.dirname(parent);
    const physical = await realpath(parent);
    if (physical !== root && !inside(root, physical)) throw new MediaFailure("media_output_outside_workspace");
    if (await exists(target)) throw new MediaFailure("media_output_exists_choose_new_path");
    await mkdir(path.dirname(target), { recursive: true });
    const finalParent = await realpath(path.dirname(target));
    if (finalParent !== root && !inside(root, finalParent)) throw new MediaFailure("media_output_outside_workspace");
    return target;
  }

  async image(http: MediaHttp, source: ImageSource, target: string, signal: AbortSignal): Promise<GeneratedMediaArtifact> {
    let bytes: Uint8Array;
    if (source.kind === "bytes") bytes = source.bytes;
    else {
      // Download hosts receive no model API credential.
      const response = await http.fetch(source.url, { signal });
      if (!response.ok) throw new MediaFailure(`media_download_http_${response.status}`);
      bytes = new Uint8Array(await response.arrayBuffer());
    }
    const checked = checkImageBytes({ bytes });
    if (!checked.ok) throw new MediaFailure("invalid_generated_image");
    signal.throwIfAborted();
    const extension = checked.attachment.mediaType === "image/jpeg" ? "jpg" : checked.attachment.mediaType.split("/")[1]!;
    const destination = target.endsWith(".image") ? target.slice(0, -6) + "." + extension : target;
    const temporary = target + "." + this.id() + ".part";
    try {
      await writeFile(temporary, bytes, { flag: "wx", signal });
      signal.throwIfAborted();
      await link(temporary, destination);
    } finally { await removeTemporary(temporary); }
    return { path: destination, mimeType: checked.attachment.mediaType, size: bytes.length,
      sha256: createHash("sha256").update(bytes).digest("hex") };
  }

  async video(http: MediaHttp, url: string, target: string, signal: AbortSignal): Promise<GeneratedMediaArtifact> {
    const response = await http.fetch(url, { signal });
    if (!response.ok || !response.body) throw new MediaFailure(`media_download_http_${response.status}`);
    const temporary = target + "." + this.id() + ".part";
    const hash = createHash("sha256");
    try {
      const meter = new Transform({ transform(chunk: Buffer, _encoding, callback) { hash.update(chunk); callback(null, chunk); } });
      await pipeline(Readable.fromWeb(response.body), meter, createWriteStream(temporary, { flags: "wx" }), { signal });
      const file = await open(temporary, "r");
      let header: Buffer;
      try { header = Buffer.alloc(12); await file.read(header, 0, 12, 0); } finally { await file.close(); }
      const mimeType = header.subarray(4, 8).toString() === "ftyp" ? "video/mp4"
        : header.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3])) ? "video/webm" : undefined;
      if (!mimeType) throw new MediaFailure("invalid_generated_video");
      signal.throwIfAborted();
      const destination = target.endsWith(".video") ? target.slice(0, -6) + (mimeType === "video/mp4" ? ".mp4" : ".webm") : target;
      // A concurrent task must never make this download overwrite its file.
      await link(temporary, destination);
      return { path: destination, mimeType, size: (await stat(destination)).size, sha256: hash.digest("hex") };
    } finally {
      await removeTemporary(temporary);
    }
  }

  private jobPath(id: string): string {
    return path.join(this.root, ".trylo", "media-jobs", createHash("sha256").update(id).digest("hex") + ".json");
  }
  async putJob(id: string, value: MediaJob): Promise<void> {
    const destination = await this.target(path.relative(this.root, this.jobPath(id)), "json");
    await writeFile(destination, JSON.stringify(value), { flag: "wx" });
  }
  async completeJob(id: string, job: MediaJob, artifact: GeneratedMediaArtifact): Promise<void> {
    const destination = await realpath(this.jobPath(id));
    if (!inside(await realpath(this.root), destination)) throw new MediaFailure("media_output_outside_workspace");
    const temporary = destination + "." + this.id() + ".part";
    try {
      await writeFile(temporary, JSON.stringify({ ...job, artifact }), { flag: "wx" });
      await rename(temporary, destination);
    } finally {
      await removeTemporary(temporary);
    }
  }
  async job(id: string): Promise<MediaJob> {
    let parsed: unknown;
    try {
      const source = await realpath(this.jobPath(id));
      if (!inside(await realpath(this.root), source)) throw new MediaFailure("media_output_outside_workspace");
      parsed = JSON.parse(await readFile(source, "utf8"));
    }
    catch { throw new MediaFailure("media_job_receipt_unavailable"); }
    const value = record(parsed);
    if (value.version !== 1 || typeof value.taskId !== "string" || typeof value.connection !== "string"
      || typeof value.outputPath !== "string") throw new MediaFailure("invalid_media_job_receipt");
    const artifact = value.artifact === undefined ? undefined
      : generatedMediaArtifacts({ generatedMedia: { schema: GENERATED_MEDIA_SCHEMA, artifacts: [value.artifact] } })?.[0];
    if (value.artifact !== undefined && artifact === undefined) throw new MediaFailure("invalid_media_job_receipt");
    if (artifact && !inside(await realpath(this.root), await realpath(artifact.path))) throw new MediaFailure("media_output_outside_workspace");
    return { version: 1, taskId: value.taskId, connection: value.connection, outputPath: value.outputPath,
      ...(artifact === undefined ? {} : { artifact }) };
  }
}
export type MediaJob = { readonly version: 1; readonly taskId: string; readonly connection: string; readonly outputPath: string;
  readonly artifact?: GeneratedMediaArtifact };
export function connectionIdentity(connection: MediaConnection): string {
  return createHash("sha256").update(JSON.stringify([connection.protocol, connection.endpoint, connection.model])).digest("hex");
}

/** Used only to verify a previously delivered artifact without loading a video. */
export async function artifactDigest(file: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest("hex");
}
