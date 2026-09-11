// Trylo Desktop — ModelPreview (base capability).
//
// three.js (MIT) orbit view for STL / OBJ / glTF / 3MF deliverables:
// drag to rotate, wheel to zoom, auto-framed on load. STL gets a
// neutral double-sided material (the format carries no material);
// OBJ/glTF/3MF keep their own. STEP stays out — it needs a full OCCT
// kernel (multi-MB WASM), so .step/.stp remain on the OS viewer.
//
// WebGL is unavailable in jsdom, so this is typechecked + manually
// verified; routing is covered in previewKind.test.ts.

import type { ReactElement } from 'react';
import { useEffect, useRef, useState } from 'react';
import * as THREE from 'three';
import { STLLoader } from 'three/addons/loaders/STLLoader.js';
import { OBJLoader } from 'three/addons/loaders/OBJLoader.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { ThreeMFLoader } from 'three/addons/loaders/3MFLoader.js';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { usePreviewBytes } from './usePreviewBytes';
import { previewExtOf } from './previewKind';

export interface ModelPreviewProps {
  readonly path: string;
}

/** Parse bytes into a scene object. Rejects on corrupt input. */
function parseModel(ext: string, bytes: Uint8Array): Promise<THREE.Object3D> {
  const buffer = bytes.slice().buffer;
  switch (ext) {
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
      return Promise.resolve(new OBJLoader().parse(text));
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

function disposeObject(root: THREE.Object3D): void {
  root.traverse((child) => {
    const mesh = child as THREE.Mesh;
    if (mesh.isMesh !== true) return;
    mesh.geometry.dispose();
    const material = mesh.material;
    if (Array.isArray(material)) {
      for (const m of material) m.dispose();
    } else {
      material.dispose();
    }
  });
}

export function ModelPreview(props: ModelPreviewProps): ReactElement {
  const bytesState = usePreviewBytes(props.path);
  const mountRef = useRef<HTMLDivElement | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    const mount = mountRef.current;
    if (bytesState.status !== 'ready' || !mount) return undefined;
    let cancelled = false;
    setError('');

    let renderer: THREE.WebGLRenderer | undefined;
    try {
      renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'WebGL is unavailable.');
      return undefined;
    }

    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(45, 1, 0.01, 100000);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    mount.appendChild(renderer.domElement);
    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    scene.add(new THREE.HemisphereLight(0xffffff, 0x334455, 1.1));
    const sun = new THREE.DirectionalLight(0xffffff, 2.2);
    sun.position.set(1, 2, 3);
    scene.add(sun);

    let model: THREE.Object3D | undefined;
    let frame = 0;

    const fit = (): void => {
      if (!mount || !renderer || !model) return;
      const width = mount.clientWidth || 1;
      const height = mount.clientHeight || 1;
      renderer.setSize(width, height);
      camera.aspect = width / height;
      camera.updateProjectionMatrix();
    };

    const tick = (): void => {
      if (cancelled || !renderer) return;
      controls.update();
      renderer.render(scene, camera);
      frame = requestAnimationFrame(tick);
    };

    parseModel(previewExtOf(props.path), bytesState.bytes).then(
      (obj) => {
        if (cancelled) {
          disposeObject(obj);
          return;
        }
        model = obj;
        scene.add(obj);
        // Frame the model: center it, back the camera off by its size.
        const box = new THREE.Box3().setFromObject(obj);
        const center = box.getCenter(new THREE.Vector3());
        const size = box.getSize(new THREE.Vector3());
        const span = Math.max(size.x, size.y, size.z, 0.001);
        controls?.target.copy(center);
        camera.position.set(
          center.x + span * 1.1,
          center.y + span * 0.7,
          center.z + span * 1.4,
        );
        camera.near = span / 1000;
        camera.far = span * 100;
        camera.updateProjectionMatrix();
        fit();
        tick();
      },
      (err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      },
    );

    const resize = new ResizeObserver(fit);
    resize.observe(mount);

    return () => {
      cancelled = true;
      cancelAnimationFrame(frame);
      resize.disconnect();
      controls.dispose();
      if (model) {
        scene.remove(model);
        disposeObject(model);
      }
      renderer?.dispose();
      renderer?.domElement.remove();
    };
  }, [bytesState, props.path]);

  if (bytesState.status === 'loading') {
    return <div className="preview__empty">Loading 3D model…</div>;
  }
  if (bytesState.status === 'error') {
    return <div className="preview__empty">Could not load model: {bytesState.message}</div>;
  }
  if (error !== '') {
    return <div className="preview__empty">Could not render model: {error}</div>;
  }
  return (
    <div className="preview__paged" role="region" aria-label="3D preview">
      <div ref={mountRef} className="preview__viewport" />
      <div className="preview__fold-note">Drag to orbit · wheel to zoom</div>
    </div>
  );
}
