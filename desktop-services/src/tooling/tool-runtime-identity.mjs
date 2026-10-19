// Cache/reuse identity, not a substitute for artifact digest verification.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export function toolInstallDir(manifest, executable) {
  const relative=String(manifest.artifact?.executableRelativePath ?? '').replaceAll('\\','/');
  const target=String(executable ?? '').replaceAll('\\','/');
  if (relative && target.toLowerCase().endsWith(`/${relative.toLowerCase()}`)) {
    const root=target.slice(0,-relative.length);
    return path.normalize(/^[a-z]:\/$/i.test(root)?root:root.replace(/\/$/,''));
  }
  return path.dirname(executable);
}

function fileIdentity(file) {
  if (!file) return null;
  try {
    const info=fs.statSync(file);
    return [path.resolve(file),info.size,info.mtimeMs,info.ctimeMs];
  } catch(error) { return [file,error.code]; }
}

export function toolRuntimeIdentity(manifest, installed) {
  const executable=installed.executable ?? null;
  const root=installed.installDir ?? (executable ? toolInstallDir(manifest,executable) : null);
  const files=[executable];
  if (root) files.push(path.join(root,'install-state.json'));
  if (executable && /python/.test(manifest.artifact?.installStrategy ?? manifest.healthCheck ?? '')) {
    files.push(path.join(path.dirname(executable),'python.exe'));
  }
  if (root && manifest.artifact?.sourceEntry) files.push(path.join(root,manifest.artifact.sourceEntry));
  if (root && manifest.id==='windows-mcp') {
    for(const relative of ['__main__.py','uia/core.py','desktop/service.py','runtime/snapshot_store.py']) {
      files.push(path.join(root,'src/windows_mcp',relative));
    }
  }
  if (root && manifest.id==='autocad-mcp') files.push(path.join(root,'.venv/Lib/site-packages/backends/com_backend.py'));
  return crypto.createHash('sha256').update(JSON.stringify({id:manifest.id,version:manifest.version,
    state:installed.state,autoUpdate:installed.autoUpdate,files:[...new Set(files)].map(fileIdentity)})).digest('hex');
}
