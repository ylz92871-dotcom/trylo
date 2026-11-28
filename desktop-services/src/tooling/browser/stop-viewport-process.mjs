import { execFile } from 'node:child_process';
import { setTimeout as wait } from 'node:timers/promises';

const exited = child => child.exitCode !== null || (child.signalCode ?? null) !== null;

function taskkill(pid) {
  return new Promise((resolve, reject) => {
    execFile('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true }, error => {
      if (error) reject(error);
      else resolve();
    });
  });
}

function signalGroup(pid, signal) {
  try {
    process.kill(-pid, signal);
    return true;
  } catch (error) {
    if (error.code === 'ESRCH') return false;
    // Darwin can temporarily report EPERM while the last member exits.
    if (signal === 0 && error.code === 'EPERM') return true;
    throw error;
  }
}

async function stopDarwinGroup(pid) {
  for (const signal of ['SIGTERM', 'SIGKILL']) {
    if (!signalGroup(pid, signal)) return;
    for (let attempt = 0; attempt < 10; attempt += 1) {
      await wait(10);
      if (!signalGroup(pid, 0)) return;
    }
  }
  throw new Error('Chromium process group still exists after SIGKILL');
}

/** On Darwin the browser owns a group. Windows walks descendants from the root. */
export async function stopViewportProcess(child, { platform = process.platform, terminateTree = taskkill } = {}) {
  if (child.pid === undefined) return;
  if (platform === 'darwin') return stopDarwinGroup(child.pid);
  if (exited(child)) return;
  if (platform !== 'win32') {
    child.kill();
    return;
  }
  try {
    await terminateTree(child.pid);
  } catch (error) {
    // The original child may publish exit while the helper is reporting failure.
    if (!exited(child)) throw error;
  }
}
