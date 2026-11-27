# Windows media engine build

This is a replaceable leaf engine, not the Trylo runtime. The accepted variant is FFmpeg shared libraries at the commit in `../media-engine.lock.json`, with OpenH264, dav1d and zlib. The complete matching source archives are in the source companion beside the installer. GPL/nonfree/version3, network, devices and GPU backends are disabled. Output codecs are OpenH264/AAC; existing platform playback is tried first.

Use Windows x64, Python 3.14, Git for Windows Bash, and GCC 15.2.0 / MinGW-w64 v13 / win32 threads / UCRT. A workspace without whitespace is required by the native GNU Make generated paths. The compiler distribution is from [MinGW-Builds](https://github.com/niXman/mingw-builds-binaries/releases); its build info and runtime notices accompany the engine. Never use a system FFmpeg as a substitute.

1. Put the matching upstream source archives from the companion in a directory. Put the four original build-tool downloads listed in `tools.lock.json` in `<workspace>/tools/`. Check the pinned hashes; `prepare.py` also checks every byte before extracting. Build tools are not runtime dependencies.
2. Run `python prepare.py --sources <source-directory> --workspace <fresh-workspace>`. It rejects existing source targets and unsafe archive paths.
3. Set `TRYLO_MEDIA_BUILD_ROOT=<workspace>` and `TRYLO_MEDIA_COMPILER=<compiler-directory>/bin` in this shell only. Run `node build.mjs`. It builds static leaf libraries and shared FFmpeg, without installing globally or replacing Trylo resources. This executes the upstream build systems in a child process, which inherits the current shell environment.
4. The result is `<workspace>/engine/bin/`: two console programs and six FFmpeg DLLs. Import libraries are build products, not runtime resources. Audit PE imports: only Windows OS DLLs and those six shared libraries are allowed. GCC C++/gcc runtimes are linked statically under the Runtime Library Exception; no compiler DLL may be resolved through PATH.
5. Retest the real media matrix, seeking, cancellation and source preservation. Retain the source hashes, build command/configuration, notices and recipe hashes. An update needs new runtime pins and the matching source supply; `stage-media-engine.mjs --check` and `verify-media-release.mjs` reject stale or incomplete supply. `stage-media-engine.mjs` never installs tools or runs a player.

`normalize-paths.py` changes generated out-of-tree Makefiles from Git-Bash paths to Windows paths. It does not modify upstream source. OpenH264's generated pkg-config metadata is adjusted to name the static GCC C++ archive explicitly. This avoids accidentally adding a system compiler runtime dependency.

The source build is not asserted bit-for-bit reproducible across toolchain installations. The shipped binary is identified by its full hashes, and the matching sources and recipes permit rebuilding/replacing it. Native WebView2/MSE and installer acceptance are separate from console conversion tests.
