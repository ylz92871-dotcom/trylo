import type { ReactElement } from 'react';
import { useModelPreview } from './useModelPreview';
import type { ModelPreviewProps } from './modelPreviewController';

export type {
  ModelPreviewProps, ModelPreviewController, ModelPreviewState, ModelPreviewCapture,
  ModelCameraPreset, ModelCameraPose, ModelCaptureOptions, ModelPreviewRevision, ModelVector, ModelSceneSummary,
} from './modelPreviewController';

export function ModelPreview(props: ModelPreviewProps): ReactElement {
  const { mountRef, state, controller } = useModelPreview(props);
  const ready = state.status === 'ready';
  return (
    <div className="preview__paged" role="region" aria-label="3D preview">
      <div className="preview__toolbar" role="toolbar" aria-label="模型视角">
        <button type="button" disabled={!ready} onClick={() => controller.setCamera('fit')}>完整取景</button>
        <button type="button" disabled={!ready} onClick={() => controller.setCamera('reset')}>重置视角</button>
        <button type="button" disabled={!ready} onClick={() => controller.setCamera('front')}>正视</button>
        <button type="button" disabled={!ready} onClick={() => controller.setCamera('top')}>俯视</button>
        <button type="button" disabled={!ready} aria-pressed={state.wireframe} onClick={() => controller.setWireframe(!state.wireframe)}>线框</button>
      </div>
      {state.status === 'loading' && <div className="preview__web-status" role="status">正在读取模型和材质…</div>}
      {state.status === 'error' && <div className="preview__empty" role="alert">无法显示模型：{state.message}</div>}
      <div ref={mountRef} className="preview__viewport" />
      <div className="preview__fold-note">拖动旋转 · 右键平移 · 滚轮缩放</div>
    </div>
  );
}
