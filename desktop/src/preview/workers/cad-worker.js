/* The OCCT provider is confined to bytes -> indexed triangle meshes. */
self.onmessage = async ({ data: { buffer, format, codecs } }) => {
  try {
    importScripts(codecs.cad);
    const occt = await self.occtimportjs({ locateFile: (name) => { if (name.endsWith('.wasm')) return codecs.cadWasm; throw new Error('未知 CAD 解码器资源'); } });
    const read = format === 'iges' ? occt.ReadIgesFile : format === 'brep' ? occt.ReadBrepFile : occt.ReadStepFile;
    const decoded = read(new Uint8Array(buffer), { linearUnit: 'millimeter', linearDeflectionType: 'bounding_box_ratio', linearDeflection: .001, angularDeflection: .5 });
    if (!decoded.success || !decoded.meshes?.length) throw new Error('无法从此 CAD 文件读取可显示的几何体。');
    let triangles = 0;
    const transfers = [];
    const meshes = decoded.meshes.map((mesh) => {
      const position = new Float32Array(mesh.attributes.position.array);
      const normal = mesh.attributes.normal?.array ? new Float32Array(mesh.attributes.normal.array) : undefined;
      const index = new Uint32Array(mesh.index.array);
      triangles += index.length / 3;
      if (triangles > 3_000_000) throw new Error('模型超过 300 万三角面的预览限制，请简化模型或使用外部应用。');
      if (!position.every(Number.isFinite) || index.some((value) => value >= position.length / 3)) throw new Error('CAD 几何数据无效。');
      transfers.push(position.buffer, index.buffer); if (normal) transfers.push(normal.buffer);
      return { name: mesh.name, color: mesh.color, position, normal, index, faces: mesh.brep_faces?.map((face) => ({ first: face.first, last: face.last, color: face.color })) };
    });
    self.postMessage({ ok: true, result: { meshes } }, transfers);
  } catch (error) { self.postMessage({ ok: false, error: error instanceof Error ? error.message : String(error) }); }
};
