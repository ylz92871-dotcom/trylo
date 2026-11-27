import { createReadStream } from 'node:fs';
import { readFile, realpath, stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { previewCachePath } from './cache-path.mjs';
const desktop=fileURLToPath(new URL('../../../../', import.meta.url));
async function hash(file){const h=createHash('sha256');for await(const chunk of createReadStream(file))h.update(chunk);return h.digest('hex');}
async function regular(root,name){const base=await realpath(root),file=await realpath(path.join(root,name)),relative=path.relative(base,file);if(!relative||relative.startsWith('..')||path.isAbsolute(relative)||!(await stat(file)).isFile())throw new Error('Redirected archive supply file');return file;}
/** Exact vendor/source/recipe supply for the replaceable byte-only decoder. */
export async function verifyArchiveRelease(){
  const lock=JSON.parse(await readFile(path.join(desktop,'scripts/build/shared/preview/archive-engine.lock.json'),'utf8'));
  if(lock.schemaVersion!==1||lock.memoryLimitBytes!==268435456||!lock.files?.length||!lock.sources?.length||!lock.recipes?.length)throw new Error('Archive decoder/source supply incomplete');
  const vendor=path.join(desktop,'vendor/preview/archive');
  for(const file of lock.files){const target=await regular(vendor,file.path);if((await stat(target)).size!==file.bytes||await hash(target)!==file.sha256)throw new Error('Archive decoder file mismatch: '+file.path);}
  for(const file of lock.recipes){if(!file.path.startsWith('scripts/build/shared/preview/archive-build/')||await hash(await regular(desktop,file.path))!==file.sha256)throw new Error('Archive build recipe mismatch: '+file.path);}
  const sourceDirectory=path.resolve(process.env.TRYLO_ARCHIVE_SOURCES_DIR??previewCachePath('archive-sources'));
  const inventory=JSON.parse(await readFile(path.join(sourceDirectory,'archive-source-inventory.json'),'utf8'));
  if(inventory.version!==lock.version||inventory.errors?.length||inventory.files?.length!==lock.sources.length)throw new Error('Archive source companion incomplete');
  for(const file of lock.sources){const supplied=inventory.files.find(f=>f.name===file.name);const target=await regular(sourceDirectory,file.name);if(!supplied||supplied.sha256!==file.sha256||(await stat(target)).size!==file.bytes||await hash(target)!==file.sha256)throw new Error('Archive source mismatch: '+file.name);}
  return {lock,sourceDirectory};
}
