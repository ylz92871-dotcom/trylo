import { execFile } from 'node:child_process';

const exited = child => child.exitCode !== null || (child.signalCode ?? null) !== null;

function taskkill(pid) {
  return new Promise((resolve, reject) => {
    execFile('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true }, error => {
      if (error) reject(error);
      else resolve();
    });
  });
}

/** Keep the owned browser root alive until Windows has walked its descendants. */
export async function stopViewportProcess(child, { platform = process.platform, terminateTree = taskkill } = {}) {
  if (child.pid === undefined || exited(child)) return;
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
