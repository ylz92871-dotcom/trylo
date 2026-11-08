import { DoubleSide, LoadingManager, type Group, type Material } from 'three';
import { MTLLoader, type MaterialInfo } from 'three/addons/loaders/MTLLoader.js';
import { OBJLoader } from 'three/addons/loaders/OBJLoader.js';
import { ModelResources, modelDataUrl } from './model-resources';

const TEXTURES = ['map_kd', 'map_ks', 'map_ke', 'norm', 'map_bump', 'bump', 'disp', 'map_d'] as const;
function disposeMaterials(materials: Record<string, Material>): void {
  for (const material of Object.values(materials)) {
    for (const value of Object.values(material)) if (value?.isTexture) value.dispose();
    material.dispose();
  }
}
/** Resolve MTL and maps before Three can request anything from the app origin. */
export async function readObj(text: string, path: string, root?: string, signal?: AbortSignal): Promise<Group> {
  const libraries = [...text.matchAll(/^\s*mtllib\s+(.+?)\s*$/gmi)].map((match) => match[1]!.trim());
  if (!libraries.length) return new OBJLoader().parse(text);
  const reader = new ModelResources(root, signal);
  const info: Record<string, MaterialInfo> = {};
  const manager = new LoadingManager();
  manager.setURLModifier((url) => { if (!url.startsWith('data:')) throw new Error('模型贴图未通过项目资源校验'); return url; });
  const loader = new MTLLoader(manager); loader.setMaterialOptions({ side: DoubleSide });
  for (const library of libraries) {
    const source = await reader.read(path, library);
    const creator = loader.parse(new TextDecoder().decode(source.bytes), '');
    for (const material of Object.values(creator.materialsInfo)) for (const key of TEXTURES) {
      const value = material[key]; if (!value) continue;
      const uri = creator.getTextureParams(value, {}).url;
      if (uri.startsWith('data:')) continue;
      const resource = await reader.read(source.path, uri);
      material[key] = value.slice(0, value.lastIndexOf(uri)) + modelDataUrl(resource.bytes, resource.path);
    }
    Object.assign(info, creator.materialsInfo);
  }
  const creator = loader.parse('', ''); creator.setMaterials(info);
  let started = false, failed = false;
  let finish!: () => void;
  const loaded = new Promise<void>((resolve) => { finish = resolve; });
  manager.onStart = () => { started = true; }; manager.onLoad = finish; manager.onError = () => { failed = true; };
  try {
    creator.preload();
    if (started) await new Promise<void>((resolve, reject) => {
      const abort = (): void => { clearTimeout(timer); reject(new DOMException('已取消', 'AbortError')); };
      const timer = setTimeout(() => { signal?.removeEventListener('abort', abort); reject(new Error('模型贴图加载超时')); }, 15_000);
      signal?.addEventListener('abort', abort, { once: true });
      void loaded.then(() => { clearTimeout(timer); signal?.removeEventListener('abort', abort); resolve(); });
      if (signal?.aborted) abort();
    });
    signal?.throwIfAborted();
    if (failed) throw new Error('模型贴图无法解码');
    return new OBJLoader().setMaterials(creator).parse(text);
  } catch (error) { disposeMaterials(creator.materials); throw error; }
}
