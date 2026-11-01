import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export function buildPortableLauncher(outputDirectory) {
  if (process.platform !== 'win32') throw new Error('The portable launcher targets Windows.');
  const source = fileURLToPath(new URL('./portable-launcher.rs', import.meta.url));
  const output = path.join(path.resolve(outputDirectory), 'Start-Trylo.exe');
  mkdirSync(path.dirname(output), { recursive: true });
  execFileSync('rustc', ['--edition=2021', '-D', 'warnings', '-O', '-C', 'strip=symbols', source, '-o', output], {
    windowsHide: true, stdio: 'pipe', timeout: 120_000,
  });
  const bytes = readFileSync(output);
  const pe = bytes.readUInt32LE(0x3c);
  if (bytes.readUInt16LE(pe + 24 + 68) !== 2) throw new Error('Portable launcher must use the Windows GUI subsystem.');
  execFileSync(path.join(process.env.SystemRoot || 'C:\\Windows', 'System32/icacls.exe'),
    [output, '/setintegritylevel', 'M'], { windowsHide: true, stdio: 'pipe' });
  const digest = value => createHash('sha256').update(value).digest('hex');
  writeFileSync(path.join(path.dirname(output), 'portable-launcher.build.json'), JSON.stringify({
    sourceSha256: digest(readFileSync(source)), executableSha256: digest(bytes), subsystem: 2,
    compiler: execFileSync('rustc', ['--version'], { windowsHide: true, encoding: 'utf8' }).trim(),
  }, null, 2) + '\n');
  return output;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  console.log(buildPortableLauncher(process.argv[2] || fileURLToPath(new URL('../src-tauri/target/release/', import.meta.url))));
}
