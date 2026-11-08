import { describe, it, expect } from 'vitest';
import { Box3, PerspectiveCamera, Vector3 } from 'three';
import { fitModelCamera } from './modelCamera';
describe('3D model framing', () => {
  for (const aspect of [.4, .8, 1.7, 3]) {
    it(`keeps every model corner visible at aspect ${aspect}`, () => {
      const bounds = new Box3(new Vector3(-6, -1, -2), new Vector3(6, 3, 2));
      const camera = new PerspectiveCamera(45, aspect, .01, 1000);
      camera.position.set(3, 2, 4);
      fitModelCamera(camera, bounds);
      for (const x of [-6, 6]) for (const y of [-1, 3]) for (const z of [-2, 2]) {
        const point = new Vector3(x, y, z).project(camera);
        expect(Math.abs(point.x)).toBeLessThan(1);
        expect(Math.abs(point.y)).toBeLessThan(1);
        expect(point.z).toBeGreaterThan(-1);
        expect(point.z).toBeLessThan(1);
      }
    });
  }
});
