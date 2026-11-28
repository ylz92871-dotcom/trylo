import { desktopControl as windows } from './windows/index.mjs';
import { desktopControl as macos } from './macos/index.mjs';
import { desktopControl as linux } from './linux/index.mjs';

const platforms = Object.freeze({ win32: windows, darwin: macos, linux });

/** Package selection only. The catalogue and health checks establish availability. */
export function desktopControlForPlatform(platform) {
  return platforms[platform] ?? null;
}
