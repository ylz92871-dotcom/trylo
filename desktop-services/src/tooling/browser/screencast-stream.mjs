// Leave enough room for JSON metadata inside the Service Host's 2 MiB frame.
export const MAX_SCREENCAST_DATA = Math.floor(1.8 * 1024 * 1024);
const JPEG_QUALITIES = [94, 90, 85, 80, 75];
export const SCREENCAST_DIMENSIONS = { maxWidth: 4096, maxHeight: 3000, everyNthFrame: 1 };

/** ACK is the producer's backpressure: Chromium waits for our completed host write. */
export function createScreencastStream({ send, emit, ack, onError, isCurrent = () => true }) {
  let active = true;
  let qualityIndex = -1;
  let failed = false;
  let tail = Promise.resolve();
  const current = () => active && isCurrent();
  const acknowledge = sessionId => {
    if (current() && (typeof sessionId === 'number' || typeof sessionId === 'string')) ack(sessionId);
  };
  const start = async () => {
    if (!current()) return;
    const format = qualityIndex < 0 ? 'png' : 'jpeg';
    await send('Page.startScreencast', {
      ...SCREENCAST_DIMENSIONS, format,
      ...(format === 'jpeg' ? { quality: JPEG_QUALITIES[qualityIndex] } : {}),
    });
  };
  const deliver = async ({ data, metadata, sessionId } = {}, receivedQuality = qualityIndex, receivedAt) => {
    if (!current() || failed) return;
    // stopScreencast already released the previous producer; its ACK must not
    // be mistaken for a frame in the newly started encoding session.
    if (receivedQuality !== qualityIndex) return;
    if (typeof data !== 'string' || !metadata) { acknowledge(sessionId); return; }
    if (data.length > MAX_SCREENCAST_DATA) {
      acknowledge(sessionId);
      if (qualityIndex >= JPEG_QUALITIES.length - 1) {
        failed = true;
        if (current()) onError('浏览器画面超过传输上限，已停止预览；请重新连接，或使用工具截图查看原图。');
        await send('Page.stopScreencast');
        return;
      }
      await send('Page.stopScreencast');
      qualityIndex++;
      if (current()) await start();
      return;
    }
    try {
      await emit('viewportFrame', {
        data,
        mimeType: data.startsWith('/9j/') ? 'image/jpeg' : data.startsWith('iVBOR') ? 'image/png'
          : qualityIndex < 0 ? 'image/png' : 'image/jpeg',
        deviceWidth: metadata.deviceWidth,
        deviceHeight: metadata.deviceHeight,
        pageScaleFactor: metadata.pageScaleFactor,
        receivedAt,
      });
    } finally { acknowledge(sessionId); }
  };
  return {
    start,
    receive(frame) {
      if (!current() || failed) return;
      const receivedQuality = qualityIndex;
      const receivedAt = Date.now();
      tail = tail.then(() => deliver(frame, receivedQuality, receivedAt)).catch(error => {
        if (current() && !failed) {
          failed = true;
          onError(`浏览器画面传输失败：${String(error?.message ?? error).slice(0, 140)}`);
        }
      });
      return tail;
    },
    dispose() { active = false; },
  };
}
