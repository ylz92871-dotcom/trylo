import { createMediaGenerationTools } from "../../adapters/media-generation/index.js";
import { readMediaConfiguration } from "../../adapters/media-generation/config.js";
import type { ToolPort } from "../../ports/tools.js";

export function mediaToolsFor(env: Readonly<Record<string, string | undefined>>, workspaceRoot: string): {
  readonly tools?: ToolPort;
  readonly warning?: string;
} {
  try {
    const configuration = readMediaConfiguration(env.TRYLO_MEDIA_CONFIG);
    if (!configuration || !configuration.image?.enabled && !configuration.video?.enabled) return {};
    return { tools: createMediaGenerationTools({ configuration, workspaceRoot }) };
  } catch {
    return { warning: "Invalid image/video connection configuration. Image/video tools are unavailable; other work can continue. Review Settings → 图片与视频; credentials were not sent." };
  }
}
