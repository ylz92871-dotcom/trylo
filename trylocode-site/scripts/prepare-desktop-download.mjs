import fs from 'node:fs';import path from 'node:path';import {fileURLToPath} from 'node:url';import {createHash} from 'node:crypto';
import {desktopReleasePolicy} from './desktop-release-policy.mjs';
import {ssh} from './seoul-connection.mjs';import {desktopDownloadActions} from './desktop-download.mjs';
const repo=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..'),siteRoot=path.join(repo,'trylocode-site'),source=path.join(siteRoot,'marketing');
const release=JSON.parse(fs.readFileSync(path.join(siteRoot,'desktop-release.json'),'utf8')),sha=data=>createHash('sha256').update(data).digest('hex');
const localInstaller=path.join(repo,'desktop/src-tauri/target/release/bundle/nsis',release.installer.file);
if(sha(fs.readFileSync(localInstaller))!==release.installer.sha256||fs.statSync(localInstaller).size!==release.installer.bytes)throw Error('Local installer does not match release');
const parent=path.join(repo,'output/desktop-web-release');fs.mkdirSync(parent,{recursive:true});const bundle=fs.mkdtempSync(path.join(parent,`desktop-${release.version}-`)),publicRoot=path.join(bundle,'public');
const host=JSON.parse(ssh(['sudo','-n','python3','-'],{input:`import subprocess,json,pathlib,re,hashlib
def inspect(name): return json.loads(subprocess.check_output(['docker','inspect',name]))[0]
ingress=pathlib.Path(next(m['Source'] for m in inspect('trylo-relay-caddy-1')['Mounts'] if m['Destination']=='/etc/caddy/Caddyfile'))
text=ingress.read_text();m=re.search(r'(?m)^trylocode\\.me\\s*\\{',text)
if not m: raise SystemExit('Apex block missing')
aliases=re.findall(r'reverse_proxy\\s+(trylo-[\\w-]+):8080',text[m.start():])
if len(aliases)!=1: raise SystemExit('Unexpected active static upstream')
alias=aliases[0];container='trylo-site-candidate-site-1' if alias=='trylo-site-candidate' else alias
data=inspect(container);mounts={m['Destination']:m['Source'] for m in data['Mounts']};root=pathlib.Path(mounts['/srv/site']).resolve();config=pathlib.Path(mounts['/etc/caddy/Caddyfile']).resolve()
if not root.is_relative_to('/home/admin/trylo-site/releases'): raise SystemExit('Unexpected static root')
page=root/'download/desktop/index.html'
sha=lambda p:hashlib.sha256(p.read_bytes()).hexdigest()
print(json.dumps({'alias':alias,'container':container,'site':str(root),'config':str(config),'configText':config.read_text(),'configSha256':sha(config),'ingress':str(ingress),'ingressSha256':sha(ingress),'pageText':page.read_text(),'pageSha256':sha(page),'homepageSha256':sha(root/'index.html'),'composeText':(config.parent/'compose.yaml').read_text()}))
`}));
fs.writeFileSync(path.join(bundle,'host-before.json'),JSON.stringify(host,null,2)+'\n');
const font=fs.readFileSync(path.join(source,'assets/trylo-text.woff')),rawCss=fs.readFileSync(path.join(source,'styles.css'),'utf8');
const id=sha(desktopDownloadActions(release)+rawCss+sha(font)).slice(0,12),prefix=`/marketing/desktop-${release.version}-${id}`;
let page=host.pageText;const start=page.indexOf('<div class="download-actions">'),end=page.indexOf('</div></div><div class="download-brand-image">',start);
if(start<0||end<start)throw Error('Inspect Desktop action markup before editing');
page=page.slice(0,start)+'<div class="download-actions">'+desktopDownloadActions(release)+page.slice(end);
const assetPrefix=host.pageText.match(/href="(\/marketing\/[^"/]+\/assets\/)trylo-icon\.svg"/)?.[1];
if(!assetPrefix)throw Error('Current brand asset namespace missing');
page=page.replace(/<link rel="stylesheet" href="[^"]+">/,`<link rel="stylesheet" href="${prefix}/styles.css">`);
page=page.replace(/(<meta (?:name="description"|property="og:description") content=")[^"]+"/g,`$1下载 Trylo Desktop ${release.version} Windows x64 预览版，在一个工作台展开代码、工具与作品。"`);
const css=rawCss.replaceAll('/assets/',assetPrefix).replaceAll(assetPrefix+'trylo-text.woff',prefix+'/trylo-text.woff');
const files=[];function write(name,bytes){const destination=path.join(publicRoot,name);fs.mkdirSync(path.dirname(destination),{recursive:true});fs.writeFileSync(destination,bytes);files.push({path:name,bytes:Buffer.byteLength(bytes),sha256:sha(bytes)});}
write('download/desktop/index.html',page);write(prefix.slice(1)+'/styles.css',css);write(prefix.slice(1)+'/trylo-text.woff',font);write(release.checksumPath.slice(1),`${release.installer.sha256}  ${release.installer.file}\n`);
const caddy=desktopReleasePolicy(host.configText,release);fs.writeFileSync(path.join(bundle,'Caddyfile'),caddy);
ssh(['sudo','-n','docker','exec','-i','-e','SITE_DOMAIN=:8080',host.container,'caddy','validate','--config','-','--adapter','caddyfile'],{input:caddy});
const manifest={kind:'desktop-download-patch',release,prefix,files,caddySha256:sha(caddy),expected:{container:host.container,alias:host.alias,site:host.site,configSha256:host.configSha256,ingressSha256:host.ingressSha256,pageSha256:host.pageSha256,homepageSha256:host.homepageSha256},validatedCaddy:true};
fs.writeFileSync(path.join(bundle,'manifest.json'),JSON.stringify(manifest,null,2)+'\n');
fs.mkdirSync(path.join(siteRoot,'.local-release'),{recursive:true});
fs.writeFileSync(path.join(siteRoot,'.local-release/desktop-download-candidate.json'),JSON.stringify({bundle,version:release.version,files:files.length,installerBytes:release.installer.bytes,installerSha256:release.installer.sha256,deployed:false},null,2)+'\n');
console.log(JSON.stringify({bundle,version:release.version,files:files.length,installerBytes:release.installer.bytes,caddyValidated:true},null,2));
