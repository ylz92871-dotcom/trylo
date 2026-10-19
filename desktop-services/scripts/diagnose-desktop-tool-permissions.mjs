import fs from 'node:fs';
import path from 'node:path';
import { defaultProbeWindowsInputAccess } from '../src/tooling/windows-input-access.mjs';

// Read-only diagnosis: inspect installations and process tokens; send no input.
const appData = process.env.APPDATA;
if (!appData) throw new Error('APPDATA is missing');
const roots = [path.join(appData, 'me.trylocode.trylo', 'Trylo', 'tool-packages'),
  path.join(appData, 'me.trylocode.trylo', 'tool-packages')];
const report = [];
for (const root of roots) {
  for (const [id, version, executable] of [['windows-mcp', '0.8.5', 'windows-mcp.exe'], ['autocad-mcp', '1.5.1', 'autocad-mcp.exe']]) {
    const dir = path.join(root, id, version);
    const entry = path.join(dir, '.venv', 'Scripts', executable);
    const item = { root, id, installed: fs.existsSync(entry) };
    if (item.installed) item.inputAccess = await defaultProbeWindowsInputAccess(entry);
    if (id === 'autocad-mcp') {
      const backend = path.join(dir, '.venv', 'Lib', 'site-packages', 'backends', 'com_backend.py');
      if (fs.existsSync(backend)) {
        const source = fs.readFileSync(backend, 'utf8');
        item.com = { threadLocal: source.includes('_COM_THREAD_STATE'), busyGuard: source.includes('def _trylo_require_com_ready('),
          generatedCacheLookup: source.includes('win32com.client.GetActiveObject(progid)') || source.includes('win32com.client.Dispatch(progid)') };
      }
    }
    report.push(item);
  }
}
console.log(JSON.stringify(report, null, 2));
