"""Verify and unpack the source companion and fixed tools, offline only."""
import argparse, pathlib, hashlib, json, tarfile, zipfile, shutil
p=argparse.ArgumentParser();p.add_argument('--sources',required=True);p.add_argument('--workspace',required=True);a=p.parse_args()
here=pathlib.Path(__file__).resolve().parent
root=pathlib.Path(a.workspace).resolve();sources=pathlib.Path(a.sources).resolve()
inputs=json.loads((here/'inputs.lock.json').read_text())
def checked(directory,item):
    file=(directory/item['name']).resolve()
    if not file.is_relative_to(directory) or file.stat().st_size!=item['bytes'] or hashlib.file_digest(file.open('rb'),'sha256').hexdigest()!=item['sha256']:
        raise RuntimeError('Input hash mismatch: '+item['name'])
    return file
root.mkdir(parents=True,exist_ok=True)
for item in inputs['sources']:
    archive=checked(sources,item)
    if not item.get('owner'):continue
    target=root/'src'/item['owner']
    if target.exists():raise RuntimeError('Use a fresh source workspace')
    temporary=target.with_name(target.name+'.unpacking');temporary.mkdir(parents=True)
    with tarfile.open(archive) as t:t.extractall(temporary,filter='data')
    children=list(temporary.iterdir())
    if len(children)!=1 or not children[0].is_dir():raise RuntimeError('Unexpected source layout')
    children[0].rename(target);temporary.rmdir()
for item in inputs['tools']:
    archive=checked(root/'tools',item)
    target=root/('toolchain' if item['name'].startswith('emscripten-') else 'python-tools')
    with zipfile.ZipFile(archive) as z:
        for entry in z.infolist():
            if not (target/entry.filename).resolve().is_relative_to(target.resolve()) or (entry.external_attr>>16)&0o170000==0o120000:raise RuntimeError('Unsafe tool member')
        z.extractall(target)
tool=root/'toolchain/install';node=shutil.which('node')
if not node:raise RuntimeError('Node.js required by the compiler')
(root/'emscripten-config.py').write_text('LLVM_ROOT='+repr(str(tool/'bin'))+'\nBINARYEN_ROOT='+repr(str(tool))+'\nNODE_JS=['+repr(node)+']\n',encoding='utf-8')
print('Verified offline archive source/tool workspace prepared; no global configuration changed')
