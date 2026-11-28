const targets = Object.freeze({
  win32: Object.freeze({ name: 'windows', config: 'tauri.windows.conf.json' }),
  darwin: Object.freeze({ name: 'macos', config: 'tauri.macos.conf.json' }),
  linux: Object.freeze({ name: 'linux', config: 'tauri.linux.conf.json' }),
});

export function buildPlatform(platform) {
  const target = targets[platform];
  if (!target) throw new Error('Desktop build is unsupported on ' + platform);
  return target;
}
