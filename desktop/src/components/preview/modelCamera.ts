import { Box3, MathUtils, PerspectiveCamera, Sphere, Vector3 } from 'three';

/** Fit the entire bounding sphere through the smaller of the horizontal
 * and vertical fields of view. A fixed distance clips narrow rails. */
export function fitModelCamera(camera: PerspectiveCamera, bounds: Box3): void {
  if (bounds.isEmpty()) return;
  const sphere = bounds.getBoundingSphere(new Sphere());
  const radius = Math.max(sphere.radius, .001);
  const vertical = MathUtils.degToRad(camera.fov);
  const horizontal = 2 * Math.atan(Math.tan(vertical / 2) * camera.aspect);
  const distance = radius / Math.sin(Math.min(vertical, horizontal) / 2) * 1.12;
  const direction = camera.position.clone().sub(sphere.center);
  if (direction.lengthSq() < 1e-8) direction.copy(new Vector3(1.1, .7, 1.4));
  camera.position.copy(sphere.center).addScaledVector(direction.normalize(), distance);
  camera.near = radius / 1000;
  camera.far = distance + radius * 100;
  camera.lookAt(sphere.center);
  camera.updateProjectionMatrix();
  camera.updateMatrixWorld();
}
