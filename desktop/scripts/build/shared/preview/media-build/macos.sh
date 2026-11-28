#!/bin/bash
set -euo pipefail

if [[ "$(uname -s)-$(uname -m)" != Darwin-arm64 || $# -ne 2 ]]; then
  echo 'Usage on Apple Silicon: bash macos.sh <pinned ffmpeg-source.tar.gz> <new media directory>' >&2
  exit 1
fi

source_archive="$(cd "$(dirname "$1")" && pwd -P)/$(basename "$1")"
output="$(cd "$(dirname "$2")" && pwd -P)/$(basename "$2")"
expected='4401b4fe672ceae51dded26ac7b0ba6416da0fc257f31be642fde8b5141fe070'
actual="$(/usr/bin/shasum -a 256 "$source_archive")"
if [[ "${actual%% *}" != "$expected" ]]; then
  echo 'FFmpeg source SHA-256 differs from media-sources.lock.json' >&2
  exit 1
fi
if [[ -e "$output" || -L "$output" ]]; then
  echo "Output already exists: $output" >&2
  exit 1
fi

scratch="$(mktemp -d "$(dirname "$output")/.trylo-ffmpeg-XXXXXXXX")"
trap 'rm -rf "$scratch"' EXIT
src="$scratch/src"
install="$scratch/install"
candidate="$scratch/media"
mkdir -p "$src" "$scratch/build" "$candidate/bin"
/usr/bin/tar -xzf "$source_archive" --strip-components=1 -C "$src"
export MACOSX_DEPLOYMENT_TARGET=14.0
export GIT_CEILING_DIRECTORIES="$scratch"
cd "$scratch/build"
../src/configure \
  --prefix=/ --shlibdir=/bin --install-name-dir=@loader_path \
  --arch=arm64 --target-os=darwin --cc=/usr/bin/clang --cxx=/usr/bin/clang++ \
  --disable-autodetect --disable-debug --disable-doc --disable-static --enable-shared \
  --disable-gpl --disable-nonfree --disable-version3 --disable-network \
  --disable-avdevice --disable-indevs --disable-outdevs --disable-ffplay --disable-hwaccels \
  --enable-videotoolbox --disable-protocols --enable-protocol=fd,file,pipe \
  --disable-demuxers --enable-demuxer=mov,matroska,avi,asf,flv,mpegps,mpegvideo,mpegts,ogg,wav,mp3,flac,aac,aiff,ac3,eac3,dts,ape,au,caf,amr,loas,m4v,mxf,rm \
  --disable-muxers --enable-muxer=hls,mpegts,rawvideo \
  --disable-encoders --enable-encoder=aac,h264_videotoolbox,rawvideo \
  --disable-filters --enable-filter=scale,setsar,setpts,asetpts,aresample,format,aformat,fps,anull,null \
  --extra-version=trylo-preview-g1e65c6cd5d
/usr/bin/make -j"${TRYLO_MEDIA_BUILD_JOBS:-6}"
/usr/bin/make DESTDIR="$install" install
cp "$install/bin/ffmpeg" "$install/bin/ffprobe" "$candidate/bin/"
# Copy the major-version install names as regular files suitable for a bundle.
for library in "$install"/bin/*.dylib; do
  name="$(basename "$library")"
  if [[ "$name" =~ ^lib[^.]+\.[0-9]+\.dylib$ ]]; then
    cp -L "$library" "$candidate/bin/$name"
  fi
done
cp "$src/COPYING.LGPLv2.1" "$candidate/LICENSE.txt"
printf '%s\n' 'FFmpeg source commit 1e65c6cd5d3d2d12cbb374460dbf08bedf54772a' \
  'https://github.com/FFmpeg/FFmpeg/tree/1e65c6cd5d3d2d12cbb374460dbf08bedf54772a' > "$candidate/NOTICE"
"$candidate/bin/ffmpeg" -hide_banner -version
"$candidate/bin/ffprobe" -hide_banner -version
mv "$candidate" "$output"
