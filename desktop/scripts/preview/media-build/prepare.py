"""Prepare an empty offline Windows build workspace from pinned archives."""
import argparse, hashlib, json, pathlib, tarfile, zipfile, shutil
p = argparse.ArgumentParser()
p.add_argument('--sources', required=True)
p.add_argument('--workspace', required=True)
a = p.parse_args()
here = pathlib.Path(__file__).resolve().parent
root = pathlib.Path(a.workspace).resolve()
sources = pathlib.Path(a.sources).resolve()
tools = json.loads((here/'tools.lock.json').read_text())['tools']
upstream = json.loads((here.parent/'media-sources.lock.json').read_text())['files']
def checked(directory, item):
    file = (directory/item['name']).resolve()
    if not file.is_relative_to(directory) or file.stat().st_size != item['bytes'] or hashlib.file_digest(file.open('rb'), 'sha256').hexdigest() != item['sha256']:
        raise RuntimeError('Archive identity mismatch: ' + item['name'])
    return file
def unpack(archive, target, flat=False):
    if target.exists():
        raise RuntimeError('Use a fresh workspace; source target exists: ' + str(target))
    temporary = target.with_name(target.name+'.unpacking')
    temporary.mkdir(parents=True)
    with tarfile.open(archive) as tar:
        tar.extractall(temporary, filter='data')
    if flat:
        temporary.rename(target)
        return
    children = list(temporary.iterdir())
    if len(children) != 1 or not children[0].is_dir():
        raise RuntimeError('Unexpected source layout')
    children[0].rename(target)
    temporary.rmdir()
root.mkdir(parents=True, exist_ok=True)
shutil.copyfile(here/'tools.lock.json', root/'build-tools.lock.json')
for item in upstream:
    source = checked(sources, item)
    owner = next((kind for token, kind in [('ffmpeg-source','ffmpeg'), ('openh264','openh264'), ('dav1d','dav1d'), ('zlib','zlib')] if token in item['name']), None)
    if owner:
        unpack(source, root/'src'/owner, flat=item['name'].startswith('git-'))
for item in tools:
    source = checked(root/'tools', item)
    if source.suffix == '.whl' or source.suffix == '.zip':
        target = root/('nasm' if source.suffix == '.zip' else 'python-tools')
        with zipfile.ZipFile(source) as z:
            for entry in z.infolist():
                if not (target/entry.filename).resolve().is_relative_to(target.resolve()) or (entry.external_attr >> 16) & 0o170000 == 0o120000:
                    raise RuntimeError('Unsafe build tool member')
            z.extractall(target)
    else:
        unpack(source, root/'src/pkgconf')
print('Verified offline source/tool workspace prepared. No system configuration changed.')
