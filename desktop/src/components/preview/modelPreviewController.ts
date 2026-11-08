/** Renderer-only controls. File reads keep their existing host/allowedRoot authority. */
export type ModelPreviewRevision = string | number;
export type ModelCameraPreset = 'fit' | 'reset' | 'isometric' | 'front' | 'top' | 'right';
export type ModelVector = readonly [number, number, number];

export interface ModelCameraPose {
  readonly position: ModelVector;
  readonly target: ModelVector;
  readonly up?: ModelVector;
}

export interface ModelSceneSummary {
  /** Mesh nodes, including one node per InstancedMesh container. */
  readonly meshes: number;
  /** Full geometry elements per mesh occurrence, multiplied by its instance count; independent of drawRange/material visibility. */
  readonly vertices: number;
  readonly triangles: number;
  /** World-space coordinates in the file's units, without assuming a physical unit. */
  readonly bounds: { readonly min: ModelVector; readonly max: ModelVector };
}

export interface ModelPreviewState {
  readonly status: 'loading' | 'ready' | 'error';
  readonly path: string;
  readonly revision: ModelPreviewRevision | null;
  /** SHA-256 of the exact main-file bytes parsed when a host identity is pinned. */
  readonly fileSignature?: string;
  /** Local load generation; readyVersion identifies the model currently eligible for capture. */
  readonly version: number;
  readonly readyVersion: number | null;
  readonly wireframe: boolean;
  readonly scene?: ModelSceneSummary;
  readonly message?: string;
}

export interface ModelCaptureOptions {
  /** Output bounding box, preserving aspect ratio. Defaults to maxEdge 1024. */
  readonly width?: number;
  readonly height?: number;
}

export interface ModelPreviewCapture {
  readonly mimeType: 'image/jpeg';
  readonly dataUrl: string;
  readonly width: number;
  readonly height: number;
  readonly path: string;
  readonly revision: ModelPreviewRevision | null;
  readonly fileSignature?: string;
  readonly version: number;
  readonly camera: ModelCameraPose;
  readonly wireframe: boolean;
}

export interface ModelPreviewController {
  getState(): ModelPreviewState;
  reload(): Promise<ModelPreviewState>;
  waitUntilReady(): Promise<ModelPreviewState>;
  setCamera(view: ModelCameraPreset | ModelCameraPose): void;
  setWireframe(enabled: boolean): void;
  capture(options?: ModelCaptureOptions): Promise<ModelPreviewCapture>;
}

export interface ModelPreviewProps {
  readonly path: string;
  readonly allowedRoot?: string;
  /** Opaque host fingerprint; a change also reloads scoped companion resources. */
  readonly revision?: ModelPreviewRevision;
  /** Expected main-file SHA-256; ordinary file previews may omit identity pinning. */
  readonly expectedFileSignature?: string;
  readonly onController?: (controller: ModelPreviewController | null) => void;
  readonly onStateChange?: (state: ModelPreviewState) => void;
}
