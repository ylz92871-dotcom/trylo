// Trylo Desktop — BrowserPreviewPanel (the IDE-style embedded browser).
//
// Renderer side of the viewport bridge. Architecture forked from
// auchenberg/vscode-browser-preview (MIT): `src/components/screencast`
// (canvas frame rendering) + `src/components/viewport` (pointer/keyboard
// capture), merged into one panel and restyled with Trylo's tokens.
// Coordinate mapping follows devtools-frontend's screencast InputModel:
// the panel reports NORMALIZED [0..1] coordinates and the sidecar scales
// them with the frame metadata (pageScaleFactor / deviceWidth).
//
// The pointer/keys forwarded here are the USER's own hand on the panel's
// browser — the human is the authority. Agent-side input keeps flowing
// through the MCP approval pipeline; this panel is never a bypass.

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type ReactElement,
  type WheelEvent as ReactWheelEvent,
} from 'react';
import { Globe, Loader2, Play, RotateCw, Square, X } from 'lucide-react';
import type { BrowserPreviewController, ViewportFrame } from '../../tooling/use-browser-preview';

/** Decode a base64 JPEG frame into a bitmap. */
async function decodeFrame(frame: ViewportFrame): Promise<ImageBitmap | null> {
  try {
    const binary = atob(frame.data);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return await createImageBitmap(new Blob([bytes], { type: 'image/jpeg' }));
  } catch {
    return null;
  }
}

export function BrowserPreviewPanel(props: {
  readonly preview: BrowserPreviewController;
  readonly onClose: () => void;
}): ReactElement {
  const { preview } = props;
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const drawRectRef = useRef<{ x: number; y: number; width: number; height: number } | null>(null);
  const pressedRef = useRef(false);
  const [urlDraft, setUrlDraft] = useState('');

  // Draw the latest frame whenever it changes (damage-driven stream).
  useEffect(() => {
    const canvas = canvasRef.current;
    const frame = preview.latestFrame;
    if (!canvas || !frame) return;
    let cancelled = false;
    void decodeFrame(frame).then((bitmap) => {
      if (cancelled || !bitmap) return;
      const context = canvas.getContext('2d');
      if (!context) return;
      const dpr = window.devicePixelRatio || 1;
      const cssWidth = canvas.clientWidth;
      const cssHeight = cssWidth * (frame.deviceHeight / Math.max(1, frame.deviceWidth));
      canvas.width = Math.round(cssWidth * dpr);
      canvas.height = Math.round(cssHeight * dpr);
      canvas.style.height = `${cssHeight}px`;
      context.setTransform(dpr, 0, 0, dpr, 0, 0);
      context.drawImage(bitmap, 0, 0, cssWidth, cssHeight);
      bitmap.close();
      drawRectRef.current = { x: 0, y: 0, width: cssWidth, height: cssHeight };
    });
    return () => { cancelled = true; };
  }, [preview.frameSeq, preview.latestFrame, preview.status]);

  const normalized = useCallback((event: ReactMouseEvent<HTMLCanvasElement> | ReactWheelEvent<HTMLCanvasElement>) => {
    const rect = drawRectRef.current;
    if (!rect || rect.width === 0) return null;
    const bounds = event.currentTarget.getBoundingClientRect();
    const nx = Math.min(1, Math.max(0, (event.clientX - bounds.left - rect.x) / rect.width));
    const ny = Math.min(1, Math.max(0, (event.clientY - bounds.top - rect.y) / rect.height));
    return { nx, ny };
  }, []);

  const onMouseDown = useCallback((event: ReactMouseEvent<HTMLCanvasElement>) => {
    const point = normalized(event);
    if (!point) return;
    pressedRef.current = true;
    void preview.input({ kind: 'mouse', action: 'pressed', x: point.nx, y: point.ny });
  }, [normalized, preview]);

  const onMouseUp = useCallback((event: ReactMouseEvent<HTMLCanvasElement>) => {
    const point = normalized(event);
    if (!point || !pressedRef.current) return;
    pressedRef.current = false;
    void preview.input({ kind: 'mouse', action: 'released', x: point.nx, y: point.ny });
  }, [normalized, preview]);

  const onMouseMove = useCallback((event: ReactMouseEvent<HTMLCanvasElement>) => {
    if (!pressedRef.current) return;
    const point = normalized(event);
    if (!point) return;
    void preview.input({ kind: 'mouse', action: 'moved', x: point.nx, y: point.ny });
  }, [normalized, preview]);

  const onWheel = useCallback((event: ReactWheelEvent<HTMLCanvasElement>) => {
    const point = normalized(event);
    if (!point) return;
    void preview.input({ kind: 'wheel', x: point.nx, y: point.ny, deltaY: event.deltaY });
  }, [normalized, preview]);

  const onKeyDown = useCallback((event: ReactKeyboardEvent<HTMLCanvasElement>) => {
    if (event.key.length === 1) {
      event.preventDefault();
      void preview.input({ kind: 'key', text: event.key });
    }
  }, [preview]);

  const submitUrl = useCallback(() => {
    const value = urlDraft.trim();
    if (value === '') return;
    void preview.navigate(value);
  }, [preview, urlDraft]);

  const running = preview.status === 'running';

  return (
    <aside className="browser-preview" role="complementary" aria-label="浏览器预览">
      <div className="browser-preview__bar">
        <span
          className={`browser-preview__dot browser-preview__dot--${preview.status}`}
          role="status"
          title={preview.detail || preview.status}
        />
        <Globe size={13} strokeWidth={2} aria-hidden="true" />
        <input
          className="browser-preview__url"
          value={urlDraft || (running ? preview.url : '')}
          onChange={(e) => setUrlDraft(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') submitUrl(); }}
          placeholder={running ? '输入网址后回车' : '浏览器未启动'}
          spellCheck={false}
          autoComplete="off"
          disabled={!running}
          aria-label="地址"
        />
        <button
          type="button"
          className="browser-preview__btn"
          onClick={submitUrl}
          disabled={!running}
          title="重新加载"
          aria-label="重新加载"
        >
          <RotateCw size={13} strokeWidth={2} aria-hidden="true" />
        </button>
        {running ? (
          <button
            type="button"
            className="browser-preview__btn browser-preview__btn--danger"
            onClick={() => void preview.stop()}
            title="关闭浏览器"
            aria-label="关闭浏览器"
          >
            <Square size={12} strokeWidth={2.2} aria-hidden="true" />
          </button>
        ) : null}
        <button
          type="button"
          className="browser-preview__btn"
          onClick={props.onClose}
          title="收起面板"
          aria-label="收起面板"
        >
          <X size={14} strokeWidth={2} aria-hidden="true" />
        </button>
      </div>

      <div className="browser-preview__body">
        {preview.status === 'running' ? (
          <canvas
            ref={canvasRef}
            className="browser-preview__canvas"
            tabIndex={0}
            onMouseDown={onMouseDown}
            onMouseUp={onMouseUp}
            onMouseMove={onMouseMove}
            onWheel={onWheel}
            onKeyDown={onKeyDown}
            aria-label="浏览器画面"
          />
        ) : (
          <div className="browser-preview__placeholder">
            {preview.status === 'starting' ? (
              <>
                <Loader2 size={22} strokeWidth={2} className="browser-preview__spin" aria-hidden="true" />
                <p>正在启动本机浏览器…</p>
              </>
            ) : preview.status === 'error' ? (
              <>
                <p className="browser-preview__error">{preview.detail || '启动失败'}</p>
                <button type="button" className="browser-preview__launch" onClick={() => void preview.start()}>
                  <RotateCw size={13} strokeWidth={2} aria-hidden="true" />
                  重试
                </button>
              </>
            ) : (
              <>
                <p>在 Trylo 内直接使用浏览器，画面全程留在本机。</p>
                <button type="button" className="browser-preview__launch" onClick={() => void preview.start()}>
                  <Play size={13} strokeWidth={2} aria-hidden="true" />
                  启动浏览器
                </button>
                <span className="browser-preview__hint">首次启动需要本机已安装 Playwright 浏览器本体</span>
              </>
            )}
          </div>
        )}
      </div>
    </aside>
  );
}
