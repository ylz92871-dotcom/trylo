import * as THREE from 'three';
import type { ModelSceneSummary } from './modelPreviewController';

/** Imported geometry facts, not GPU draw calls: shared geometry is counted at each mesh occurrence. */
export function summarizeModelScene(root: THREE.Object3D): ModelSceneSummary {
  let meshes = 0;
  let vertices = 0;
  let triangles = 0;
  root.traverse((object) => {
    const mesh = object as THREE.Mesh;
    if (!mesh.isMesh) return;
    meshes += 1;
    const instances = mesh instanceof THREE.InstancedMesh ? mesh.count : 1;
    const positions = mesh.geometry.getAttribute('position')?.count ?? 0;
    vertices += positions * instances;
    triangles += Math.floor((mesh.geometry.index?.count ?? positions) / 3) * instances;
  });
  const bounds = new THREE.Box3().setFromObject(root);
  return { meshes, vertices, triangles, bounds: { min: bounds.min.toArray(), max: bounds.max.toArray() } };
}
