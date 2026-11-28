import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { mkdir, readdir } from 'node:fs/promises';
import path from 'node:path';
const here = path.dirname(fileURLToPath(import.meta.url));
if (!process.env.TRYLO_ARCHIVE_BUILD_ROOT) throw new Error('Set TRYLO_ARCHIVE_BUILD_ROOT; see README.md');
const root = path.resolve(process.env.TRYLO_ARCHIVE_BUILD_ROOT);
const tool = path.join(root, 'toolchain/install');
const emscripten = path.join(tool, 'emscripten');
const prefix = path.join(root, 'prefix');
const ninja = path.join(root, 'python-tools/ninja-1.13.2.data/scripts/ninja.exe');
const cmake = path.join(root, 'python-tools/cmake/data/bin/cmake.exe');
const env = { ...process.env, EM_CONFIG: path.join(root, 'emscripten-config.py'), EM_CACHE: path.join(root, 'cache'), EM_PORTS: path.join(root, 'ports'), PATH: [path.dirname(cmake), path.dirname(ninja), path.join(tool, 'bin'), process.env.PATH].join(path.delimiter) };
async function run(exe, args, cwd = root) {
  console.log(JSON.stringify({ exe: path.basename(exe), args }));
  const child = spawn(exe, args, { env, cwd, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.on('data', (p) => process.stdout.write(p)); child.stderr.on('data', (p) => process.stderr.write(p));
  const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', resolve); });
  if (code !== 0) throw new Error(`Build failed (${code}): ${path.basename(exe)}`);
}
const emcc = (args, cwd) => run('python', [path.join(emscripten, 'emcc.py'), ...args], cwd);
const emar = (args) => run('python', [path.join(emscripten, 'emar.py'), ...args]);
await mkdir(path.join(prefix, 'lib'), { recursive: true }); await mkdir(path.join(prefix, 'include'), { recursive: true });
async function leaf(name, files, flags = []) {
  const out = path.join(root, 'build', name); await mkdir(out, { recursive: true });
  const sources = files.map((file) => path.join(root, 'src', name, file));
  await emcc(['-O2', '-c', ...flags, ...sources, '-I', path.join(root, 'src', name)], out);
  const archive = path.join(prefix, 'lib', name === 'zlib' ? 'libz.a' : 'libbz2.a');
  await emar(['rcs', archive, ...files.map((file) => path.join(out, file.replace(/\.c$/, '.o')))]);
}
if (!process.argv.includes('--resume') && !process.argv.includes('--resume-zstd') && !process.argv.includes('--link-only')) {
  await leaf('zlib', 'adler32.c compress.c crc32.c deflate.c gzclose.c gzlib.c gzread.c gzwrite.c infback.c inffast.c inflate.c inftrees.c trees.c uncompr.c zutil.c'.split(' '), ['-DHAVE_UNISTD_H']);
  await leaf('bzip2', 'blocksort.c compress.c decompress.c huffman.c randtable.c bzlib.c crctable.c'.split(' '), ['-DBZ_NO_STDIO']);
}
const common = ['-G', 'Ninja', '-DCMAKE_MAKE_PROGRAM=' + ninja, '-DCMAKE_TOOLCHAIN_FILE=' + path.join(emscripten, 'cmake/Modules/Platform/Emscripten.cmake'), '-DCMAKE_BUILD_TYPE=Release', '-DCMAKE_INSTALL_PREFIX=' + prefix, '-DCMAKE_INSTALL_LIBDIR=lib', '-DBUILD_SHARED_LIBS=OFF', '-DBUILD_TESTING=OFF'];
async function cm(name, source, flags) {
  const build = path.join(root, 'build', name);
  await run(cmake, ['-S', path.join(root, 'src', source), '-B', build, ...common, ...flags]);
  await run(cmake, ['--build', build, '--parallel', '8']);
  return build;
}
if (!process.argv.includes('--resume') && !process.argv.includes('--resume-zstd') && !process.argv.includes('--link-only')) {
  const xz = await cm('xz', 'xz', ['-DXZ_TOOL_XZ=OFF', '-DXZ_TOOL_XZDEC=OFF', '-DXZ_TOOL_LZMADEC=OFF', '-DXZ_TOOL_LZMAINFO=OFF', '-DXZ_TOOL_SCRIPTS=OFF', '-DXZ_DOC=OFF', '-DXZ_NLS=OFF', '-DXZ_THREADS=no', '-DXZ_SMALL=ON']);
  await run(cmake, ['--install', xz]);
}
if (!process.argv.includes('--resume') && !process.argv.includes('--link-only')) {
  // C-only single-threaded zstd. Its CMake development recipe checks CXX
  // flags without enabling CXX under Emscripten; no source patch is needed.
  const sources = [];
  for (const group of ['common','compress','decompress']) for (const name of await readdir(path.join(root,'src/zstd/lib',group))) if (name.endsWith('.c')) sources.push(path.join(root,'src/zstd/lib',group,name));
  const out=path.join(root,'build/zstd-direct');await mkdir(out,{recursive:true});
  await emcc(['-O2','-c','-DZSTD_DISABLE_ASM=1','-DZSTD_LEGACY_SUPPORT=0',...sources],out);
  await emar(['rcs',path.join(prefix,'lib/libzstd.a'),...sources.map(source=>path.join(out,path.basename(source,'.c')+'.o'))]);
}
const off = ['OPENSSL','NETTLE','MBEDTLS','MD','LIBB2','LZ4','LZO','LIBXML2','BSDXML','EXPAT','WIN32_XMLLITE','PCREPOSIX','PCRE2POSIX','LIBGCC','CNG','TAR','CPIO','CAT','UNZIP','XATTR','ACL','ICONV','TEST','INSTALL'].map((name) => `-DENABLE_${name}=OFF`);
const archive = process.argv.includes('--link-only') ? path.join(root, 'build/libarchive') : await cm('libarchive', 'libarchive-3.8.11', [...off, '-DCMAKE_PREFIX_PATH=' + prefix, '-DENABLE_ZLIB=ON', '-DENABLE_BZip2=ON', '-DENABLE_LZMA=ON', '-DENABLE_ZSTD=ON', '-DLIBLZMA_INCLUDE_DIR=' + path.join(prefix,'include'), '-DLIBLZMA_LIBRARY_RELEASE=' + path.join(prefix,'lib/liblzma.a'), '-DZLIB_LIBRARY=' + path.join(prefix, 'lib/libz.a'), '-DZLIB_INCLUDE_DIR=' + path.join(root, 'src/zlib'), '-DBZIP2_LIBRARY_RELEASE=' + path.join(prefix, 'lib/libbz2.a'), '-DBZIP2_INCLUDE_DIR=' + path.join(root, 'src/bzip2'), '-DZSTD_LIBRARY=' + path.join(prefix,'lib/libzstd.a'), '-DZSTD_INCLUDE_DIR=' + path.join(root,'src/zstd/lib')]);
const exports = ['_malloc','_free','_trylo_locale_init','_archive_read_new','_archive_read_support_filter_all','_archive_read_support_format_all','_archive_read_support_format_raw','_archive_read_open_memory','_archive_read_next_header','_archive_read_data','_archive_read_data_skip','_archive_read_free','_archive_error_string','_archive_entry_pathname_utf8','_archive_entry_pathname','_archive_entry_filetype','_archive_entry_is_encrypted','_trylo_entry_size','_trylo_entry_regular','_archive_version_details'];
const output = path.join(root, 'engine'); await mkdir(output, { recursive: true });
await emcc([path.join(here, 'shim.c'), '-I', path.join(root, 'src/libarchive-3.8.11/libarchive'), path.join(archive, 'libarchive/libarchive.a'), ...['liblzma.a','libzstd.a','libbz2.a','libz.a'].map((name) => path.join(prefix, 'lib', name)), '-O3', '-sMODULARIZE=1', '-sEXPORT_NAME=TryloArchive', '-sENVIRONMENT=worker', '-sFILESYSTEM=0', '-sINITIAL_MEMORY=33554432', '-sMAXIMUM_MEMORY=268435456', '-sALLOW_MEMORY_GROWTH=1', '-sEXPORTED_RUNTIME_METHODS=["cwrap","HEAPU8","HEAPU32"]', '-sEXPORTED_FUNCTIONS=' + JSON.stringify(exports), '-o', path.join(output, 'libarchive.js')]);
console.log('Bounded 256MB Worker-only archive engine compiled; not staged or selected yet');
