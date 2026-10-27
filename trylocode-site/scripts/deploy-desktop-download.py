"""Apply a hash-bound Desktop download overlay, retaining the prior static service."""
import hashlib,json,pathlib,re,shutil,subprocess,sys,tarfile,time
archive=pathlib.Path(sys.argv[1]).resolve();expected_archive=sys.argv[2]
root=pathlib.Path('/home/admin/trylo-site/releases')
if archive.parent!=root or not re.fullmatch(r'desktop-download-\d+\.\d+\.\d+-\d+\.tar\.gz',archive.name): raise SystemExit('Unexpected patch path')
sha=lambda data:hashlib.sha256(data).hexdigest()
if sha(archive.read_bytes())!=expected_archive: raise SystemExit('Archive mismatch')
def run(args,**kwargs):
    result=subprocess.run(args,stdout=subprocess.PIPE,stderr=subprocess.PIPE,**kwargs)
    if result.returncode: raise RuntimeError(result.stderr.decode(errors='replace'))
    return result.stdout
def inspect(name): return json.loads(run(['docker','inspect',name]))[0]
release=root/archive.name.removesuffix('.tar.gz')
if release.exists(): raise SystemExit('Patch directory already exists; inspect before retry')
release.mkdir(mode=0o755)
with tarfile.open(archive) as package:
    for member in package.getmembers():
        if not (member.name in ('public','Caddyfile','manifest.json') or member.name.startswith('public/')) or not (member.isfile() or member.isdir()): raise SystemExit('Unexpected archive member')
    package.extractall(release,filter='data')
manifest=json.loads((release/'manifest.json').read_text());expected=manifest['expected'];info=manifest['release'];installer=info['installer']
if manifest['kind']!='desktop-download-patch' or not re.fullmatch(r'\d+\.\d+\.\d+',info['version']): raise SystemExit('Unexpected patch manifest')
if not re.fullmatch(r'Trylo_[\d.]+_x64-setup\.exe',installer['file']) or installer['path']!='/download/desktop/releases/'+info['version']+'/'+installer['file']: raise SystemExit('Unexpected installer path')
if installer['originUrl']!='https://github.com/ylz92871-dotcom/trylo/releases/download/desktop-v'+info['version']+'/'+installer['file']: raise SystemExit('Unexpected upstream')
old=inspect(expected['container']);mounts={v['Destination']:v['Source'] for v in old['Mounts']}
old_site=pathlib.Path(mounts['/srv/site']).resolve();old_config=pathlib.Path(mounts['/etc/caddy/Caddyfile']).resolve()
if not old_site.is_relative_to(root) or str(old_site)!=expected['site']: raise SystemExit('Static root changed')
ingress=pathlib.Path(next(v['Source'] for v in inspect('trylo-relay-caddy-1')['Mounts'] if v['Destination']=='/etc/caddy/Caddyfile'))
original=ingress.read_bytes()
if sha(original)!=expected['ingressSha256'] or sha(old_config.read_bytes())!=expected['configSha256'] or sha((old_site/'download/desktop/index.html').read_bytes())!=expected['pageSha256']: raise SystemExit('Deployment changed since inspection')
if sha((release/'Caddyfile').read_bytes())!=manifest['caddySha256']: raise SystemExit('Static config mismatch')
for item in manifest['files']:
    file=(release/'public'/item['path']).resolve()
    if not file.is_relative_to(release/'public') or sha(file.read_bytes())!=item['sha256']: raise SystemExit('Overlay inventory mismatch')
def origin(route,head=False):
    args=['curl','--fail','--silent','--show-error','--max-time','25','--resolve','trylocode.me:443:127.0.0.1']
    if head: args+=['--head']
    return run(args+['https://trylocode.me'+route])
preserve=['/','/download/app/','/app/','/chat/','/remote/','/account/','/admin/','/console/shared/base.css']
before={route:sha(origin(route)) for route in preserve}
cache=pathlib.Path('/home/admin/trylo-site/artifacts/desktop')/info['version']/installer['file'];cache.parent.mkdir(parents=True,exist_ok=True)
if cache.exists() and cache.stat().st_size==installer['bytes']:
    if sha(cache.read_bytes())!=installer['sha256']: raise SystemExit('Existing package has different bytes')
else:
    args=['curl','--fail','--location','--silent','--show-error','--proto','=https','--proto-redir','=https','--retry','2','--connect-timeout','15','--max-time','300']
    if cache.exists(): args+=['--continue-at','-']
    run(args+['--output',str(cache),installer['originUrl']])
if cache.stat().st_size!=installer['bytes'] or sha(cache.read_bytes())!=installer['sha256']: raise SystemExit('Downloaded installer mismatch')
if any(p.is_symlink() for p in old_site.rglob('*')): raise SystemExit('Inspect static symlinks before cloning')
site=release/'site';shutil.copytree(old_site,site);shutil.copytree(release/'public',site,dirs_exist_ok=True)
target=site/installer['path'].lstrip('/');target.parent.mkdir(parents=True,exist_ok=True)
if target.exists() and sha(target.read_bytes())!=installer['sha256']: raise SystemExit('Refuse to replace a versioned package')
shutil.copyfile(cache,target)
if sha(target.read_bytes())!=installer['sha256']: raise SystemExit('Installer copy mismatch')
new_alias='trylo-desktop-'+info['version'].replace('.','-')+'-'+archive.name.split('-')[-1].removesuffix('.tar.gz')
compose=(old_config.parent/'compose.yaml').read_text()
if expected['alias'] not in compose: raise SystemExit('Current compose identity missing')
(release/'compose.yaml').write_text(compose.replace(expected['alias'],new_alias))
run(['docker','compose','-f',str(release/'compose.yaml'),'up','-d','--no-build'])
changed=False
try:
    run(['docker','exec',new_alias,'caddy','validate','--config','/etc/caddy/Caddyfile','--adapter','caddyfile'])
    probe='''import{createHash}from'node:crypto';const m=MANIFEST,b=ORIGIN,sha=v=>createHash('sha256').update(v).digest('hex');
for(let i=0;i<20;i++){try{const r=await fetch(b+'/',{signal:AbortSignal.timeout(2000)});if(r.ok)break;}catch{}if(i===19)throw Error('Service not ready');await new Promise(r=>setTimeout(r,250));}
for(const f of m.files){const route=f.path.endsWith('index.html')?f.path.slice(0,-10):f.path;const r=await fetch(b+'/'+route,{headers:{'Accept-Encoding':'identity'}});const bytes=Buffer.from(await r.arrayBuffer());if(r.status!==200||sha(bytes)!==f.sha256)throw Error('Patch bytes '+f.path);}
const r=await fetch(b+m.release.installer.path,{method:'HEAD',headers:{'Accept-Encoding':'identity'}});if(r.status!==200||Number(r.headers.get('content-length'))!==m.release.installer.bytes||!r.headers.get('content-disposition')?.startsWith('attachment'))throw Error('Installer delivery');
const partial=await fetch(b+m.release.installer.path,{headers:{Range:'bytes=0-99'}});if(partial.status!==206||(await partial.arrayBuffer()).byteLength!==100)throw Error('Installer Range');
console.log(JSON.stringify({files:m.files.length,installerHead:true,range:true}));
'''.replace('MANIFEST',json.dumps(manifest)).replace('ORIGIN',json.dumps('http://'+new_alias+':8080'))
    candidate=json.loads(run(['docker','exec','-i','trylo-relay-relay-1','node','--input-type=module','-'],input=probe.encode()))
    text=original.decode();match=re.search(r'(?m)^trylocode\.me\s*\{',text)
    if not match: raise RuntimeError('Apex block missing')
    depth=0;end=None
    for index in range(text.index('{',match.start()),len(text)):
        depth+=int(text[index]=='{')-int(text[index]=='}')
        if depth==0: end=index+1;break
    if end is None: raise RuntimeError('Unbalanced apex block')
    block=text[match.start():end];old_target='reverse_proxy '+expected['alias']+':8080'
    if block.count(old_target)!=1: raise RuntimeError('Static upstream changed')
    updated=(text[:match.start()]+block.replace(old_target,'reverse_proxy '+new_alias+':8080')+text[end:]).encode()
    (release/'ingress.before.Caddyfile').write_bytes(original);(release/'ingress.after.Caddyfile').write_bytes(updated)
    run(['docker','exec','-i','trylo-relay-caddy-1','sh','-c','cat > /config/desktop-download.Caddyfile && caddy validate --config /config/desktop-download.Caddyfile --adapter caddyfile'],input=updated)
    if ingress.read_bytes()!=original: raise RuntimeError('Concurrent ingress update')
    ingress.write_bytes(updated);changed=True
    run(['docker','exec','trylo-relay-caddy-1','caddy','reload','--config','/etc/caddy/Caddyfile','--adapter','caddyfile'])
    page=next(v for v in manifest['files'] if v['path']=='download/desktop/index.html')
    if sha(origin('/download/desktop/'))!=page['sha256']: raise RuntimeError('Published page mismatch')
    for route,digest in before.items():
        if sha(origin(route))!=digest: raise RuntimeError('Existing route changed '+route)
    head=origin(installer['path'],head=True).decode()
    if not re.search(r'content-length:\s*'+str(installer['bytes']),head,re.I) or 'attachment' not in head.lower(): raise RuntimeError('Public origin installer delivery')
    health=json.loads(run(['curl','--fail','--silent','--show-error','--max-time','20','--resolve','relay.trylocode.me:443:127.0.0.1','https://relay.trylocode.me/health']))
    if not health.get('ok'): raise RuntimeError('Relay health')
    report={'at':time.strftime('%Y-%m-%dT%H:%M:%SZ',time.gmtime()),'version':info['version'],'release':str(release),'container':new_alias,'previousContainer':expected['container'],'installer':installer,'candidate':candidate,'preservedRoutes':before,'ingressBeforeSha256':sha(original),'ingressAfterSha256':sha(updated),'backup':str(release/'ingress.before.Caddyfile'),'deployed':True}
    (release/'deployment.json').write_text(json.dumps(report,indent=2)+'\n');(root.parent/'current-desktop-download.json').write_text(json.dumps(report,indent=2)+'\n');print(json.dumps(report))
except BaseException:
    if changed:
        ingress.write_bytes(original);run(['docker','exec','trylo-relay-caddy-1','caddy','reload','--config','/etc/caddy/Caddyfile','--adapter','caddyfile'])
    run(['docker','compose','-f',str(release/'compose.yaml'),'stop']);raise
