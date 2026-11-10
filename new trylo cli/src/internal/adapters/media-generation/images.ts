import { mediaApiUrl, type MediaConnection } from "./config.js";
import { imageUrl, list, mediaJson, record, text, MediaFailure, type ImageSource, type MediaHttp } from "./http.js";

export async function generateImages(http: MediaHttp, connection: MediaConnection, input: { readonly prompt: string; readonly size?: string },
  signal: AbortSignal): Promise<readonly ImageSource[]> {
  const size = input.size ? { size: input.size } : {};
  let result: readonly (ImageSource | undefined)[];
  if (connection.protocol === "openai-images") {
    const data = await mediaJson(http, mediaApiUrl(connection, "images/generations"), connection, signal,
      { model: connection.model, prompt: input.prompt, ...size });
    result = list(data.data).map(value => {
      const item = record(value), base64 = text(item.b64_json);
      return base64 ? { kind: "bytes" as const, bytes: Buffer.from(base64, "base64") } : imageUrl(item.url);
    });
  } else if (connection.protocol === "dashscope-images") {
    const data = await mediaJson(http, mediaApiUrl(connection, "services/aigc/multimodal-generation/generation"), connection, signal,
      { model: connection.model, input: { messages: [{ role: "user", content: [{ text: input.prompt }] }] }, parameters: size });
    result = list(record(data.output).choices).flatMap(choice => list(record(record(choice).message).content)).map(part => imageUrl(record(part).image));
  } else if (connection.protocol === "gemini-images") {
    if (input.size && !["1K", "2K", "4K"].includes(input.size)) throw new MediaFailure("gemini_image_size_requires_1K_2K_or_4K");
    const data = await mediaJson(http, mediaApiUrl(connection, `models/${encodeURIComponent(connection.model)}:generateContent`), connection, signal,
      { contents: [{ parts: [{ text: input.prompt }] }], generationConfig: { responseModalities: ["TEXT", "IMAGE"],
        ...(input.size ? { imageConfig: { imageSize: input.size } } : {}) } });
    result = list(data.candidates).flatMap(candidate => list(record(record(candidate).content).parts)).map(part => {
      const inline = record(record(part).inlineData), base64 = text(inline.data);
      return base64 ? { kind: "bytes" as const, bytes: Buffer.from(base64, "base64") } : undefined;
    });
  } else throw new MediaFailure("unsupported_image_protocol");
  const images = result.filter((source): source is ImageSource => source !== undefined);
  if (!images.length) throw new MediaFailure("media_result_missing_image");
  return images;
}
