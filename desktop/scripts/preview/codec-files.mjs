import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const packageRoot = (name) => path.dirname(require.resolve(`${name}/package.json`));

/** LGPL providers stay separate, unmodified, replaceable files with notices.
 * Only workers load them, on demand; no vendor codec enters the main bundle. */
export function previewFormatFiles() {
  const heif = packageRoot('libheif-js');
  const cad = packageRoot('occt-import-js');
  const tiff = packageRoot('utif');
  const pako = path.dirname(createRequire(path.join(tiff, 'package.json')).resolve('pako/package.json'));
  const workers = fileURLToPath(new URL('../../src/preview/workers/', import.meta.url));
  const archive = fileURLToPath(new URL('../../vendor/preview/archive/', import.meta.url));
  return new Map([
    ['preview-workers/image-worker.js', path.join(workers, 'image-worker.js')],
    ['preview-workers/cad-worker.js', path.join(workers, 'cad-worker.js')],
    ['preview-workers/archive-worker.js', path.join(workers, 'archive-worker.js')],
    ['preview-codecs/archive/libarchive.js', path.join(archive, 'libarchive.js')],
    ['preview-codecs/archive/libarchive.wasm', path.join(archive, 'libarchive.wasm')],
    ...['LICENSE-libarchive.txt', 'LICENSE-liblzma.txt', 'LICENSE-0BSD.txt', 'LICENSE-zstd.txt', 'LICENSE-bzip2.txt', 'LICENSE-zlib.txt', 'LICENSE-Emscripten.txt', 'LICENSE-musl.txt', 'LICENSE-compiler-rt.txt', 'LICENSE-libcxx.txt', 'LICENSE-libcxxabi.txt', 'LICENSE-libunwind.txt', 'NOTICE-source-headers.txt', 'NOTICE.txt'].map((name) => [`preview-codecs/archive/${name}`, path.join(archive, name)]),
    ['preview-codecs/heif/libheif-bundle.js', path.join(heif, 'libheif-wasm/libheif-bundle.js')],
    ['preview-codecs/heif/LICENSE.txt', path.join(heif, 'libheif-wasm/LICENSE')],
    ['preview-codecs/heif/README.md', path.join(heif, 'README.md')],
    ['preview-codecs/tiff/UTIF.js', path.join(tiff, 'UTIF.js')],
    ['preview-codecs/tiff/LICENSE.txt', path.join(tiff, 'LICENSE')],
    ['preview-codecs/tiff/pako.min.js', path.join(pako, 'dist/pako.min.js')],
    ['preview-codecs/tiff/pako-LICENSE.txt', path.join(pako, 'LICENSE')],
    ['preview-codecs/cad/occt-import-js.js', path.join(cad, 'dist/occt-import-js.js')],
    ['preview-codecs/cad/occt-import-js.wasm', path.join(cad, 'dist/occt-import-js.wasm')],
    ['preview-codecs/cad/LICENSE.txt', path.join(cad, 'dist/license.occt-import-js.txt')],
    ['preview-codecs/cad/OCCT-LICENSE.txt', path.join(cad, 'dist/license.occt.txt')],
    ['preview-codecs/cad/README.md', path.join(cad, 'README.md')],
    ['preview-codecs/README.md', fileURLToPath(new URL('../../docs/preview/codecs.md', import.meta.url))],
  ]);
}
