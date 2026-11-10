import { createMediaGenerationTools } from "../../adapters/media-generation/index.js";
import { readMediaConfiguration } from "../../adapters/media-generation/config.js";
import { EXIT_CODES } from "../../protocol/cli-stream.js";
import type { ToolPort } from "../../ports/tools.js";
import { fail, type RunFailure } from "./run-failure.js";

export function mediaToolsFor(env: Readonly<Record<string, string | undefined>>, workspaceRoot: string): ToolPort | RunFailure | undefined {
  try {
    const configuration = readMediaConfiguration(env.TRYLO_MEDIA_CONFIG);
    if (!configuration || !configuration.image?.enabled && !configuration.video?.enabled) return undefined;
    return createMediaGenerationTools({ configuration, workspaceRoot });
  } catch {
    return fail(EXIT_CODES.CONFIG, "Invalid image/video connection configuration.", "Review Settings → 图片与视频; credentials were not sent.");
  }
}
