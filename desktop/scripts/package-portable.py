from pathlib import Path
import argparse,concurrent.futures,collections,hashlib,json,os,time,zipfile

def main():
 parser=argparse.ArgumentParser(description='Package the already-built Windows Desktop as a portable ZIP (Python 3.10+).')
 parser.add_argument('--output',type=Path)
 parser.add_argument('--workers',type=int,default=16)
 parser.add_argument('--compression-level',type=int,choices=range(10),default=6)
 parser.add_argument('--component',choices=['desktop','cowork'],default='desktop')
 args=parser.parse_args()
 root=Path(__file__).resolve().parents[2]
 version=json.loads((root/'desktop/package.json').read_text(encoding='utf-8'))['version']
 resources=root/'desktop/src-tauri/resources'
 profile=json.loads((root/'desktop/distribution.json').read_text(encoding='utf-8'))
 if (profile['distribution']!='core' or profile['components']['coworkRuntime']['bundled'] is not False
     or profile.get('defaultCliRuntime')!='legacy-stream-json' or profile['components'].get('legacyCliRuntime',{}).get('bundled') is not True):
  raise SystemExit('This release requires a core Desktop distribution profile')
 dependency=json.loads((root/'desktop/optional-dependencies/cowork-runtime.json').read_text(encoding='utf-8'))
 name=(f'Trylo-Desktop-{version}-windows-x64-portable-core.zip' if args.component=='desktop'
       else f"Trylo-CoWork-Runtime-{dependency['version']}-windows-x64-experimental.zip")
 output=args.output or root/'result/desktop'/name
 output=output.resolve();output.parent.mkdir(parents=True,exist_ok=True)
 if output.exists():raise SystemExit('Refusing to overwrite an existing portable archive: '+str(output))
 items=[]
 # Explicit component roots: an old staged Work tree can never leak into core.
 trees=(['desktop-services','sidecars/desktop-companion/publish','sidecars/hermes-capabilities','cli','cli-legacy','runtime']
        if args.component=='desktop' else ['work/bin','workd'])
 for tree in trees:
  source=resources/tree
  if not source.is_dir():raise SystemExit('Missing staged runtime: '+tree)
  for file in source.rglob('*'):
   if file.is_file():
    if file.is_symlink() or not file.resolve().is_relative_to(resources.resolve()):raise SystemExit('Redirected runtime file: '+str(file))
    items.append((file,file.relative_to(resources).as_posix()))
 if args.component=='desktop':
  executable=root/'desktop/src-tauri/target/release/trylo-desktop.exe'
  if not executable.is_file():raise SystemExit('Build the native Desktop application first')
  items.extend([(executable,'trylo-desktop.exe'),(root/'desktop/distribution.json','distribution.json'),
                (root/'desktop/scripts/Start-Trylo.ps1','Start-Trylo.ps1'),
                (root/'desktop/scripts/Start-Trylo.cmd','Start-Trylo.cmd')])
  notices=['NODE-v24.14.1-LICENSE.txt','TRYLO-LICENSE.txt','README-Desktop.txt']
 else:
  workManifest=json.loads((resources/'workd/manifest.json').read_text(encoding='utf-8'))
  workPackage=json.loads((resources/'workd/package.json').read_text(encoding='utf-8'))
  if workManifest['node']!=dependency['node']['version'] or workPackage['version']!=dependency['version']:
   raise SystemExit('Experimental dependency version does not match the staged artifact')
  items.append((root/'desktop/optional-dependencies/cowork-runtime.json','dependency-manifest.json'))
  notices=['WORKD-LICENSE.txt','README-CoWork.txt']
 for name in notices:
  file=(root/'desktop/README-Portable.txt' if args.component=='desktop' and name=='README-Desktop.txt'
        else root/'result/desktop'/name)
  if not file.is_file():raise SystemExit('Missing release notice: '+name)
  items.append((file,name))
 items.sort(key=lambda item:item[1]);started=time.monotonic()
 def read(item):
  file,name=item
  # Large binaries stream through ZipFile.write instead of filling the read queue.
  return file,name,None if file.stat().st_size>32*1024*1024 else file.read_bytes()
 partial=output.with_suffix(output.suffix+'.partial')
 if partial.exists():raise SystemExit('Review the previous partial archive first: '+str(partial))
 with zipfile.ZipFile(partial,'w',compression=zipfile.ZIP_DEFLATED,compresslevel=args.compression_level,allowZip64=True) as archive,concurrent.futures.ThreadPoolExecutor(max_workers=max(1,min(args.workers,32))) as pool:
  pending=collections.deque()
  def store(future):
   file,name,data=future.result()
   if data is None:archive.write(file,name)
   else:archive.writestr(name,data)
  for item in items:
   pending.append(pool.submit(read,item))
   if len(pending)>=32:store(pending.popleft())
  while pending:store(pending.popleft())
 os.replace(partial,output)
 digest=hashlib.sha256()
 with output.open('rb') as stream:
  for block in iter(lambda:stream.read(1024*1024),b''):digest.update(block)
 result={'component':args.component,'file':output.name,'bytes':output.stat().st_size,'files':len(items),'sha256':digest.hexdigest(),'seconds':round(time.monotonic()-started,2),'compressionLevel':args.compression_level}
 output.with_suffix('.build.json').write_text(json.dumps(result,indent=2)+'\n',encoding='utf-8')
 print(json.dumps(result,indent=2))

if __name__=='__main__':main()
