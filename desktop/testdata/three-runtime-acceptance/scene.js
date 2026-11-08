import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { settings } from './settings.js';

// A deterministic multi-object scene exercises the runtime, not a copied artwork.
const scene = new THREE.Scene();
scene.background = new THREE.Color('#182027');
scene.fog = new THREE.Fog('#182027', 14, 30);
const camera = new THREE.OrthographicCamera(-6.4, 6.4, 4, -4, .1, 60);
camera.position.set(8, 7, 9);
const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
renderer.setPixelRatio(1);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
document.body.append(renderer.domElement);
const controls = new OrbitControls(camera, renderer.domElement);
controls.target.set(0, .8, 0);
controls.enableDamping = true;
scene.add(new THREE.HemisphereLight('#bdcfda', '#5f4735', 2));
const sun = new THREE.DirectionalLight('#ffe1b2', 3);
sun.position.set(4, 9, 5); sun.castShadow = true;
sun.shadow.mapSize.set(1024, 1024);
Object.assign(sun.shadow.camera, { left:-7, right:7, top:7, bottom:-7 });
scene.add(sun);
const lamp = new THREE.PointLight('#ffbd63', 3, 7, 1.6);
lamp.position.set(.7, 1.7, 1.2); scene.add(lamp);
const roof = new THREE.MeshStandardMaterial({ color: settings.roofColor, roughness: .8, flatShading: true });
const texture = await new THREE.TextureLoader().loadAsync('./timber.svg');
texture.colorSpace = THREE.SRGBColorSpace;
const timber = new THREE.MeshStandardMaterial({ map:texture, color:'#efc58a', roughness:.9 });
const stone = new THREE.MeshStandardMaterial({ color:'#b0aea0', roughness:.95 });
function box(size, position, material, parent = scene) {
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(...size), material);
  mesh.position.set(...position); mesh.castShadow = true; mesh.receiveShadow = true;
  parent.add(mesh); return mesh;
}
box([8,.45,5.8], [0,-.25,0], stone);
box([8,.3,.5], [0,.12,-2.6], stone);
const house = new THREE.Group(); house.position.set(0,0,-.8); scene.add(house);
box([3.2,1.7,1.8], [0,.85,0], timber, house);
for (const x of [-1.65, 1.65]) for (const z of [-.95,.95]) box([.14,2,.14], [x,1,z], timber, house);
for (const sign of [-1,1]) {
  const wing = box([3.9,.16,1.4], [0,2,.56*sign], roof, house);
  wing.rotation.x = sign * .28;
}
for (let i=0;i<15;i++) {
  const tile = box([.13,.13,2.4], [-1.75+i*.25,2.13,0], roof, house);
  tile.rotation.z = .02;
}
const tower = new THREE.Group(); tower.position.set(2.5,0,-1); scene.add(tower);
box([.9,1,1], [0,.5,0], timber, tower);
const cap = new THREE.Mesh(new THREE.ConeGeometry(.95,.65,4), roof);
cap.position.y = 1.3; cap.rotation.y = Math.PI/4; tower.add(cap);
const water = new THREE.Mesh(new THREE.PlaneGeometry(7.3,2.2,30,18), new THREE.MeshStandardMaterial({ color:'#367a7f', roughness:.24, metalness:.4, side:THREE.DoubleSide }));
water.rotation.x = -Math.PI/2; water.position.set(0,.015,1.2); water.receiveShadow = true; scene.add(water);
const boat = box([.65,.14,1.25], [-1.6,.22,1.2], new THREE.MeshStandardMaterial({ color:'#d18b45' }));
const rainPositions = new Float32Array(450);
for (let i=0;i<150;i++) { rainPositions[i*3]=(i*1.73%10)-5; rainPositions[i*3+1]=i*.31%6; rainPositions[i*3+2]=(i*2.27%8)-4; }
const rainGeometry = new THREE.BufferGeometry(); rainGeometry.setAttribute('position', new THREE.BufferAttribute(rainPositions,3));
const rain = new THREE.Points(rainGeometry, new THREE.PointsMaterial({ color:'#adced8', size:.028, transparent:true, opacity:.55 })); scene.add(rain);

const instance = crypto.randomUUID();
let current = settings, frame = 0, paused = false;
function apply(next) {
  if (next.fail) {
    const message = 'three-runtime-synthetic-error: lamp configuration rejected';
    console.error(message);
    throw new Error(message);
  }
  current = next; roof.color.set(next.roofColor); tower.scale.y = next.towerHeight;
  lamp.intensity = next.lightIntensity;
  document.getElementById('stage').textContent = `场景阶段 ${next.revision} · 材质、光照与动画已载入`;
}
const state = () => ({ instance, revision:current.revision, frames:frame, paused,
  camera:{ position:camera.position.toArray(), target:controls.target.toArray() },
  objects:scene.children.length, textureLoaded:!!texture.image, renderer:renderer.getContext().getParameter(renderer.getContext().RENDERER) });
Object.assign(window, { threeRuntimeAcceptance: { state, pause(value) { paused=value; },
  setCamera() { camera.position.set(9,8,6); controls.target.set(.25,.7,0); controls.update(); } } });
function resize() {
  const aspect = innerWidth / innerHeight;
  camera.left=-4.1*aspect; camera.right=4.1*aspect; camera.top=4.1; camera.bottom=-4.1;
  camera.updateProjectionMatrix(); renderer.setSize(innerWidth,innerHeight);
}
addEventListener('resize',resize); resize(); apply(settings);
renderer.setAnimationLoop(time => {
  frame++;
  if (!paused) {
    boat.position.y = .22 + Math.sin(time*.001)*.06;
    for(let i=0;i<150;i++) rainPositions[i*3+1]=(6+i*.31-time*.002)%6;
    rainGeometry.attributes.position.needsUpdate=true;
    const position=water.geometry.attributes.position;
    for(let i=0;i<position.count;i++) position.setZ(i,Math.sin(position.getX(i)*3+time*.002)*.018);
    position.needsUpdate=true; water.geometry.computeVertexNormals();
  }
  controls.update(); renderer.render(scene,camera);
});
if (import.meta.hot) import.meta.hot.accept('./settings.js', module => {
  if (module) apply(module.settings);
});
