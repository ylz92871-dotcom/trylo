import pathlib, os
here = pathlib.Path(__file__).resolve().parent
root = pathlib.Path(os.environ['TRYLO_MEDIA_BUILD_ROOT']).resolve()
windows = root.as_posix()
posix = '/' + root.drive[0].lower() + windows[2:]
for relative in ['Makefile', 'ffbuild/config.mak']:
    target = root / 'build/ffmpeg' / relative
    text = target.read_text(encoding='utf-8')
    backup = target.with_name(target.name + '.posix-first')
    if not backup.exists():
        backup.write_text(text, encoding='utf-8')
    target.write_text(text.replace(posix, windows), encoding='utf-8', newline='\n')
print('Normalized generated out-of-tree paths for native Windows GNU Make; source unchanged')
