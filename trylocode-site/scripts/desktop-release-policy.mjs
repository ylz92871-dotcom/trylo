/** Add a versioned installer without changing old artifact routes or other policies. */
export function desktopReleasePolicy(config, release) {
  if (!/^\d+\.\d+\.\d+$/.test(release.version)
      || release.installer.file !== `Trylo_${release.version}_x64-setup.exe`
      || release.installer.path !== `/download/desktop/releases/${release.version}/${release.installer.file}`) {
    throw new Error('Unexpected versioned installer');
  }
  if ((config.match(/^    file_server\s*$/gm) ?? []).length !== 1) throw new Error('Inspect static file_server before updating');
  const matcher = `desktopInstaller_${release.version.replaceAll('.', '_')}`;
  if (config.includes(`@${matcher} `)) throw new Error('This version already has a delivery policy');
  let base = config;
  let common = '';
  if (base.includes('@desktopPackages')) {
    const current = /^    header @desktopDelivery X-Trylo-Desktop "[\d.]+"$/gm;
    if ([...base.matchAll(current)].length !== 1) throw new Error('Inspect existing Desktop delivery policy');
    base = base.replace(current, `    header @desktopDelivery X-Trylo-Desktop "${release.version}"`);
  } else {
    common = `    @desktopPackages path /download/desktop/releases/*\n    header @desktopPackages Cache-Control "public, max-age=31536000, immutable"\n    @desktopDelivery path /download/desktop/ /download/desktop/releases/*\n    header @desktopDelivery X-Trylo-Desktop "${release.version}"\n`;
  }
  const installer = `    @${matcher} path ${release.installer.path}\n    header @${matcher} {\n        Content-Disposition "attachment; filename=${release.installer.file}"\n        Content-Type application/octet-stream\n    }\n`;
  return base.replace('    file_server', common + installer + '    file_server');
}
