import { runPreviewWorker } from '../workers/run-worker';
export interface CadMesh {
  readonly name?: string;
  readonly color?: readonly number[];
  readonly position: Float32Array;
  readonly normal?: Float32Array;
  readonly index: Uint32Array;
  readonly faces?: readonly { first: number; last: number; color?: readonly number[] }[];
}
export async function readCadMeshes(bytes: Uint8Array, format: 'step' | 'iges' | 'brep', signal?: AbortSignal): Promise<readonly CadMesh[]> {
  if (bytes.byteLength > 50 * 1024 * 1024) throw new Error('STEP / IGES / BREP 预览支持 50 MB 以内的文件。');
  const buffer = bytes.slice().buffer;
  const result = await runPreviewWorker<{ meshes: CadMesh[] }>('cad', { buffer, format }, [buffer], signal, 60_000);
  return result.meshes;
}
