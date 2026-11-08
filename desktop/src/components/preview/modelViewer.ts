// One WebGL/OrbitControls lifetime; model replacements do not own the camera.
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { fitModelCamera } from './modelCamera';
import { disposeModelObject } from './modelScene';
import { summarizeModelScene } from './modelSceneSummary';
import { paintModelViewportBackground } from './modelViewportBackground';
import type { ModelCameraPose, ModelCameraPreset, ModelCaptureOptions } from './modelPreviewController';

function vector(value: readonly number[]): THREE.Vector3 {
  if (value.length !== 3 || !value.every(Number.isFinite)) throw new Error('模型视角坐标必须是三个有限数值');
  return new THREE.Vector3(value[0], value[1], value[2]);
}

export function createModelViewer(mount: HTMLDivElement) {
  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(45, 1, .01, 100000);
  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  mount.appendChild(renderer.domElement);
  scene.add(new THREE.HemisphereLight(0xffffff, 0x334455, 1.1));
  const sun = new THREE.DirectionalLight(0xffffff, 2.2);
  sun.position.set(1, 2, 3);
  scene.add(sun);

  let model: THREE.Object3D | undefined;
  let wireframe = false;
  let disposed = false;
  let frame = 0;

  const render = (): void => { if (!disposed) { controls.update(); renderer.render(scene, camera); } };
  const resize = (): void => {
    const width = mount.clientWidth || 1;
    const height = mount.clientHeight || 1;
    renderer.setSize(width, height);
    camera.aspect = width / height;
    camera.updateProjectionMatrix();
    render();
  };
  const bounds = (): THREE.Box3 => new THREE.Box3().setFromObject(model!);
  const fit = (): void => {
    if (!model) return;
    const box = bounds();
    controls.target.copy(box.getCenter(new THREE.Vector3()));
    fitModelCamera(camera, box);
    render();
  };
  const setWireframe = (enabled: boolean): void => {
    wireframe = enabled;
    model?.traverse((object) => {
      const mesh = object as THREE.Mesh;
      if (!mesh.isMesh) return;
      for (const material of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) {
        if ('wireframe' in material) { material.wireframe = enabled; material.needsUpdate = true; }
      }
    });
    render();
  };
  const clear = (): void => {
    if (model) { scene.remove(model); disposeModelObject(model); model = undefined; }
    wireframe = false;
    camera.up.set(0, 1, 0);
    controls.target.set(0, 0, 0);
    render();
  };
  const setCamera = (view: ModelCameraPreset | ModelCameraPose): void => {
    if (!model) throw new Error('模型尚未就绪');
    if (typeof view === 'string') {
      if (view !== 'fit') {
        const direction = view === 'front' ? [0, 0, 1] : view === 'top' ? [0, 1, .0001] : view === 'right' ? [1, 0, 0] : [1.1, .7, 1.4];
        camera.up.set(0, 1, 0);
        camera.position.copy(controls.target).add(vector(direction));
      }
      fit();
      return;
    }
    const position = vector(view.position);
    const target = vector(view.target);
    const up = view.up ? vector(view.up) : camera.up.clone();
    if (position.distanceToSquared(target) === 0 || up.lengthSq() === 0) throw new Error('模型相机位置、目标与上方向无效');
    camera.position.copy(position);
    camera.up.copy(up).normalize();
    controls.target.copy(target);
    camera.lookAt(target);
    camera.updateMatrixWorld();
    render();
  };
  const pose = (): ModelCameraPose => ({
    position: camera.position.toArray(), target: controls.target.toArray(), up: camera.up.toArray(),
  });

  resize();
  const tick = (): void => {
    if (disposed) return;
    render();
    frame = requestAnimationFrame(tick);
  };
  tick();
  const observer = new ResizeObserver(resize);
  observer.observe(mount);

  return {
    setModel(object: THREE.Object3D) {
      const box = new THREE.Box3().setFromObject(object);
      if (box.isEmpty() || [...box.min.toArray(), ...box.max.toArray()].some((value) => !Number.isFinite(value))) {
        disposeModelObject(object);
        throw new Error('模型没有可显示的有效几何体');
      }
      const previous = model;
      model = object;
      scene.add(object);
      if (previous) { scene.remove(previous); disposeModelObject(previous); }
      else {
        const center = box.getCenter(new THREE.Vector3());
        const size = box.getSize(new THREE.Vector3());
        const span = Math.max(size.x, size.y, size.z, .001);
        camera.position.copy(center).addScaledVector(new THREE.Vector3(1.1, .7, 1.4), span);
        fit();
      }
      // Replacement may change bounds, but retaining the inspection pose takes priority over automatic framing.
      const radius = Math.max(box.getBoundingSphere(new THREE.Sphere()).radius, .001);
      camera.near = radius / 1000;
      camera.far = Math.max(camera.position.distanceTo(box.getCenter(new THREE.Vector3())) + radius * 100, camera.near * 2);
      camera.updateProjectionMatrix();
      setWireframe(wireframe);
      return summarizeModelScene(object);
    },
    clear, setCamera, setWireframe,
    capture(options: ModelCaptureOptions = {}) {
      if (disposed || !model) throw new Error('模型尚未就绪');
      for (const value of [options.width, options.height]) {
        if (value !== undefined && (!Number.isInteger(value) || value <= 0)) throw new Error('截图尺寸必须是正整数');
      }
      const source = renderer.domElement;
      const widthLimit = options.width ?? (options.height === undefined ? 1024 : source.width);
      const heightLimit = options.height ?? (options.width === undefined ? 1024 : source.height);
      const scale = Math.min(1, widthLimit / source.width, heightLimit / source.height);
      const canvas = document.createElement('canvas');
      canvas.width = Math.max(1, Math.floor(source.width * scale));
      canvas.height = Math.max(1, Math.floor(source.height * scale));
      try {
        const context = canvas.getContext('2d');
        if (!context) throw new Error('无法创建模型截图画布');
        // The default WebGL drawing buffer may be cleared after presentation. Copy the explicit frame synchronously.
        render();
        paintModelViewportBackground(context, mount, canvas.width, canvas.height);
        context.drawImage(source, 0, 0, canvas.width, canvas.height);
        const dataUrl = canvas.toDataURL('image/jpeg', .85);
        if (!dataUrl.startsWith('data:image/jpeg;')) throw new Error('模型截图编码失败');
        return { mimeType: 'image/jpeg' as const, dataUrl, width: canvas.width, height: canvas.height, camera: pose(), wireframe };
      } finally {
        canvas.width = 0;
        canvas.height = 0;
      }
    },
    dispose(): void {
      if (disposed) return;
      disposed = true;
      cancelAnimationFrame(frame);
      observer.disconnect();
      controls.dispose();
      clear();
      renderer.dispose();
      renderer.domElement.remove();
    },
  };
}

export type ModelViewer = ReturnType<typeof createModelViewer>;
