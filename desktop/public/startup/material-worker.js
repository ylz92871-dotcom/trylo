/* Owns only the decorative startup surface; never an application runtime. */
importScripts('/startup/material.js');
let canvas, material;
self.onmessage = event => {
  const data = event.data;
  try {
    if (data.type === 'init') {
      canvas = data.canvas; canvas.width = data.width; canvas.height = data.height;
      canvas.addEventListener('webglcontextlost', event => {
        event.preventDefault(); material?.dispose(); material = null;
        self.postMessage({ type: 'failed' });
      });
      const start = performance.now();
      material = self.TryloStartupMaterial(canvas, data.image, data.contour);
      material.draw(-.1, 0);
      data.image.close(); data.contour.close();
      self.postMessage({ type: 'ready', initMs: performance.now() - start });
    } else if (data.type === 'draw' && material) {
      if (canvas.width !== data.width || canvas.height !== data.height) {
        canvas.width = data.width; canvas.height = data.height;
      }
      material.draw(data.scan, data.light);
    }
  } catch (_) {
    material?.dispose(); material = null;
    self.postMessage({ type: 'failed' });
  }
};
