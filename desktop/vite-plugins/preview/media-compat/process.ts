import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { closeSync, openSync } from 'node:fs';
import policy from '../../../src/preview/providers/media-policy.json';

/** FFmpeg receives one already validated, seekable, read-only descriptor. Its
 * input demuxers/protocols cannot follow a playlist to local/network files. */
export function spawnMedia(executable: string, args: string[], source: string, cwd?: string) {
  const fd = openSync(source, 'r');
  let child: ChildProcessWithoutNullStreams;
  try {
    const env = { ...process.env }; delete env.FFREPORT;
    child = spawn(executable, args, { cwd, env, windowsHide: true, stdio: [fd, 'pipe', 'pipe'] }) as ChildProcessWithoutNullStreams;
  } finally { closeSync(fd); }
  // These console executables do not launch child processes. Node retains the
  // spawned process handle; cancellation never targets an image name/PID scan.
  let diagnostic = '';
  child.stderr.on('data', (part: Buffer) => { if (diagnostic.length < 8192) diagnostic += part.toString('utf8').slice(0, 8192 - diagnostic.length); });
  const done = new Promise<void>((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code) => code === 0 ? resolve() : reject(new Error(diagnostic || '媒体转换失败')));
  });
  void done.catch(() => {});
  return { child, done, stop: () => { if (child.exitCode === null && child.signalCode === null) child.kill(); } };
}

export async function probeMedia(executable: string, args: string[], source: string, signal: AbortSignal): Promise<unknown> {
  signal.throwIfAborted();
  const job = spawnMedia(executable, args, source);
  const abort = (): void => { job.stop(); };
  signal.addEventListener('abort', abort, { once: true });
  if (signal.aborted) abort();
  const timer = setTimeout(abort, policy.probeTimeoutMs);
  const chunks: Buffer[] = []; let bytes = 0;
  try {
    for await (const part of job.child.stdout) {
      bytes += (part as Buffer).length;
      if (bytes > policy.maxProbeBytes) throw new Error('媒体信息超过限制');
      chunks.push(part as Buffer);
    }
    await job.done; signal.throwIfAborted();
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } finally {
    clearTimeout(timer); signal.removeEventListener('abort', abort); job.stop(); await job.done.catch(() => {});
  }
}
