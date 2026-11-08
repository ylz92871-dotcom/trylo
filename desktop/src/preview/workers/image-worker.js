/* Isolated TIFF/HEIC decoder; providers are unmodified local assets. */
const MAX_PIXELS = 64 * 1024 * 1024;
const dimensions = (width, height) => {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1 || width * height > MAX_PIXELS) throw new Error('图像尺寸超过预览限制（最多 6,700 万像素）。');
};
self.onmessage = async ({ data: { buffer, format, page = 0, codecs } }) => {
  try {
    let width, height, rgba, pageCount, orientation = 1;
    if (format === 'tiff') {
      importScripts(codecs.tiffPako, codecs.tiffUtif);
      const pages = self.UTIF.decode(buffer).filter((image) => image.t256?.[0] && image.t257?.[0]);
      pageCount = pages.length;
      const image = pages[page];
      if (!image) throw new Error('找不到此 TIFF 页面。');
      width = image.t256[0]; height = image.t257[0]; dimensions(width, height);
      orientation = image.t274?.[0] ?? 1;
      self.UTIF.decodeImage(buffer, image);
      rgba = self.UTIF.toRGBA8(image);
    } else {
      importScripts(codecs.heif);
      const lib = self.libheif;
      const decoder = new lib.HeifDecoder();
      const pages = decoder.decode(new Uint8Array(buffer));
      pageCount = pages.length;
      const image = pages[page];
      if (!image) throw new Error('找不到可解码的 HEIC/HEIF 图像。');
      width = image.get_width(); height = image.get_height(); dimensions(width, height);
      const rendered = await new Promise((resolve, reject) => image.display({ data: new Uint8ClampedArray(width * height * 4), width, height }, (result) => result ? resolve(result) : reject(new Error('HEIC/HEIF 图像解码失败。'))));
      rgba = rendered.data;
    }
    const source = new OffscreenCanvas(width, height);
    source.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(rgba), width, height), 0, 0);
    const swapped = orientation >= 5 && orientation <= 8;
    const output = new OffscreenCanvas(swapped ? height : width, swapped ? width : height);
    const transforms = { 1: [1, 0, 0, 1, 0, 0], 2: [-1, 0, 0, 1, width, 0], 3: [-1, 0, 0, -1, width, height], 4: [1, 0, 0, -1, 0, height], 5: [0, 1, 1, 0, 0, 0], 6: [0, 1, -1, 0, height, 0], 7: [0, -1, -1, 0, height, width], 8: [0, -1, 1, 0, 0, width] };
    const context = output.getContext('2d');
    context.setTransform(...(transforms[orientation] ?? transforms[1])); context.drawImage(source, 0, 0);
    const blob = await output.convertToBlob({ type: 'image/png' });
    self.postMessage({ ok: true, result: { blob, pageCount, width: output.width, height: output.height } });
  } catch (error) { self.postMessage({ ok: false, error: error instanceof Error ? error.message : String(error) }); }
};
