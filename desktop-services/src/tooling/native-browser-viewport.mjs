// One owner for logical page dimensions; native bounds remain Desktop-owned.
const MAX_EDGE = 16384, MAX_AREA = 33_554_432;
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
export function viewportRequest(value) {
  if (value?.mode === 'panel') return { mode: 'panel' };
  const { width, height } = value ?? {};
  if (value?.mode !== 'fixed' || !Number.isInteger(width) || !Number.isInteger(height)
      || width < 1 || height < 1 || width > MAX_EDGE || height > MAX_EDGE || width * height > MAX_AREA) throw new Error('页面尺寸必须为有效整数，且不能超过浏览器尺寸上限');
  const mobile = value.mobile ?? false, deviceScaleFactor = value.deviceScaleFactor ?? 1;
  if (typeof mobile !== 'boolean' || !Number.isFinite(deviceScaleFactor) || deviceScaleFactor < 0 || deviceScaleFactor > 4) throw new Error('页面缩放参数无效');
  return { mode: 'fixed', width, height, mobile, deviceScaleFactor };
}
export function viewportBounds(value) {
  if (!value || ![value.x, value.y, value.width, value.height].every(Number.isFinite)
      || value.x < 0 || value.y < 0 || value.width < 1 || value.height < 1 || value.width > MAX_EDGE || value.height > MAX_EDGE) throw new Error('浏览器区域尺寸无效');
  return { x: value.x, y: value.y, width: value.width, height: value.height };
}

export function createNativeViewport({ record, target, native, cdp }) {
  const settings = new Map();
  const nativePanels = new Map();
  let panel, fault = '';
  const bounds = () => panel ?? record().bounds;
  function snapshot(label = record().activeLabel) {
    const config = settings.get(label) ?? { mode: 'panel' }, area = bounds();
    if (config.mode === 'fixed') return { mode: 'fixed', width: config.width, height: config.height,
      mobile: config.mobile, deviceScaleFactor: config.deviceScaleFactor, scale: area ? Math.min(1, area.width / config.width, area.height / config.height) : 1 };
    const zoom = record().zoom ?? 1;
    return { mode: 'panel', scale: 1, ...(area ? { width: Math.max(1, Math.round(area.width / zoom)), height: Math.max(1, Math.round(area.height / zoom)) } : {}) };
  }
  async function measured(socket) {
    const value = (await cdp(socket, 'Runtime.evaluate', { expression: '({width:innerWidth,height:innerHeight})', returnByValue: true }))?.result?.value;
    if (!Number.isFinite(value?.width) || !Number.isFinite(value?.height)) throw new Error('无法确认页面的实际尺寸');
    return value;
  }
  async function apply(label, config) {
    const page = target(label);
    if (!page) throw new Error('页面不属于当前原生浏览器会话');
    if (!bounds()) {
      const size = await measured(page.socket), zoom = record().zoom ?? 1;
      panel = { x: 0, y: 0, width: size.width * zoom, height: size.height * zoom };
    }
    const desiredZoom = config.mode === 'fixed' ? 1 : config.restoreZoom ?? record().zoom ?? 1;
    if ((record().zoom ?? 1) !== desiredZoom) await native('zoom', { zoom: desiredZoom });
    if (config.mode === 'panel') {
      // Native bounds already resize the real viewport. Reinstalling explicit
      // CDP dimensions here freezes it until a later serialized host update.
      if (nativePanels.get(label) !== page.socket) {
        await cdp(page.socket, 'Emulation.clearDeviceMetricsOverride');
        nativePanels.set(label, page.socket);
      }
      fault = '';
      return;
    }
    nativePanels.delete(label);
    const area = bounds(), { width, height } = config;
    const scale = Math.min(1, area.width / width, area.height / height);
    await cdp(page.socket, 'Emulation.setDeviceMetricsOverride', { width, height, scale,
      deviceScaleFactor: config.deviceScaleFactor,
      mobile: config.mobile, screenWidth: width, screenHeight: height, dontSetVisibleSize: true });
    let actual;
    for (let attempt = 0; attempt < 20; attempt++) {
      actual = await measured(page.socket);
      if (actual.width === width && actual.height === height) { fault = ''; return; }
      await wait(25);
    }
    throw new Error(`页面尚未应用请求的尺寸：期望 ${width}×${height}，实际 ${actual?.width}×${actual?.height}`);
  }
  async function set(label, input) {
    const config = viewportRequest(input), previous = settings.get(label) ?? { mode: 'panel', restoreZoom: record().zoom ?? 1 };
    const restoreZoom = previous.mode === 'fixed' ? previous.restoreZoom : record().zoom ?? 1;
    try {
      if (config.mode === 'panel' && previous.mode === 'fixed') await native('zoom', { zoom: restoreZoom });
      await apply(label, { ...config, restoreZoom });
    } catch (error) {
      try { await apply(label, previous); }
      catch (rollback) { fault = '页面尺寸更新与恢复均失败，请重新连接浏览器'; throw new AggregateError([error, rollback], fault); }
      throw error;
    }
    settings.set(label, config.mode === 'fixed' ? { ...config, restoreZoom } : config);
    return snapshot(label);
  }
  return {
    snapshot, set, error: () => fault,
    invalidate() { nativePanels.clear(); fault = '页面尺寸控制连接已断开，请重新连接浏览器'; },
    async capture(label, params) {
      const page = target(label);
      if (!page) throw new Error('页面不属于当前原生浏览器会话');
      if (fault) await apply(label, settings.get(label) ?? { mode: 'panel' });
      return cdp(page.socket, 'Page.captureScreenshot', params);
    },
    async layout(value, visible, nativeApplied = false) {
      const next = value === undefined ? bounds() : viewportBounds(value);
      if (!nativeApplied) await native('layout', { ...(next ? { bounds: next } : {}), visible });
      if (next) panel = next;
      if (visible) {
        try { await apply(record().activeLabel, settings.get(record().activeLabel) ?? { mode: 'panel' }); }
        catch (error) { fault = String(error.message ?? error); throw error; }
      }
    },
    async sync(label) { if (bounds() || settings.has(label)) await apply(label, settings.get(label) ?? { mode: 'panel' }); },
    retain(labels) {
      for (const map of [settings, nativePanels])
        for (const label of map.keys()) if (!labels.includes(label)) map.delete(label);
    },
  };
}
