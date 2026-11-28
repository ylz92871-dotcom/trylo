import os from 'node:os';
import path from 'node:path';

/** Keep writable browser registration per task, while reading the installed binaries. */
export function browserRuntimeEnv(runtimeDir, { platform = process.platform, env = process.env, home = os.homedir() } = {}) {
  if (platform !== 'win32') return {};
  const localData = env.LOCALAPPDATA || path.join(home, 'AppData', 'Local');
  const browsers = env.PLAYWRIGHT_BROWSERS_PATH;
  return {
    LOCALAPPDATA: path.join(runtimeDir, 'browser-cache'),
    // Custom values, including '0' and relative paths, retain Playwright's own resolution.
    PLAYWRIGHT_BROWSERS_PATH: browsers || path.join(localData, 'ms-playwright'),
  };
}
