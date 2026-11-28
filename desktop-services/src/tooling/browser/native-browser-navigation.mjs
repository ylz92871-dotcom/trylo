// CDP owns navigation failure facts; a site title or message cannot assert one.
export async function navigationFailure(socket, cdp) {
  const frame = (await cdp(socket, 'Page.getFrameTree'))?.frameTree?.frame;
  if (typeof frame?.unreachableUrl !== 'string' || !frame.unreachableUrl) return undefined;
  const value = (await cdp(socket, 'Runtime.evaluate', {
    expression: "document.documentURI.startsWith('chrome-error:') ? (document.getElementById('error-code')?.textContent || document.body?.innerText?.match(/ERR_[A-Z_]+/)?.[0] || '') : ''",
    returnByValue: true,
  }))?.result?.value;
  const code = typeof value === 'string' ? value.trim().match(/^ERR_[A-Z_]+$/)?.[0] : undefined;
  return { url: frame.unreachableUrl, ...(code ? { code } : {}) };
}
