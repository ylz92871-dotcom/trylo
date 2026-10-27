import fs from 'node:fs';import path from 'node:path';import {fileURLToPath} from 'node:url';import {spawnSync} from 'node:child_process';import {createHash} from 'node:crypto';import {ssh} from './seoul-connection.mjs';
const repo=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..'),record=JSON.parse(fs.readFileSync(path.join(repo,'trylocode-site/.local-release/desktop-download-candidate.json'),'utf8')),manifest=JSON.parse(fs.readFileSync(path.join(record.bundle,'manifest.json'),'utf8'));
const helper=fs.readFileSync(new URL('./http-verification.py',import.meta.url),'utf8');
const program=`import hashlib,json,pathlib,re,subprocess,tempfile\n${helper}\nm=json.loads(${JSON.stringify(JSON.stringify(manifest))})
results=[]
for item in m['files']:
    relative=item['path'];relative=relative[:-10] if relative.endswith('index.html') else relative
    status,final,headers,data=fetch('https://trylocode.me/'+relative)
    assert status==200,(relative,status)
    if hashlib.sha256(data).hexdigest()!=item['sha256']:
        assert item['path'].endswith('.html') and hashlib.sha256(unmask_email(data)).hexdigest()==item['sha256'],relative
    results.append({'path':relative,'status':status,'hashMatches':True})
url='https://trylocode.me'+m['release']['installer']['path']
status,_,headers,_=fetch(url,head=True)
assert status==200 and int(headers['content-length'])==m['release']['installer']['bytes'],headers
assert headers.get('content-disposition','').startswith('attachment') and headers.get('content-type')=='application/octet-stream',headers
with tempfile.TemporaryDirectory(prefix='trylo-download-range-') as directory:
    body=pathlib.Path(directory)/'body';header=pathlib.Path(directory)/'headers'
    subprocess.run(['curl','--fail','--silent','--show-error','--range','0-99','--max-filesize','1024','--max-time','20','-D',str(header),'-o',str(body),url],check=True)
    assert len(body.read_bytes())==100 and '206' in header.read_text(),header.read_text()
status,_,_,home=fetch('https://trylocode.me/')
assert status==200 and hashlib.sha256(unmask_email(home)).hexdigest()==m['expected']['homepageSha256']
print(json.dumps({'files':results,'installerHead':True,'range':True,'homepageUnchanged':True,'headers':headers}))
`;
const publicChecks=JSON.parse(ssh(['sudo','-n','python3','-'],{input:program,timeout:120000}));
console.log('Public page, assets, package headers and Range checks passed. Downloading the complete installer to D:.');
const folder=path.join(record.bundle,'downloads');fs.mkdirSync(folder,{recursive:true});const file=path.join(folder,manifest.release.installer.file),sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const complete=fs.existsSync(file)&&fs.statSync(file).size===manifest.release.installer.bytes&&sha(fs.readFileSync(file))===manifest.release.installer.sha256;
if(!complete){const args=['--fail','--location','--silent','--show-error','--retry','2','--connect-timeout','20','--max-time','600','--output',file,'--dump-header',path.join(record.bundle,'download-headers.txt')];if(fs.existsSync(file))args.push('--continue-at','-');args.push('https://trylocode.me'+manifest.release.installer.path);const result=spawnSync('curl.exe',args,{encoding:'utf8',timeout:630000,windowsHide:true});if(result.status!==0)throw Error(result.stderr||result.error?.message);}
const actual=sha(fs.readFileSync(file));if(actual!==manifest.release.installer.sha256||fs.statSync(file).size!==manifest.release.installer.bytes)throw Error('Public installer differs from the original');
const report={at:new Date().toISOString(),version:manifest.release.version,url:'https://trylocode.me'+manifest.release.installer.path,bytes:fs.statSync(file).size,sha256:actual,completePublicDownload:true,matchesLocalOriginal:true,downloadedFile:file,publicChecks,installerExecuted:false};
fs.writeFileSync(path.join(record.bundle,'public-verification.json'),JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify({version:report.version,bytes:report.bytes,sha256:actual,completePublicDownload:true,matchesLocalOriginal:true},null,2));
