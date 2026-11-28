/** Headless tabs still expose document focus after an MCP tab selection. */
async function focused(target) {
  return new Promise(resolve => {
    const socket = new WebSocket(target.webSocketDebuggerUrl);
    const finish = value => { clearTimeout(timer); socket.close(); resolve(value); };
    const timer = setTimeout(() => finish(false), 450);
    socket.addEventListener('open', () => socket.send(JSON.stringify({
      id: 1, method: 'Runtime.evaluate', params: { expression: 'document.hasFocus()' },
    })), { once: true });
    socket.addEventListener('message', event => {
      try {
        const result = JSON.parse(String(event.data));
        if (result.id === 1) finish(result.result?.result?.value === true);
      } catch { finish(false); }
    });
    socket.addEventListener('error', () => finish(false), { once: true });
  });
}
export async function activePageTarget(targets) {
  const pages = targets.filter(t => t.type === 'page' && t.webSocketDebuggerUrl && !String(t.url).startsWith('devtools://'));
  if (pages.length < 2) return pages[0] ?? null;
  const focus = await Promise.all(pages.map(focused));
  return pages.find((_, index) => focus[index]) ?? pages[0];
}
