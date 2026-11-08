// Regenerate the shipped contour when the approved startup bitmap changes.
// The matte uses the approved compositor's exact flood fill and feather.
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const source = fileURLToPath(new URL('../public/startup/approved-facet.png', import.meta.url));
const output = fileURLToPath(new URL('../public/startup/approved-contour.png', import.meta.url));
const ffmpeg = process.argv[2] ?? 'ffmpeg';
const header = readFileSync(source);
const width = header.readUInt32BE(16), height = header.readUInt32BE(20), count = width * height;
const decoded = spawnSync(ffmpeg, ['-v', 'error', '-i', source, '-f', 'rawvideo', '-pix_fmt', 'rgba', 'pipe:1'],
  { maxBuffer: count * 4 + 1024, windowsHide: true });
if (decoded.error) throw decoded.error;
if (decoded.status !== 0) throw new Error(decoded.stderr.toString());
const pixels = decoded.stdout;
const background = new Uint8Array(count), queue = new Int32Array(count);
let head = 0, tail = 0;
const visit = i => {
  if (background[i]) return;
  const p = i * 4;
  if (Math.min(pixels[p], pixels[p + 1], pixels[p + 2]) < 246) return;
  background[i] = 1; queue[tail++] = i;
};
for (let x = 0; x < width; x++) { visit(x); visit((height - 1) * width + x); }
for (let y = 1; y < height - 1; y++) { visit(y * width); visit(y * width + width - 1); }
while (head < tail) {
  const i = queue[head++], x = i % width;
  if (x > 0) visit(i - 1); if (x < width - 1) visit(i + 1);
  if (i >= width) visit(i - width); if (i < count - width) visit(i + width);
}
const distance = new Float32Array(count), diagonal = Math.SQRT2;
for (let i = 0; i < count; i++) distance[i] = background[i] ? 0 : 1e6;
for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
  const i = y * width + x; let d = distance[i];
  if (x > 0) d = Math.min(d, distance[i - 1] + 1);
  if (y > 0) { d = Math.min(d, distance[i - width] + 1); if (x > 0) d = Math.min(d, distance[i - width - 1] + diagonal); if (x < width - 1) d = Math.min(d, distance[i - width + 1] + diagonal); }
  distance[i] = d;
}
for (let y = height - 1; y >= 0; y--) for (let x = width - 1; x >= 0; x--) {
  const i = y * width + x; let d = distance[i];
  if (x < width - 1) d = Math.min(d, distance[i + 1] + 1);
  if (y < height - 1) { d = Math.min(d, distance[i + width] + 1); if (x > 0) d = Math.min(d, distance[i + width - 1] + diagonal); if (x < width - 1) d = Math.min(d, distance[i + width + 1] + diagonal); }
  distance[i] = d;
}
const alpha = new Uint8Array(count);
for (let i = 0; i < count; i++) {
  const x = Math.max(0, Math.min(1, (distance[i] - 2.5) / 2));
  alpha[i] = Math.round(x * x * (3 - 2 * x) * 255);
}
// Store normal image rows; the material flips both textures identically.
const encoded = spawnSync(ffmpeg, ['-v', 'error', '-f', 'rawvideo', '-pixel_format', 'gray', '-video_size',
  `${width}x${height}`, '-i', 'pipe:0', '-frames:v', '1', '-y', output],
{ input: alpha, windowsHide: true });
if (encoded.error) throw encoded.error;
if (encoded.status !== 0) throw new Error(encoded.stderr.toString());
console.log(`Prepared ${width}x${height} approved startup contour.`);
