#!/usr/bin/env bash
set -euo pipefail
root="$(cygpath -u "${TRYLO_MEDIA_BUILD_ROOT:?Set TRYLO_MEDIA_BUILD_ROOT}")"
compiler="$(cygpath -u "${TRYLO_MEDIA_COMPILER:?Set TRYLO_MEDIA_COMPILER}")"
export PATH="$compiler:$root/nasm/nasm-3.02:$root/prefix/bin:/usr/bin:/bin:$PATH"
prefix="$(cygpath -m "$root/prefix")"
engine="$(cygpath -m "$root/engine")"
export PKG_CONFIG="$(cygpath -m "$root/prefix/bin/pkgconf.exe")"
export PKG_CONFIG_PATH="$prefix/lib/pkgconfig"
export GIT_CEILING_DIRECTORIES="$(cygpath -m "$root/src")"
make_bin="$compiler/mingw32-make.exe"
if [[ "${1:-}" == '--resume-make' ]]; then
  python "$(dirname -- "$0")/normalize-paths.py"
  cd "$root/build/ffmpeg"
  "$make_bin" -j8
  "$make_bin" install
  exit 0
fi
cd "$root/src/openh264"
"$make_bin" -j8 OS=mingw_nt ARCH=x86_64 BUILDTYPE=Release DEBUGSYMBOLS=False PREFIX="$prefix" libraries
"$make_bin" OS=mingw_nt ARCH=x86_64 BUILDTYPE=Release DEBUGSYMBOLS=False PREFIX="$prefix" install-static
cxx_runtime="$(gcc -print-file-name=libstdc++.a | tr -d '\r')"
case "$cxx_runtime" in ?:/*libstdc++.a) ;; *) echo 'Unexpected C++ runtime archive' >&2; exit 1;; esac
sed -i "s|-lstdc++|$cxx_runtime|g" "$root/prefix/lib/pkgconfig/openh264.pc"
cd "$root/src/zlib"
"$make_bin" -f win32/Makefile.gcc -j8 SHARED_MODE=0 BINARY_PATH="$prefix/bin" INCLUDE_PATH="$prefix/include" LIBRARY_PATH="$prefix/lib" install
mkdir -p "$root/build/ffmpeg"
cd "$root/build/ffmpeg"
"$root/src/ffmpeg/configure" \
  --prefix="$engine" --arch=x86_64 --target-os=mingw32 \
  --cc=gcc --cxx=g++ --ar=ar --ranlib=ranlib --nm=nm --strip=strip \
  --disable-autodetect --disable-debug --disable-doc --disable-static --enable-shared \
  --disable-gpl --disable-nonfree --disable-version3 --disable-network \
  --disable-avdevice --disable-indevs --disable-outdevs --disable-ffplay --disable-hwaccels \
  --disable-amf --disable-cuda-llvm --disable-cuvid --disable-nvdec --disable-nvenc \
  --disable-d3d11va --disable-d3d12va --disable-dxva2 --disable-mediafoundation --disable-opencl --disable-vulkan \
  --disable-protocols --enable-protocol=fd,file,pipe \
  --disable-demuxers --enable-demuxer=mov,matroska,avi,asf,flv,mpegps,mpegvideo,mpegts,ogg,wav,mp3,flac,aac,aiff,ac3,eac3,dts,ape,au,caf,amr,loas,m4v,mxf,rm \
  --disable-muxers --enable-muxer=hls,mpegts,rawvideo \
  --disable-encoders --enable-encoder=aac,libopenh264,rawvideo \
  --disable-filters --enable-filter=scale,setsar,setpts,asetpts,aresample,format,aformat,fps,anull,null \
  --enable-libdav1d --enable-libopenh264 --enable-zlib \
  --pkg-config="$PKG_CONFIG" --pkg-config-flags=--static \
  --extra-cflags="-I$prefix/include" \
  --extra-ldflags="-L$prefix/lib -static-libgcc" \
  --extra-libs="$cxx_runtime" \
  --extra-version=trylo-preview-g1e65c6cd5d
python "$(dirname -- "$0")/normalize-ffmpeg-build-paths.py"
"$make_bin" -j8
"$make_bin" install
