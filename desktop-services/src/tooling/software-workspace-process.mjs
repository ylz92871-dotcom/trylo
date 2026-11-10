import { spawn } from 'node:child_process';
import readline from 'node:readline';

/** One native owner, one job, one command channel. EOF releases all children. */
export function createSoftwareProcess({ executable, entry, directory, spawnWorker = spawn, onFailure, onEvent }) {
  const child = spawnWorker(executable, ['-B', '-u', entry], { windowsHide: true,
    env: { ...process.env, TEMP: directory, TMP: directory, PYTHONIOENCODING: 'utf-8', PYTHONDONTWRITEBYTECODE: '1' },
    stdio: ['pipe', 'pipe', 'pipe'] });
  const pending = new Map();
  let next = 0, closed = false, diagnostic = '';
  const fail = error => {
    if (closed) return;
    closed = true;
    for (const entry of pending.values()) entry.reject(error);
    pending.clear();
    onFailure?.(error.message);
  };
  const lines = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });
  lines.on('line', line => {
    try {
      const message = JSON.parse(line);
      if (message.event) onEvent?.(message);
      if (message.event === 'fatal' || message.event === 'isolationFailure') { fail(new Error(message.error)); child.stdin.end(); return; }
      const waiting = pending.get(message.id);
      if (!waiting) return;
      pending.delete(message.id);
      message.error ? waiting.reject(new Error(message.error)) : waiting.resolve(message.result);
    } catch (error) { fail(new Error(`软件工作区协议错误：${error.message}`)); child.stdin.end(); }
  });
  child.stderr.on('data', data => { diagnostic = (diagnostic + String(data)).slice(-4000); });
  child.once('error', fail);
  child.once('exit', () => fail(new Error(`软件工作区已断开${diagnostic ? `：${diagnostic}` : ''}。未完成的写入结果需检查，系统没有自动重放。`)));
  return {
    request(operation, params = {}) {
      if (closed) return Promise.reject(new Error('软件工作区已断开，请重新启动'));
      const id = String(++next);
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
        child.stdin.write(JSON.stringify({ id, operation, params }) + '\n', error => { if (error) fail(error); });
      });
    },
    async stop() {
      if (!closed) child.stdin.end();
      // EOF normally closes the native job. A blocked native call must not
      // keep the job owner alive after an explicit stop or Host shutdown.
      const timer = setTimeout(() => child.kill(), 1000);
      timer.unref();
      if (child.pid && child.exitCode === null && child.signalCode === null) await new Promise(resolve => child.once('exit', resolve));
      clearTimeout(timer);
    },
  };
}
