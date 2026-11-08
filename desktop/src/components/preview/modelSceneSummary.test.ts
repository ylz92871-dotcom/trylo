import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { summarizeModelScene } from './modelSceneSummary';

describe('3D scene facts', () => {
  it('counts indexed/non-indexed mesh occurrences and instances with world-coordinate bounds', () => {
    const root = new THREE.Group();
    const indexed = new THREE.BufferGeometry();
    indexed.setAttribute('position', new THREE.Float32BufferAttribute([0, 0, 0, 2, 0, 0, 2, 2, 0, 0, 2, 0], 3));
    indexed.setIndex([0, 1, 2, 0, 2, 3]);
    const material = new THREE.MeshBasicMaterial();
    const first = new THREE.Mesh(indexed, material);
    first.position.set(1, 2, 3);
    const nonindexed = indexed.toNonIndexed();
    const second = new THREE.Mesh(nonindexed, material);
    second.position.set(-2, 0, -1);
    // The summary describes the imported geometry, including disabled material/draw-range parts.
    second.visible = false;
    second.geometry.setDrawRange(0, 3);
    const instances = new THREE.InstancedMesh(indexed, material, 2);
    instances.setMatrixAt(0, new THREE.Matrix4().makeTranslation(10, 0, 0));
    instances.setMatrixAt(1, new THREE.Matrix4().makeTranslation(20, 0, 0));
    root.add(first, second, instances, new THREE.Line(indexed, new THREE.LineBasicMaterial()));
    const summary = summarizeModelScene(root);
    expect(summary).toEqual({
      meshes: 3, vertices: 4 + 6 + 4 * 2, triangles: 2 + 2 + 2 * 2,
      bounds: { min: [-2, 0, -1], max: [22, 4, 3] },
    });
    indexed.dispose(); nonindexed.dispose(); material.dispose();
  });
});
