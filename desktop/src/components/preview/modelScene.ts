// Shared parser and resource disposal for the production 3D viewer.
import * as THREE from 'three';
import { STLLoader } from 'three/addons/loaders/STLLoader.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { ThreeMFLoader } from 'three/addons/loaders/3MFLoader.js';
import { prepareGltf } from './gltfResources';
import { readCadMeshes } from '../../preview/providers/cad';
import { readObj } from '../../preview/providers/obj';
/** Parse bytes into a scene object. Rejects on corrupt input. */
export async function parseModel(ext: string, bytes: Uint8Array, path: string, root?: string, signal?: AbortSignal): Promise<THREE.Object3D> {
  const source = ext === '.gltf' || ext === '.glb' ? await prepareGltf(bytes, path, root, signal) : bytes;
  const buffer = source.slice().buffer;
  switch (ext) {
    case '.step': case '.stp': case '.iges': case '.igs': case '.brep': case '.brp': {
      const meshes = await readCadMeshes(bytes, ext === '.iges' || ext === '.igs' ? 'iges' : ext === '.brep' || ext === '.brp' ? 'brep' : 'step', signal);
      const group = new THREE.Group();
      for (const source of meshes) {
        const geometry = new THREE.BufferGeometry();
        geometry.setAttribute('position', new THREE.BufferAttribute(source.position, 3));
        geometry.setIndex(new THREE.BufferAttribute(source.index, 1));
        if (source.normal) geometry.setAttribute('normal', new THREE.BufferAttribute(source.normal, 3)); else geometry.computeVertexNormals();
        const materials: THREE.MeshStandardMaterial[] = [];
        const materialFor = (color: readonly number[] | undefined): number => {
          const rgb = color?.length === 3 && color.every(Number.isFinite) ? color : [.62, .7, .77];
          const value = new THREE.Color(rgb[0] ?? .62, rgb[1] ?? .7, rgb[2] ?? .77);
          const existing = materials.findIndex((material) => material.color.equals(value));
          if (existing >= 0) return existing;
          materials.push(new THREE.MeshStandardMaterial({ color: value, metalness: .1, roughness: .65, side: THREE.DoubleSide }));
          return materials.length - 1;
        };
        if (source.faces?.length) for (const face of source.faces) geometry.addGroup(face.first * 3, (face.last - face.first + 1) * 3, materialFor(face.color ?? source.color));
        else geometry.addGroup(0, source.index.length, materialFor(source.color));
        const mesh = new THREE.Mesh(geometry, materials); mesh.name = source.name ?? ''; group.add(mesh);
      }
      return group;
    }
    case '.stl': {
      const geometry = new STLLoader().parse(buffer);
      const material = new THREE.MeshStandardMaterial({
        color: 0x9db4c8,
        metalness: 0.15,
        roughness: 0.55,
        side: THREE.DoubleSide,
      });
      return Promise.resolve(new THREE.Mesh(geometry, material));
    }
    case '.obj': {
      const text = new TextDecoder().decode(bytes);
      return readObj(text, path, root, signal);
    }
    case '.glb':
    case '.gltf': {
      return new Promise((resolve, reject) => {
        new GLTFLoader().parse(
          buffer,
          '',
          (gltf) => resolve(gltf.scene),
          (err) => reject(err instanceof Error ? err : new Error(String(err))),
        );
      });
    }
    case '.3mf': {
      return Promise.resolve(new ThreeMFLoader().parse(buffer));
    }
    default:
      return Promise.reject(new Error(`unsupported 3D format: ${ext}`));
  }
}

export function disposeModelObject(root: THREE.Object3D): void {
  const textures = new Set<THREE.Texture>();
  const materials = new Set<THREE.Material>();
  root.traverse((child) => {
    const mesh = child as THREE.Mesh;
    if (mesh.isMesh !== true) return;
    mesh.geometry.dispose();
    for (const material of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) materials.add(material);
  });
  for (const material of materials) {
    for (const value of Object.values(material)) if (value instanceof THREE.Texture) textures.add(value);
    material.dispose();
  }
  for (const texture of textures) { if (typeof ImageBitmap !== 'undefined' && texture.image instanceof ImageBitmap) texture.image.close(); texture.dispose(); }
}


