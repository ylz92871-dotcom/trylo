// Offline bundle gate and matching source companion. No runtime downloads.
import { createReadStream } from 'node:fs';
import { mkdir, readFile, realpath, rename, stat, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { previewFormatFiles } from './codec-files.mjs';
import { verifyMediaRelease } from './verify-media-release.mjs';
import { verifyArchiveRelease } from './verify-archive-engine.mjs';
import { previewCachePath } from './cache-path.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const desktop = path.resolve(here, '../../../..');
const repository = path.dirname(desktop);
const resources = path.join(desktop, 'src-tauri/resources');
const office = JSON.parse(await readFile(path.join(here, 'office-engine.lock.json'), 'utf8'));
const sources = JSON.parse(await readFile(path.join(here, 'source-archives.lock.json'), 'utf8'));
const pkg = JSON.parse(await readFile(path.join(desktop, 'package.json'), 'utf8'));
const media = await verifyMediaRelease();
const archive = await verifyArchiveRelease();
for (const file of archive.lock.sources) {
  const duplicate = [...sources.files, ...media.lock.files].find((item) => item.name === file.name);
  if (duplicate && duplicate.sha256 !== file.sha256) throw new Error(`Conflicting source companion name: ${file.name}`);
}
const archiveSourceNames = archive.lock.sources.filter((file) => ![...sources.files, ...media.lock.files].some((item) => item.name === file.name)).map((file) => file.name);
if (sources.schemaVersion !== 1 || sources.officeVersion !== office.version) throw new Error('Preview source lock does not match Office');
for (const [name, version] of [['utif', '3.1.0'], ['libheif-js', '1.23.5'], ['occt-import-js', '0.0.23']]) {
  if (pkg.dependencies[name] !== version) throw new Error(`Update preview source supply before releasing ${name}`);
}
async function digest(file) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}
async function regularFile(root, relative) {
  const target = await realpath(path.join(root, relative));
  const within = path.relative(await realpath(root), target);
  if (!within || within === '..' || within.startsWith(`..${path.sep}`) || path.isAbsolute(within) || !(await stat(target)).isFile()) throw new Error(`Redirected or missing preview release file: ${relative}`);
  return target;
}
const sourceDirectory = path.resolve(process.env.TRYLO_PREVIEW_SOURCES_DIR ?? previewCachePath('sources'));
const sourceInventory = JSON.parse(await readFile(path.join(sourceDirectory, 'source-inventory.json'), 'utf8').catch(() => { throw new Error('Prepare matching preview sources with fetch-sources.mjs --output <checkout directory>, then set TRYLO_PREVIEW_SOURCES_DIR before bundling'); }));
if (sourceInventory.officeVersion !== office.version || sourceInventory.errors?.length || sourceInventory.files?.length !== sources.files.length) throw new Error('Incomplete preview source companion');
for (const file of sources.files) {
  const supplied = sourceInventory.files.find((entry) => entry.name === file.name);
  const target = await regularFile(sourceDirectory, file.name);
  if (!supplied || supplied.url !== file.url || supplied.sha256 !== file.sha256 || (await stat(target)).size !== file.bytes || await digest(target) !== file.sha256) throw new Error(`Source archive mismatch: ${file.name}`);
}
// This checks the pinned conversion profile and rejects extra/missing files.
execFileSync(process.execPath, [path.join(here, 'stage-office-engine.mjs'), '--check'], { windowsHide: true, stdio: 'inherit' });

const notices = [];
notices.push(...media.notices);
for (const [name, original] of previewFormatFiles()) {
  if (!name.startsWith('preview-codecs/')) continue;
  const relative = `preview/codecs/${name.slice('preview-codecs/'.length)}`;
  const target = await regularFile(resources, relative);
  const sha256 = await digest(target);
  if (sha256 !== await digest(original)) throw new Error(`Staged preview codec/notice differs from supply: ${relative}`);
  notices.push({ path: relative, sha256 });
}
const officeNotices = ['preview/office/license.txt', 'preview/office/LICENSE.html', 'preview/office/NOTICE'];
for (const relative of officeNotices) notices.push({ path: relative, sha256: await digest(await regularFile(resources, relative)) });
const ownSources = [
  'docs/preview/README.md', 'docs/preview/DEPENDENCIES.md', 'docs/preview/codecs.md',
  'scripts/build/shared/preview/source-archives.lock.json', 'scripts/build/shared/preview/office-engine.lock.json',
  'scripts/build/shared/preview/office-runtime-profile.mjs', 'scripts/build/shared/preview/stage-office-engine.mjs',
  'src/preview/workers/image-worker.js', 'src/preview/workers/cad-worker.js',
  'src/preview/workers/run-worker.ts',
  'src/preview/providers/raster.ts', 'src/preview/providers/cad.ts',
  'docs/preview/media.md', 'scripts/build/shared/preview/media-engine.lock.json', 'scripts/build/shared/preview/media-sources.lock.json',
  'src/preview/providers/media-policy.json', 'src/preview/providers/media-playlist.ts',
  'src/host-adapter/preview/media.ts', 'src/components/preview/media-playback.ts',
  'src-tauri/src/preview/media/mod.rs', 'src-tauri/src/preview/media/engine.rs',
  'src-tauri/src/preview/media/policy.rs', 'src-tauri/src/preview/media/process.rs',
  'src-tauri/src/preview/media/session.rs', 'src-tauri/src/preview/media/producer.rs',
  ...media.recipes,
  'src/preview/workers/archive-worker.js', 'src/preview/providers/archive.ts', 'src/preview/providers/archive-types.ts',
  'scripts/build/shared/preview/archive-engine.lock.json', ...archive.lock.recipes.map((file) => file.path),
  'docs/preview/archives.md',
];
const ownFiles = [];
for (const relative of ownSources) ownFiles.push({ path: relative, sha256: await digest(await regularFile(desktop, relative)) });
const identity = createHash('sha256').update(JSON.stringify({ sources, media: media.lock, archive: archive.lock, notices, ownFiles })).digest('hex');
const output = path.resolve(process.env.TRYLO_PREVIEW_RELEASE_DIR ?? previewCachePath('release'));
if (!output.startsWith(repository + path.sep)) throw new Error('Preview release output must stay inside this checkout');
await mkdir(output, { recursive: true });
if ((await realpath(output)).toLowerCase() !== output.toLowerCase()) throw new Error('Redirected preview release output');
const companionName = `Trylo-preview-sources-${office.version}-${identity.slice(0, 12)}.tar`;
const companion = path.join(output, companionName);
const manifestPath = path.join(output, 'preview-release.json');
const prior = await readFile(manifestPath, 'utf8').then(JSON.parse, () => undefined);
let companionSha256;
if (prior?.identity === identity && prior.sourceCompanion?.file === companionName && await stat(companion).catch(() => false)) {
  companionSha256 = await digest(companion);
  if (companionSha256 !== prior.sourceCompanion.sha256) throw new Error('Retain and inspect the changed source companion');
} else {
  if (await stat(companion).catch(() => false)) throw new Error('Retain and inspect the unrecorded source companion');
  const temporary = `${companion}.partial-${process.pid}`;
  const archiveNotices = notices.filter((file) => /(?:LICENSE|NOTICE|README)/i.test(file.path)).map((file) => file.path);
  execFileSync(process.platform === 'win32' ? 'tar.exe' : 'tar', ['-cf', temporary,
    '-C', sourceDirectory, ...sources.files.map((file) => file.name), 'source-inventory.json',
    '-C', media.sourceDirectory, ...media.lock.files.map((file) => file.name), 'media-source-inventory.json',
    '-C', archive.sourceDirectory, ...archiveSourceNames, 'archive-source-inventory.json',
    '-C', resources, ...archiveNotices,
    '-C', desktop, ...ownSources,
  ], { windowsHide: true, stdio: 'inherit' });
  companionSha256 = await digest(temporary);
  await rename(temporary, companion);
}
const manifest = {
  schemaVersion: 1, productVersion: pkg.version, identity,
  office: { version: office.version, buildId: office.buildId, runtimeProfile: office.runtimeProfile, upstreamDistributionFilesSha256: office.upstreamDistributionFilesSha256, distributionFilesSha256: office.distributionFilesSha256 },
  sourceCompanion: { file: companionName, sha256: companionSha256, bytes: (await stat(companion)).size },
  sources: [...sources.files, ...media.lock.files, ...archive.lock.sources], archive: { version: archive.lock.version }, media: { version: media.lock.engineVersion, ffmpegCommit: media.lock.ffmpegCommit, builderCommit: media.lock.builderCommit }, suppliedFiles: notices, applicationAdapters: ownFiles,
};
await writeFile(`${manifestPath}.partial-${process.pid}`, `${JSON.stringify(manifest, null, 2)}\n`);
await rename(`${manifestPath}.partial-${process.pid}`, manifestPath);
await writeFile(path.join(output, 'README.txt'), `Trylo preview release companion\n\nDistribute preview-release.json and ${companionName} alongside the matching installer.\nLibreOffice uses the ${office.runtimeProfile} conversion profile. Its binaries are unchanged; unused UI languages, editing dictionaries/help/gallery are omitted, and dictionaries.xcu retains hyphenation registrations only.\nThe companion includes matching upstream sources/build recipes, license notices, Trylo adapters, and the exact profile/staging scripts needed to reproduce these changes.\nSHA256 ${companionName}: ${companionSha256}\n\nThis gate verifies supply consistency. Native UI and installer acceptance are separate.\n`);
console.log(`Preview release verified: Office ${office.version}; ${sources.files.length} source archives; companion ${companion}`);
